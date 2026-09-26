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

import { MAX_RESPONSE_BYTES } from '../helpers.js';

export interface DealerPositioningOptions {
  /** Total per-strike rows kept nearest spot (the cap, with strikeWindowPct). */
  strikeRange?: number;
  /** Every strike within this percent of spot, nearest first, up to the cap. */
  strikeWindowPct?: number;
}

const DEFAULT_STRIKE_RANGE = 10;
export const MAX_STRIKE_ROWS = 150;
/**
 * Room left under the response ceiling for the wire sanitizer's key
 * renames and the envelope. The rows get whatever the rest of the answer
 * leaves below MAX_RESPONSE_BYTES minus this, and past it are dropped
 * farthest from spot first, and said to be, rather than left to the
 * generic size guard, which trims arrays without saying which rows went.
 */
export const RESPONSE_MARGIN_BYTES = 2 * 1024;

const num = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null =>
  (typeof v === 'string' && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
/** A YYYY-MM-DD string that names a real calendar day (not 2026-02-30). */
const isoDate = (v: unknown): string | null => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const parsed = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v ? v : null;
};
const exDividend = (v: unknown): { date: string; amount: number | null; declared: boolean } | null => {
  const raw = record(v);
  const date = isoDate(raw.date);
  return date === null ? null : { date, amount: num(raw.amount), declared: raw.declared === true };
};
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

/**
 * One side of spot. Net GEX and each open interest carry their coverage the
 * way the window totals do (a partial sum is published and labelled partial);
 * the call and put GEX go out only under complete or empty gamma coverage,
 * for the reason the per-strike sides do.
 */
function spotSide(value: unknown) {
  const raw = record(value);
  const gammaCoverage = metricCoverage(raw.gammaCoverage);
  const callOiCoverage = metricCoverage(raw.callOpenInterestCoverage);
  const putOiCoverage = metricCoverage(raw.putOpenInterestCoverage);
  const gamma = measuredValue(raw.netGamma, gammaCoverage);
  const established = gammaCoverage.status === 'complete' || gammaCoverage.status === 'empty';
  const side = (v: unknown) => (established ? measuredValue(v, gammaCoverage).value : null);
  const callOi = measuredValue(raw.callOpenInterest, callOiCoverage);
  const putOi = measuredValue(raw.putOpenInterest, putOiCoverage);
  return {
    strikes: count(raw.strikes),
    netGex: gamma.value,
    callGex: side(raw.callGamma),
    putGex: side(raw.putGamma),
    callOpenInterest: callOi.value,
    putOpenInterest: putOi.value,
    status: { netGex: gamma.status, callOpenInterest: callOi.status, putOpenInterest: putOi.status },
    coverage: { gamma: gammaCoverage, callOpenInterest: callOiCoverage, putOpenInterest: putOiCoverage },
  };
}

/** A finite number as the decimal it prints as: n x 10^-scale, exactly. */
function decimalOf(x: number): { n: bigint; scale: number } {
  const [mantissa, exponent = '0'] = String(x).toLowerCase().split('e');
  const negative = mantissa.startsWith('-');
  const [whole, fraction = ''] = (negative ? mantissa.slice(1) : mantissa).split('.');
  let n = BigInt(whole + fraction);
  let scale = fraction.length - Number(exponent);
  if (scale < 0) { n *= 10n ** BigInt(-scale); scale = 0; }
  return { n: negative ? -n : n, scale };
}

/**
 * |strike - spot| <= spot x pct / 100, decided on the decimals the numbers
 * print as, exactly. Binary floating point cannot decide it: 6 - 4.8 is
 * 1.2000000000000002, past a 25% edge of 1.2, and the float nearest 4.8 is
 * below 4.8, so even exact binary arithmetic puts strike 6 outside. A
 * tolerance cannot fix it either, because the edge need not sit on the cent
 * grid (100 at 9.99999995% ends at 109.99999995, and 110 is outside).
 */
