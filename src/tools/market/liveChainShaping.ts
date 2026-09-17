/**
 * Shape a LIVE single-expiration chain for a model.
 *
 * NOT optionsChainShaping. That one reads `contracts[]` with `optionType`,
 * `impliedVolatility`, `dte` and `optionSymbol`; a live chain returns `calls`
 * and `puts` of NormalizedOption, which has `type`, `iv`, and neither of the
 * other two. Its value is also multi-expiration structure - term structure and
 * skew across the curve - which degenerates to nothing on a single expiration.
 *
 * SHAPING IS MANDATORY HERE, not a convenience. One SPY expiration is 300-1000
 * contracts at roughly 200 bytes; MAX_RESPONSE_BYTES is 50KB, and the size
 * guard's fallback truncates to the lowest strikes, which for SPY means a wall
 * of deep-ITM calls and no strikes near the money at all. That is a worse
 * answer than a summary, not a smaller one.
 *
 * Everything here is a real row from the chain. Nothing is interpolated,
 * averaged into a synthetic contract, or filled in when absent - a missing
 * quote stays null, because a model relaying "the 25-delta put is bid 1.20"
 * must be repeating a quote that existed.
 */

export interface LiveOption {
  strike?: number | null;
  type?: string | null;
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  mid?: number | null;
  /** The broker's own published valuation. Never a midpoint we computed. */
  mark?: number | null;
  iv?: number | null;
  volume?: number | null;
  openInterest?: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
}

export interface LiveChainResponse {
  symbol?: string;
  expiration?: string;
  dataSource?: string;
  provider?: string;
  asOf?: string;
  spotPrice?: number | null;
  contractCount?: number;
  calls?: LiveOption[];
  puts?: LiveOption[];
}

export interface ShapeOptions {
  /** Strikes to keep either side of spot. */
  strikeRange?: number;
}

const DEFAULT_STRIKE_RANGE = 8;
const num = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Absence is now REAL, so nothing here has to guess.
 *
 * An earlier version read an exact zero as "missing", because BrokerService
 * zero-filled and the two were indistinguishable by the time they arrived. That
 * premise was false in both directions: a zero delta is legitimate at
 * expiration, and with deltas of 0 and 1 the wing selector picked 1 even though
 * 0 is nearer to 0.25. The fix belonged upstream, and it is there now -
 * NormalizedOption returns null when the broker published nothing - so a zero
 * that reaches this file is a zero the market actually quoted.
 */

/** One contract, trimmed to the fields a model can actually use. */
function row(option: LiveOption) {
  return {
    strike: num(option.strike),
    bid: num(option.bid),
    ask: num(option.ask),
    mid: num(option.mid),
    // Carried even when null, so the shape is the same on every row. A
    // one-sided market has no midpoint, and without this the model is told
    // there is no price for a contract the broker did in fact price.
    mark: num(option.mark),
    iv: num(option.iv),
    delta: num(option.delta),
    volume: num(option.volume),
    openInterest: num(option.openInterest),
  };
}

/** Null unless both sides were actually reported and the denominator is usable. */
function ratioOf(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || !(denominator > 0)) return null;
  return Number((numerator / denominator).toFixed(4));
}

function totals(options: LiveOption[]) {
  let volume = 0; let openInterest = 0; let quoted = 0;
  // Counts the broker did not publish are UNKNOWN, not zero. Folding them into
  // the sum made a side whose counts were all omitted indistinguishable from a
  // side that genuinely traded nothing, and a put/call ratio built from it read
  // as a real 0. The sum still covers what was reported; how much that leaves
  // out travels beside it.
  let volumeUnknown = 0; let openInterestUnknown = 0;
  for (const option of options) {
    const optionVolume = num(option.volume);
    const optionOpenInterest = num(option.openInterest);
    if (optionVolume === null) volumeUnknown += 1; else volume += optionVolume;
    if (optionOpenInterest === null) openInterestUnknown += 1; else openInterest += optionOpenInterest;
    // A two-sided zero is NO quote, not a quote of zero. Counting those made
    // `quoted` equal to `contracts` on a chain with no quotes at all.
    if ((num(option.bid) ?? 0) > 0 || (num(option.ask) ?? 0) > 0) quoted += 1;
  }
  return {
    contracts: options.length,
    quoted,
    // Null rather than 0 when NOTHING was reported: a total of zero over zero
    // reported contracts is not a measurement of an inactive book.
    volume: volumeUnknown === options.length && options.length > 0 ? null : volume,
    openInterest: openInterestUnknown === options.length && options.length > 0 ? null : openInterest,
    contractsMissingVolume: volumeUnknown,
    contractsMissingOpenInterest: openInterestUnknown,
  };
}

