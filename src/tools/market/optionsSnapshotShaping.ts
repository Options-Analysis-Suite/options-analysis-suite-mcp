/**
 * Shape the EOD options snapshot, and the multi-symbol metrics comparison.
 *
 * The single-symbol response carries twenty-four scalars and NINE opaque curve
 * payloads - per-strike GEX, DEX, vanna, charm, vomma, the max-pain curve, a
 * skew curve, a probability blob and a chain extract. For a liquid name that is
 * far past the response ceiling, and the size guard's fallback would truncate
 * to whichever fields came first rather than to the ones anyone asked for.
 *
 * So the scalars are always returned, and the curves are opt-in and summarized
 * to the fact each one exists to establish.
 *
 * TWO THINGS THAT MUST NOT BE SILENT:
 *
 * 1. Curves come from a different table and are returned as null when their
 *    date does not match the snapshot's. That is "we have no curve for this
 *    session", not "this symbol has no curve", and the difference decides
 *    whether a caller should retry tomorrow or stop asking.
 * 2. The batch endpoint OMITS symbols it has no snapshot for. A caller that
 *    asked for ten and reads seven has been handed a complete-looking answer
 *    about a different set of symbols than the one it asked about.
 */

export interface SnapshotResponse { [key: string]: unknown }
export interface MetricsBatchResponse { count?: unknown; data?: unknown }

export interface ShapeSnapshotOptions {
  /** Which curve payloads to summarize. */
  curves?: ReadonlyArray<'maxPain' | 'gex' | 'dex' | 'skew'>;
  /** Per-curve row cap. */
  curveLimit?: number;
}

const DEFAULT_CURVE_LIMIT = 12;

