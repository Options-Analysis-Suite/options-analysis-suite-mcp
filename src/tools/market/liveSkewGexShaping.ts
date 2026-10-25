/**
 * Shape the live watchlist skew and GEX ranking (the proxy's GET
 * /live/skew-gex) for a model: one flat-ish row per answered symbol, ranked
 * when asked, with everything the call did NOT answer said beside it.
 *
 * THREE THINGS THAT MUST NOT BE SILENT:
 *
 * 1. A symbol this call has no value for is in `pending` with its reason (the
 *    budget, the time, a computation still running, the broker's own 429) and
 *    the call is `complete: false` with `retryAfterSeconds`; it is never just
 *    absent from the ranking. A row older than maxAgeSeconds is served, marked
 *    `stale` and named in `refreshPending`.
 * 2. A metric whose coverage cannot support a number (no leg sized) is null
 *    with its status, never a measured 0, and so is the change built on it.
 * 3. A row the answer cannot hold (the `limit`, the response ceiling) is
 *    named in `omitted`, worst-ranked first, rather than left to the generic
 *    size guard, which trims arrays without saying which rows went.
 */
import { MAX_RESPONSE_BYTES, utf8ByteLength } from '../helpers.js';
import type { LiveRateLimit } from '../../proxy/liveApiClient.js';
import { codeLegend, rateLimitGuide, type Guide } from '../liveGuide.js';
import { excludedRootsPhrase, isoDate, measuredValue, metricCoverage, readExcludedRoots, type FieldStatus } from './dealerPositioningShaping.js';
import { readOmittedRows } from './omittedRows.js';

export const LIVE_SKEW_GEX_METRICS = ['skew', 'gex'] as const;
export type LiveSkewGexMetric = typeof LIVE_SKEW_GEX_METRICS[number];

export const LIVE_SKEW_GEX_RANK_BY = ['skew', 'skewChange', 'gex', 'gexChange', 'gexChangePercent'] as const;
export type LiveSkewGexRankBy = typeof LIVE_SKEW_GEX_RANK_BY[number];

/** The metric each ranking reads, so a ranking on a metric not requested is refused before any request. */
export const RANK_METRIC: Readonly<Record<LiveSkewGexRankBy, LiveSkewGexMetric>> = Object.freeze({
  skew: 'skew', skewChange: 'skew', gex: 'gex', gexChange: 'gex', gexChangePercent: 'gex',
});

/** A change ranks by its size, its sign kept in the value: the biggest movers either way. */
const BY_SIZE: ReadonlySet<LiveSkewGexRankBy> = new Set(['skewChange', 'gexChange', 'gexChangePercent']);

export const MAX_LIVE_SKEW_GEX_SYMBOLS = 50;

/**
 * Greek exposure methodology v2: this tool's GEX is its own engine's, never labeled platform
 * methodology 1, and the platform's default methodology does not control it.
 */
export const LIVE_SKEW_GEX_METHODOLOGY = 'GEX here is this tool\'s own model (`method`: implied volatility solved from the live mids), '
  + 'neither platform exposure methodology 1 nor 2, and the platform\'s default exposure methodology does not change it; its sign '
  + '(calls positive, puts negative) is the assumed dealer book\'s in both.';

/** Room under the response ceiling for the wire sanitizer's renames and the envelope. */
export const LIVE_SKEW_GEX_MARGIN_BYTES = 2 * 1024;
const MAX_WARNINGS = 3;
const MAX_TEXT = 240;

