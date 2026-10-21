import { sanitizeMcpWireOutput, utf8ByteLength, WIRE_CEILING_BYTES } from '../helpers.js';
import { omittedRowsSentence, readOmittedRows } from './omittedRows.js';
import type { LiveRateLimit } from '../../proxy/liveApiClient.js';
import { INDEX_UNDERLYINGS, newYorkSession, rateLimitGuide, type Guide } from '../liveGuide.js';

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
  /** The contract's own OCC root, where the broker names it. */
  root?: string | null;
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
  /** When the spot printed, where the broker gives it, and whether that predates the last session's open. */
  spotTime?: string | null;
  spotStale?: boolean | null;
  contractCount?: number;
  /** The proxy withheld a blanket-zero open interest (every contract read 0): the figures are null and this says why. */
  openInterestUnpublished?: true;
  /** The OCC roots the rows are under: `roots` all of them, `root` the primary (the most open interest). Several when the date is listed under several series (SPX and SPXW), each contract then its own row under its own root. */
  root?: string | null;
  roots?: string[];
  /** Adjusted series (a digit root, a different deliverable) the proxy left out of the rows, each with its contract count. */
  excludedRoots?: Array<{ root: string; contracts: number }>;
  calls?: LiveOption[];
  puts?: LiveOption[];
}

