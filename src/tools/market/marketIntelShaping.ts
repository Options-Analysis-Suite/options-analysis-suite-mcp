/**
 * Shaping for the market-wide reads behind get_regime's volatility and
 * sectors scopes, get_fundamentals' `valuation` block and
 * get_company_profile's `esg` block (proxy routes /market/vix-term-structure,
 * /market/sector-metrics, /market/sector-metrics/history,
 * /market-cap-history/:symbol and /esg/:symbol).
 */

/** A read that threw (an outage), as against a 404 (null: nothing on record). */
export const READ_FAILED = Symbol('read failed');
export type Read<T> = T | null | typeof READ_FAILED;

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const round = (v: number | null, decimals: number): number | null => (v === null ? null : Number(v.toFixed(decimals)));
/** A P/E to 2 decimals, or to 3 significant digits under 1: the vendor stores some as 0.000495, which must not read 0. */
const roundPe = (v: number | null): number | null => (v === null ? null : Math.abs(v) >= 1 ? round(v, 2) : Number(v.toPrecision(3)));
const DAY_MS = 86_400_000;
const dayMs = (ymd: string) => Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`);

// ---------------------------------------------------------------------------
// get_regime scope "volatility"

type VixPoint = {
  symbol?: string;
  horizon?: string;
  days?: number;
  close?: number | null;
  date?: string | null;
  previousClose?: number | null;
  change?: number | null;
  changePct?: number | null;
};

export type VixTermResponse = {
  asOf?: string;
  shape?: string | null;
  shapeTenors?: string[];
  curve?: VixPoint[];
  vvix?: VixPoint | null;
};

export const VOLATILITY_NOTE = 'End-of-day closes of the Cboe volatility indexes: VIX1D, VIX9D, VIX, VIX3M and VIX6M are the S&P 500\'s expected volatility over 1 day, 9 days, 30 days, 3 months and 6 months, and VVIX the expected volatility of VIX. '
  + '`shape` is read across the 9-day to 6-month indexes that closed on `asOf` (`shapeTenors`): contango when each closes above the one before it, backwardation when each closes below, else mixed, and null with fewer than two; VIX1D moves with each day\'s events and is left out. '
  + '`ratios` use closes on `asOf` only: VIX/VIX3M above 1 prices the next month above the next three, and VIX9D/VIX above 1 the next nine days above the month. '
  + 'An index whose newest close is older than `asOf` is marked `stale` and left out of the shape and the ratios; one with no close in the last three weeks keeps its index and horizon with every close, date and change field null. `change` is against the index\'s previous close on file.';

type ShapedVixPoint = { close: number | null; date: string | null; previousClose: number | null; change: number | null; changePct: number | null; stale?: true };

function shapeVixPoint(p: VixPoint, asOf: string | null): ShapedVixPoint {
  const date = text(p.date);
  return {
    close: finite(p.close),
    date,
    previousClose: finite(p.previousClose),
    change: finite(p.change),
    changePct: finite(p.changePct),
    ...(date !== null && asOf !== null && date < asOf ? { stale: true } : {}),
  };
}

export function shapeVixTermStructure(payload: VixTermResponse | null): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') {
    return { view: 'volatility', dataAvailable: false, message: 'No VIX term structure on record.' };
  }
  const asOf = text(payload.asOf);
  const curve = (Array.isArray(payload.curve) ? payload.curve : [])
    .filter((p): p is VixPoint => p != null && typeof p === 'object')
    .map(p => ({ index: text(p.symbol), horizon: text(p.horizon), horizonDays: finite(p.days), ...shapeVixPoint(p, asOf) }));
  // A ratio of two closes on asOf; a stale or missing side gives null.
  const closeOn = (symbol: string) => {
    const p = curve.find(c => c.index === symbol);
    return p && p.date === asOf ? finite(p.close) : null;
  };
  const ratio = (a: number | null, b: number | null) => (a !== null && b !== null && b > 0 ? round(a / b, 4) : null);
  return {
    view: 'volatility',
    asOf,
    shape: text(payload.shape),
    shapeTenors: Array.isArray(payload.shapeTenors) ? payload.shapeTenors : [],
    curve,
    ratios: {
      vixToVix3m: ratio(closeOn('VIX'), closeOn('VIX3M')),
      vix9dToVix: ratio(closeOn('VIX9D'), closeOn('VIX')),
    },
    vvix: payload.vvix && typeof payload.vvix === 'object' ? shapeVixPoint(payload.vvix, asOf) : null,
    volatilityNote: VOLATILITY_NOTE,
  };
}

// ---------------------------------------------------------------------------
// get_regime scope "sectors"

type SectorRow = { name?: string; exchange?: string; pe?: number | null; changePct?: number | null };
export type SectorMetricsResponse = { kind?: string; date?: string; rows?: SectorRow[] };
type SectorHistoryResponse = { series?: Array<{ date?: string; pe?: number | null; changePct?: number | null }> };

export const SECTOR_EXCHANGES = ['NYSE', 'NASDAQ', 'AMEX'] as const;

export const SECTORS_NOTE = 'Each group\'s `pe` is its price-to-earnings ratio among its companies listed on that exchange, and `changePct` the average daily price change of those companies that day, in percent (0.5 is half a percent); '
  + 'groups are kept for the NYSE, NASDAQ and AMEX only, and a null is a value not on record for the day. `date` is the newest day on file for every exchange with recent data (else the newest day on file for the most exchanges).';

function sectorCell(row: SectorRow): { pe: number | null; changePct: number | null } {
  return { pe: roundPe(finite(row.pe)), changePct: round(finite(row.changePct), 3) };
}

/** The day's rows grouped by name, one entry per exchange, optionally one exchange only. */
export function groupSectorRows(rows: unknown, exchange?: string): Array<{ name: string; byExchange: Record<string, { pe: number | null; changePct: number | null }> }> {
  const groups = new Map<string, Record<string, { pe: number | null; changePct: number | null }>>();
  for (const row of Array.isArray(rows) ? rows as SectorRow[] : []) {
    const name = text(row?.name);
    const ex = text(row?.exchange);
    if (!name || !ex || (exchange && ex !== exchange)) continue;
    const byExchange = groups.get(name) ?? {};
    byExchange[ex] = sectorCell(row);
    groups.set(name, byExchange);
  }
  return [...groups.entries()].map(([name, byExchange]) => ({ name, byExchange }));
}

export function shapeSectorMetrics(
  payload: SectorMetricsResponse | null,
  opts: { kind: 'sector' | 'industry'; exchange?: string; group?: string },
): { shaped: Record<string, unknown>; group: { name: string; exchanges: string[] } | null } {
  const noun = opts.kind === 'industry' ? 'industry' : 'sector';
  if (!payload || typeof payload !== 'object') {
    return { shaped: { view: 'sectors', kind: opts.kind, dataAvailable: false, message: `No ${noun} metrics on record.` }, group: null };
  }
  const groups = groupSectorRows(payload.rows, opts.exchange);
  const base = { view: 'sectors', kind: payload.kind ?? opts.kind, date: text(payload.date), ...(opts.exchange ? { exchange: opts.exchange } : {}) };
  if (opts.group) {
    const wanted = opts.group.trim().toLowerCase();
    const match = groups.find(g => g.name.toLowerCase() === wanted);
    if (match) {
      return {
        shaped: { ...base, group: match, sectorsNote: SECTORS_NOTE },
        group: { name: match.name, exchanges: Object.keys(match.byExchange) },
      };
    }
    return {
      shaped: { ...base, groups, groupNote: `No ${noun} named "${opts.group}"${opts.exchange ? ` on the ${opts.exchange}` : ''} on record for ${base.date ?? 'the day'}; \`groups\` lists the ${noun === 'industry' ? 'industries' : 'sectors'} on record that day.`, sectorsNote: SECTORS_NOTE },
      group: null,
    };
  }
  return { shaped: { ...base, groups, sectorsNote: SECTORS_NOTE }, group: null };
}

