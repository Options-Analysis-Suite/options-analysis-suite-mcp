/**
 * get_institutional_ownership: the proxy's /institutional-ownership/:symbol
 * (built from the SEC's Form 13F data sets), shaped for a model. The newest
 * quarter in full, its top holders, and the quarters before; every count says
 * what it is, and nothing missing reads as zero.
 */
import { MAX_RESPONSE_BYTES, sanitizeMcpWireOutput, utf8ByteLength } from '../helpers.js';
import { RESPONSE_MARGIN_BYTES } from './dealerPositioningShaping.js';

type Quarter = Record<string, unknown> & { period?: unknown };
type Holder = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 'Q2 2026' from a quarter end. */
export function quarterLabel(period: string): string {
  return `Q${Math.floor((Number(period.slice(5, 7)) - 1) / 3) + 1} ${period.slice(0, 4)}`;
}

export const INSTITUTIONAL_NOTE = 'From the SEC\'s Form 13F data sets: investment managers with $100 million or more in Section 13(f) securities (U.S.-listed stocks, ETFs and options, mostly) report their holdings as of each quarter end, up to 45 days after it; a quarter is read from the data set holding its deadline and the two after it, so late filings and amendments are included. '
  + 'A manager\'s restated filing replaces its original, and an amendment adding holdings adds them; a manager whose same-day filings would leave different holdings depending on their unknown order is left out. Every quarter is matched to the company\'s ticker as of the newest quarter (a renamed company keeps its history); a holding filed under the company\'s older security identifier counts when it prices like its other holdings (or as filed when there are too few of those to compare), a holder whose shares were reported on another basis (before a reverse split, as ADRs) counts in `institutions` and `reportedValue`, not in `shares` (`coverage` says how many), and a line that cannot be placed is left out and never read as a sale or a purchase (the quarter-over-quarter totals are then null). Values are as the managers reported them, except a position read as reported in thousands of dollars (inferred: its price about 1,000 times below other managers\' for the same stock, from a manager whose positions mostly price that way) is read in dollars. '
  + 'The same shares can be reported by more than one manager (shared investment discretion), so `shares`, `reportedValue` and `pctOfMarketCap` can count some twice. Calls and puts are counted apart from shares. '
  + 'Position changes (`positionChanges`, a holder\'s `priorShares`) count only managers whose reports for both quarters are comparable (each filed, and, unless both list fewer than ten, neither lists under a fifth as many share positions as the other, whatever the securities), with the earlier shares adjusted for splits and rounded to whole shares (at least one share for a holding, so a reverse split never rounds one away). '
  + 'A quarter in which no manager held the symbol, after some did the quarter before, reads zero institutions with its closed positions.';

const NO_RECORD = 'No institutional (13F) holdings on record for this symbol.';

/** "ETFs holding {T}" (phase C): the proxy's /etf-holders rows - security matches in files classified as the fund's
 * own holdings, as reported. */
export const ETF_HOLDERS_BASIS = "long security matches in files classified as the fund's own holdings (line count at most twice the fund's reported count plus 10, or at most 1,000 for a reported count of exactly 10, which the data source gives many funds as a cap; read with the file or inherited from its last classified file within 20% and 60 days), read within 21 days";
export const ETF_HOLDERS_EXCLUDED = 'unconfirmed lines, count-mismatch or unknown files, and a fund with any line for the security that is not long (a negative weight, share count or value, or none above zero)';
export const ETF_HOLDERS_NONE = "No qualifying ETF holder on record: a fund qualifies when its latest own-holdings file, read within 21 days, confirms a position in this security and every confirmed line for it is long.";
const ETF_HOLDERS_NULLS = "shares or marketValue is null when one of the fund's lines for the security gives none (never a partial sum).";