export interface ShapeOptions {
  /** Strikes to keep either side of spot. */
  strikeRange?: number;
  /**
   * The live-broker budget after this call: given, it rides INSIDE the fit with the rows and
   * the guide, so the answer the guard measures is the answer that was fitted. Absent: no rateLimit field.
   */
  rateLimit?: LiveRateLimit | null;
  /** True when the caller named no expiration, so the book is the nearest one that may still trade. */
  expirationOmitted?: boolean;
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

/**
 * The band inside which a published implied volatility is a volatility.
 *
 * The same rule as the exposure engine (packages/shared exposure-compute
 * isUsableIV) and the proxy's capIv: finite, above 0, at most 5 (500%).
 * Brokers publish sentinels for contracts their solver could not price: seen
 * live on SPY after hours, a 0DTE deep-ITM call at `iv: 10, delta: 1` and
 * deep-ITM puts at `iv: 0` beside real deltas (a mid below intrinsic has no
 * IV). Those reached the model as a 1000% and a 0% vol. The IV is reported
 * as absent, and the totals say how many were; the quote beside it is real and
 * stays. The Greeks beside it come from the same failed solve (delta 1 with
 * gamma and vega 0 are the zero-vol limits, not measurements: the final live
 * re-run's XSP 762-764 calls), so a row withholds them too (see `row`).
 */
export function usableIv(value: unknown): number | null {
  const iv = num(value);
  return iv !== null && iv > 0 && iv <= 5 ? iv : null;
}

/**
 * One contract, trimmed to the fields a model can actually use. `primaryRoot`
 * is the chain's root when it names roots; `everyRoot` is set on a date listed
 * under several, where each row is a different series' contract and names it.
 */
function row(option: LiveOption, primaryRoot: string | null = null, everyRoot = false) {
  const iv = usableIv(option.iv);
  // A contract whose IV is not usable (unpublished, or a solver sentinel)
  // carries Greeks from the same failed solve: withheld, with the reason,
  // wherever the broker published any. Display only; positioning and the scan
  // read the proxy's chain under their own rules.
  const published = [option.delta, option.gamma, option.theta, option.vega].some((value) => num(value) !== null);
  const withheld = iv === null && published;
  const greek = (value: unknown): number | null => (withheld ? null : num(value));
  // A mid only where both sides are quoted above zero, get_live_quote's rule:
  // a zero bid is nobody bidding, and the midpoint of it and the ask (0 and
  // 0.01 make 0.005) is no price anyone can trade at. Display only; the scan
  // computes its own midpoint from bid and ask under its stated leg rule.
  const bid = num(option.bid);
  const ask = num(option.ask);
  const twoSided = bid !== null && ask !== null && bid > 0 && ask > 0;
  return {
    strike: num(option.strike),
    // Under several roots every row names its own, null where the broker named
    // none: two rows at one strike are two series' contracts. Under one, named
    // only where it differs, so silence always means the chain's root.
    ...(primaryRoot === null ? {} : typeof option.root === 'string' ? (everyRoot || option.root !== primaryRoot ? { root: option.root } : {}) : { root: null }),
    bid,
    ask,
    mid: twoSided ? num(option.mid) : null,
    // Carried even when null, so the shape is the same on every row. A
    // one-sided market has no midpoint, and without this the model is told
    // there is no price for a contract the broker did in fact price.
    mark: num(option.mark),
    // The broker's last trade: never a stand-in for mid (the adapters keep it
    // separate), and it can be hours old on a thin contract.
    last: num(option.last),
    iv,
    delta: greek(option.delta),
    // As published, in the broker's units. Nineteenth run: these were dropped
    // here while every adapter mapped them, so the live chain's Greeks were
    // delta alone.
    gamma: greek(option.gamma),
    theta: greek(option.theta),
    vega: greek(option.vega),
    ...(withheld ? { greeksReason: 'iv-unusable' as const } : {}),
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
  let volumeUnknown = 0; let openInterestUnknown = 0; let ivUnusable = 0;
  for (const option of options) {
    const optionVolume = num(option.volume);
    const optionOpenInterest = num(option.openInterest);
    if (optionVolume === null) volumeUnknown += 1; else volume += optionVolume;
    if (optionOpenInterest === null) openInterestUnknown += 1; else openInterest += optionOpenInterest;
    if (usableIv(option.iv) === null) ivUnusable += 1;
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
    // Unpublished, or published outside the usable band (see usableIv).
    contractsWithoutUsableIv: ivUnusable,
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
    // Only a delta the row would show: a contract whose IV is not usable has
    // its Greeks withheld (see `row`), so its delta chooses nothing either.
    if (delta === null || usableIv(option.iv) === null) continue;
    const distance = Math.abs(Math.abs(delta) - Math.abs(target));
    if (distance < bestDistance) { best = option; bestDistance = distance; }
  }
  return best;
}

function aroundSpot(options: LiveOption[], spot: number, range: number, primaryRoot: string | null = null, roots: string[] | null = null) {
  const withStrike = options
    .filter((o) => num(o.strike) !== null)
    .sort((a, b) => (num(a.strike)! - num(b.strike)!));
  if (withStrike.length === 0) return [];
  const several = roots !== null && roots.length > 1;
  // Under several roots a strike has a row per series: the window is `range`
  // STRIKES either side, every series' row at each, the primary's first.
  const points = several ? [...new Set(withStrike.map((o) => num(o.strike)!))] : withStrike.map((o) => num(o.strike)!);
  let pivot = 0;
  let bestDistance = Infinity;
  points.forEach((strike, index) => {
    const distance = Math.abs(strike - spot);
    if (distance < bestDistance) { pivot = index; bestDistance = distance; }
  });
  if (!several) return withStrike.slice(Math.max(0, pivot - range), pivot + range + 1).map((option) => row(option, primaryRoot));
  const kept = new Set(points.slice(Math.max(0, pivot - range), pivot + range + 1));
  const rank = (option: LiveOption): number => {
    const at = typeof option.root === 'string' ? [primaryRoot, ...roots.filter((root) => root !== primaryRoot)].indexOf(option.root) : -1;
    return at === -1 ? roots.length + 1 : at;
  };
  return withStrike
    .filter((option) => kept.has(num(option.strike)!))
    .sort((a, b) => (num(a.strike)! - num(b.strike)!) || (rank(a) - rank(b)))
    .map((option) => row(option, primaryRoot, true));
}

export function summarizeLiveChain(response: LiveChainResponse, options: ShapeOptions = {}) {
  const range = Math.max(0, options.strikeRange ?? DEFAULT_STRIKE_RANGE);
  const calls = Array.isArray(response.calls) ? response.calls : [];
  const puts = Array.isArray(response.puts) ? response.puts : [];
  const spot = num(response.spotPrice);

  const callTotals = totals(calls);
  const putTotals = totals(puts);
  const roots = Array.isArray(response.roots) && response.roots.length > 0 ? response.roots : null;
  const primaryRoot = roots !== null && typeof response.root === 'string' ? response.root : null;
  // A date under several roots holds several series: the at-the-money pair and
  // the wings are one series' (the primary's), never one root's call beside
  // another's put; every row names its root.
  const severalRoots = roots !== null && roots.length > 1;
  const primaryCalls = severalRoots && primaryRoot !== null ? calls.filter((option) => option.root === primaryRoot) : calls;
  const primaryPuts = severalRoots && primaryRoot !== null ? puts.filter((option) => option.root === primaryRoot) : puts;
  const one = (option: LiveOption) => row(option, primaryRoot, severalRoots);
  // One root that is not the symbol's own spelling (SPXW on an SPX weekly) is
  // worth a sentence: the root is the settlement. AAPL under AAPL is not.
  const ownSpelling = typeof response.symbol === 'string' ? response.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
  const singleForeignRoot = roots !== null && roots.length === 1 && primaryRoot !== null && primaryRoot !== ownSpelling ? primaryRoot : null;
  // A row the broker named no root for is not under it, and goes out root null.
  const rootedContracts = [...calls, ...puts].filter((option) => option.root === primaryRoot).length;
  const omitted = readOmittedRows((response as { omittedRows?: unknown }).omittedRows);
  const excluded = Array.isArray(response.excludedRoots) && response.excludedRoots.length > 0
    ? response.excludedRoots
        .filter((entry) => typeof entry?.root === 'string' && typeof entry?.contracts === 'number')
        .map((entry) => ({ root: entry.root, contracts: entry.contracts }))
    : null;

  const body = (effective: number) => ({
    symbol: response.symbol ?? null,
    expiration: response.expiration ?? null,
    // PROVENANCE TRAVELS WITH THE SUMMARY. A model relaying a quote has to be
    // able to say where it came from and how old it is, and the summary is what
    // it will actually read - not the envelope it came in.
    dataSource: response.dataSource ?? null,
    provider: response.provider ?? null,
    asOf: response.asOf ?? null,
    spotPrice: spot,
    // When the spot printed and whether that predates the last session's
    // open: the at-the-money pair and the strike window are read against it.
    spotTime: typeof response.spotTime === 'string' ? response.spotTime : null,
    spotStale: typeof response.spotStale === 'boolean' ? response.spotStale : null,
    // Carried on purpose: this answer is rebuilt by hand, and a null open
    // interest without its reason reads as a broker that published nothing.
    ...(response.openInterestUnpublished === true ? { openInterestUnpublished: true as const } : {}),
    ...(roots !== null ? { root: primaryRoot, roots } : {}),
    ...(excluded !== null ? { excludedRoots: excluded } : {}),
    ...(omitted !== null ? { omittedRows: omitted } : {}),
    view: {
      shaped: true,
      strikeRange: effective,
      requestedStrikeRange: range,
      narrowedForSize: effective < range,
      note: `Near-the-money strikes plus 25-delta wings. ${callTotals.contracts + putTotals.contracts} contracts in the full chain.`
        + (response.spotStale === true ? ' The spot printed before the last session\'s open (spotTime), so the at-the-money pair and the strike window are read against a stale price.' : '')
        + (response.openInterestUnpublished === true ? ' Open interest withheld: every contract read zero at the broker, an unpublished figure, not an empty book; the nonempty sides\' openInterest and putCallOpenInterestRatio are null (unknown, not zero), and the withholding applies only to a chain of at least 20 contracts.'
          + (callTotals.contracts === 0 || putTotals.contracts === 0 ? ' An empty side still has openInterest 0 over 0 contracts.' : '') : '')
        + (severalRoots ? ` The date is listed under the ${roots!.join(' and ')} roots, different series (their settlement and the day their trading stops differ): each row is one contract under its own \`root\`, so a strike shows a row per root, never merged; the at-the-money pair and the 25-delta wings are the ${primaryRoot ?? 'primary'} root's (the most open interest), and the totals count every root's contracts.` : '')
        + (singleForeignRoot !== null
          ? (rootedContracts === calls.length + puts.length
            ? ` Every contract is under the ${singleForeignRoot} root, not ${ownSpelling}.`
            : ` ${rootedContracts} of ${calls.length + puts.length} contracts are under the ${singleForeignRoot} root, not ${ownSpelling}; the rest name root null, none from the broker.`)
          : '')
        + (excluded !== null ? ' ' + excluded.map((entry) => `${entry.contracts} contracts under the ${entry.root} root`).join(' and ') + ' (an adjusted series, a different deliverable at the same strikes) are left out of the rows and the totals.' : '')
        + (omitted !== null ? ' ' + omittedRowsSentence(omitted, 'the rows and the totals') : '')
        // Why the window is narrower than asked.
        + (effective < range ? ' The rows at the requested range would exceed the response budget, so the window was narrowed evenly on both sides: view.strikeRange is the range returned.' : ''),
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
      call: nearestToSpot(primaryCalls, spot) ? one(nearestToSpot(primaryCalls, spot)!) : null,
      put: nearestToSpot(primaryPuts, spot) ? one(nearestToSpot(primaryPuts, spot)!) : null,
    },
    wings: {
      call25Delta: nearestToDelta(primaryCalls, 0.25) ? one(nearestToDelta(primaryCalls, 0.25)!) : null,
      put25Delta: nearestToDelta(primaryPuts, 0.25) ? one(nearestToDelta(primaryPuts, 0.25)!) : null,
    },
    nearTheMoney: spot === null ? { calls: [], puts: [] } : {
      calls: aroundSpot(calls, spot, effective, primaryRoot, roots),
      puts: aroundSpot(puts, spot, effective, primaryRoot, roots),
    },
  });
  // The budget and the guide are part of the answer the fit measures.
  const shape = (effective: number) => {
    const b = body(effective);
    const guide = chainGuide(b, { response, severalRoots, singleForeignRoot, excluded, options });
    return { ...b, ...('rateLimit' in options ? { rateLimit: options.rateLimit ?? null } : {}), guide };
  };

  // review: with gamma, theta, vega and last on every row, 81
  // rows a side of full-precision decimals on a dense grid (475 to 525 in
  // 0.5 steps) came to 53,291 bytes, and the generic size guard kept the
  // FIRST rows of each array, 480 to 504.5 of a requested 480 to 520. So the
  // window is narrowed here, evenly, to the widest range whose payload the
  // guard will pass whole (it measures the same sanitized compact JSON), and
  // `view` says so. A single row that cannot fit is left to the guard. The line is the guard's own,
  // WIRE_CEILING_BYTES: fitted to the full 51,200, an answer between the two would pass
  // here and then lose its last rows to the guard - the lopsided window this narrowing exists to prevent.
  const fits = (payload: unknown) =>
    utf8ByteLength(JSON.stringify(sanitizeMcpWireOutput(payload))) <= WIRE_CEILING_BYTES;
  let effective = range;
  let payload = shape(effective);
  while (effective > 0 && !fits(payload)) {
    effective -= 1;
    payload = shape(effective);
  }
  return payload;
}

type ShapedRow = Record<string, unknown> & { strike: number | null };

/**
 * The chain's guide emits each applicable reading rule under a stable key. Rows "shown"
 * are every contract row anywhere in it: the at-the-money pair, the wings (chosen without a spot) and the window.
 */
function chainGuide(
  b: Record<string, any>,
  ctx: { response: LiveChainResponse; severalRoots: boolean; singleForeignRoot: string | null; excluded: Array<{ root: string; contracts: number }> | null; options: ShapeOptions },
): Guide {
  const { response, severalRoots, singleForeignRoot, excluded, options } = ctx;
  const provider = response.provider ?? null;
  const symbol = typeof response.symbol === 'string' ? response.symbol.toUpperCase() : null;
  const spot: number | null = b.spotPrice;
  const callRows: ShapedRow[] = [b.atm?.call, b.wings.call25Delta, ...b.nearTheMoney.calls].filter(Boolean);
  const putRows: ShapedRow[] = [b.atm?.put, b.wings.put25Delta, ...b.nearTheMoney.puts].filter(Boolean);
  const shown = [...callRows, ...putRows];
  const any = (test: (row: ShapedRow) => boolean) => shown.some(test);
  const g: Guide = {};

  // The root rules.
  const roots: string[] | null = Array.isArray(b.roots) ? b.roots : null;
  const rootNull = any((row) => row.root === null);
  const rootLines: string[] = [];
  if (severalRoots) {
    rootLines.push('Under several roots every row names its root; the primary root (root) is the one with the most open '
      + 'interest over the date, the symbol\'s own root on a tie, as when the broker publishes no open interest.');
  }
  if (rootNull) rootLines.push('A row with root null is one the broker named no root for; it is not the primary root\'s.');
  if (roots !== null && roots.length === 1 && singleForeignRoot === null && rootNull) {
    rootLines.push('Under one root a row names root only where it differs: absent means the chain\'s root, null means '
      + 'the broker named none.');
  }
  if (rootLines.length) g.root = rootLines.join(' ');
  if (severalRoots || singleForeignRoot !== null || (symbol !== null && INDEX_UNDERLYINGS.has(symbol))) {
    g.settlement = 'The root is the series, and series settle differently (SPX monthly AM, SPXW at the close; VIX '
      + 'weeklies AM, XSP monthlies at the close): read the exchange\'s specification for the root, not a pattern.';
  }
  if (provider === 'public' && ((roots ?? []).includes('SPXW') || symbol === 'SPX')) {
    g.publicSpx = 'Public lists SPX\'s options under SPXW only, even on a third Friday, so an SPX monthly there is the '
      + 'PM-settled series.';
  }
  if (excluded !== null) {
    const empty = b.totals.calls.contracts + b.totals.puts.contracts === 0;
    g.excludedRoots = 'The rows keep the symbol\'s own root and the symbol plus one letter (SPXW, NDXP, RUTW, VIXW); an '
      + 'adjusted series (a digit root, a different deliverable) is left out.'
      + (empty ? ' Here the standard book is empty by listing, not an outage: the totals\' zeros over 0 contracts describe that empty book.' : '');
  }
  // Stated here, not by pointer to get_live_quote.
  const spotTimeNull = b.spotTime === null;
  const spotStaleNull = b.spotStale === null;
  if (spotTimeNull || spotStaleNull || provider === 'moomoo') {
    const lines = ['spotTime is the spot\'s print time where the spot is a last trade the broker timed, null for a close '
      + 'or a mark standing in for the last or when no time was given; spotStale is true when that predates the 09:30 '
      + 'New York open of the last session that has started, null when unknown - unknown, never fresh.'];
    if (provider === 'moomoo') lines.push('On moomoo spotTime is the underlying snapshot\'s update time, not a print.');
    g.spotClock = lines.join(' ');
  }
  const sides = [b.totals.calls, b.totals.puts];
  if (sides.some((t) => t.contractsMissingVolume > 0 || t.contractsMissingOpenInterest > 0 || t.volume === null || t.openInterest === null)
    || b.totals.putCallVolumeRatio === null || b.totals.putCallOpenInterestRatio === null) {
    g.totals = 'The volume and open-interest totals add up only what the broker reported; contractsMissingVolume and '
      + 'contractsMissingOpenInterest count the contracts it left out. A total is null (unknown, never 0) only when no '
      + 'contract on that side reported one, and a reported 0 is a genuine 0; the put/call ratios are null when either '
      + 'total is unknown or the call total is not above 0.';
  }
  if (shown.length) {
    g.last = 'last is the broker\'s last traded price: it can be hours old and never stands in for mid.'
      + (any((row) => row.last === null) ? ' A null last is no trade printed (a broker\'s 0 is no print and goes out null).' : '');
  }
  if (any((row) => row.mid === null)) {
    g.mid = 'mid is the exact (bid + ask) / 2 only where both sides are quoted above zero; a zero bid (nobody bidding) '
      + 'or a missing side leaves it null beside the ask and the broker\'s mark.';
  }
  const totalsNull = sides.some((t) => Object.values(t).some((v) => v === null))
    || b.totals.putCallVolumeRatio === null || b.totals.putCallOpenInterestRatio === null;
  if (totalsNull || any((row) => Object.values(row).some((v) => v === null))) {
    g.nullIsUnknown = 'A null field means the broker published nothing for it, which is different from zero, except '
      + 'where this tool withholds and says so: a mid without a two-sided market, the Greeks beside an IV this tool '
      + 'found unusable (greeksReason, set by this tool), an IV this tool nulled because the broker published a solver '
      + 'sentinel, a broker\'s last of 0, a blanket-zero open '
      + 'interest (openInterestUnpublished), and the unknown totals and ratios.';
  }
  if (any((row) => row.mark !== null && row.mark !== undefined)) {
    g.mark = 'mark is the broker\'s own valuation (Public\'s is its published mid), not an executable quote.';
  }
  if (provider === 'tradier' || provider === 'moomoo') {
    g.markUnpublished = 'Tradier and moomoo publish no mark, so mark is always null there: not zero, not missing data.';
  }
  if (sides.some((t) => t.contractsWithoutUsableIv > 0) || any((row) => row.iv === null)) {
    g.iv = 'iv is the broker\'s published IV where usable (finite, above 0, at most 5 = 500%). Published 0 or above-5 '
      + 'solver sentinels (deep in the money near expiration, after close) go out null; a shown iv passed this filter. '
      + 'totals.<side>.contractsWithoutUsableIv counts IVs never published together with rejected sentinels: null cannot say which.';
  }
  if (any((row) => row.greeksReason !== undefined)) {
    // A shown iv's row was read as withheld; the line says which rows are and which are not.
    // The zero-vol remark is tied to the withheld values (standalone it fits a shown row);
    // And only as a possibility - a missing IV establishes no solver failure.
    g.greeksWithheld = 'greeksReason "iv-unusable": this tool withholds Greeks for unusable or missing IV; a withheld '
      + 'delta 1 beside gamma/vega 0 can be a failed solve\'s zero-vol limit; the broker quote stays. A shown iv keeps '
      + 'available Greeks; broker no-data values can still be null.';
  }
  const wingNull = b.wings.call25Delta === null || b.wings.put25Delta === null;
  const wingShown = b.wings.call25Delta !== null || b.wings.put25Delta !== null;
  if (wingShown || wingNull) {
    const selection = severalRoots ? ' in the primary root' : '';
    g.wings = (wingShown ? `A 25-delta wing is the contract${selection} with the nearest |delta| to 0.25 among those with usable IV and a delta, with no tolerance cutoff; its delta is one the row shows.` : '')
      + (wingNull ? `${wingShown ? ' ' : ''}A null wing means no contract${selection} with a usable IV has a delta on that side; it is not "no options".` : '');
  }
  if (any((row) => ['delta', 'gamma', 'theta', 'vega'].some((k) => typeof row[k] === 'number'))) {
    g.greeks = 'Available Greeks beside usable IV are as published by the broker, not checked against the quote or the IV '
      + 'beside them; delta, gamma, theta and vega are in the broker\'s own units, not rescaled and not comparable '
      + 'across brokers; a broker\'s Greeks can be a snapshot refreshed about hourly, and can carry one theta for the '
      + 'call and the put at a strike.';
  }
  if (any((row) => row.delta === 0 || (typeof row.delta === 'number' && Math.abs(row.delta) === 1))) {
    g.deltaLimit = 'Delta exactly 0 or |delta| 1 may be a genuine limit or solver output; neither is established. Treat '
      + 'it as suspect beside the quote and IV: no check tells them apart.';
  }
  if (provider === 'moomoo') {
    g.moomooDelay = 'moomoo serves US option quotes in real time only once the moomoo account holds assets or a US '
      + 'position; until then they may be delayed (about 15 minutes) with nothing in the data saying so: read them as '
      + 'possibly delayed.';
  }
  // The outside-hours clause, always on, was applied to an in-session fetch. It is added only on a
  // fetch known to be outside regular hours (weekday clock or weekend; a holiday is not known here, so it reads as in
  // session and the clause is left out rather than asserted), and as a condition when the fetch time is unknown.
  const fetched = newYorkSession(b.asOf);
  g.asOf = 'asOf is the fetch time, not a quote time; quotes are not individually dated.'
    + (fetched === null
      ? ' Outside regular hours the quotes are the last the broker holds.'
        + (b.asOf === null ? ' asOf is null: the fetch time is unknown.' : '')
      : fetched.outsideRegularSession ? ' This fetch was outside regular hours: quotes are the last the broker holds.' : '');
  g.cache = 'A repeat for the same symbol and expiration on the same broker, by the same account, within 15 seconds can '
    + 'be answered from a short cache with the same asOf: no broker request, not charged, answered even on a spent '
    + 'budget; per proxy instance, account and broker, so a repeat can also be fetched afresh.';
  const belowIntrinsic = (rows: ShapedRow[], intrinsic: (strike: number) => number) => spot !== null
    && rows.some((row) => typeof row.bid === 'number' && row.strike !== null && row.bid < intrinsic(row.strike));
  if (belowIntrinsic(callRows, (k) => spot! - k) || belowIntrinsic(putRows, (k) => k - spot!)) {
    g.intrinsic = 'A bid can sit below intrinsic value against spotPrice during trading hours too; it is not a data error.';
  }
  // What a null spot leaves out, which no text covered.
  if (spot === null) {
    g.noSpot = 'spotPrice is null: the broker gave no usable spot, so no at-the-money pair or strike window can be read '
      + '(atm null, nearTheMoney empty); the 25-delta wings and the totals still come from the available contracts '
      + '(wings use only the primary root when several roots are listed; totals cover every root).';
  }
  if (spot !== null) {
    const source: Record<string, string> = {
      tradier: 'Tradier: last, else close', tastytrade: 'tastytrade: last, else close', public: 'Public: last',
      schwab: 'Schwab: underlying price, else last or mark', moomoo: 'moomoo: last, the regular session\'s',
    };
    g.spotPrice = `spotPrice is this broker's own underlying price (${provider !== null && source[provider] ? source[provider] : 'each broker\'s own source'}); `
      + 'outside regular hours a last can include extended-hours trades, so brokers can report different spots for one '
      + 'moment; moneyness and the Greeks follow this broker\'s spot, and open interest can also differ by broker.';
  }
  // At or after 16:00 New York or outside the regular session, keyed on the book's own fetch time; unknown: emit.
  const ny = newYorkSession(response.asOf);
  if (ny === null || ny.outsideRegularSession) {
    g.afterClose = 'Some ETF options, SPY\'s included, quote until 4:15 PM New York time, so between 4:00 and 4:15 and '
      + 'on the quotes held after, put-call parity can imply an underlying away from spotPrice.';
  }
  const expirationLines: string[] = [];
  if (options.expirationOmitted === true) {
    expirationLines.push('No expiration was named: the default selects the nearest listed one that may still trade, '
      + 'retaining the nearest listing if none remain open.');
  }
  if ((ny !== null && b.expiration === ny.date) || (ny === null && options.expirationOmitted === true)) {
    expirationLines.push('Default selection passes over the expiring day from 4:15 PM New York time when a later listed '
      + 'expiration remains open; if the broker lists nothing else, the expiring day is retained. A named expiration is '
      + 'never filtered. Early closes are not known, so the default cutoff remains 4:15 on those days. Expiring stock '
      + 'options stop at 4:00 in regular hours and at 4:15 for a class Cboe '
      + 'trades in its curb session, some expiring ETF options (SPY\'s included) trade until 4:15, and PM-settled index '
      + 'options stop at 4:00.');
  }
  if (expirationLines.length) g.expiration = expirationLines.join(' ');
  // The budget line, with the reservation mechanics where they apply.
  if ('rateLimit' in options) {
    const budget = rateLimitGuide(options.rateLimit ?? null);
    if (budget) {
      g.rateLimit = budget + (provider === 'tastytrade' || provider === 'moomoo'
        ? ' A tastytrade or moomoo chain longer than its reservation (12 requests on tastytrade, 2 on moomoo) reserves '
          + 'the rest once its count is known, before its quote batches, and is refused RATE_LIMITED when the budget '
          + 'cannot hold them; a call bigger than the whole budget runs alone on a window holding nothing else, charged '
          + 'in full, and waits for the reset only while something else is in the window.'
        : '');
    }
  }
  return g;
}

