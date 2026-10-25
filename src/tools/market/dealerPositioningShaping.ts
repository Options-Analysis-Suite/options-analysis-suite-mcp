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

import { MAX_RESPONSE_BYTES, significant } from '../helpers.js';
import { omittedRowsSentence, readOmittedRows } from './omittedRows.js';
import type { LiveRateLimit } from '../../proxy/liveApiClient.js';
import { rateLimitGuide, spotClockGuide, type Guide } from '../liveGuide.js';
import { bookOfWire, coverageShortfall, isWireBases, mcpExposuresV2, type V2Book } from '../exposureMethodology.js';

export interface DealerPositioningOptions {
  /** Total per-strike rows kept nearest spot (the cap, with strikeWindowPct). */
  strikeRange?: number;
  /** Every strike within this percent of spot, nearest first, up to the cap. */
  strikeWindowPct?: number;
  /**
   * Every strike inside this delta band, nearest spot first, up to the cap:
   * a call delta from d to 1 - d or a put delta from -(1 - d) to -d on at
   * least one expiration in the window. Takes the place of strikeWindowPct.
   */
  strikeWindowDelta?: number;
  /**
   * The live-broker budget after this call: given, it rides INSIDE the fit with the rows and
   * the guide, so the answer measured is the answer fitted. Absent: no rateLimit field.
   */
  rateLimit?: LiveRateLimit | null;
  /** The answer's methodology label, first in the answer and inside the fit */
  label?: Record<string, unknown>;
  /**
   * Methodology 2: the route's exposureV2 replaces every methodology-1 exposure (the totals, the rows', each
   * expiration's and each side of spot's); the levels stay methodology 1's, labeled; the note rides inside the fit.
   */
  methodology2?: { note: string };
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
export const isoDate = (v: unknown): string | null => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const parsed = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v ? v : null;
};
export const exDividend = (v: unknown): { date: string; amount: number | null; declared: boolean } | null => {
  const raw = record(v);
  const date = isoDate(raw.date);
  return date === null ? null : { date, amount: num(raw.amount), declared: raw.declared === true };
};
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

/** The adjusted series a book left out (root and contract count each), or null when it named none. */
export function readExcludedRoots(v: unknown): Array<{ root: string; contracts: number }> | null {
  const entries = arr(v).flatMap((value) => {
    const entry = record(value);
    const contracts = count(entry.contracts);
    return typeof entry.root === 'string' && contracts !== null ? [{ root: entry.root, contracts }] : [];
  });
  return entries.length > 0 ? entries : null;
}

/**
 * The adjusted series left out, in words, ending in its verb: "12 contracts
 * under the AAPL1 root (an adjusted series, a different deliverable at the
 * same strikes) are". The live positioning and the scan say it the same way.
 */
export function excludedRootsPhrase(entries: ReadonlyArray<{ root: string; contracts: number }>): string {
  const named = entries.map((entry) => `${entry.contracts} ${entry.contracts === 1 ? 'contract' : 'contracts'} under the ${entry.root} root`).join(' and ');
  return `${named} (an adjusted series, a different deliverable at the same strikes) ${entries.length === 1 && entries[0]!.contracts === 1 ? 'is' : 'are'}`;
}

export type CoverageStatus = 'complete' | 'partial' | 'unmeasured' | 'empty' | 'unknown';
export type FieldStatus = CoverageStatus | 'unavailable';
export interface MetricCoverage {
  total: number | null;
  included: number | null;
  status: CoverageStatus;
}