/** One exchange's daily series for a group, oldest first, or null with nothing on record. */
export function shapeSectorHistory(payload: Read<SectorHistoryResponse>): Array<{ date: string | null; pe: number | null; changePct: number | null }> | null {
  if (payload === READ_FAILED || !payload || !Array.isArray(payload.series)) return null;
  return payload.series.map(p => ({ date: text(p?.date), pe: roundPe(finite(p?.pe)), changePct: round(finite(p?.changePct), 3) }));
}

// ---------------------------------------------------------------------------
// get_fundamentals `valuation`

type CapHistoryResponse = { points?: Array<[string, number]>; latest?: { date?: string; marketCap?: number } | null };

/**
 * Percent change from the first point on or after `days` before the last,
 * when that point lies within two weeks of the target (a gap in the history
 * would otherwise label a shorter change as a year's). The asset page's
 * MarketCapHistoryCard applies the same rule.
 */
export function capChangeOver(series: ReadonlyArray<{ date: string; cap: number }>, days: number): number | null {
  if (series.length < 2) return null;
  const last = series[series.length - 1]!;
  const target = dayMs(last.date) - days * DAY_MS;
  const then = series.find(p => dayMs(p.date) >= target);
  if (!then || then === last || dayMs(then.date) - target > 14 * DAY_MS) return null;
  return then.cap > 0 ? (last.cap / then.cap - 1) * 100 : null;
}

