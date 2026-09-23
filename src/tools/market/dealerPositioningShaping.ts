/**
 * Shape LIVE dealer positioning, computed from the caller's own broker chain.
 *
 * LIVE ONLY, deliberately. An end-of-day positioning exists too (the stored
 * snapshot's net GEX and dealer regime), but a live gamma flip and an end-of-day
 * one are different claims, and folding the second into this tool as a
 * fallback would let a caller quote one as the other. Whatever tool carries
 * the end-of-day number carries its own name and its own caveats.
 *
 * So this shapes one source: the live computation over the caller's broker
 * chain, which works for any symbol their broker lists.
 *
 * The raw payload is far past the response ceiling - byStrike over four
 * expirations is thousands of rows - so per-strike rows are trimmed to a window
 * around spot. Totals come from the full input window; per-metric coverage
 * identifies any missing contributions rather than calling partial sums a
 * measurement of the whole book.
 */

export interface DealerPositioningOptions {
  /** Total per-strike rows kept nearest spot. */
  strikeRange?: number;
}

const DEFAULT_STRIKE_RANGE = 10;

const num = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null =>
  (typeof v === 'string' && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

type CoverageStatus = 'complete' | 'partial' | 'unmeasured' | 'empty' | 'unknown';
type FieldStatus = CoverageStatus | 'unavailable';
interface MetricCoverage {
  total: number | null;
  included: number | null;
  status: CoverageStatus;
}

function metricCoverage(value: unknown): MetricCoverage {
  const raw = record(value);
  const total = count(raw.total);
  const included = count(raw.included);
  if (total === null || included === null || included > total) {
    return { total: null, included: null, status: 'unknown' };
  }
  const status = total === 0 ? 'empty'
    : included === 0 ? 'unmeasured'
      : included === total ? 'complete' : 'partial';
  return { total, included, status };
}

function measuredValue(raw: unknown, coverage: MetricCoverage): { value: number | null; status: FieldStatus } {
  const value = num(raw);
  if (coverage.status === 'unknown' || coverage.status === 'unmeasured') {
    return { value: null, status: coverage.status };
  }
  // No active legs can support a nonzero sum, even when the response claims it.
  if (coverage.status === 'empty' && value !== null && value !== 0) {
    return { value: null, status: 'unknown' };
  }
  return { value, status: value === null ? 'unavailable' : coverage.status };
}

function measuredLevel(raw: unknown, status: FieldStatus): { value: number | null; status: FieldStatus } {
  if (status !== 'complete') return { value: null, status };
  // A reported null means no level was found; absence or an invalid value does not.
  if (raw === null) return { value: null, status };
  const value = num(raw);
  return { value, status: value === null ? 'unavailable' : status };
}

/** The `limit` rows nearest `centre`, returned in ascending strike order. */
function nearestStrikes<T extends { strike: number | null }>(
  rows: T[], centre: number | null, limit: number,
): T[] {
  const withStrike = rows.filter((row) => row.strike !== null);
  if (centre === null) return withStrike.slice(0, limit);
  return [...withStrike]
    .sort((a, b) => Math.abs((a.strike as number) - centre) - Math.abs((b.strike as number) - centre))
    .slice(0, limit)
    .sort((a, b) => (a.strike as number) - (b.strike as number));
}

/**
 * Positive net gamma means dealers dampen moves, negative means they amplify.
 *
 * Derived only when the computation did not state one. A regime is a claim
 * about how the market will behave, so it is never invented from a missing
 * number - no net gamma means no regime, not "neutral".
 */
function readRegime(explicit: unknown, netGex: number | null): string | null {
  if (explicit === 'positive' || explicit === 'negative' || explicit === 'neutral') return explicit;
  if (netGex === null) return null;
  if (netGex > 0) return 'positive';
  if (netGex < 0) return 'negative';
  return 'neutral';
}

export function summarizeDealerPositioning(
  response: Record<string, unknown>,
  options: DealerPositioningOptions = {},
) {
  const limit = Math.min(40, Math.max(1, Math.trunc(num(options.strikeRange) ?? DEFAULT_STRIKE_RANGE)));
  const body = response ?? {};
  const snapshot = record(body.snapshot);

  const spotPrice = num(snapshot.spotPrice);

  const rawCoverage = record(body.coverage);
  const reportedResolution = num(rawCoverage.gammaFlipResolution);
  const searchStatus = rawCoverage.gammaFlipSearchStatus;
  const coverage = {
    unit: 'total/included count option legs the broker quoted that are not known to have zero open interest; a leg whose open interest was omitted or corrupt is counted and excluded, because it exists and cannot be sized',
    strikes: count(rawCoverage.strikes),
    strikesWithGamma: count(rawCoverage.strikesWithGamma),
    strikesWithDelta: count(rawCoverage.strikesWithDelta),
    gamma: metricCoverage(rawCoverage.gamma),
    delta: metricCoverage(rawCoverage.delta),
    vega: metricCoverage(rawCoverage.vega),
    vanna: metricCoverage(rawCoverage.vanna),
    charm: metricCoverage(rawCoverage.charm),
    vomma: metricCoverage(rawCoverage.vomma),
    gammaFlip: metricCoverage(rawCoverage.gammaFlip),
    // How the flip was produced (packages/shared exposure-compute
    // GammaFlipMethod): `repriced` = every leg recomputed from IV;
    // `frozen-gamma` = no leg had a usable IV, every published gamma held
    // constant across the sweep; `mixed` = some of each. A held gamma is an
    // approximation that can turn "no flip" into a level. A reader quoting a
    // regime-change price is entitled to know which they got.
    gammaFlipMethod: typeof rawCoverage.gammaFlipMethod === 'string'
      ? rawCoverage.gammaFlipMethod : null,
    // The price step the flip search sampled at where it found the level. The
    // flip is a SAMPLED root: two crossings within one interval can be missed, so
    // the level is the nearest crossing detectable at this resolution, not a
    // proof that nothing sits between it and spot. Left only in a comment on
    // the computation, no reader quoting the number could ever know that.
    gammaFlipResolution: reportedResolution !== null && reportedResolution > 0
      ? reportedResolution : null,
    // This describes the search on supported legs, separately from whether
    // coverage permits quoting a whole-book level. Never infer it for legacy
    // responses: a null level alone cannot distinguish failure from no crossing.
    gammaFlipSearchStatus: searchStatus === 'found' || searchStatus === 'not-found' || searchStatus === 'unresolved'
      ? searchStatus : null,
  };
  const fields = {
    netGex: measuredValue(snapshot.netGamma, coverage.gamma),
    netDex: measuredValue(snapshot.netDelta, coverage.delta),
    netVega: measuredValue(snapshot.netVega, coverage.vega),
    netVanna: measuredValue(snapshot.netVanna, coverage.vanna),
    netCharm: measuredValue(snapshot.netCharm, coverage.charm),
    netVomma: measuredValue(snapshot.netVomma, coverage.vomma),
  };
  const exposure = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])) as Record<keyof typeof fields, number | null>;
  const exposureStatus = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.status])) as Record<keyof typeof fields, FieldStatus>;

  // Repriced gamma needs its own coverage: published IV can support a flip
  // even when the broker publishes no gamma. Partial books cannot establish
  // a whole-book level, so their sums remain visible but their levels do not.
  const levelFields = {
    gammaFlip: measuredLevel(snapshot.gammaFlip, coverage.gammaFlip.status),
    callWall: measuredLevel(snapshot.callWall, fields.netGex.status),
    putWall: measuredLevel(snapshot.putWall, fields.netGex.status),
    gammaMagnet: measuredLevel(snapshot.absGamma, fields.netGex.status),
    gammaConcentration: measuredLevel(snapshot.gammaConcentration, fields.netGex.status),
  };
  // Resolution belongs to the reported level. Incomplete coverage, a missing
  // value or no detected crossing leaves no level whose step can be quoted.
  if (levelFields.gammaFlip.value === null) coverage.gammaFlipResolution = null;
  const dealerRegime = fields.netGex.status === 'complete'
    ? readRegime(snapshot.regime, fields.netGex.value) : null;

  // Shape coverage only for the displayed window, rather than expanding every
  // strike in a multi-expiration book before discarding most of them.
  const rows = arr(body.byStrike).map((value) => {
    const row = record(value);
    return { strike: num(row.strike), row };
  }).filter((row) => row.strike !== null);
  const nearSpot = nearestStrikes(rows, spotPrice, limit).map(({ strike, row }) => {
    const raw = record(row.coverage);
    const coverage = { gamma: metricCoverage(raw.gamma), delta: metricCoverage(raw.delta), vega: metricCoverage(raw.vega) };
    const gamma = measuredValue(row.netGamma, coverage.gamma);
    // The walls are chosen per side (largest positive call gamma, most
    // negative put gamma) and a row carrying net gamma alone could not be
    // checked against them. The route's gamma coverage counts both sides
    // together, so under partial coverage a side can be an unmeasured zero
    // (no call gammas, usable put gammas: callGex 0 beside a real putGex);
    // the sides go out only when the coverage establishes them, complete
    // or empty, and the partial net is published on its own.
    const sideValue = (raw: unknown): number | null =>
      (coverage.gamma.status === 'complete' || coverage.gamma.status === 'empty')
        ? measuredValue(raw, coverage.gamma).value
        : null;
    const callGamma = { value: sideValue(row.callGamma) };
    const putGamma = { value: sideValue(row.putGamma) };
    const delta = measuredValue(row.netDelta, coverage.delta);
    const vega = measuredValue(row.netVega, coverage.vega);
    return {
      strike, netGex: gamma.value, callGex: callGamma.value, putGex: putGamma.value, netDex: delta.value, netVega: vega.value,
      status: { netGex: gamma.status, netDex: delta.status, netVega: vega.status },
      coverage,
    };
  });
  const limitations = [
    'Totals cover the selected expirations, not every listed expiration. Metric coverage counts active option legs; per-strike coverage combines those expirations.',
    'Partial sums include only supported contributions and are not whole-book measurements. Levels are withheld when their required coverage is incomplete.',
    'Unknown or unmeasured values are null. Empty means no active legs; it supports a reported zero sum but no inferred level or regime.',
    'The gamma-flip search samples prices within 20% of spot. A pair of crossings within one sampling interval can be missed, so no detected flip does not prove that no crossing exists within or beyond that range.',
  ];
  if (coverage.gammaFlipSearchStatus === 'unresolved') {
    limitations.push('The gamma-flip search is unresolved: numerical signs or crossing order could not be established reliably, so the null level gives no conclusion about whether a crossing exists.');
  }
  if (levelFields.gammaFlip.value !== null) {
    limitations.push(
      coverage.gammaFlipResolution === null
        ? 'The gamma flip is a sampled root and the sampling step was not reported, so how finely it was searched is unknown.'
        : `The gamma flip is a sampled root found at a step of ${coverage.gammaFlipResolution} in price: this is the local sampling bracket width, not a confidence interval or an error bound on the level. It is the nearest crossing detected by the search.`,
    );
  }
  if (Object.values(fields).some((field) => field.status === 'unavailable')) {
    limitations.push('Some reported totals are missing or invalid despite available input coverage.');
  }

  return {
    symbol: str(body.symbol),
    // Never omitted and never inferred from the absence of an error: a reader
    // relaying a gamma flip has to be able to say how old it is.
    dataSource: 'live' as const,
    asOf: str(body.asOf),
    provider: str(body.provider),
    spotPrice,

    levels: {
      gammaFlip: levelFields.gammaFlip.value,
      callWall: levelFields.callWall.value,
      putWall: levelFields.putWall.value,
      gammaMagnet: levelFields.gammaMagnet.value,
      dealerRegime,
      gammaConcentration: levelFields.gammaConcentration.value,
    },
    levelStatus: {
      gammaFlip: levelFields.gammaFlip.status,
      callWall: levelFields.callWall.status,
      putWall: levelFields.putWall.status,
      gammaMagnet: levelFields.gammaMagnet.status,
      dealerRegime: fields.netGex.status,
      gammaConcentration: levelFields.gammaConcentration.status,
    },
    exposure,
    exposureStatus,
    coverage,
    limitations,

    // What the numbers were computed OVER. Exposure across four expirations is
    // not exposure across one, and a reader comparing two answers needs to know
    // they cover the same book.
    window: {
      expirations: arr(body.expirations).map(str).filter((exp) => exp !== null),
      expirationsAvailable: num(body.expirationsAvailable),
      strikesUsed: num(body.strikesUsed),
    },

    strikes: {
      returned: nearSpot.length,
      total: rows.length,
      nearSpot,
    },

    // Which rate and dividend yield the gamma flip was repriced with. The flip
    // is a repricing across spot levels, so it is only as good as these.
    resolved: body.resolved ?? null,
  };
}