/** The listed strike closest to spot, by absolute distance. */
function nearestToSpot(options: LiveOption[], spot: number): LiveOption | null {
  let best: LiveOption | null = null;
  let bestDistance = Infinity;
  for (const option of options) {
    const strike = num(option.strike);
    if (strike === null) continue;
    const distance = Math.abs(strike - spot);
    if (distance < bestDistance) { best = option; bestDistance = distance; }
  }
  return best;
}

/**
 * The contract whose delta is closest to the target.
 *
 * Returns null when NO contract carries a delta, rather than falling back to a
 * strike-based guess: a "25-delta wing" that is not actually a 25-delta wing is
 * a number a model will quote as if it were one. Closed-market Schwab chains
 * report -999 IV and absent Greeks, so this genuinely happens.
 */
function nearestToDelta(options: LiveOption[], target: number): LiveOption | null {
  let best: LiveOption | null = null;
  let bestDistance = Infinity;
  for (const option of options) {
    const delta = num(option.delta);
    if (delta === null) continue;
    const distance = Math.abs(Math.abs(delta) - Math.abs(target));
    if (distance < bestDistance) { best = option; bestDistance = distance; }
  }
  return best;
}

function aroundSpot(options: LiveOption[], spot: number, range: number) {
  const withStrike = options
    .filter((o) => num(o.strike) !== null)
    .sort((a, b) => (num(a.strike)! - num(b.strike)!));
  if (withStrike.length === 0) return [];
  let pivot = 0;
  let bestDistance = Infinity;
  withStrike.forEach((option, index) => {
    const distance = Math.abs(num(option.strike)! - spot);
    if (distance < bestDistance) { pivot = index; bestDistance = distance; }
  });
  return withStrike.slice(Math.max(0, pivot - range), pivot + range + 1).map(row);
}

export function summarizeLiveChain(response: LiveChainResponse, options: ShapeOptions = {}) {
  const range = Math.max(0, options.strikeRange ?? DEFAULT_STRIKE_RANGE);
  const calls = Array.isArray(response.calls) ? response.calls : [];
  const puts = Array.isArray(response.puts) ? response.puts : [];
  const spot = num(response.spotPrice);

  const callTotals = totals(calls);
  const putTotals = totals(puts);

  return {
    symbol: response.symbol ?? null,
    expiration: response.expiration ?? null,
    // PROVENANCE TRAVELS WITH THE SUMMARY. A model relaying a quote has to be
    // able to say where it came from and how old it is, and the summary is what
    // it will actually read - not the envelope it came in.
    dataSource: response.dataSource ?? null,
    provider: response.provider ?? null,
    asOf: response.asOf ?? null,
    spotPrice: spot,
    view: {
      shaped: true,
      strikeRange: range,
      note: `Near-the-money strikes plus 25-delta wings. ${callTotals.contracts + putTotals.contracts} contracts in the full chain.`,
    },
    totals: {
      calls: callTotals,
      puts: putTotals,
      // A ratio built from a side whose counts were never published is not a
      // ratio; withheld rather than reported as a confident number.
      putCallVolumeRatio: ratioOf(putTotals.volume, callTotals.volume),
      putCallOpenInterestRatio: ratioOf(putTotals.openInterest, callTotals.openInterest),
    },
    atm: spot === null ? null : {
      call: nearestToSpot(calls, spot) ? row(nearestToSpot(calls, spot)!) : null,
      put: nearestToSpot(puts, spot) ? row(nearestToSpot(puts, spot)!) : null,
    },
    wings: {
      call25Delta: nearestToDelta(calls, 0.25) ? row(nearestToDelta(calls, 0.25)!) : null,
      put25Delta: nearestToDelta(puts, 0.25) ? row(nearestToDelta(puts, 0.25)!) : null,
    },
    nearTheMoney: spot === null ? { calls: [], puts: [] } : {
      calls: aroundSpot(calls, spot, range),
      puts: aroundSpot(puts, spot, range),
    },
  };
}