export function metricCoverage(value: unknown): MetricCoverage {
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

// The one rounding every tool's answer goes through, kept in helpers so the
// shared tool handler applies it; re-exported here for this tool's callers.
export { significant, significantDeep } from '../helpers.js';

/**
 * The flip search's price step, which describes how finely it sampled and
 * is not a measurement: the engine's step arithmetic leaves error well past
 * the last bit (0.15312200000005305 for a step of 0.153122), so it goes out
 * at 6 significant digits, finer than a cent at any price under $10,000.
 */
export const RESOLUTION_DIGITS = 6;

export function measuredValue(raw: unknown, coverage: MetricCoverage): { value: number | null; status: FieldStatus } {
  const parsed = num(raw);
  const value = parsed === null ? null : significant(parsed);
  if (coverage.status === 'unknown' || coverage.status === 'unmeasured') {
    return { value: null, status: coverage.status };
  }
  // No active legs can support a nonzero sum, even when the response claims it.
  if (coverage.status === 'empty' && value !== null && value !== 0) {
    return { value: null, status: 'unknown' };
  }
  return { value, status: value === null ? 'unavailable' : coverage.status };
}

export function measuredLevel(raw: unknown, status: FieldStatus): { value: number | null; status: FieldStatus } {
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

/** One expiration's published deltas at a strike, as the route sends them. */
export interface ExpirationDeltas {
  expiration: string | null;
  call: number | null;
  put: number | null;
}

/** A delta the route sent, kept only inside its side's range (call 0 to 1, put -1 to 0). */
function readDeltas(value: unknown): ExpirationDeltas[] {
  const within = (v: unknown, low: number, high: number): number | null => {
    const n = num(v);
    return n !== null && n >= low && n <= high ? n : null;
  };
  return arr(value).map((entry) => {
    const raw = record(entry);
    return { expiration: str(raw.expiration), call: within(raw.call, 0, 1), put: within(raw.put, -1, 0) };
  });
}

/**
 * Whether a strike lies inside the band `d`: on at least one expiration its
 * call delta is from d to 1 - d, or its put delta from -(1 - d) to -d, ends
 * included. Either leg qualifies the strike on its own; neither is derived
 * from the other.
 *
 * Decided on the decimals printed: 1 - 0.07 is 0.9299999999999999 in
 * binary, which would leave a published 0.93 outside a band it closes.
 */
export function inDeltaBand(entries: ReadonlyArray<{ expiration?: string | null; call: number | null; put: number | null }>, d: number): boolean {
  // Every term at one scale, as integers: x, d and 1 exactly.
  const scaled = (x: number, scale: number) => {
    const dec = decimalOf(x);
    return dec.n * 10n ** BigInt(scale - dec.scale);
  };
  return entries.some(({ call, put }) => {
    for (const [value, side] of [[call, 'call'], [put, 'put']] as const) {
      if (value === null) continue;
      const scale = Math.max(decimalOf(value).scale, decimalOf(d).scale);
      const x = scaled(value, scale);
      const band = scaled(d, scale);
      const one = 10n ** BigInt(scale);
      // call: d <= x <= 1 - d.  put: -(1 - d) <= x <= -d.
      if (side === 'call' ? x >= band && x + band <= one : x + band <= 0n && x + one >= band) return true;
    }
    return false;
  });
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
export function readRegime(explicit: unknown, netGex: number | null): string | null {
  if (explicit === 'positive' || explicit === 'negative' || explicit === 'neutral') return explicit;
  if (netGex === null) return null;
  if (netGex > 0) return 'positive';
  if (netGex < 0) return 'negative';
  return 'neutral';
}

// ---------------------------------------------------------------------------------------------------------------
// Methodology 2 (Greek exposure methodology v2): the route's exposureV2 (proxy/lib/liveExposureV2.ts), the window's own book over the
// same legs under the intraday expiry scope, read through the twin. Every methodology-1 exposure is replaced by its
// methodology-2 counterpart or left out: the totals, each row's, each expiration's and each side of spot's. The levels
// stay methodology 1's, labeled, beside the coverage they are read from; the window, its fetch gaps, the expected moves
// and the events are unchanged.

/** The route's failure reason (proxy/lib/liveExposureV2.ts LIVE_V2_FAILED) */
const LIVE_V2_FAILED = 'the methodology-2 book could not be computed';
const LIVE_V2_UNREADABLE = 'the methodology-2 data is unreadable';

/** What `exposures` cover, in words (the dates are exposureScope's) */
export const LIVE_V2_SCOPE = 'the window\'s expirations still in the book when the chain was read (exposureScope.expirationsIncluded)';

/** The per-answer note's live part (after METHODOLOGY_2_NOTE) */
export const LIVE_V2_NOTE = 'Here `exposures` is the book of the window\'s legs still in it when the chain was read, on the '
  + 'broker\'s spot and the resolved rate and yield (exposureScope: an expiration leaves it at its session\'s close, while the '
  + 'window lists it until 4:15 PM New York); the rows, byExpiration\'s `exposures` and spotSides\' gex are the same book. '
  + '`levels` are methodology 1\'s over every leg of the window, their statuses and coverage inside them, so near a close the '
  + 'two can cover different legs and neither is wrong.';

/** Where the levels come from, on every methodology-2 answer */
export const LEVELS_V1_BASIS = 'methodology 1: the legacy engine\'s gamma over every leg of the window (levels.coverage), '
  + 'not derived from `exposures`';

interface LiveV2Strike {
  strike: number;
  book: V2Book;
  callOpenInterest: number | null;
  putOpenInterest: number | null;
  deltas: ExpirationDeltas[];
}

interface LiveV2SpotSide {
  strikes: number | null;
  book: V2Book;
  callOpenInterest: unknown;
  callOpenInterestCoverage: unknown;
  putOpenInterest: unknown;
  putOpenInterestCoverage: unknown;
}

interface LiveV2 {
  /** Why there is no book (the whole answer's), or null */
  unavailable: string | null;
  /** The instant the book was scoped at (the route's rows' build clock), or null */
  scopeAsOf: string | null;
  totals: V2Book | null;
  referenceKind: string;
  rollStatus: string;
  expirationsIncluded: string[];
  strikeRowsExpired: number;
  strikeRowsUnscoped: number;
  strikes: LiveV2Strike[];
  /** Each window expiration's book, or why it has none ('expired' | 'no legs') */
  expirations: Map<string, V2Book | 'expired' | 'no legs'>;
  spotSides: { atSpotStrike: number | null; callOpenInterestShareAbove: number | null; above: LiveV2SpotSide; below: LiveV2SpotSide } | null;
}

function readLiveV2(raw: unknown): LiveV2 {
  const v = record(raw);
  const none = (unavailable: string): LiveV2 => ({
    unavailable, scopeAsOf: null, totals: null, referenceKind: 'spot', rollStatus: 'notApplicable', expirationsIncluded: [],
    strikeRowsExpired: 0, strikeRowsUnscoped: 0, strikes: [], expirations: new Map(), spotSides: null,
  });
  if (v.available !== true) return none(v.reason === LIVE_V2_FAILED ? 'the methodology-2 book could not be computed on this call' : LIVE_V2_UNREADABLE);
  if (!isWireBases(v.totals)) return none(LIVE_V2_UNREADABLE);
  const census = record(v.strikeRows);
  const strikes = arr(v.strikes).flatMap((value): LiveV2Strike[] => {
    const entry = record(value);
    const strike = num(entry.strike);
    if (strike === null || !isWireBases(entry.bases)) return [];
    return [{
      strike, book: bookOfWire(entry.bases),
      callOpenInterest: count(entry.callOpenInterest), putOpenInterest: count(entry.putOpenInterest),
      deltas: readDeltas(entry.deltasByExpiration),
    }];
  });
  const expirations = new Map<string, V2Book | 'expired' | 'no legs'>();
  for (const value of arr(v.expirations)) {
    const entry = record(value);
    const expiration = isoDate(entry.expiration);
    if (expiration === null) continue;
    if (isWireBases(entry.bases)) expirations.set(expiration, bookOfWire(entry.bases));
    else if (entry.reason === 'expired' || entry.reason === 'no legs') expirations.set(expiration, entry.reason);
  }
  const sides = record(v.spotSides);
  const side = (value: unknown): LiveV2SpotSide | null => {
    const s = record(value);
    if (!isWireBases(s.bases)) return null;
    return {
      strikes: count(s.strikes), book: bookOfWire(s.bases),
      callOpenInterest: s.callOpenInterest, callOpenInterestCoverage: s.callOpenInterestCoverage,
      putOpenInterest: s.putOpenInterest, putOpenInterestCoverage: s.putOpenInterestCoverage,
    };
  };
  const above = side(sides.above);
  const below = side(sides.below);
  const share = num(sides.callOpenInterestShareAbove);
  return {
    unavailable: null,
    scopeAsOf: str(v.scopeAsOf),
    totals: bookOfWire(v.totals),
    referenceKind: str(v.referenceKind) ?? 'unknown',
    rollStatus: str(record(v.roll).status) ?? 'notApplicable',
    expirationsIncluded: arr(v.expirationsIncluded).map(isoDate).filter((date): date is string => date !== null),
    strikeRowsExpired: count(census.expired) ?? 0,
    strikeRowsUnscoped: count(census.unscoped) ?? 0,
    strikes,
    expirations,
    spotSides: above === null || below === null ? null : {
      atSpotStrike: num(sides.atSpotStrike),
      callOpenInterestShareAbove: share !== null && share >= 0 && share <= 1 ? share : null,
      above, below,
    },
  };
}

/** The answer's `exposures` (or why none), and the scope's census */
function liveV2Exposures(v2: LiveV2): Record<string, unknown> {
  if (v2.unavailable !== null || v2.totals === null) return { exposures: null, exposuresUnavailable: v2.unavailable ?? LIVE_V2_UNREADABLE };
  const scope = {
    // the route's asOf is taken after its other reads, so it can follow this across a close
    ...(v2.scopeAsOf !== null ? { asOf: v2.scopeAsOf } : {}),
    expirationsIncluded: v2.expirationsIncluded,
    ...(v2.strikeRowsExpired > 0 ? { strikeRowsExpired: v2.strikeRowsExpired } : {}),
    ...(v2.strikeRowsUnscoped > 0 ? { strikeRowsUnscoped: v2.strikeRowsUnscoped } : {}),
  };
  // every leg read had left the book: an empty book, said so rather than a complete zero
  if (v2.expirationsIncluded.length === 0 && v2.strikeRowsUnscoped === 0 && v2.totals.coverage.gamma.total === 0) {
    return {
      exposures: null,
      exposuresUnavailable: 'no leg in the window was still in the book when the chain was read: each had passed its expiration session\'s close',
      exposureScope: scope,
    };
  }
  return {
    exposures: mcpExposuresV2(v2.totals, { referenceKind: v2.referenceKind, rollStatus: v2.rollStatus, carry: null }, LIVE_V2_SCOPE),
    exposureScope: scope,
  };
}

/** One row's methodology-2 numbers: the assumed book's GEX and vega exposure and the delta balance, with what is short */
function liveV2Row(entry: LiveV2Strike, own: ExpirationDeltas | null) {
  const coverage = coverageShortfall(entry.book, ['gamma', 'delta', 'vega']);
  return {
    strike: entry.strike,
    gex: entry.book.assumedDealerBook.gex,
    putMinusCallDeltaBalance: entry.book.putMinusCallDeltaBalance,
    vegaExposure: entry.book.assumedDealerBook.vegaExposure,
    callOpenInterest: entry.callOpenInterest, putOpenInterest: entry.putOpenInterest,
    callDelta: own?.call ?? null, putDelta: own?.put ?? null,
    ...(coverage !== null ? { coverage } : {}),
  };
}

const LIVE_V2_EXPIRATION_WHY: Record<'expired' | 'no legs', string> = {
  expired: 'its session had closed when the chain was read, so its legs are out of the book',
  'no legs': 'the broker answered it with no contracts',
};

/**
 * One expiration's methodology-2 numbers. The share of the book's Long OI GEX only when every window expiration is in
 * the book with complete gamma coverage or out of it by the clock (a date answered empty leaves the share unknown).
 */
function liveV2Expiration(v2: LiveV2, expiration: string | null, shareKnown: boolean): Record<string, unknown> {
  if (v2.unavailable !== null || v2.totals === null) return { exposures: null };
  const entry = expiration === null ? undefined : v2.expirations.get(expiration);
  if (entry === undefined) return { exposures: null, exposuresUnavailable: 'not in the methodology-2 answer' };
  if (typeof entry === 'string') return { exposures: null, exposuresUnavailable: LIVE_V2_EXPIRATION_WHY[entry] };
  const coverage = coverageShortfall(entry, ['gamma', 'delta']);
  const whole = v2.totals.longOi.gex;
  const share = shareKnown && entry.longOi.gex !== null && whole !== null && whole > 0 ? entry.longOi.gex / whole : null;
  return {
    exposures: {
      gex: entry.assumedDealerBook.gex,
      putMinusCallDeltaBalance: entry.putMinusCallDeltaBalance,
      longOiGex: entry.longOi.gex,
      shareOfLongOiGex: share !== null && share >= 0 && share <= 1 ? share : null,
      ...(coverage !== null ? { coverage } : {}),
    },
  };
}

function liveV2SpotSide(side: LiveV2SpotSide) {
  const callOiCoverage = metricCoverage(side.callOpenInterestCoverage);
  const putOiCoverage = metricCoverage(side.putOpenInterestCoverage);
  const callOi = measuredValue(side.callOpenInterest, callOiCoverage);
  const putOi = measuredValue(side.putOpenInterest, putOiCoverage);
  const gex = coverageShortfall(side.book, ['gamma']);
  return {
    strikes: side.strikes,
    gex: side.book.assumedDealerBook.gex,
    callOpenInterest: callOi.value,
    putOpenInterest: putOi.value,
    status: { callOpenInterest: callOi.status, putOpenInterest: putOi.status },
    coverage: { ...(gex ?? {}), callOpenInterest: callOiCoverage, putOpenInterest: putOiCoverage },
  };
}

export function summarizeDealerPositioning(
  response: Record<string, unknown>,
  options: Omit<DealerPositioningOptions, 'methodology2'> = {},
) {
  return shapeDealerPositioning(response, options);
}

/**
 * Methodology 2's answer: its own layout - `exposures`, `exposureScope`, and the levels labeled methodology
 * 1 with their statuses and coverage inside them - read by name, never through methodology 1's type.
 */
export function summarizeDealerPositioningV2(
  response: Record<string, unknown>,
  options: Omit<DealerPositioningOptions, 'methodology2'> & { note: string },
): Record<string, unknown> {
  const { note, ...rest } = options;
  return shapeDealerPositioning(response, { ...rest, methodology2: { note } });
}

/**
 * The one shaper. Its type is methodology 1's answer: methodology 2's parts are cast to it locally, and only
 * summarizeDealerPositioningV2, untyped, ever returns them.
 */
function shapeDealerPositioning(
  response: Record<string, unknown>,
  options: DealerPositioningOptions,
) {
  const windowDelta = num(options.strikeWindowDelta);
  const requestedDeltaBand = windowDelta !== null && windowDelta > 0 && windowDelta < 0.5 ? windowDelta : null;
  const windowPct = num(options.strikeWindowPct);
  // A delta band takes the place of a percent window (the tool refuses both).
  const requestedWindowPct = requestedDeltaBand === null && windowPct !== null && windowPct > 0 && windowPct <= 50
    ? windowPct : null;
  const limit = Math.min(MAX_STRIKE_ROWS, Math.max(1, Math.trunc(
    num(options.strikeRange)
      ?? (requestedWindowPct !== null || requestedDeltaBand !== null ? MAX_STRIKE_ROWS : DEFAULT_STRIKE_RANGE),
  )));
  const body = response ?? {};
  const snapshot = record(body.snapshot);
  // Methodology 2: the route's own book replaces every methodology-1 exposure below
  const v2 = options.methodology2 ? readLiveV2(body.exposureV2) : null;

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
      ? significant(reportedResolution, RESOLUTION_DIGITS) : null,
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
  // Under methodology 2 the rows are its book's strikes (the legs in it), never the legacy engine's
  const v2Strikes = new Map((v2?.strikes ?? []).map((entry) => [entry.strike, entry]));
  const rows = (v2 !== null
    ? (v2.strikes.map((entry) => ({ strike: entry.strike as number | null, row: {} as Record<string, unknown>, deltas: entry.deltas })))
    : arr(body.byStrike).map((value) => {
      const row = record(value);
      return { strike: num(row.strike), row, deltas: readDeltas(row.deltasByExpiration) };
    })).filter((row) => row.strike !== null);
  // A window keeps the strikes within it, nearest first up to the cap: a
  // percent of spot (none without spot) or a delta band.
  const windowed = requestedDeltaBand !== null || (requestedWindowPct !== null && spotPrice !== null);
  const candidates = requestedDeltaBand !== null
    ? rows.filter((row) => inDeltaBand(row.deltas, requestedDeltaBand))
    : requestedWindowPct !== null && spotPrice !== null
      ? rows.filter((row) => withinPercent(row.strike as number, spotPrice, requestedWindowPct))
      : rows;
  // One expiration has one delta a leg, so a row can carry it; over several
  // a strike has one per expiration, and no single number is published.
  const singleExpiration = arr(body.expirations).length === 1;
  const shapeRowV1 = ({ strike, row, deltas }: { strike: number | null; row: Record<string, unknown>; deltas: ExpirationDeltas[] }) => {
    const own = singleExpiration && deltas.length === 1 ? deltas[0] : null;
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
      // The broker's per-contract deltas at this strike, only when the window
      // is one expiration; null when unpublished or over several.
      callDelta: own?.call ?? null, putDelta: own?.put ?? null,
      status: { netGex: gamma.status, netDex: delta.status, netVega: vega.status },
      // Only when some status is not complete: a complete row's counts add
      // nothing its status does not say, and dropping them is what lets the
      // cap reach MAX_STRIKE_ROWS inside the response budget.
      ...(gamma.status === 'complete' && delta.status === 'complete' && vega.status === 'complete'
        ? {} : { coverage }),
    };
  };
  const shapeRow = (entry: { strike: number | null; row: Record<string, unknown>; deltas: ExpirationDeltas[] }) => (v2 !== null
    ? liveV2Row(v2Strikes.get(entry.strike as number)!, singleExpiration && entry.deltas.length === 1 ? entry.deltas[0] : null) as unknown as ReturnType<typeof shapeRowV1>
    : shapeRowV1(entry));
  let nearSpot = nearestStrikes(candidates, spotPrice, limit).map(shapeRow);

  // The walls and the magnet are chosen over every strike in the window, so
  // they can sit outside the rows above; their rows go out beside them.
  const levelStrikes = new Map<number, string[]>();
  for (const [level, field] of [['callWall', levelFields.callWall], ['putWall', levelFields.putWall], ['gammaMagnet', levelFields.gammaMagnet]] as const) {
    if (field.value === null) continue;
    levelStrikes.set(field.value, [...(levelStrikes.get(field.value) ?? []), level]);
  }
  // Methodology 1 keys its strikes to the cent (strike_cents); under methodology 2 a row is the book's exact strike, so a
  // level names each of the book's strikes at it to the cent, by the rows' own rounding
  const levelKey = (strike: number) => (v2 !== null ? Math.round(strike * 100) / 100 : strike);
  const shapeLevels = (kept: ReadonlyArray<{ strike: number | null }>) => {
    const shown = new Set(kept.map((row) => row.strike));
    return rows
      .filter((row) => levelStrikes.has(levelKey(row.strike as number)) && !shown.has(row.strike))
      .map((row) => ({ levels: levelStrikes.get(levelKey(row.strike as number))!, ...shapeRow(row) }));
  };
  let atLevels = shapeLevels(nearSpot);

  // Each expiration computed alone on the window's own rows (the route's
  // expirationBreakdown). The sides and the gross go out only under complete
  // or empty gamma coverage, for the reason the per-strike sides do; the share
  // only when the route published one (it requires every expiration complete).
  // Each expiration's share of the book's Long OI GEX needs every window date in the book complete, or out of it by the clock
  const v2ShareKnown = v2 !== null && v2.totals !== null && v2.totals.coverage.gamma.status === 'complete'
    && arr(body.expirations).every((expiration) => {
      const entry = v2.expirations.get(String(expiration));
      return entry === 'expired' || (entry !== undefined && entry !== 'no legs' && entry.coverage.gamma.status === 'complete');
    });
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
    const entryOmitted = readOmittedRows(entry.omittedRows);
    const entryExcluded = readExcludedRoots(entry.excludedRoots);
    const numbers = {
      netGex: gamma.value,
      netDex: delta.value,
      callGex: side(entry.callGamma),
      putGex: side(entry.putGamma),
      grossGex: side(entry.grossGamma),
      shareOfGrossGex: share !== null && share >= 0 && share <= 1 ? share : null,
      status: { netGex: gamma.status, netDex: delta.status },
    };
    return {
      expiration: str(entry.expiration),
      ...(entryOmitted !== null ? { omittedRows: entryOmitted } : {}),
      ...(entryExcluded !== null ? { excludedRoots: entryExcluded } : {}),
      daysToExpiration: Number.isSafeInteger(entry.daysToExpiration) ? entry.daysToExpiration as number : null,
      ...(v2 !== null ? liveV2Expiration(v2, str(entry.expiration), v2ShareKnown) as unknown as typeof numbers : numbers),
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
        // On a date listed under several roots (SPX and SPXW): the series the straddle is.
        ...(str(move.root) !== null ? { root: str(move.root) } : {}),
      },
      expectedMoveUnavailable: str(entry.expectedMoveUnavailable),
      events: rawEvents === null ? null : {
        earningsOnOrBefore: isoDate(rawEvents.earningsOnOrBefore),
        exDividendOnOrBefore: exDividend(rawEvents.exDividendOnOrBefore),
      },
    };
  }).filter((entry) => entry.expiration !== null);

  const limitations = [
    v2 === null
      ? 'Totals cover the selected expirations, not every listed expiration. Metric coverage counts active option legs; per-strike coverage combines those expirations.'
      : '`exposures` cover the selected expirations still in the book when the chain was read (exposureScope), not every listed expiration; a coverage entry counts the active option legs of one number, and a row\'s combines its strike\'s expirations.',
    'Partial sums include only supported contributions and are not whole-book measurements. Levels are withheld when their required coverage is incomplete.',
    v2 === null
      ? 'Unknown or unmeasured values are null. Empty means no active legs; it supports a reported zero sum but no inferred level or regime.'
      : 'Unavailable numbers are null. A level whose status is unknown or unmeasured is null; empty means no active legs, which supports no inferred level or regime.',
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
  if (v2 === null && Object.values(fields).some((field) => field.status === 'unavailable')) {
    limitations.push('Some reported totals are missing or invalid despite available input coverage.');
  }
  // A spot that printed before the last session's open (Public's 04:00
  // snapshot) skews everything read against it; resolved.S carries the flag,
  // and this says what it touches.
  if (record(record(body.resolved).S).stale === true) {
    limitations.push("The spot printed before the last session's open (resolved.S.asOf, the broker's own time), so the levels' distances from spot, the at-the-money straddles and the split at spot are read against a stale price.");
  }
  // The expirations whose open interest the broker did not publish: a window
  // of null levels says why, rather than reading as a thin book.
  const unpublished = arr(body.openInterestUnpublishedExpirations).map(isoDate).filter((date): date is string => date !== null);
  // A window date the broker answered with no contracts (though it lists it), and rows it sent that could not be
  // used: the totals leave both out, so they are said.
  const emptyExpirations = arr(body.emptyExpirations).map(isoDate).filter((date): date is string => date !== null);
  const omittedRows = readOmittedRows(body.omittedRows);
  if (emptyExpirations.length > 0) {
    limitations.push(`The broker answered ${emptyExpirations.join(', ')} with no contracts, though it lists ${emptyExpirations.length === 1 ? 'that date' : 'those dates'}; the totals leave ${emptyExpirations.length === 1 ? 'it' : 'them'} out, so the window is partial.`);
  }
  if (omittedRows !== null) limitations.push(omittedRowsSentence(omittedRows));
  // Adjusted series (a digit root, a different deliverable) the books left
  // out: a window date listed only under one adds nothing, and is named.
  const excludedRoots = readExcludedRoots(body.excludedRoots);
  if (excludedRoots !== null) {
    // The coverage and statuses measure the symbol's own contracts: "complete"
    // never includes the adjusted series, which no total of this book counts.
    limitations.push(`${excludedRootsPhrase(excludedRoots)} left out of the totals, the levels and their coverage, which measure the symbol's own contracts alone, so "complete" there does not include them; \`byExpiration\` names the dates.`);
  }
  if (unpublished.length > 0) {
    const named = unpublished.length === 1 ? unpublished[0]
      : `${unpublished.slice(0, -1).join(', ')} and ${unpublished[unpublished.length - 1]}`;
    limitations.push(unpublished.length === 1
      ? `The broker published no open interest for ${named} (a zero on every contract, as Schwab prints on index options), so its legs are excluded and a level it feeds is withheld for incomplete coverage (\`${v2 === null ? 'levelStatus' : 'levels.status'}\` says which)${v2 === null ? '' : '; the methodology-2 numbers it feeds carry the shortfall in their coverage'}; the expected move is priced from quotes and is unaffected.`
      : `The broker published no open interest for ${named} (a zero on every contract, as Schwab prints on index options), so their legs are excluded and a level they feed is withheld for incomplete coverage (\`${v2 === null ? 'levelStatus' : 'levels.status'}\` says which)${v2 === null ? '' : '; the methodology-2 numbers they feed carry the shortfall in their coverage'}; the expected moves are priced from quotes and are unaffected.`);
  }

  const levels = {
    gammaFlip: levelFields.gammaFlip.value,
    callWall: levelFields.callWall.value,
    putWall: levelFields.putWall.value,
    gammaMagnet: levelFields.gammaMagnet.value,
    dealerRegime,
    gammaConcentration: levelFields.gammaConcentration.value,
  };
  const levelStatus = {
    gammaFlip: levelFields.gammaFlip.status,
    callWall: levelFields.callWall.status,
    putWall: levelFields.putWall.status,
    gammaMagnet: levelFields.gammaMagnet.status,
    dealerRegime: fields.netGex.status,
    gammaConcentration: levelFields.gammaConcentration.status,
  };
  const v1Book = { levels, levelStatus, exposure, exposureStatus, coverage };
  const legacySpotSides = () => {
    if (body.spotSides === null || typeof body.spotSides !== 'object') return null;
    const raw = record(body.spotSides);
    const share = num(raw.callOpenInterestShareAbove);
    return {
      atSpotStrike: num(raw.atSpotStrike),
      above: spotSide(raw.above),
      below: spotSide(raw.below),
      callOpenInterestShareAbove: share !== null && share >= 0 && share <= 1 ? share : null,
    };
  };
  const shaped = {
    ...(options.label ?? {}),
    symbol: str(body.symbol),
    // Never omitted and never inferred from the absence of an error: a reader
    // relaying a gamma flip has to be able to say how old it is.
    dataSource: 'live' as const,
    asOf: str(body.asOf),
    provider: str(body.provider),
    spotPrice,

    ...(v2 === null ? v1Book : {
      // methodology 1's levels, labeled, with their statuses and the coverage they are read from (gamma and the flip's)
      levels: {
        methodology: 1 as const,
        basis: LEVELS_V1_BASIS,
        ...levels,
        status: levelStatus,
        coverage: {
          unit: coverage.unit,
          strikes: coverage.strikes,
          strikesWithGamma: coverage.strikesWithGamma,
          gamma: coverage.gamma,
          gammaFlip: coverage.gammaFlip,
          gammaFlipMethod: coverage.gammaFlipMethod,
          gammaFlipResolution: coverage.gammaFlipResolution,
          gammaFlipSearchStatus: coverage.gammaFlipSearchStatus,
        },
      },
      ...liveV2Exposures(v2),
    } as unknown as typeof v1Book),
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
      ...(unpublished.length > 0 ? { openInterestUnpublishedExpirations: unpublished } : {}),
      ...(body.partial === true ? { partial: true as const } : {}),
      ...(emptyExpirations.length > 0 ? { emptyExpirations } : {}),
      ...(omittedRows !== null ? { omittedRows } : {}),
      ...(excludedRoots !== null ? { excludedRoots } : {}),
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
      if (v2 !== null) {
        const sides = v2.spotSides;
        return (sides === null ? null : {
          atSpotStrike: sides.atSpotStrike,
          above: liveV2SpotSide(sides.above),
          below: liveV2SpotSide(sides.below),
          callOpenInterestShareAbove: sides.callOpenInterestShareAbove,
        }) as unknown as ReturnType<typeof legacySpotSides>;
      }
      return legacySpotSides();
    })(),

    strikes: {
      returned: nearSpot.length,
      total: rows.length,
      // With strikeWindowPct: the percent asked for and how many strikes lie
      // within it, which exceeds `returned` when the cap or the size budget
      // cut the window.
      windowPct: requestedWindowPct !== null && spotPrice !== null ? requestedWindowPct : null,
      // With strikeWindowDelta: the band d asked for.
      deltaBand: requestedDeltaBand,
      inWindow: windowed ? candidates.length : null,
      limitedBySize: false,
      nearSpot: [] as typeof nearSpot,
      atLevels: [] as typeof atLevels,
    },

    // Which rate and dividend yield the gamma flip was repriced with. The flip
    // is a repricing across spot levels, so it is only as good as these.
    resolved: body.resolved ?? null,
    // The proxy's own success warnings (resolver and read-gap warnings): the shaper used to drop them, so an
    // unsuitable stored yield or a rate fallback never reached the model.
    ...(warningsOf(body.warnings).length > 0 ? { warnings: warningsOf(body.warnings) } : {}),
    ...('rateLimit' in options ? { rateLimit: options.rateLimit ?? null } : {}),
    guide: {} as Guide,
    ...(options.methodology2 ? { methodologyNote: options.methodology2.note } : {}),
  };
  const rowsReturned = nearSpot.length > 0 || atLevels.length > 0;
  const guideFacts = {
    rowsReturned, requestedWindowPct, provider: shaped.provider, rateLimitGiven: 'rateLimit' in options, rateLimit: options.rateLimit ?? null,
    regime: dealerRegime, cov: coverage, levels, levelStatus,
    v2: v2 === null ? null : {
      exposures: (shaped as Record<string, any>).exposures as Record<string, unknown> | null,
      expired: v2.strikeRowsExpired, unscoped: v2.strikeRowsUnscoped,
    },
  };
  shaped.guide = dealerGuide(shaped, guideFacts, false);

  // The rows take what the rest of the answer (the guide and the budget included) leaves under the ceiling,
  // dropped farthest from spot first until they fit. Once rows go, the guide gains the line saying so, and the
  // rows give way for it too.
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  let rowBudget = MAX_RESPONSE_BYTES - RESPONSE_MARGIN_BYTES - bytes(shaped);
  while (nearSpot.length > 1 && bytes(nearSpot) + bytes(atLevels) > rowBudget) {
    if (!shaped.strikes.limitedBySize) {
      shaped.strikes.limitedBySize = true;
      shaped.guide = dealerGuide(shaped, guideFacts, true);
      rowBudget = MAX_RESPONSE_BYTES - RESPONSE_MARGIN_BYTES - bytes(shaped);
    }
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

/** The same-day rule under methodology 2: its book leaves a leg at the session's close; the levels keep the gamma */
const SAME_DAY_V2 = 'On same-day legs, vanna, charmFlow and vomma change sharply with small spot moves and time to expiry: '
  + 'one charmFlow reading is not a steady rate into the close. A same-day expiration\'s legs leave vanna, charmFlow and '
  + 'vomma one minute before its session\'s close and the whole methodology-2 book at the close (4:00 PM New York, '
  + '1:00 PM on an NYSE early close: exposureScope); the default window lists the date until 4:15 PM and methodology 1\'s '
  + 'levels keep its gamma until then. charmFlow is not split by expiration; over several expirations this answer does '
  + 'not show its same-day share; as general possibilities, not a reading of this answer: charm near the money can be the '
  + 'largest term in the book, a same-day leg\'s vanna changes sign near its strike, and on an expiration afternoon '
  + 'charmFlow can be mostly the same-day legs and the clock. The levels\' flip sweep reprices each leg at its time to '
  + 'expiry floored at one minute, so same-day legs\' repriced gamma narrows onto their strikes until one minute before '
  + 'that close and holds that shape after it (4:15 PM is the default-window cutoff, not a repricing boundary; named '
  + 'expirations and those with no later listing are kept): the flip moves with the clock.';

const warningsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string') : []);

/**
 * The dealer guide emits each applicable reading rule under a stable key. It explains neutral regimes,
 * percent windows without a spot, the magnet and concentration alongside the fields they describe.
 */
function dealerGuide(
  shaped: Record<string, any>,
  f: {
    rowsReturned: boolean; requestedWindowPct: number | null; provider: string | null; rateLimitGiven: boolean; rateLimit: LiveRateLimit | null; regime: string | null;
    /** Methodology 1's coverage, levels and their statuses, wherever the answer carries them */
    cov: Record<string, any>; levels: Record<string, any>; levelStatus: Record<string, any>;
    /** Methodology 2's facts, or null for a methodology-1 answer */
    v2: { exposures: Record<string, unknown> | null; expired: number; unscoped: number } | null;
  },
  limited: boolean,
): Guide {
  const g: Guide = {};
  const cov = f.cov;
  const v2 = f.v2;
  // Under methodology 2 the levels' statuses and coverage sit inside `levels`
  const statusPath = v2 === null ? 'levelStatus' : 'levels.status';
  const covPath = v2 === null ? 'coverage' : 'levels.coverage';
  const entries: Array<Record<string, any>> = shaped.byExpiration;
  const provider = f.provider;
  // Governs every exposure value, null ones included.
  g.exposure = v2 === null
    ? 'netCharm is dealer dollar charm per calendar day on the remaining-maturity sign, the opposite of '
      + 'compute_black_scholes\' time-passing charm: one day of time passing moves the dealers\' dollar delta by minus it. '
      + 'GEX counts call gamma positive and put gamma negative (dealers assumed long calls and short puts); a squeeze '
      + 'reading of out-of-the-money calls assumes customers bought them and dealers are short, and open interest does not '
      + 'say who holds a contract: spotSides and the open-interest fields are what a squeeze argument reads, not a squeeze signal.'
    : '`exposures`, each row\'s numbers, byExpiration\'s `exposures` and spotSides\' gex are one methodology-2 book '
      + '(methodologyNote): GEX counts call gamma positive and put gamma negative (dealers assumed long calls and short '
      + 'puts); a squeeze reading of out-of-the-money calls assumes customers bought them and dealers are short, and open '
      + 'interest does not say who holds a contract: spotSides and the open-interest fields are what a squeeze argument '
      + 'reads, not a squeeze signal. charmFlow is the book\'s hedge flow per calendar day (+ is buying), not '
      + 'compute_black_scholes\' time-passing charm.';
  if (v2 !== null) {
    g.exposureScope = 'exposureScope.expirationsIncluded are the window\'s expirations the methodology-2 book holds: an '
      + 'expiration\'s legs leave it at its session\'s close (4:00 PM New York, 1:00 PM on an NYSE early close), while the '
      + 'default window lists the date until 4:15 PM and the levels keep its legs\' gamma until then. exposureScope.asOf is the '
      + 'instant the book was scoped at, when the chain rows were built: asOf, taken after the answer\'s other reads, can '
      + 'follow it across a close, so a book can hold an expiration beside an asOf past that expiration\'s close'
      + (v2.expired > 0 ? '; strikeRowsExpired counts the strike rows read and left out of the book for that reason' : '')
      + (v2.unscoped > 0 ? '; strikeRowsUnscoped counts the strike rows kept in it with an expiration date that could not be read' : '')
      + '.';
  }
  g.walls = (v2 === null ? '' : 'The levels are methodology 1\'s (levels.basis). ')
    + 'The call wall is the strike with the largest positive call gamma and the put wall the strike with the most '
    + 'negative put gamma; ties go to the lower strike, and nothing orders them, so the put wall can sit above the call '
    + `wall. A null wall beside a complete ${statusPath} means no strike has such gamma on that side; beside any other `
    + 'status it is withheld.';
  const flipNullComplete = f.levels.gammaFlip === null && f.levelStatus.gammaFlip === 'complete';
  // Coverage.gammaFlip's legs, repriced and held alike, are flipMethod's (every answer); not repeated here.
  // Under methodology 2 the walls' status is methodology 1's net gamma total's, which the answer does not send
  const netGexStatus = v2 === null ? 'the netGex field status' : 'methodology 1\'s net gamma status (its dealerRegime entry)';
  g.levelStatus = `${statusPath} is each level\'s required coverage, not whether a level was found: the flip\'s is `
    + `${covPath}.gammaFlip, and the walls\', the magnet\'s and the `
    + `concentration\'s is ${netGexStatus}, which can also read "unavailable" (a missing or invalid reported `
    + 'total despite coverage). A reported null level keeps its coverage status; a missing or invalid reported level '
    + 'reads "unavailable" when its required coverage is complete.'
    // An evaluation found "a search result, not withheld" lifted without the next sentence's caveat: one sentence.
    // Both the repriced grid and the observed-leg adaptive search can miss crossings between samples or outside the range.
    + (flipNullComplete ? ' Here gammaFlip\'s null over complete coverage (every counted leg entered the search) '
      + 'is a search result, not withheld, and not proof of no flip: sampling within 20% of spot can miss two crossings in '
      + `one interval or a crossing outside the range. See ${covPath}.gammaFlipSearchStatus.` : '');
  if (f.levels.gammaFlip !== null) {
    // Put the nearest-detected rule beside the coverage rule without enlarging this branch's guide.
    // Adding it to the old prose displaced a strike on a complete mixed-method window.
    g.levelStatus = `${statusPath} reports required coverage, not whether a level was found: gammaFlip uses `
      + `${covPath}.gammaFlip; walls, magnet and concentration use ${v2 === null ? 'netGex\'s field status' : 'methodology 1\'s net gamma status'} ("unavailable" for missing/invalid `
      + 'totals). Missing/invalid levels read "unavailable" under complete coverage; reported null levels keep coverage '
      + 'status. gammaFlip is nearest to spot among crossings found by sampling; nearer or farther crossings may be missed.';
  }
  g.dealerRegime = v2 === null
    ? 'dealerRegime positive means dealers hedge against moves and dampen them, negative that they hedge with '
      + 'moves and amplify them. It is the sign of net gamma over the selected expirations interpolated at spot between the '
      + 'two bracketing strikes (the nearest strike\'s gamma when spot is outside them), not the sign of netGex nor which '
      + 'side of gammaFlip spot is on, and can disagree with both; only with fewer than two gamma-bearing strikes is it '
      + 'netGex\'s sign, as it is when the route sent none. It is published only when netGex coverage is complete.'
      + (f.regime === 'neutral' ? ' "neutral" is a net gamma of exactly zero at that point (or a measured zero netGex): neither dampening nor amplifying.' : '')
      + (f.regime === null ? ' Null here: the regime is not established (netGex coverage is not complete - levelStatus.dealerRegime names its status - or there is no netGex), which is not "neutral".' : '')
    : 'dealerRegime (methodology 1) positive means dealers hedge against moves and dampen them, negative that they hedge '
      + 'with moves and amplify them. It is the sign of methodology 1\'s net gamma over the selected expirations interpolated '
      + 'at spot between the two bracketing strikes (the nearest strike\'s gamma when spot is outside them), not the sign of '
      + 'exposures.gex nor which side of gammaFlip spot is on, and can disagree with both; only with fewer than two '
      + 'gamma-bearing strikes is it the sign of methodology 1\'s net gamma total, as it is when the route sent none. It is '
      + 'published only when that total\'s coverage (levels.coverage.gamma) is complete.'
      + (f.regime === 'neutral' ? ' "neutral" is a net gamma of exactly zero at that point (or a measured zero total): neither dampening nor amplifying.' : '')
      + (f.regime === null ? ' Null here: the regime is not established (that coverage is not complete - levels.status.dealerRegime names its status - or there is no total), which is not "neutral".' : '');
  g.magnet = 'gammaMagnet is the strike with the largest absolute net gamma in the window (ties to the lower strike).';
  // "its inverse": an evaluation found 0.041 over 236 strikes read as evenly spread
  g.concentration = 'gammaConcentration is the Herfindahl index of the strikes\' shares of absolute net gamma; its '
    + 'inverse is the effective number of equally weighted strikes, so it reads about 1 over the number of strikes only '
    + 'when gamma is spread evenly, and 1 when it all sits at one strike; null when there is no gamma.';
  const method = cov.gammaFlipMethod;
  // "not a coverage status": an evaluation found "mixed" read as the coverage
  const named = (m: string) => `The flip method (${covPath}.gammaFlipMethod, not a coverage status) is "${m}": `;
  const methodLine = method === 'repriced'
    ? named(method) + 'every leg recomputed from IV across the sweep.'
    : method === 'frozen-gamma'
      ? named(method) + 'no leg had a usable IV, so every published gamma was held constant.'
      : method === 'mixed'
        ? named(method) + 'some legs were repriced from their IV and the rest held their published gamma.'
        : method === null
          ? `The route reported no method (${covPath}.gammaFlipMethod null): whether any gamma was held is unknown.`
          : `${covPath}.gammaFlipMethod "${method}" is not one this tool names.`;
  g.flipMethod = 'The gamma flip is found by repricing the book across spot levels, and the method qualifies the level. '
    + methodLine
    + (method === 'frozen-gamma' || method === 'mixed' ? ' A held gamma is an approximation that can materially move the level or create one where there was none, even over complete coverage.' : '')
    + (method !== null ? ' A usable IV is finite, above 0 and at most 5 (500%), so a broker IV of 0 or above 5 counts as absent.' : '')
    + ` ${covPath}.gammaFlip counts every leg that entered the sweep, repriced or held: complete means every counted leg entered it, and it can read complete under "mixed" or "frozen-gamma"; the method, not the count, says whether legs were repriced or held.`;
  if (cov.gammaFlipSearchStatus === null) {
    g.flipSearch = `${covPath}.gammaFlipSearchStatus is null: no leg entered the search (every one excluded, as when the `
      + 'broker published no open interest) or the route reported no recognized status.';
  }
  if (f.rowsReturned) {
    g.rows = (v2 === null
      ? 'A row\'s callGex and putGex (the sides the walls are chosen from) are published only when its gamma '
        + 'coverage is complete or empty: coverage counts both sides together, so under partial coverage a side could be an '
        + 'unmeasured zero and both are null while the partial net stays. callOpenInterest and putOpenInterest are contracts '
        + 'summed over the window\'s expirations, null (not zero) when some leg at that strike has no published size. A row '
        + 'carries its coverage counts only when one of its statuses is not complete. '
      : 'A row\'s gex, putMinusCallDeltaBalance and vegaExposure are the methodology-2 book\'s at that strike, over its '
        + 'legs in the book; the row carries `coverage` only for a number that is not complete (partial: the legs included; '
        + 'unavailable: null). callOpenInterest and putOpenInterest are contracts summed over those legs, null (not zero) '
        + 'when some leg at that strike has no published size. ')
      + (shaped.window.expirations.length === 1
        ? 'With one expiration each row carries callDelta and putDelta, the broker\'s per-contract deltas (null when unpublished or outside 0 to 1 for a call, -1 to 0 for a put).'
        : 'Over several expirations callDelta and putDelta are null by design (a strike has one delta per expiration): not missing data.');
  }
  g.spotSides = shaped.spotSides === null
    ? 'spotSides is null: the route sent no split at spot.'
    : 'spotSides splits the book at spot: above holds strikes strictly above spot, below strictly below, and a strike exactly '
      + (v2 === null
        ? 'at spot (atSpotStrike) is in neither. Each side\'s netGex retains partial sums with its status; callGex and putGex '
          + 'are published only under complete or empty gamma coverage. callOpenInterest and putOpenInterest have their own '
        : 'at spot (atSpotStrike) is in neither. Each side\'s gex is the methodology-2 book\'s over its strikes, partial sums '
          + 'kept with coverage.gex where not complete. callOpenInterest and putOpenInterest have their own ')
      + 'coverage (a partial open interest is the sum of '
      + 'the sizes published, labelled partial); callOpenInterestShareAbove is the call open interest above spot over the '
      + (v2 === null ? 'window\'s' : 'book\'s') + ' call open interest (the at-spot strike in the whole), null unless every call leg\'s size is known.';
  if (shaped.levels.callWall !== null || shaped.levels.putWall !== null || shaped.levels.gammaMagnet !== null) {
    g.rowsAtLevels = v2 === null
      ? 'The walls and the magnet are chosen over every strike in the window (strikes.total of them), so they '
        + 'can sit outside the returned rows; such a level\'s own row is returned in strikes.atLevels, naming the level.'
      // under methodology 2 strikes.total counts the book's strikes, not the ones methodology 1 chose its levels from
      : 'The walls and the magnet (methodology 1) are chosen over every strike of the window\'s legs, so they can sit '
        + 'outside the returned rows; methodology 1 keys a strike to the cent, so such a level\'s rows are the '
        + 'methodology-2 book\'s strikes at it to the cent, where the book holds any, returned in strikes.atLevels naming the level.';
  }
  if (limited) {
    g.rowsLimited = 'Rows that would have carried the answer past its size limit were dropped farthest from spot first '
      + '(strikes.limitedBySize).';
  }
  if (shaped.strikes.inWindow !== null) {
    g.inWindow = 'strikes.inWindow counts the strikes inside the window or band, which exceeds strikes.returned when the '
      + 'cap or the size limit cut it.';
  }
  if (f.requestedWindowPct !== null && shaped.spotPrice === null) {
    g.windowPctNoSpot = 'strikeWindowPct was not applied: with no spot price there is no percent window, so the rows are '
      + 'the first strikes in strike order up to the cap, and strikes.windowPct and strikes.inWindow are null.';
  }
  if (entries.length > 0) {
    g.byExpiration = v2 === null
      ? 'Each byExpiration entry is computed alone on the same rows: netGex, netDex, callGex, putGex and '
        + 'grossGex (its strikes\' call and put gamma exposure sizes summed); daysToExpiration counts calendar days from '
        // "(a same-day share is 0DTE concentration)" was read as same-day dominance of netCharm.
        + 'today in New York (0 on the day); shareOfGrossGex is its share of the window\'s gross gamma (gamma only, not a '
        + 'share of netCharm), published only when every expiration\'s gamma coverage is complete. The sides and grossGex '
        + 'are null under partial gamma coverage; an expiration the broker answered with no options has unknown coverage '
        + 'and null values, and then no expiration gets a share.'
      : 'Each byExpiration entry\'s `exposures` is the methodology-2 book\'s over that expiration\'s legs in it: gex, '
        + 'putMinusCallDeltaBalance and longOiGex (the same gamma with every contract held long); shareOfLongOiGex is its '
        + 'share of the book\'s longOiGex (gamma only, not a share of charmFlow), published only when every expiration '
        + 'still in the book has complete gamma coverage and none was answered with no contracts; `coverage` names a number '
        + 'that is not complete. An expiration past its session\'s close or answered with no contracts has null `exposures` '
        + 'and says which in exposuresUnavailable. daysToExpiration counts calendar days from today in New York (0 on the day).';
    const anyNull = entries.some((e) => e.expectedMove === null);
    const anyMove = entries.some((e) => e.expectedMove !== null);
    g.expectedMove = 'expectedMove is the at-the-money straddle: the call and put midpoints at the strike nearest spot that '
      + 'lists both (ties lower), summed as straddle, with lower and upper at spot minus and plus it and pctOfSpot its '
      + 'fraction of spot - the market\'s price for a move by that expiration, not a forecast; never from a farther '
      + 'strike, a mark or a last trade.'
      + (anyNull ? ' A null expectedMove carries expectedMoveUnavailable: "atm-quote-missing" (that strike lacks a two-sided quote on a leg) or "no-strike-with-both-legs"; null beside it means the reason was not reported.' : '')
      + (anyMove ? ' atmIv is the mean of the two legs\' usable IVs, or the one usable leg\'s IV when only one has one, null only when neither has one; ivOneSigma is spot x atmIv x sqrt(years to expiry) (null with atmIv); near the money the straddle is about 0.8 of it while the market is open, but on a closed market the straddle is the broker\'s last prices while ivOneSigma uses the time left now, so the ratio drifts; outside trading hours the midpoints are the broker\'s last quotes.' : '');
  }
  const anyEvents = shaped.events !== null || entries.some((e) => e.events !== null);
  const anyEventsNull = shaped.events === null || entries.some((e) => e.events === null);
  if (anyEvents) {
    g.events = 'events flags what falls between today (New York) and each expiration, the day included: earningsOnOrBefore '
      + '(the first earnings date on file) and exDividendOnOrBefore (the first ex-dividend date on file, its per-share '
      + 'amount, declared false when no declaration dated on or before today is on file); the top-level events lists the '
      + 'dates on file from `from` through `through`. An empty list or a null date means none on file, not none scheduled: '
      + 'earnings are on file only '
      + 'once known and mostly for operating companies, the release time of day is not on file, and ex-dividend dates are '
      + 'not complete ahead of time (a fund\'s often appears only on or after the day), so for a fund or ETF an empty or '
      + 'null events answer says little.';
  }
  if (anyEventsNull) {
    // "unknown, not no events" and the lookup clause: an evaluation found a separate lookup's empty
    // answer read as none scheduled
    g.eventsUnread = 'events null (top level or on an entry) means the calendar could not be read - unknown, not no '
      + 'events; the exposure is unaffected (the dates feed no number), and a separate dividends or earnings lookup '
      + 'lists only the dates on file, so finding none there does not show that none is scheduled.';
  }
  if (entries.some((e) => e.expectedMove === null || e.expectedMove?.root !== undefined)) {
    g.roots = 'On a date listed under several roots (SPX and SPXW) each root\'s contracts are their own rows with their own '
      + 'Greeks and open interest; exposures are computed per contract then summed per strike, never merged across roots '
      + '(settlement and the last trading day differ), every row timed to the engine\'s close for that date '
      + '(4:00 PM New York on a regular day), an AM-settled '
      + 'series included; that date\'s expectedMove is the primary root\'s (the most open interest over the date), named in root.';
  }
  g.strikeCounts = 'window.strikesUsed counts the strike rows the broker returned, one per strike per expiration (per root '
    + (v2 === null
      ? 'on a multi-root date); coverage.strikes counts those with at least one leg not known to have zero open interest '
        + '(the rows in the totals); strikes.total counts the distinct strikes among them (what rows are chosen from). A null '
      : 'on a multi-root date); levels.coverage.strikes counts those with at least one leg not known to have zero open '
        + 'interest (the rows in methodology 1\'s totals); strikes.total counts the distinct strikes with such a leg in the '
        + 'methodology-2 book (what rows are chosen from). A null ')
    + 'count was not reported.';
  if (shaped.window.expirationSelection !== 'requested') {
    g.windowRoll = 'In the default window, from 4:15 PM New York on an expiration day (when no expiring series trades: some '
      + 'ETF options, SPY\'s included, until 4:15; stock options at 4:00 in regular hours, 4:15 for a Cboe curb-session '
      + 'class; PM-settled index options at 4:00) that day\'s expiration is left out, so after the close the window is the '
      + 'next session\'s book; early closes are not known (it stays until 4:15), it is kept if the broker lists nothing else, '
      + (v2 === null
        ? 'and naming it with expiration shows the book as it closed.'
        : 'and naming it with expiration shows methodology 1\'s levels as it closed, while the methodology-2 book holds none '
          + 'of its legs once its session has closed (exposureScope).');
  }
  g.windowMoves = 'The window moves with the broker\'s list and the clock (a listing expires, reaches 4:15 PM, or a nearer one '
    + 'is added), so two answers across such a change cover different books; the live figure can differ in sign from the '
    + '0-60 day figure on file (a different window on a different session).';
  g.clock = 'Time to expiry is measured from the wall clock when the chain rows are built, moments before asOf; outside '
    + 'trading hours the quotes are the broker\'s last, so the repriced flip and the time-sensitive totals drift a little '
    + 'between calls with no new quotes. The broker\'s Greeks and IVs can be a snapshot older than asOf (the fetch time) '
    + 'and nothing here dates them; a post-close refresh can move levels and totals at an unchanged spot, and the answer '
    + 'does not say whether a change is a refresh or the market. Between refreshes only spot and the clock move the totals '
    + (v2 === null
      ? '(r, q, open interest and the summed legs unchanged): per-strike gamma scales with spot squared exactly, netGex to '
        + 'its rounding.'
      // the book's legs change with the clock: an expiration leaves it at its session's close
      : '(r, q and open interest unchanged), and the clock also takes an expiration\'s legs out of the book at its session\'s '
        + 'close, so gex can fall at an unchanged spot; between such changes per-strike gamma scales with spot squared '
        + 'exactly, gex to its rounding.');
  if (provider === 'tradier' || provider === null) {
    g.tradierGreeks = (provider === null ? 'If the broker is Tradier, it refreshes its Greeks about hourly' : 'Tradier refreshes its Greeks about hourly')
      + `; the engine computes vanna, ${v2 === null ? 'charm' : 'charmFlow'} and vomma from IV and time to expiry, so those totals can change with spot `
      + 'and the clock between refreshes.';
  }
  g.cache = 'The short cache is per proxy instance and per account and broker, so a quick repeat can also be computed '
    + 'afresh (a new asOf), and another account\'s call never shares it.';
  if (provider === 'moomoo' || provider === null) {
    g.moomooDelay = (provider === null ? 'If the broker is moomoo: ' : '')
      + 'moomoo serves US option quotes in real time only once the moomoo account holds assets or a US position; until then '
      + 'they may be delayed about 15 minutes with nothing in the data saying so, so read moomoo option prices on such an '
      + 'account as possibly delayed.';
  }
  // The close is named as the engine's for the date, with only the regular day's time:
  // the proxy's early-close clock and this server deploy apart, so no line states a date rule the deployed
  // proxy may not share.
  const sameDay = entries.some((e) => e.daysToExpiration === 0 || e.daysToExpiration === null)
    || (entries.length === 0 && shaped.window.expirations.length > 0);
  if (sameDay) {
    // An evaluation found the 4:15 window and the charm possibilities read as a same-day reading: the possibilities
    // follow "not a reading of this answer". An evaluation found the legs' exit, leading, displacing the swing: the swing
    // rule leads. An evaluation found the lead repeated beside "steady dealer buying into the close": the baseline had
    // drawn its conclusion from an example no longer in the tool description, so the guide states the conclusion.
    g.sameDay = v2 !== null ? SAME_DAY_V2 : 'On same-day legs, vanna, charm and vomma change sharply with small spot moves and time to expiry: '
      + 'one netCharm reading is not a steady rate into the close. A same-day '
      + 'expiration\'s legs leave vanna, charm and vomma one minute before the '
      + 'engine\'s close for that date (4:00 PM New York on a regular day) and stay in gamma, delta and vega; the expiration '
      + 'itself stays in the default window until 4:15 PM New York, so from then until 4:15 those three totals neither '
      + 'include nor move with its legs. netCharm is not split by expiration; over several expirations this answer '
      + 'does not show its same-day share; as general possibilities, not a reading of this answer: charm near the money can be the '
      + 'largest term in the book, a same-day leg\'s vanna changes sign near its strike, and on an expiration afternoon '
      + 'netCharm can be mostly the same-day legs and the clock. The flip sweep reprices each leg at its '
      + 'time to expiry floored at one minute, so same-day legs\' repriced gamma narrows onto their strikes until one '
      + 'minute before that close and holds that shape after it (4:15 PM is the default-window cutoff, not a '
      + 'repricing boundary; named expirations and those with no later listing are kept): the flip moves with the clock.';
  }
  if (shaped.window.expirationSelection === 'requested' && entries.some((e) => e.daysToExpiration === 0 || e.daysToExpiration === null)) {
    g.sameDayNamed = v2 === null
      ? 'Named after the close, an expiration\'s expired legs are inside the totals and levels; window.expirations '
        + 'beside asOf is the only sign of it.'
      : 'Named after its session\'s close, an expiration\'s legs are out of the methodology-2 book (exposureScope) but '
        + 'inside methodology 1\'s levels.';
  }
  if (v2 !== null) {
    // methodology 2's numbers: their own shortfall (exposures.coverage lists only what is not complete)
    if (v2.exposures !== null && v2.exposures.coverage !== undefined) {
      g.legEligibility = 'A leg counts toward vanna, charmFlow and vomma only while its broker IV is above 1% and at most '
        + '500% and more than a minute remains before its session\'s close, and toward gex, putMinusCallDeltaBalance and '
        + 'vegaExposure only while the broker publishes that Greek; a leg of unknown size counts toward none. So a partial '
        + 'number\'s included count moves, and two partial numbers minutes apart can differ by which legs were summed, which '
        + 'the answer does not name.';
    }
  } else if (['gamma', 'delta', 'vega', 'vanna', 'charm', 'vomma'].some((k) => cov[k].status === 'partial' || cov[k].status === 'unmeasured')) {
    g.legEligibility = 'A leg counts toward vanna, charm and vomma only while its broker IV is above 1% and at most 500% and '
      + 'more than a minute remains before the engine\'s close for its expiration day (4:00 PM New York on a regular '
      + 'day), and toward gamma, delta and vega only '
      + 'while the broker publishes that Greek; so a partial total\'s included count moves, and two partial totals minutes '
      + 'apart can differ by which legs were summed, which the answer does not name.';
  }
  const resolved = shaped.resolved !== null && typeof shaped.resolved === 'object' ? shaped.resolved : null;
  g.inputs = resolved === null
    ? 'The route reported no resolved inputs; r and q are never defaulted, because the flip is a repricing that depends on them.'
    : 'r and q are resolved from real market data or supplied, never defaulted, because the flip is a repricing that depends '
      + 'on them; resolved reports the value, source and date used.';
  const r = resolved?.r;
  if (r !== null && typeof r === 'object' && r.source !== 'supplied') {
    g.rateSource = 'resolved.r is the newest stored 3-month Treasury yield (FRED), whatever its age: FRED posts a business '
      + 'day\'s value the next business day and the platform syncs it each weekday evening, so resolved.r.asOf is usually one '
      + 'or two sessions back; an older date can mean the sync is behind, a delayed publication or a withdrawn newer '
      + 'observation, and the answer carries no warning either way.'
      + (r.asOf === null ? ' Its date is unknown here (resolved.r.asOf null).' : '');
  }
  if (resolved?.q !== null && typeof resolved?.q === 'object' && resolved.q.source === 'profile_yield') {
    g.profileYield = 'resolved.q.source "profile_yield": no usable trailing yield was resolved, so q is the trailing annual '
      + 'dividend over the live spot - it moves slightly with spot between calls - and resolved.q.asOf is when that profile '
      + 'record was last updated, not when the division was made.';
  }
  if (resolved?.S !== null && typeof resolved?.S === 'object') g.spotClock = spotClockGuide(provider);
  if (f.rateLimitGiven) {
    const budget = rateLimitGuide(f.rateLimit);
    if (budget) {
      g.rateLimit = budget + (provider === 'moomoo' || provider === 'tastytrade' || provider === null
        ? ' moomoo reserves and settles to what it spent (about three fully cold calls a minute on its 30, more once its '
          + 'contract lists are cached for the day, the settle refunding the rest); a tastytrade or moomoo chain longer than '
          + 'its reservation reserves the rest once its count is known, before its quote batches, and is refused '
          + 'RATE_LIMITED with the wait when the budget cannot hold them. A call bigger than the whole budget (four very '
          + 'large tastytrade chains) runs alone on an empty window, charged in full, waiting for a reset only while '
          + 'something else is in it.'
        : '');
    }
  }
  return g;
}