export const VALUATION_NOTE = '`peers` sets the company\'s trailing P/E (`peTtm`, the same as `ratiosTtm.priceToEarningsRatioTTM`) beside its sector\'s and its industry\'s P/E among the companies listed on its own exchange, each on its own `asOf` day; '
  + '`premiumPct` is the company\'s P/E over the group\'s, minus 1, in percent (negative is a discount). Group P/E is kept for the NYSE, NASDAQ and AMEX only, and there is no comparison without a positive P/E. '
  + '`marketCap` is from weekly points (each week\'s last session) plus the day\'s profile value when newer: `latest` and its `date`, and the change over one and five years from the first point on or after that many years before `date`, null when the history has no point within two weeks of it; `since` is the first point on file (about five years back, or the listing for a younger company). '
  + 'The profile\'s market cap stands in as `latest` only for a newer session than the last weekly point.';

/** Beside the summary's `companyProfile` (the full payload carries none). */
const VALUATION_PROFILE_NOTE = ' `companyProfile.peRatioTtm` and `companyProfile.marketCap` are the profile\'s own figures, from another source and refresh, so they can differ from `peTtm` and from `marketCap.latest` on the same session, at times by a few percent.';

function sectorRowFor(payload: Read<SectorMetricsResponse>, name: unknown, exchange: string): { name: string; pe: number; asOf: string | null } | null {
  if (payload === READ_FAILED || !payload || typeof name !== 'string') return null;
  const row = (Array.isArray(payload.rows) ? payload.rows : []).find(r => r?.name === name && r?.exchange === exchange);
  const pe = finite(row?.pe);
  return row && pe !== null && pe > 0 ? { name, pe, asOf: text(payload.date) } : null;
}

function shapePeers(pe: number | null, profile: Record<string, unknown> | null | typeof READ_FAILED, sectors: Read<SectorMetricsResponse>, industries: Read<SectorMetricsResponse>):
  { peers: Record<string, unknown> | null; peersNote?: string } {
  if (pe === null) return { peers: null, peersNote: 'No trailing P/E on record, so no peer comparison.' };
  if (!(pe > 0)) return { peers: null, peersNote: 'The trailing P/E is not positive, so no peer comparison.' };
  if (profile === READ_FAILED) return { peers: null, peersNote: 'The company profile was unavailable on this call, so no peer comparison.' };
  const exchange = typeof profile?.exchange_short === 'string' ? profile.exchange_short.toUpperCase() : null;
  if (!exchange) return { peers: null, peersNote: 'No listing exchange on record, so no peer comparison.' };
  if (!(SECTOR_EXCHANGES as readonly string[]).includes(exchange)) {
    return { peers: null, peersNote: `Lists on ${exchange}; group P/E is kept for the NYSE, NASDAQ and AMEX only.` };
  }
  const sector = sectorRowFor(sectors, profile?.sector, exchange);
  const industry = sectorRowFor(industries, profile?.industry, exchange);
  const failed = sectors === READ_FAILED || industries === READ_FAILED;
  const premium = (g: { pe: number }) => round((pe / g.pe - 1) * 100, 1);
  if (!sector && !industry) {
    return { peers: null, peersNote: failed ? 'Sector and industry P/E were unavailable on this call.' : 'No sector or industry P/E on record for the company\'s groups on its exchange.' };
  }
  return {
    peers: {
      exchange,
      sector: sector ? { name: sector.name, pe: roundPe(sector.pe), premiumPct: premium(sector), asOf: sector.asOf } : null,
      industry: industry ? { name: industry.name, pe: roundPe(industry.pe), premiumPct: premium(industry), asOf: industry.asOf } : null,
    },
    ...(failed ? { peersNote: 'Part of the group P/E was unavailable on this call.' } : {}),
  };
}