const num = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null =>
  (typeof v === 'string' && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Scalars copied under the proxy's own names. `expectedMovePct` is NOT here:
 * option_ticker_snapshots.expected_move_pct is iv * sqrt(30 / 365), a decimal
 * FRACTION of spot over 30 calendar days despite the column name, and 0.018
 * under a key ending in "Pct" reads as 0.018%. It is published under the name
 * of its unit, with the unit stated again in `units`, by every shaper here.
 *
 * `dividendYield` is NOT here either. The producer has never written it: on
 * 2026-09-18 the column was 0 on all but 24 of 21.3 million rows, and every
 * row of the latest session. Published, AAPL read as "pays no dividend", a
 * zero nobody computed. The live positioning tool resolves q from the company
 * profile and says so under `resolved`; this one says nothing until the
 * stored value is real.
 */
const SCALARS = [
  'spotPrice', 'maxPain', 'netGex', 'netDex',
  'atmIv', 'atmIv7d', 'atmIv30d', 'atmIv90d',
  'putCallRatio', 'ivSkew25d',
  'totalVolume', 'totalOi', 'callVolume', 'putVolume', 'callOi', 'putOi',
  'ivRank', 'ivPercentile', 'hv20d', 'hv60d',
] as const;

export const EXPECTED_MOVE_30D_FRACTION_UNIT =
  'decimal fraction of spot over the next 30 calendar days (0.018 = 1.8%)';

/** The `range` rows nearest `centre`, back in ascending strike order. */
function nearestStrikes<T extends { strike: number | null }>(rows: T[], centre: number | null, limit: number): T[] {
  const withStrike = rows.filter((r) => r.strike !== null);
  if (centre === null) return withStrike.slice(0, limit);
  return [...withStrike]
    .sort((a, b) => Math.abs((a.strike as number) - centre) - Math.abs((b.strike as number) - centre))
    .slice(0, limit)
    .sort((a, b) => (a.strike as number) - (b.strike as number));
}

function summarizeMaxPainCurve(raw: unknown, spot: number | null, limit: number) {
  const rows = arr(raw).map((row: any) => ({
    strike: num(row?.strike),
    callPain: num(row?.callPain),
    putPain: num(row?.putPain),
    totalPain: num(row?.totalPain),
  })).filter((r) => r.strike !== null);
  if (rows.length === 0) return null;

  // The curve's MINIMUM is what max pain means. Reporting only the strikes near
  // spot would leave a caller computing it from a window that may not contain
  // it, so it is derived from every row and reported explicitly.
  let minimum: { strike: number | null; totalPain: number | null } | null = null;
  for (const row of rows) {
    if (row.totalPain === null) continue;
    if (minimum === null || minimum.totalPain === null || row.totalPain < minimum.totalPain) {
      minimum = { strike: row.strike, totalPain: row.totalPain };
    }
  }
  return {
    strikes: rows.length,
    minimumTotalPain: minimum,
    nearSpot: nearestStrikes(rows, spot, limit),
  };
}

/**
 * The stored row is `{ strike, callGex, putGex, netGex }` (and the dex twin),
 * written at proxy/services/SnapshotComputeService.ts:434.
 *
 * An earlier version read `row.gex`, a key that exists only in the OpenAPI
 * EXAMPLE. It produced a null at every strike and a total of zero, which is
 * indistinguishable from a symbol with no dealer exposure at all - a fabricated
 * flat book, reported with total confidence. The key travels under its own name
 * here so the output cannot drift from the writer without the name drifting too.
 */
function summarizeExposureCurve(raw: unknown, key: 'netGex' | 'netDex', spot: number | null, limit: number) {
  const rows = arr(raw)
    .map((row: any) => ({ strike: num(row?.strike), [key]: num(row?.[key]) } as { strike: number | null } & Record<string, number | null>))
    .filter((r) => r.strike !== null);
  if (rows.length === 0) return null;

  let total = 0;
  let measured = 0;
  let largest: ({ strike: number | null } & Record<string, number | null>) | null = null;
  for (const row of rows) {
    const value = row[key];
    if (value === null) continue;
    measured += 1;
    total += value;
    const best = largest?.[key];
    if (largest === null || best === null || best === undefined || Math.abs(value) > Math.abs(best)) {
      largest = { strike: row.strike, [key]: value };
    }
  }
  // A curve of strikes that carry no exposure value is not a zero book, so the
  // total is withheld rather than reported as 0.
  return {
    strikes: rows.length,
    strikesWithValue: measured,
    total: measured > 0 ? total : null,
    largestAbsolute: largest,
    nearSpot: nearestStrikes(rows, spot, limit),
  };
}

const MAX_SKEW_EXPIRATIONS = 6;

/**
 * Sample down to `limit` points, keeping BOTH ends.
 *
 * Taking every nth point drops the tail whenever the length is not a multiple
 * of the step: 24 points at a limit of 12 kept indices 0 to 22 and lost the
 * highest strike. On a skew curve the ends are the wings, so a curve whose
 * final point is an IV spike came back looking flat - the one feature a reader
 * is most likely to be asking about.
 */
function thinPreservingEnds<T>(points: T[], limit: number): T[] {
  if (points.length <= limit) return points;
  if (limit === 1) return [points[0]];
  const stride = (points.length - 1) / (limit - 1);
  const out: T[] = [];
  for (let i = 0; i < limit; i += 1) out.push(points[Math.round(i * stride)]);
  return out;
}

/**
 * The stored curve is keyed BY EXPIRATION: `{ [expiry]: [{ strike, iv }] }`,
 * built at proxy/services/SnapshotComputeService.ts:1023.
 *
 * An earlier version expected parallel `strikes[]` and `iv[]` arrays, so every
 * real curve read as null. Expiration is not decoration here: an IV means
 * nothing without the expiry it was measured at, and flattening the map would
 * put a 7-day and a 90-day point on the same curve.
 */
function summarizeSkew(raw: unknown, limit: number) {
  const curve = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!curve) return null;

  const expirations = Object.keys(curve).sort()
    .map((expiration) => {
      const points = arr(curve[expiration])
        .map((point: any) => ({ strike: num(point?.strike), iv: num(point?.iv) }))
        .filter((point) => point.strike !== null);
      return { expiration, points };
    })
    .filter((entry) => entry.points.length > 0);
  if (expirations.length === 0) return null;

  const kept = expirations.slice(0, MAX_SKEW_EXPIRATIONS).map((entry) => ({
    expiration: entry.expiration,
    strikes: entry.points.length,
    points: thinPreservingEnds(entry.points, limit),
  }));

  return {
    expirationsAvailable: expirations.length,
    expirations: kept,
  };
}

/**
 * The keys the options snapshot always carries, whatever their values. When
 * a symbol has NO options snapshot the proxy falls back to a different table
 * and answers a PRICE-ONLY row - spot, open, high, low, volume - and none of
 * these keys at all. Reading that row as a snapshot would report every metric
 * as null, which is indistinguishable from "this symbol has no IV rank".
 *
 * THE BOUNDARY IS THE ROW'S SHAPE, NOT THE ASSET CLASS. Futures contracts with
 * listed options get full snapshots (SnapshotComputeService writes them, and a
 * computed /ESZ26 row shapes like any equity's); the fallback is what any
 * symbol without a snapshot gets. Tested by key PRESENCE rather than by any
 * `source` label, because the provenance spread on the proxy rewrites
 * `source` after the fallback sets it. A row with a spot and none of these is
 * that fallback; an empty or malformed body is not, and keeps the
 * null-metrics shape below.
 */
const OPTIONS_SHAPE_KEYS = ['maxPain', 'netGex', 'atmIv', 'putCallRatio'] as const;

export function isPriceOnlyRow(snapshot: SnapshotResponse): boolean {
  return 'spotPrice' in snapshot && !OPTIONS_SHAPE_KEYS.some((key) => key in snapshot);
}