export function shapeEtfHolders(payload: any, limit: number): Record<string, unknown> {
  const rows = (Array.isArray(payload?.holders) ? payload.holders : []).slice(0, limit).map((h: any) => {
    const row: Record<string, unknown> = { fund: h.fund, fundName: h.fundName ?? null, weightPct: h.weightPct ?? null, shares: h.shares ?? null, marketValue: h.marketValue ?? null, holdingsUpdated: h.holdingsUpdated ?? null, basisInherited: h.basisInherited === true, basisCountReadOn: h.basisCountReadOn ?? null };
    if (Array.isArray(h.splitWarnings) && h.splitWarnings.length > 0) row.splitWarnings = h.splitWarnings.map((w: any) => ({ date: w.date, ratio: w.ratio }));
    return row;
  });
  return {
    etfHolders: rows,
    etfHoldersMeta: {
      limit, returned: rows.length, fundsOnFile: Number(payload?.fundsOnFile ?? rows.length), order: 'by value', basis: ETF_HOLDERS_BASIS,
      excluded: ETF_HOLDERS_EXCLUDED, quantitiesNote: [payload?.asReported, ETF_HOLDERS_NULLS].filter(Boolean).join(' '),
    },
  };
}

const fits = (payload: unknown) => utf8ByteLength(JSON.stringify(sanitizeMcpWireOutput(payload))) <= MAX_RESPONSE_BYTES - RESPONSE_MARGIN_BYTES;

/** `base` (the 13F answer) with the ETF holders part, its rows trimmed to the byte budget BY THIS SHAPER - the meta
 * says how many it kept and why - so the response guard never cuts them behind a meta that counts more. */
export function fitEtfHolders(base: Record<string, unknown>, part: Record<string, unknown>): Record<string, unknown> {
  const all = Array.isArray(part.etfHolders) ? part.etfHolders as Record<string, unknown>[] : null;
  if (!all || all.length === 0) return { ...base, ...part };
  const meta = part.etfHoldersMeta as Record<string, unknown>;
  const shape = (rows: Record<string, unknown>[]) => ({
    ...base, ...part, etfHolders: rows,
    etfHoldersMeta: { ...meta, returned: rows.length, ...(rows.length < all.length ? { budgetNote: 'Fewer rows than asked, to fit the response; ask with a smaller etfHolders, holders or quarters.' } : {}) },
  });
  let rows = all;
  let payload = shape(rows);
  while (rows.length > 0 && !fits(payload)) { rows = rows.slice(0, rows.length > 20 ? rows.length - Math.ceil(rows.length / 10) : rows.length - 1); payload = shape(rows); }
  return payload;
}

export const INSTITUTIONAL_READ_FAILED = 'Institutional (13F) holdings could not be read right now.';

export function noInstitutionalRecord(symbol: string): Record<string, unknown> {
  return { symbol, institutionalStatus: NO_RECORD };
}

function coverageOf(q: Quarter): { institutionsWithSharesOnAnotherBasis: number; managersUnplaced: number } {
  return { institutionsWithSharesOnAnotherBasis: num(q.holders_other_basis) ?? 0, managersUnplaced: num(q.managers_unplaced) ?? 0 };
}

function holderChange(shares: number, prior: number | null, status: unknown): string {
  if (prior === null) return status === 'quantity_unknown' ? 'change not known' : 'no comparable report';
  if (prior === 0) return 'new';
  if (shares === prior) return 'unchanged';
  const diff = shares - prior;
  return `${diff > 0 ? '+' : ''}${diff} (${((diff / prior) * 100).toFixed(1)}%)`;
}

