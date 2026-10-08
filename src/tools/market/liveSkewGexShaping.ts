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
import { isoDate, measuredValue, metricCoverage, type FieldStatus } from './dealerPositioningShaping.js';

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

/** Room under the response ceiling for the wire sanitizer's renames and the envelope. */
export const LIVE_SKEW_GEX_MARGIN_BYTES = 2 * 1024;
const MAX_WARNINGS = 3;
const MAX_TEXT = 240;

export const LIVE_SKEW_GEX_UNITS = Object.freeze({
  skew: 'decimal implied volatility: 0.05 is 5 volatility points (skew.value, putIv25d, callIv25d, skew10d, prior and change)',
  gex: 'dollars per 1% move of the underlying: gamma x open interest x 100 x spot^2 x 1%, calls positive, puts negative (gex.value, prior and change)',
  gexChangePercent: 'percent of the size of the prior session\'s net GEX: 12.5 is 12.5%; null when the prior is 0',
  oiShare: 'fraction (0 to 1) of the known open interest whose leg got a gamma',
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
  return {
    value: dollars(measured.value),
    status: measured.status,
    // Counted where some leg went unsized; "complete" means every one was.
    ...(measured.status !== 'complete' ? { legCoverage: { total: legs.total, included: legs.included } } : {}),
    oiShare: model(r.oiShare),
    expirations: dates(r.expirations),
    ...(empty.length > 0 ? { emptyExpirations: empty } : {}),
    ...(unpublished.length > 0 ? { openInterestUnpublishedExpirations: unpublished } : {}),
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
  const warnings = arr(r.warnings).map(text).filter((w): w is string => w !== null);
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
    notes: record(body.notes),
  };

  // The best-ranked rows that fit: the limit first, then the response ceiling.
  const limit = options.limit ?? rows.length;
  const byLimit = rows.slice(limit);
  const budget = MAX_RESPONSE_BYTES - LIVE_SKEW_GEX_MARGIN_BYTES - bytes(shell);
  const kept: Row[] = [];
  const bySize: Row[] = [];
  let used = 0;
  for (const row of rows.slice(0, limit)) {
    const size = bytes(row) + 1;
    if (bySize.length > 0 || used + size > budget) { bySize.push(row); continue; }
    kept.push(row);
    used += size;
  }
  const omitted = byLimit.length + bySize.length > 0
    ? {
      omitted: {
        count: byLimit.length + bySize.length,
        ...(byLimit.length > 0 ? { byLimit: byLimit.map((row) => row.symbol) } : {}),
        ...(bySize.length > 0 ? { bySize: bySize.map((row) => row.symbol) } : {}),
      },
    }
    : {};
  return { ...shell, returned: kept.length, results: kept, ...omitted };
}