export const LIVE_SKEW_GEX_UNITS = Object.freeze({
  skew: 'decimal implied volatility: 0.05 is 5 volatility points (skew.value, putIv25d, callIv25d, skew10d, prior and change)',
  gex: 'dollars per 1% move of the underlying: gamma x open interest x 100 x spot^2 x 1%, calls positive, puts negative (gex.value, prior and change)',
  gexChangePercent: 'percent of the size of the prior session\'s net GEX: 12.5 is 12.5%; null when the prior is 0',
  oiShare: 'fraction (0 to 1) of the known open interest whose leg got a gamma',
  // The precision every figure goes out at.
  precision: 'skews, IVs, yields, shares and percentages at 6 significant digits; GEX in whole dollars; prices as the broker quoted them',
});

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const dates = (v: unknown): string[] => arr(v).map(isoDate).filter((d): d is string => d !== null);
const text = (v: unknown): string | null => {
  const s = str(v);
  return s === null ? null : s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 3)}...` : s;
};
const bytes = (value: unknown) => utf8ByteLength(JSON.stringify(value));

/**
 * The proxy's warning for an adjusted series it left out carries this; the
 * metric's own `excludedRootsNote` says the same from the structured fields,
 * whole, so the warning is not relayed twice (nor cut at MAX_TEXT, nor pushed
 * past MAX_WARNINGS by the rate warnings before it).
 */
const ADJUSTED_SERIES_WARNING = '(an adjusted series, a different deliverable at the same strikes)';

/**
 * A model output at the precision it has. Fifty rows of skews, yields and
 * shares printed to 15 significant digits did not fit the response ceiling
 * (live run, 2026-10-08: 46 of 50, four rows computed, paid for and dropped),
 * and the digits past the sixth were never information: an IV solved from a
 * mid quoted to the cent is good to about 1e-4. Dollar GEX is to the dollar.
 */
const SIGNIFICANT = 6;
// Whole numbers too (review): the shared significant() leaves an
// integer as it is, and a prior near 0 makes a seven-digit changePercent.
const sixDigits = (n: number): number => Number(n.toPrecision(SIGNIFICANT));
const model = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : sixDigits(n);
};
const dollars = (v: number | null): number | null => (v === null ? null : Math.round(v));

export interface LiveSkewGexShapeOptions {
  requestedSymbols: string[];
  rankBy?: LiveSkewGexRankBy;
  order?: 'asc' | 'desc';
  limit?: number;
  /**
   * The live-broker budget after this call: given, it rides INSIDE the fit with the rows and
   * the guide. Absent: no rateLimit field.
   */
  rateLimit?: LiveRateLimit | null;
}

/**
 * A metric's own baseline date only where it differs from the row's (two
 * computations of one symbol under different prior sessions); the age dates
 * it against the response's `asOf`. Both were on every metric and left fifty
 * rows past the response ceiling.
 */
function provenance(r: Record<string, unknown>, rowBaselineDate: string | null) {
  const baselineDate = isoDate(r.baselineDate);
  return {
    ageSeconds: count(r.ageSeconds),
    ...(baselineDate !== rowBaselineDate ? { baselineDate } : {}),
  };
}

function shapeSkew(raw: unknown, rowBaselineDate: string | null) {
  const r = record(raw);
  const prior = record(r.prior);
  return {
    value: model(r.value),
    status: str(r.status),
    putIv25d: model(r.putIv25d),
    callIv25d: model(r.callIv25d),
    skew10d: model(r.ivSkew10d),
    expiration: isoDate(r.expiration),
    dte: count(r.dte),
    ...(() => {
      const omitted = readOmittedRows(r.omittedRows);
      return omitted !== null ? { omittedRows: omitted } : {};
    })(),
    ...(r.partial === true ? { partial: true as const } : {}),
    // On a date listed under several roots (SPX and SPXW): the series the smile was read from.
    ...(str(r.root) !== null ? { root: str(r.root) } : {}),
    ...(() => {
      const excluded = readExcludedRoots(r.excludedRoots);
      return excluded === null ? {} : {
        excludedRoots: excluded,
        excludedRootsNote: `${excludedRootsPhrase(excluded)} left out of the skew's expiration, whose smile is read from the symbol's own contracts alone.`,
      };
    })(),
    prior: model(prior.value),
    priorStatus: str(prior.status),
    change: model(r.change),
    ...provenance(r, rowBaselineDate),
  };
}

function shapeGex(raw: unknown, rowBaselineDate: string | null) {
  const r = record(raw);
  const legs = metricCoverage(r.gammaCoverage);
  // The proxy's own verdict first: no leg sized is no number, whatever the coverage reads.
  const measured: { value: number | null; status: FieldStatus } = r.status === 'ok'
    ? measuredValue(r.value, legs)
    : { value: null, status: 'unmeasured' };
  const strikes = record(r.strikeCoverage);
  const prior = record(r.prior);
  const fraction = num(r.changePct);
  const empty = dates(r.emptyExpirations);
  const unpublished = dates(r.openInterestUnpublishedExpirations);
  const adjustedOnly = dates(r.adjustedOnlyExpirations);
  const excluded = readExcludedRoots(r.excludedRoots);
  return {
    value: dollars(measured.value),
    status: measured.status,
    // Counted where some leg went unsized; "complete" means every one was.
    ...(measured.status !== 'complete' ? { legCoverage: { total: legs.total, included: legs.included } } : {}),
    oiShare: model(r.oiShare),
    expirations: dates(r.expirations),
    ...(empty.length > 0 ? { emptyExpirations: empty } : {}),
    // Adjusted series (a digit root, a different deliverable) left out: a date listed only under one adds nothing and
    // is no outage; the status measures the symbol's own contracts, so "complete" never includes them.
    ...(adjustedOnly.length > 0 ? { adjustedOnlyExpirations: adjustedOnly } : {}),
    ...(excluded !== null ? {
      excludedRoots: excluded,
      excludedRootsNote: `${excludedRootsPhrase(excluded)} left out of the GEX, which measures the symbol's own contracts alone, so a "complete" status does not include them`
        + (adjustedOnly.length > 0 ? `; ${adjustedOnly.join(', ')} ${adjustedOnly.length === 1 ? 'is' : 'are'} listed only under adjusted series, so ${adjustedOnly.length === 1 ? 'it adds' : 'they add'} nothing.` : '.'),
    } : {}),
    ...(unpublished.length > 0 ? { openInterestUnpublishedExpirations: unpublished } : {}),
    // Rows the broker sent for the window's chains that could not be used: the GEX leaves them out.
    ...(() => {
      const omitted = readOmittedRows(r.omittedRows);
      return omitted !== null ? { omittedRows: omitted } : {};
    })(),
    // The window could not be read whole (a date or a quote): the proxy withholds the change on unread quotes.
    ...(r.partial === true ? { partial: true as const } : {}),
    // Every priced strike in one of the three: the total is their sum, not sent.
    strikes: {
      otmSide: count(strikes.strikesOtmSide),
      filled: count(strikes.strikesFilled),
      noIv: count(strikes.strikesNoIv),
    },
    prior: dollars(num(prior.value)),
    priorOiShare: model(prior.oiShare),
    priorStatus: str(prior.status),
    // A change on a withheld level is withheld with it.
    change: measured.value === null ? null : dollars(num(r.change)),
    changePercent: measured.value === null || fraction === null ? null : sixDigits(fraction * 100),
    ...provenance(r, rowBaselineDate),
  };
}