/**
 * What the single-symbol tool returns: the summary, or - for a price-only row -
 * a refusal that says so. Kept apart from summarizeOptionsSnapshot so the
 * summarizer's shape stays one shape; this is a decision at the tool boundary.
 */
export function shapeOptionsSnapshot(response: SnapshotResponse, options: ShapeSnapshotOptions = {}) {
  const snapshot = response ?? {};
  if (isPriceOnlyRow(snapshot)) {
    const symbol = str(snapshot.ticker);
    return {
      symbol,
      date: str(snapshot.date),
      dataSource: 'eod' as const,
      dataAvailable: false as const,
      message: `No options snapshot for ${symbol ?? 'this symbol'}: the platform holds a price row only for it `
        + '(spot, open, high, low, volume), so there are no options metrics to report.',
    };
  }
  return summarizeOptionsSnapshot(snapshot, options);
}

export function summarizeOptionsSnapshot(response: SnapshotResponse, options: ShapeSnapshotOptions = {}) {
  const limit = Math.max(1, Math.trunc(options.curveLimit ?? DEFAULT_CURVE_LIMIT));
  const requested = options.curves ?? [];
  const snapshot = response ?? {};
  const spot = num(snapshot.spotPrice);

  const metrics: Record<string, number | null> = {};
  for (const key of SCALARS) metrics[key] = num(snapshot[key]);
  metrics.expectedMove30dFraction = num(snapshot.expectedMovePct);

  // Every curve field null while the scalars are present means the curve table
  // has not caught up to this session, which is a different fact from "absent".
  const curveKeys = ['maxPainCurve', 'gexByStrike', 'dexByStrike', 'volSkew'] as const;
  const curvesPresent = curveKeys.some((key) => snapshot[key] !== null && snapshot[key] !== undefined);

  const curves: Record<string, unknown> = {};
  if (requested.includes('maxPain')) curves.maxPain = summarizeMaxPainCurve(snapshot.maxPainCurve, spot, limit);
  if (requested.includes('gex')) curves.gex = summarizeExposureCurve(snapshot.gexByStrike, 'netGex', spot, limit);
  if (requested.includes('dex')) curves.dex = summarizeExposureCurve(snapshot.dexByStrike, 'netDex', spot, limit);
  if (requested.includes('skew')) curves.skew = summarizeSkew(snapshot.volSkew, limit);

  return {
    symbol: str(snapshot.ticker),
    date: str(snapshot.date),
    dataSource: 'eod' as const,
    metrics,
    units: { expectedMove30dFraction: EXPECTED_MOVE_30D_FRACTION_UNIT },
    curvesRequested: [...requested],
    curvesAvailableForThisSession: curvesPresent,
    ...(requested.length > 0 ? { curves } : {}),
    analyticsExpiry: str(snapshot.analyticsExpiry),
    chainExpiry: str(snapshot.chainExpiry),
  };
}

export function summarizeMetricsBatch(response: MetricsBatchResponse, requestedSymbols: string[]) {
  const rows = arr(response?.data).map((row: any) => ({
    symbol: str(row?.symbol),
    date: str(row?.date),
    atmIv: num(row?.atmIv),
    ivRank: num(row?.ivRank),
    ivPercentile: num(row?.ivPercentile),
    hv20d: num(row?.hv20d),
    hv60d: num(row?.hv60d),
    putCallRatio: num(row?.putCallRatio),
    totalVolume: num(row?.totalVolume),
    totalOi: num(row?.totalOi),
    maxPain: num(row?.maxPain),
    expectedMove30dFraction: num(row?.expectedMovePct),
  }));

  // The endpoint omits a symbol it has no snapshot for, so the difference has
  // to be reported: seven rows for a ten-symbol request is a complete-looking
  // answer about a set the caller did not ask about.
  const returned = new Set(rows.map((r) => r.symbol).filter((s): s is string => s !== null));
  const missing = requestedSymbols.filter((symbol) => !returned.has(symbol));

  // In the order asked for, not the endpoint's alphabetical one: a comparison
  // table built row by row against the request came out misaligned. A row
  // for a symbol nobody asked for is kept, last.
  const position = new Map(requestedSymbols.map((symbol, index) => [symbol, index] as const));
  const rank = (symbol: string | null) => (symbol !== null ? position.get(symbol) : undefined) ?? Number.MAX_SAFE_INTEGER;
  rows.sort((a, b) => rank(a.symbol) - rank(b.symbol));

  return {
    dataSource: 'eod' as const,
    requested: requestedSymbols.length,
    returned: rows.length,
    missingSymbols: missing,
    metrics: rows,
    units: { expectedMove30dFraction: EXPECTED_MOVE_30D_FRACTION_UNIT },
  };
}