export function withinPercent(strike: number, spot: number, pct: number): boolean {
  const k = decimalOf(strike);
  const s = decimalOf(spot);
  const p = decimalOf(pct);
  const scale = Math.max(k.scale, s.scale);
  const at = (d: { n: bigint; scale: number }) => d.n * 10n ** BigInt(scale - d.scale);
  let distance = at(k) - at(s);
  if (distance < 0n) distance = -distance;
  // 100 x distance / 10^scale <= s.n x p.n / 10^(s.scale + p.scale)
  return 100n * distance * 10n ** BigInt(s.scale + p.scale) <= s.n * p.n * 10n ** BigInt(scale);
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
  const windowPct = num(options.strikeWindowPct);
  const requestedWindowPct = windowPct !== null && windowPct > 0 && windowPct <= 50 ? windowPct : null;
  const limit = Math.min(MAX_STRIKE_ROWS, Math.max(1, Math.trunc(
    num(options.strikeRange) ?? (requestedWindowPct !== null ? MAX_STRIKE_ROWS : DEFAULT_STRIKE_RANGE),
  )));
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
  // A percent window keeps the strikes within it, nearest first up to the
  // cap; without spot there is no window to take.
  const candidates = requestedWindowPct !== null && spotPrice !== null
    ? rows.filter((row) => withinPercent(row.strike as number, spotPrice, requestedWindowPct))
    : rows;
  const shapeRow = ({ strike, row }: { strike: number | null; row: Record<string, unknown> }) => {
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
      // Summed over the window's expirations; null when the broker did not
      // publish a size for some leg at this strike.
      callOpenInterest: count(row.callOpenInterest), putOpenInterest: count(row.putOpenInterest),
      status: { netGex: gamma.status, netDex: delta.status, netVega: vega.status },
      // Only when some status is not complete: a complete row's counts add
      // nothing its status does not say, and dropping them is what lets the
      // cap reach MAX_STRIKE_ROWS inside the response budget.
      ...(gamma.status === 'complete' && delta.status === 'complete' && vega.status === 'complete'
        ? {} : { coverage }),
    };
  };
  let nearSpot = nearestStrikes(candidates, spotPrice, limit).map(shapeRow);

  // The walls and the magnet are chosen over every strike in the window, so
  // they can sit outside the rows above; their rows go out beside them.
  const levelStrikes = new Map<number, string[]>();
  for (const [level, field] of [['callWall', levelFields.callWall], ['putWall', levelFields.putWall], ['gammaMagnet', levelFields.gammaMagnet]] as const) {
    if (field.value === null) continue;
    levelStrikes.set(field.value, [...(levelStrikes.get(field.value) ?? []), level]);
  }
  const shapeLevels = (kept: ReadonlyArray<{ strike: number | null }>) => {
    const shown = new Set(kept.map((row) => row.strike));
    return rows
      .filter((row) => levelStrikes.has(row.strike as number) && !shown.has(row.strike))
      .map((row) => ({ levels: levelStrikes.get(row.strike as number)!, ...shapeRow(row) }));
  };
  let atLevels = shapeLevels(nearSpot);

  // Each expiration computed alone on the window's own rows (the route's
  // expirationBreakdown). The sides and the gross go out only under complete
  // or empty gamma coverage, for the reason the per-strike sides do; the share
  // only when the route published one (it requires every expiration complete).
  const byExpiration = arr(body.byExpiration).map((value) => {
    const entry = record(value);
    const raw = record(entry.coverage);
    const gammaCoverage = metricCoverage(raw.gamma);
    const deltaCoverage = metricCoverage(raw.delta);
    const gamma = measuredValue(entry.netGamma, gammaCoverage);
    const delta = measuredValue(entry.netDelta, deltaCoverage);
    const established = gammaCoverage.status === 'complete' || gammaCoverage.status === 'empty';
    const side = (v: unknown) => (established ? measuredValue(v, gammaCoverage).value : null);
    const share = num(entry.shareOfGrossGamma);
    const move = record(entry.expectedMove);
    const straddle = num(move.straddle);
    // Null when the route's calendar read failed (or it sent none); the
    // three fields are then unknown, not "no event".
    const rawEvents = entry.events !== null && typeof entry.events === 'object' ? record(entry.events) : null;
    return {
      expiration: str(entry.expiration),
      daysToExpiration: Number.isSafeInteger(entry.daysToExpiration) ? entry.daysToExpiration as number : null,
      netGex: gamma.value,
      netDex: delta.value,
      callGex: side(entry.callGamma),
      putGex: side(entry.putGamma),
      grossGex: side(entry.grossGamma),
      shareOfGrossGex: share !== null && share >= 0 && share <= 1 ? share : null,
      status: { netGex: gamma.status, netDex: delta.status },
      expectedMove: straddle === null ? null : {
        strike: num(move.strike),
        callMid: num(move.callMid),
        putMid: num(move.putMid),
        straddle,
        pctOfSpot: num(move.pctOfSpot),
        lower: num(move.lower),
        upper: num(move.upper),
        atmIv: num(move.atmIv),
        ivOneSigma: num(move.ivOneSigma),
      },
      expectedMoveUnavailable: str(entry.expectedMoveUnavailable),
      events: rawEvents === null ? null : {
        earningsOnOrBefore: isoDate(rawEvents.earningsOnOrBefore),
        exDividendOnOrBefore: exDividend(rawEvents.exDividendOnOrBefore),
      },
    };
  }).filter((entry) => entry.expiration !== null);

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

  const shaped = {
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
      // "requested": the caller named the one expiration. "nearest": the first
      // four the broker lists. Null from a route that did not say.
      expirationSelection: body.expirationSelection === 'requested' || body.expirationSelection === 'nearest'
        ? body.expirationSelection : null,
      expirationsAvailable: num(body.expirationsAvailable),
      strikesUsed: num(body.strikesUsed),
    },

    byExpiration,
    events: (() => {
      if (body.events === null || typeof body.events !== 'object') return null;
      const raw = record(body.events);
      return {
        from: isoDate(raw.from),
        through: isoDate(raw.through),
        earnings: arr(raw.earnings).map(isoDate).filter((date) => date !== null),
        exDividends: arr(raw.exDividends).map(exDividend).filter((ex) => ex !== null),
      };
    })(),

    // The book split at spot (strictly above, strictly below; a strike exactly
    // at spot in neither). Measurements for a squeeze argument, not a signal:
    // the GEX signs assume dealers are long the calls.
    spotSides: (() => {
      if (body.spotSides === null || typeof body.spotSides !== 'object') return null;
      const raw = record(body.spotSides);
      const share = num(raw.callOpenInterestShareAbove);
      return {
        atSpotStrike: num(raw.atSpotStrike),
        above: spotSide(raw.above),
        below: spotSide(raw.below),
        callOpenInterestShareAbove: share !== null && share >= 0 && share <= 1 ? share : null,
      };
    })(),

    strikes: {
      returned: nearSpot.length,
      total: rows.length,
      // With strikeWindowPct: the percent asked for and how many strikes lie
      // within it, which exceeds `returned` when the cap or the size budget
      // cut the window.
      windowPct: requestedWindowPct !== null && spotPrice !== null ? requestedWindowPct : null,
      inWindow: requestedWindowPct !== null && spotPrice !== null ? candidates.length : null,
      limitedBySize: false,
      nearSpot: [] as typeof nearSpot,
      atLevels: [] as typeof atLevels,
    },

    // Which rate and dividend yield the gamma flip was repriced with. The flip
    // is a repricing across spot levels, so it is only as good as these.
    resolved: body.resolved ?? null,
  };

  // The rows take what the rest of the answer leaves under the ceiling,
  // dropped farthest from spot first until they fit.
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const rowBudget = MAX_RESPONSE_BYTES - RESPONSE_MARGIN_BYTES - bytes(shaped);
  while (nearSpot.length > 1 && bytes(nearSpot) + bytes(atLevels) > rowBudget) {
    shaped.strikes.limitedBySize = true;
    const farthest = spotPrice === null ? nearSpot.length - 1 : nearSpot.reduce((far, row, index) =>
      (Math.abs((row.strike as number) - spotPrice) >= Math.abs((nearSpot[far].strike as number) - spotPrice) ? index : far), 0);
    nearSpot = nearSpot.filter((_, index) => index !== farthest);
    atLevels = shapeLevels(nearSpot);
  }
  shaped.strikes.returned = nearSpot.length;
  shaped.strikes.nearSpot = nearSpot;
  shaped.strikes.atLevels = atLevels;
  return shaped;
}