type Row = ReturnType<typeof shapeRow>;

function shapeRow(raw: unknown, metrics: readonly LiveSkewGexMetric[], stale: ReadonlySet<string>, sessionValuation: string | null) {
  const r = record(raw);
  const symbol = str(r.symbol);
  const spot = record(r.spot);
  const q = record(r.q);
  const baseline = record(r.baseline);
  const warnings = arr(r.warnings).filter((w) => !(typeof w === 'string' && w.includes(ADJUSTED_SERIES_WARNING)))
    .map(text).filter((w): w is string => w !== null);
  const valuation = str(r.valuation);
  const skipped = count(baseline.sessionsSkipped);
  const missing = dates(baseline.missingExpirations);
  return {
    symbol,
    spot: num(spot.value),
    spotTime: str(spot.time),
    spotStale: bool(spot.stale),
    // Only a row valued otherwise than the response says (a cached row from before the close).
    ...(valuation !== sessionValuation ? { valuation } : {}),
    ...(metrics.includes('skew') && r.skew !== undefined ? { skew: shapeSkew(r.skew, isoDate(baseline.date)) } : {}),
    ...(metrics.includes('gex') && r.gex !== undefined ? { gex: shapeGex(r.gex, isoDate(baseline.date)) } : {}),
    // A skipped session and a missing expiration are named where there is one.
    baseline: {
      date: isoDate(baseline.date),
      status: str(baseline.status),
      ...(skipped !== null && skipped > 0 ? { sessionsSkipped: skipped } : {}),
      spot: num(baseline.spot),
      ...(missing.length > 0 ? { missingExpirations: missing } : {}),
    },
    q: { value: model(q.value), source: str(q.source), asOf: str(q.asOf) },
    // Older than maxAgeSeconds: served from the cache and listed in refreshPending.
    stale: symbol !== null && stale.has(symbol),
    ...(warnings.length > 0 ? { warnings: warnings.slice(0, MAX_WARNINGS) } : {}),
  };
}

function rankValue(row: Row, rankBy: LiveSkewGexRankBy): number | null {
  switch (rankBy) {
    case 'skew': return row.skew?.value ?? null;
    case 'skewChange': return row.skew?.change ?? null;
    case 'gex': return row.gex?.value ?? null;
    case 'gexChange': return row.gex?.change ?? null;
    case 'gexChangePercent': return row.gex?.changePercent ?? null;
  }
}