export function shapeInstitutionalOwnership(payload: unknown, opts: { quarters?: number; holders?: number } = {}): Record<string, unknown> {
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  const quarters = (Array.isArray(data?.quarters) ? data!.quarters as Quarter[] : [])
    .filter(q => typeof q?.period === 'string' && num(q.holders) !== null && num(q.shares) !== null && num(q.value) !== null);
  const symbol = typeof data?.symbol === 'string' ? data.symbol : null;
  if (!data || quarters.length === 0) return { symbol, institutionalStatus: NO_RECORD };
  const q = quarters[0];
  const period = q.period as string;
  const priorHolders = num(q.prev_holders);
  const priorShares = num(q.prev_shares);
  const periods = Array.isArray(data.periods) ? data.periods as Array<Record<string, unknown>> : [];
  const meta = periods.find(p => p.period === period);
  const holdersBlock = data.holders && typeof data.holders === 'object' ? data.holders as { period?: unknown; rows?: unknown } : null;
  const rows = (Array.isArray(holdersBlock?.rows) ? holdersBlock!.rows as Holder[] : [])
    .filter(h => num(h.shares) !== null && num(h.value) !== null)
    .slice(0, opts.holders ?? 10);
  const historyCount = Math.max(1, Math.min(opts.quarters ?? 8, 8));
  const latest = typeof periods[0]?.period === 'string' ? periods[0].period as string : null;
  const shared = Array.isArray(q.market_cap_shared_with) ? (q.market_cap_shared_with as unknown[]).filter((x): x is string => typeof x === 'string') : [];

  return {
    symbol,
    quarter: quarterLabel(period),
    asOf: period,
    // A newer quarter on file that holds none of it is said, never passed over.
    ...(latest && latest > period ? { newerQuarterNote: `No 13F holdings of this symbol were found for ${quarterLabel(latest)}, the newest quarter on file; the figures are for ${quarterLabel(period)}.` } : {}),
    institutions: q.holders,
    shares: q.shares,
    reportedValue: q.value,
    pctOfMarketCap: num(q.pct_of_market_cap),
    marketCapDate: typeof q.market_cap_date === 'string' ? q.market_cap_date : null,
    // A market cap on file that another security of the company carries too is likely the company's whole market cap.
    ...(shared.length > 0 && num(q.pct_of_market_cap) !== null ? {
      marketCapSharedWith: shared,
      marketCapNote: `The market cap on file for ${symbol ?? 'this security'} is about the same figure as for ${shared.join(' and ')}, ${shared.length === 1 ? 'another security' : 'other securities'} of the same company (the same issuer number and name on file): pctOfMarketCap is likely over the company's whole market cap.`,
    } : {}),
    changeFromPriorQuarter: priorHolders === null ? null : {
      institutions: (q.holders as number) - priorHolders,
      shares: priorShares === null ? null : (q.shares as number) - priorShares,
      priorInstitutions: priorHolders,
      priorShares,
    },
    positionChanges: num(q.new_holders) === null ? null : {
      new: q.new_holders, closed: num(q.closed_holders), increased: num(q.increased_holders), decreased: num(q.decreased_holders),
    },
    // How complete the figures are: holders with shares on another basis, managers whose lines could not be placed.
    coverage: coverageOf(q),
    calls: { institutions: num(q.call_holders), shares: num(q.call_shares) },
    puts: { institutions: num(q.put_holders), shares: num(q.put_shares) },
    filedThrough: typeof q.filed_through === 'string' ? q.filed_through : null,
    topHolders: holdersBlock && holdersBlock.period === period
      ? rows.map(h => {
        const prior = num(h.prev_shares);
        return {
          rank: h.rank,
          manager: typeof h.manager_name === 'string' && h.manager_name ? h.manager_name : null,
          managerCik: h.manager_cik,
          shares: h.shares,
          reportedValue: h.value,
          priorShares: prior,
          change: holderChange(h.shares as number, prior, h.prev_status),
          ...(h.other_basis === true ? { someSharesOnAnotherBasis: true } : {}),
        };
      })
      : [],
    history: quarters.slice(0, historyCount).map(r => ({
      quarter: quarterLabel(r.period as string),
      asOf: r.period,
      institutions: r.holders,
      shares: r.shares,
      reportedValue: r.value,
      pctOfMarketCap: num(r.pct_of_market_cap),
      coverage: coverageOf(r),
    })),
    institutionalMeta: {
      source: 'SEC Form 13F data sets',
      quartersOnFile: quarters.length,
      publishedAt: typeof meta?.publishedAt === 'string' ? meta.publishedAt : null,
      dataSets: Array.isArray(meta?.windows) ? meta!.windows : [],
      filers: num(meta?.filers),
    },
    institutionalNote: INSTITUTIONAL_NOTE,
  };
}