function shapeMarketCap(payload: Read<CapHistoryResponse>): { marketCap: Record<string, unknown> | null; marketCapNote?: string } {
  if (payload === READ_FAILED) return { marketCap: null, marketCapNote: 'Market-cap history was unavailable on this call.' };
  const series = (Array.isArray(payload?.points) ? payload!.points! : [])
    .filter(p => Array.isArray(p) && typeof p[0] === 'string' && finite(p[1]) !== null)
    .map(([date, cap]) => ({ date, cap }));
  const latest = payload?.latest;
  if (latest && typeof latest.date === 'string' && finite(latest.marketCap) !== null) series.push({ date: latest.date, cap: latest.marketCap! });
  if (series.length === 0) return { marketCap: null, marketCapNote: 'No market-cap history on record.' };
  const last = series[series.length - 1]!;
  return {
    marketCap: {
      latest: round(last.cap, 0),
      date: last.date,
      change1yPct: round(capChangeOver(series, 365), 1),
      change5yPct: round(capChangeOver(series, 5 * 365), 1),
      since: series[0]!.date,
    },
  };
}

export function shapeValuation(
  fundamentals: unknown,
  profile: Read<unknown>,
  sectors: Read<SectorMetricsResponse>,
  industries: Read<SectorMetricsResponse>,
  capHistory: Read<CapHistoryResponse>,
  view: 'summary' | 'full' = 'summary',
): Record<string, unknown> {
  const ratios = (fundamentals as { ratios_ttm?: Record<string, unknown> } | null)?.ratios_ttm;
  const pe = finite(ratios?.priceToEarningsRatioTTM);
  const p = profile === READ_FAILED ? READ_FAILED : profile && typeof profile === 'object' ? profile as Record<string, unknown> : null;
  return {
    peTtm: round(pe, 2),
    ...shapePeers(pe, p, sectors, industries),
    ...shapeMarketCap(capHistory),
    note: view === 'summary' ? VALUATION_NOTE + VALUATION_PROFILE_NOTE : VALUATION_NOTE,
  };
}

// ---------------------------------------------------------------------------
// get_company_profile `esg`

type EsgResponse = {
  disclosure?: Record<string, unknown> | null;
  rating?: Record<string, unknown> | null;
  withheld?: {
    disclosure?: { reason?: string; date?: string } | null;
    rating?: { reason?: string; fiscalYear?: number } | null;
  };
};

/** The proxy's lib/esgView.ts decisions in words (the asset page's EsgCard says the same). */
export function esgWithheldNotes(w: EsgResponse['withheld']): string[] {
  const notes: string[] = [];
  if (w?.disclosure?.reason === 'stale') notes.push(`The latest ESG disclosure on file is for the period ended ${w.disclosure.date}, over two years ago, so its scores are not shown.`);
  if (w?.disclosure?.reason === 'placeholder') notes.push(`The latest ESG disclosure on file (period ended ${w.disclosure.date}) carries placeholder scores, all four exactly 50, so they are not shown.`);
  if (w?.rating) notes.push(`The latest ESG risk rating on file is for fiscal ${w.rating.fiscalYear}, more than two years back, so it is not shown.`);
  return notes;
}

export function shapeEsg(payload: Read<EsgResponse>): { esg: Record<string, unknown> | null; esgNote?: string } {
  if (payload === READ_FAILED) return { esg: null, esgNote: 'ESG data was unavailable on this call.' };
  if (!payload || typeof payload !== 'object') return { esg: null, esgNote: 'No ESG data on record for this symbol.' };
  const d = payload.disclosure && typeof payload.disclosure === 'object' ? payload.disclosure : null;
  const r = payload.rating && typeof payload.rating === 'object' ? payload.rating : null;
  const withheld = esgWithheldNotes(payload.withheld);
  return {
    esg: {
      disclosure: d ? {
        esgScore: round(finite(d.esgScore), 2),
        environmentalScore: round(finite(d.environmentalScore), 2),
        socialScore: round(finite(d.socialScore), 2),
        governanceScore: round(finite(d.governanceScore), 2),
        scale: '0 to 100',
        formType: text(d.formType),
        periodEnded: text(d.date),
        filingDate: text(d.acceptedDate),
        filingUrl: text(d.url),
      } : null,
      riskRating: r ? {
        rating: text(r.rating),
        fiscalYear: finite(r.fiscalYear),
        industry: text(r.industry),
        industryRank: text(r.industryRank),
      } : null,
      ...(withheld.length > 0 ? { withheld } : {}),
    },
  };
}