function shapeError(raw: unknown) {
  const r = record(raw);
  const warnings = arr(r.warnings).map(text).filter((w): w is string => w !== null);
  const missing = arr(r.missingFields).map(str).filter((f): f is string => f !== null);
  return {
    symbol: str(r.symbol),
    status: count(r.status),
    code: str(r.code),
    error: text(r.error),
    retryable: bool(r.retryable),
    ...(str(r.message) !== null ? { message: text(r.message) } : {}),
    ...(missing.length > 0 ? { missingFields: missing } : {}),
    ...(str(r.brokerFailure) !== null ? { brokerFailure: str(r.brokerFailure) } : {}),
    ...(r.brokerStatus !== undefined ? { brokerStatus: count(r.brokerStatus) } : {}),
    ...(num(r.retryAfterSeconds) !== null ? { retryAfterSeconds: num(r.retryAfterSeconds) } : {}),
    ...(warnings.length > 0 ? { warnings: warnings.slice(0, MAX_WARNINGS) } : {}),
  };
}

export function shapeLiveSkewGex(response: unknown, options: LiveSkewGexShapeOptions) {
  const body = record(response);
  const metrics = arr(body.metrics).filter((m): m is LiveSkewGexMetric => m === 'skew' || m === 'gex');
  const refreshPending = arr(body.refreshPending).map(str).filter((s): s is string => s !== null);
  const stale = new Set(refreshPending);
  const sessionValuation = str(record(body.session).valuation);
  const rows = arr(body.results).map((raw) => shapeRow(raw, metrics, stale, sessionValuation));
  // The proxy answers in the order asked for, after its own spelling (BRK-B is BRK.B), so
  // ITS order is the base: a ranking is a stable re-sort of it, ties in the order asked for.
  const position = new Map(rows.map((row, index) => [row, index] as const));
  const asked = (row: Row) => position.get(row) ?? Number.MAX_SAFE_INTEGER;

  // Each rate once, by expiration: every row priced that date at the same tenor's rate.
  const rates = new Map<string, { expiration: string; value: number | null; source: string | null; asOf: string | null }>();
  for (const raw of arr(body.results)) {
    for (const rate of arr(record(raw).rates)) {
      const r = record(rate);
      const expiration = isoDate(r.expiration);
      if (expiration === null) continue;
      const entry = { expiration, value: num(r.value), source: str(r.source), asOf: str(r.asOf) };
      const key = `${expiration}|${entry.value}`;
      if (!rates.has(key)) rates.set(key, entry);
    }
  }

  let rankMeta: Record<string, unknown> | undefined;
  if (options.rankBy) {
    const rankBy = options.rankBy;
    const order = options.order ?? 'desc';
    const bySize = BY_SIZE.has(rankBy);
    const key = (row: Row) => {
      const v = rankValue(row, rankBy);
      return v === null ? null : bySize ? Math.abs(v) : v;
    };
    const direction = order === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const va = key(a);
      const vb = key(b);
      if (va === null && vb === null) return asked(a) - asked(b);
      if (va === null) return 1;
      if (vb === null) return -1;
      if (va !== vb) return (va - vb) * direction;
      return asked(a) - asked(b);
    });
    const unranked = rows.filter((row) => key(row) === null);
    rankMeta = {
      rankBy,
      order,
      by: bySize ? 'size of the change, sign kept in the value' : 'value',
      ranked: rows.length - unranked.length,
      unranked: unranked.length,
      unrankedSymbols: unranked.map((row) => row.symbol),
    };
  }

  const shell = {
    dataSource: 'live' as const,
    provider: str(body.provider),
    asOf: str(body.asOf),
    session: {
      liveSessionDate: isoDate(record(body.session).liveSessionDate),
      marketOpen: bool(record(body.session).marketOpen),
      valuation: sessionValuation,
    },
    metrics,
    maxAgeSeconds: count(body.maxAgeSeconds),
    complete: bool(body.complete),
    retryAfterSeconds: num(body.retryAfterSeconds),
    requested: options.requestedSymbols.length,
    returned: 0,
    ...(rankMeta ? { rankMeta } : {}),
    results: [] as Row[],
    pending: arr(body.pending).map((raw) => {
      const p = record(raw);
      return {
        symbol: str(p.symbol),
        metrics: arr(p.metrics).filter((m): m is LiveSkewGexMetric => m === 'skew' || m === 'gex'),
        reason: str(p.reason),
      };
    }),
    refreshPending,
    errors: arr(body.errors).map(shapeError),
    rates: [...rates.values()].sort((a, b) => (a.expiration < b.expiration ? -1 : a.expiration > b.expiration ? 1 : 0)),
    units: LIVE_SKEW_GEX_UNITS,
    method: record(body.method),
    methodologyNote: LIVE_SKEW_GEX_METHODOLOGY,
    notes: record(body.notes),
    ...('rateLimit' in options ? { rateLimit: options.rateLimit ?? null } : {}),
    guide: {} as Guide,
  };

  // The best-ranked rows that fit: the limit first, then the response ceiling. Measure the final answer each time,
  // including the omitted symbol lists, the guide for the retained rows and rateLimit. At most fifty rows are tried.
  const limit = options.limit ?? rows.length;
  const byLimit = rows.slice(limit);
  const fit = (keptCount: number) => {
    const kept = rows.slice(0, keptCount);
    const bySize = rows.slice(keptCount, limit);
    const omitted = byLimit.length + bySize.length > 0
      ? {
        omitted: {
          count: byLimit.length + bySize.length,
          ...(byLimit.length > 0 ? { byLimit: byLimit.map((row) => row.symbol) } : {}),
          ...(bySize.length > 0 ? { bySize: bySize.map((row) => row.symbol) } : {}),
        },
      }
      : {};
    const out = { ...shell, returned: kept.length, results: kept, ...omitted };
    out.guide = rankingGuide(out, kept, options, byLimit.length + bySize.length > 0);
    return out;
  };
  let keptCount = Math.min(limit, rows.length);
  let out = fit(keptCount);
  while (keptCount > 0 && bytes(out) > MAX_RESPONSE_BYTES - LIVE_SKEW_GEX_MARGIN_BYTES) out = fit(--keptCount);
  return out;
}

// The per-symbol codes this tool's legend names beyond the shared ones: what each means HERE, where the
// relayed message points at inputs this tool does not take.
const RANKING_CODES: Record<string, string> = {
  NO_EXPIRATIONS: 'NO_EXPIRATIONS: the broker lists no option expirations for the symbol (an unknown ticker, or one '
    + 'without options); not retryable.',
  RESOLUTION_FAILED: 'RESOLUTION_FAILED: a required rate or dividend yield could not be resolved; missingFields names '
    + 'what is missing. This tool takes no supplied rate or yield; get_live_dealer_positioning takes r and q, including '
    + 'q for an index whose stored yield is unavailable (a volatility index has none).',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE: a stored rate or index yield could not be read, or the proxy did not '
    + 'answer; retryable later. This tool takes no supplied r or q, so a message saying to supply the fields does not apply here.',
  ADJUSTED_SERIES_ONLY: 'ADJUSTED_SERIES_ONLY: the expiration the tool needed is listed only under an adjusted series (a '
    + 'different deliverable), which it does not price; this tool has no expiration parameter, so a message saying to ask '
    + 'for another expiration does not apply here.',
};

const SKEW_GATES: Record<string, string> = {
  'curve-gate': '"curve-gate" (fewer than 5 strikes with a usable IV)',
  'delta-gate': '"delta-gate" (fewer than 5 strikes with a delta)',
  'wing-iv': '"wing-iv" (no usable IV at the 25-delta call or put)',
};

const GEX_STATUSES: Record<string, string> = {
  complete: '"complete": every leg with open interest (above zero, or not published) got a gamma',
  partial: '"partial": some did not (legCoverage counts them, oiShare is the share sized)',
  unmeasured: '"unmeasured": none did',
  unknown: '"unknown": the coverage could not be read or is inconsistent with the reported value',
  unavailable: '"unavailable": no value was reported for the stated coverage',
  empty: '"empty": no legs at all',
};

/**
 * The ranking's guide emits each applicable reading rule once under a stable key for the answer and its rows.
 */
function rankingGuide(shell: Record<string, any>, rows: Row[], options: LiveSkewGexShapeOptions, omitted: boolean): Guide {
  const g: Guide = {};
  const skews = rows.map((r) => r.skew).filter((x): x is NonNullable<typeof x> => x !== undefined);
  const gexes = rows.map((r) => r.gex).filter((x): x is NonNullable<typeof x> => x !== undefined);
  const provider = shell.provider;
  const gexAsked = shell.metrics.includes('gex');
  const gates = [...new Set(skews.map((k) => k.status).filter((st): st is string => st !== null && st in SKEW_GATES))];
  const statusNull = skews.some((k) => k.status === null);
  if (gates.length || statusNull) {
    g.skewGate = (gates.length
      ? 'When the skew definition\'s expiration fails a check the next one is tried (one more chain at most); when every one '
        + `tried fails, skew.value is null and skew.status names the check the expiration nearest 30 days out failed, with that `
        + `expiration and dte: ${gates.map((x) => SKEW_GATES[x]).join('; ')} - one-sided or missing quotes, more often outside regular hours.`
      : '')
      + (statusNull ? `${gates.length ? ' ' : ''}A null skew.status could not be read: that skew is unknown, and a null value is not 0.` : '');
  }
  if (skews.some((k) => k.status === 'no-qualifying-expiration')) {
    g.skewNoExpiration = 'skew.status "no-qualifying-expiration", with expiration and dte null, means no listed expiration '
      + 'is at least 7 days out.';
  }
  const priorStatuses = new Set<string>([...skews.map((k) => k.priorStatus), ...gexes.map((x) => x.priorStatus)].filter((st): st is string => st !== null && st !== 'ok'));
  const baselineStatuses = new Set(rows.map((r) => r.baseline.status).filter((st): st is string => st !== null && st !== 'found'));
  const priorUnknown = skews.some((k) => k.priorStatus === null) || gexes.some((x) => x.priorStatus === null);
  const baselineUnknown = rows.some((r) => r.baseline.status === null);
  const missing = rows.some((r) => r.baseline.missingExpirations !== undefined);
  if (priorStatuses.size || baselineStatuses.size || missing || priorUnknown || baselineUnknown) {
    const lines: string[] = [];
    if (priorStatuses.has('not-measured-live')) lines.push('priorStatus "not-measured-live": a live skew that failed has no prior.');
    const checks = [...priorStatuses].filter((st) => st in SKEW_GATES);
    if (checks.length) lines.push(`A prior that fails a check on the stored chain is null with that check in priorStatus (${checks.map((x) => `"${x}"`).join(', ')}).`);
    for (const st of ['none-on-file', 'unavailable']) {
      if (baselineStatuses.has(st) || priorStatuses.has(st)) {
        lines.push(`baseline.status or priorStatus "${st}" means ${st === 'unavailable' ? 'a failed or slow read' : 'no prior session on file'}; a metric with that priorStatus has a null prior.`);
      }
    }
    if (priorUnknown) lines.push('A null priorStatus was not reported or could not be read: that prior\'s status is unknown.');
    if (baselineUnknown) lines.push('A null baseline.status is unknown, not evidence that a prior was found.');
    if (priorStatuses.has('baseline-expiration-missing') || missing) {
      lines.push('priorStatus "baseline-expiration-missing": a live expiration the prior session did not store (such as a new weekly) makes that metric\'s prior null. '
        + 'baseline.missingExpirations names absent stored dates only when baseline.status is "found"; with "unavailable" or "none-on-file" '
        + 'it lists the requested dates, not proof that an expiration is newly listed or absent from storage after a failed read.');
    }
    if (priorStatuses.has('baseline-spot-missing')) lines.push('priorStatus "baseline-spot-missing": the prior session stored no spot, so that prior is null.');
    if (priorStatuses.has('unmeasured')) lines.push('A gex priorStatus "unmeasured": no prior leg was sized, so the prior is null.');
    lines.push('The row\'s baseline describes its newest computation; independently cached metrics can differ, so each metric\'s priorStatus describes its own prior, '
      + 'with its baselineDate when shown, otherwise the row\'s baseline.date.');
    lines.push('Every null prior sits beside its status, never as 0.');
    g.prior = lines.join(' ');
  }
  if (gexAsked) {
    g.gexWindow = 'From 4:15 PM New York on an expiration day, that day\'s expiration leaves the GEX window unless the broker '
      + 'lists nothing else (gex.expirations is the window used).';
    g.gexComparison = 'get_live_dealer_positioning sums the broker\'s published Greeks over the same window; get_options_snapshot\'s '
      + 'netGex covers every expiration on file and get_dealer_positioning\'s 0-60 days, so neither can be subtracted from this.';
  }
  if (gexes.length) {
    g.strikes = 'gex.strikes sorts the window\'s priced strikes by IV source: otmSide (their own out-of-the-money quote), '
      + 'filled (interpolated between neighbours), noIv (none: left out); a null count was not reported.';
  }
  const skewRoot = skews.some((k) => k.root !== undefined);
  if (skewRoot || gexes.length) {
    g.roots = (skewRoot ? 'On a date listed under several OCC roots (SPX and SPXW: different series, settlement and last '
      + 'trading day) the skew is read from one series, the primary (the most open interest over the date), named in '
      + 'skew.root. ' : '')
      + (gexes.length ? 'The GEX sums every retained same-deliverable series under the date, each on its own quotes; adjusted '
        + 'roots (a different deliverable) are removed before it is computed and their exclusion is reported.' : '');
  }
  const statuses = [...new Set(gexes.map((x) => x.status))];
  if (gexes.length) {
    g.gexStatus = `gex.status: ${statuses.map((st) => GEX_STATUSES[st] ?? `"${st}"`).join('; ')}. The statuses measure the symbol\'s own contracts alone, so "complete" excludes adjusted series.`
      + (gexes.some((x) => x.value === null) ? ' A null gex.value is never a measured 0; a computed 0 with status "complete" stays 0.' : '');
  }
  if (skews.some((k) => k.change === null) || gexes.some((x) => x.change === null || x.changePercent === null)) {
    g.changeWithheld = 'A null change is withheld, never "no change"; it can reflect an unmeasured level, a null prior '
      + 'beside its status, or unread quotes. A withheld level also withholds its change.'
      + (gexes.some((x) => x.changePercent === null && x.prior === 0)
        ? ' gex.changePercent is also null when the prior is 0; that alone does not withhold the level or dollar change.' : '');
  }
  if (gexes.some((x) => x.openInterestUnpublishedExpirations !== undefined)) {
    g.openInterestUnpublished = 'gex.openInterestUnpublishedExpirations names expirations whose open interest the broker did '
      + 'not publish (a zero on every contract, which Schwab has printed on index options, withheld as unknown): their legs '
      + 'are counted and left out (outside oiShare\'s denominator, so oiShare can read 1 beside "partial"). The change is still '
      + 'published, and the prior side may count that date\'s stored open interest, so a change on such a date may not be like for like.';
  }
  if (gexes.some((x) => x.emptyExpirations !== undefined)) {
    g.emptyExpirations = 'gex.emptyExpirations: a window date the broker answered with no contracts at all, an outage on that '
      + 'date, left out of both sides, so the change stands.';
  }
  if (gexes.some((x) => x.adjustedOnlyExpirations !== undefined)) {
    g.adjustedOnly = 'A date in gex.adjustedOnlyExpirations is listed only under adjusted series: it is no outage, neither '
      + 'empty nor partial, and adds nothing.';
  }
  if (gexes.some((x) => x.omittedRows !== undefined) || skews.some((k) => k.omittedRows !== undefined)) {
    g.omittedRows = 'omittedRows counts the rows the broker sent that could not be used - quarantined, invalidStrike, '
      + 'notSuccess, unquoted, with their total - left out of the GEX (the whole window) or of the skew expiration\'s chain.';
  }
  if (gexes.some((x) => x.partial === true) || skews.some((k) => k.partial === true)) {
    g.partial = 'partial on gex: the window could not be read whole (a date in emptyExpirations, or unread quotes in '
      + 'omittedRows.unquoted); on skew: its expiration lost quotes. With unread quotes the change is withheld (null), since '
      + 'the prior session holds those strikes; an empty date alone leaves the change standing.';
  }
  if (rows.some((r) => r.baseline.sessionsSkipped !== undefined)) {
    g.sessionsSkipped = 'The prior session is the most recent on file before the live session, up to two more back when an '
      + 'import is missing; baseline.sessionsSkipped means the change spans that many more sessions.';
  }
  if (rows.some((r) => r.valuation !== undefined)) {
    g.valuation = 'A row valued otherwise than the response says (a cached row computed before the close) carries its own valuation.';
  }
  if (rows.length) {
    g.spotClock = 'spotTime is the spot\'s trade time where the spot is a last trade the broker timed, null otherwise; '
      + 'spotStale is true when the spot printed before the last session\'s open, null when there is no time or no session is '
      + 'on file: null is unknown, never fresh.'
      + (provider === 'moomoo' ? ' On moomoo spotTime is the underlying snapshot\'s update time, when the quote last changed, not a print time.' : '');
  }
  if (rows.some((r) => r.q.source === 'index_constituents')) {
    g.indexYield = 'An index (SPX, NDX, RUT) uses its stored basket-derived dividend yield (q.source "index_constituents").';
  }
  if (provider === 'moomoo') {
    g.moomooDelay = 'moomoo serves US option quotes in real time only once the account holds assets or a US position; until '
      + 'then they may be delayed (about 15 minutes) with nothing in the data to say so.';
  }
  const pendingReasons = new Set<string>(shell.pending.map((p: { reason: string | null }) => p.reason).filter((x: string | null): x is string => x !== null));
  if ('rateLimit' in options) {
    const budget = rateLimitGuide(options.rateLimit ?? null);
    if (budget) g.rateLimit = budget;
  }
  // "rateLimit present" is the key (on a success it always is, null or a budget); the provider
  // clauses only for the provider that answered; an unknown provider gets only the general cost facts.
  const rateLimitGiven = 'rateLimit' in options;
  const cost: string[] = [];
  if (rateLimitGiven || pendingReasons.has('budget')) {
    const named = provider === 'moomoo' || provider === 'tastytrade' ? [provider] : [];
    if (named.includes('moomoo')) {
      cost.push('moomoo settles to what it spent (a contract list when not cached for the day, one snapshot per 400 codes, the '
        + 'underlying\'s among them, so an index\'s large chains spend more).');
    }
    if (named.includes('tastytrade')) cost.push('tastytrade settles to the real count (2 plus one per 100 contracts per chain).');
    if (named.length) {
      cost.push(`On ${named.join(' or ')} a chain longer than its share reserves the rest once its count is known, before its `
        + 'quote batches, and the symbol is pending "budget" when the budget cannot hold them.');
      cost.push('A symbol bigger than the whole budget runs alone, on a window holding nothing else, charged in full.');
    }
  }
  if (rateLimitGiven || shell.errors.length) {
    cost.push('A request counts when it is sent, answered or not: a chain the broker does not answer in time still spends its share.');
  }
  if (rateLimitGiven && pendingReasons.has('in-progress')) {
    cost.push('A symbol still finishing when the answer goes out holds its reservation until it settles, so remaining can read low for a moment.');
  }
  if (cost.length) g.cost = cost.join(' ');
  if (shell.refreshPending.length) {
    g.stale = 'A row older than maxAgeSeconds is served as it is (each metric\'s ageSeconds), stale true, named in '
      + 'refreshPending. Refreshing it is a priority, not a barrier: the symbols with no cached value are queued first and '
      + 'the stale rows after them, oldest first, dispatched as the budget and deadlines allow. A stale row is never pending.';
  }
  const pendingReasonUnknown = shell.pending.some((p: { reason: string | null }) => p.reason === null);
  if (pendingReasons.size || pendingReasonUnknown) {
    const legend: Record<string, string> = {
      budget: '"budget" (the per-broker quota ran out, or - with pending metrics ["skew"] only - the skew chain could not be afforded and the GEX was answered without it)',
      time: '"time" (no new symbol starts after 15 seconds; the answer comes by 25)',
      'in-progress': '"in-progress" (still computing - this call\'s, or a concurrent call\'s for the same symbol on the same account and broker, which this one waits on rather than pay twice - and it lands in the cache)',
      'broker-rate-limited': '"broker-rate-limited" (the broker\'s own 429: that symbol and the rest wait the broker\'s wait, else 60 seconds)',
    };
    const reasons = [...pendingReasons].map((x) => legend[x] ?? `"${x}"`);
    if (pendingReasonUnknown) reasons.push('a null reason was not reported');
    g.pending = `pending lists only metrics with no value; its reasons: ${reasons.join('; ')}.`;
  }
  if (shell.complete === false || shell.refreshPending.length || shell.retryAfterSeconds !== null) {
    g.complete = 'complete is true once every symbol has a value for every requested metric or an error, stale rows included; '
      + 'retryAfterSeconds says when the next call can make progress, on pending symbols or stale rows (null: nothing to wait for).';
  }
  // The per-symbol errors' legend, one sentence per code present.
  if (shell.errors.length) {
    const codes = [...new Set(shell.errors.map((e: { code: string | null }) => e.code).filter((c: string | null): c is string => c !== null))] as string[];
    const sentences = codes.map((code) => RANKING_CODES[code] ?? (codeLegend('ranking', code) !== undefined ? `${codeLegend('ranking', code)}` : undefined))
      .filter((x): x is string => x !== undefined);
    g.errorCodes = 'One symbol\'s failure never fails the list, and complete does not wait for it; a retryable one can be asked '
      + 'for again later (retryable null: not reported).' + (sentences.length ? ` ${sentences.join(' ')}` : '');
  }
  if (shell.rankMeta !== undefined) {
    g.ranking = (shell.rankMeta.unranked > 0
      ? 'A row without the ranked figure (null: withheld or unmeasured) sorts last and is named in rankMeta.unrankedSymbols, never ranked as 0; '
      : '') + 'ties keep the order asked for.';
  }
  if (omitted) {
    g.omitted = 'omitted names rows past limit (byLimit) or past the response ceiling (bySize): they were computed and are '
      + 'cached, so a call naming only them is answered from the cache '
      + 'at no cost while younger than maxAgeSeconds.';
  }
  return g;
}
