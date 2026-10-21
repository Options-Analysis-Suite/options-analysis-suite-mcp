/**
 * Shape a live strategy scan (the proxy's /live/strategy-scan).
 *
 * The proxy prices and sorts the candidates; this keeps what it sent within
 * the response budget, gates the dealer levels on their coverage exactly as
 * get_live_dealer_positioning does, and adds each strike's and breakeven's
 * distance from spot, so a candidate can be read against the expected move
 * and the levels without arithmetic.
 */

import { MAX_RESPONSE_BYTES } from '../helpers.js';
import { exDividend, excludedRootsPhrase, isoDate, measuredLevel, measuredValue, metricCoverage, readExcludedRoots, readRegime, RESOLUTION_DIGITS, RESPONSE_MARGIN_BYTES, significant } from './dealerPositioningShaping.js';
import { readOmittedRows } from './omittedRows.js';
import type { LiveRateLimit } from '../../proxy/liveApiClient.js';
import { rateLimitGuide, spotClockGuide, type Guide } from '../liveGuide.js';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const probability = (v: unknown): number | null => {
  const p = num(v);
  return p !== null && p >= 0 && p <= 1 ? p : null;
};
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

export interface StrategyScanOptions {
  /**
   * The live-broker budget after this call: given, it rides INSIDE the fit with the candidates
   * and the guide. Absent: no rateLimit field.
   */
  rateLimit?: LiveRateLimit | null;
}

export function summarizeStrategyScan(response: Record<string, unknown>, options: StrategyScanOptions = {}) {
  const body = response ?? {};
  const spot = num(body.spotPrice);
  const pctFromSpot = (price: number | null) =>
    price === null || spot === null || spot <= 0 ? null : (price - spot) / spot * 100;

  const move = record(body.expectedMove);
  const lower = num(move.lower);
  const upper = num(move.upper);
  const expectedMove = body.expectedMove && typeof body.expectedMove === 'object' ? {
    strike: num(move.strike),
    callMid: num(move.callMid),
    putMid: num(move.putMid),
    straddle: num(move.straddle),
    lower,
    upper,
    // A fraction of spot, as get_live_dealer_positioning publishes it.
    pctOfSpot: num(move.pctOfSpot),
    atmIv: num(move.atmIv),
    ivOneSigma: num(move.ivOneSigma),
    // On a date listed under several roots (SPX and SPXW): the series the straddle is.
    ...(str(move.root) !== null ? { root: str(move.root) } : {}),
  } : null;

  // A date listed under several roots (SPX and SPXW) is scanned on one series,
  // the primary: every leg, the smile and the straddle are that root's. The
  // series settle differently, so the candidates are unidentified without it.
  const roots = arr(body.roots).filter((r): r is string => typeof r === 'string' && r !== '');
  const root = str(body.root);
  const severalRoots = roots.length > 1 && root !== null;
  // Adjusted series (a digit root, a different deliverable) the proxy left out
  // of the scanned chain and of the levels' window.
  const excludedRoots = readExcludedRoots(body.excludedRoots);
  const levelExcludedRoots = readExcludedRoots(record(body.levels).excludedRoots);

  // The levels are gated as get_live_dealer_positioning gates them: the flip
  // on the flip's own coverage, the walls and magnet on gamma coverage.
  const rawLevels = record(body.levels);
  const cov = record(rawLevels.coverage);
  const gammaCoverage = metricCoverage(cov.gamma);
  const flipCoverage = metricCoverage(cov.gammaFlip);
  const netGex = measuredValue(rawLevels.netGex, gammaCoverage);
  const flip = measuredLevel(rawLevels.gammaFlip, flipCoverage.status);
  const callWall = measuredLevel(rawLevels.callWall, gammaCoverage.status);
  const putWall = measuredLevel(rawLevels.putWall, gammaCoverage.status);
  const magnet = measuredLevel(rawLevels.gammaMagnet, gammaCoverage.status);
  const searchStatus = cov.gammaFlipSearchStatus;
  const resolution = num(cov.gammaFlipResolution);
  const levels = {
    scope: rawLevels.scope === 'expiration' || rawLevels.scope === 'window' ? rawLevels.scope : null,
    expirations: arr(rawLevels.expirations).filter((e): e is string => typeof e === 'string'),
    gammaFlip: flip.value,
    callWall: callWall.value,
    putWall: putWall.value,
    gammaMagnet: magnet.value,
    pctFromSpot: {
      gammaFlip: pctFromSpot(flip.value),
      callWall: pctFromSpot(callWall.value),
      putWall: pctFromSpot(putWall.value),
      gammaMagnet: pctFromSpot(magnet.value),
    },
    // dealerRegime's is its net gamma's, as the live tool's levelStatus.
    status: { gammaFlip: flip.status, callWall: callWall.status, putWall: putWall.status, gammaMagnet: magnet.status, dealerRegime: netGex.status },
    // How the flip was found and the step its search sampled at, the
    // resolution only with a flip to belong to.
    gammaFlipMethod: cov.gammaFlipMethod === 'repriced' || cov.gammaFlipMethod === 'frozen-gamma' || cov.gammaFlipMethod === 'mixed'
      ? cov.gammaFlipMethod : null,
    gammaFlipResolution: flip.value !== null && resolution !== null && resolution > 0 ? significant(resolution, RESOLUTION_DIGITS) : null,
    // The sign of gamma at spot, published only with a measured net gamma
    // under complete coverage, the live tool's own gate: complete coverage
    // with no finite net (an overflow serializes as null) is no measured book.
    dealerRegime: netGex.status === 'complete' ? readRegime(rawLevels.regime, netGex.value) : null,
    gammaFlipSearchStatus: flip.value === null && (searchStatus === 'found' || searchStatus === 'not-found' || searchStatus === 'unresolved')
      ? searchStatus
      : flip.value !== null ? 'found' : null,
    // The expirations whose open interest the broker did not publish (a zero
    // on every contract): the levels they feed are unmeasured, and this is why.
    ...(() => {
      const dates = arr(rawLevels.openInterestUnpublishedExpirations).map(isoDate).filter((e): e is string => e !== null);
      return dates.length > 0 ? { openInterestUnpublishedExpirations: dates } : {};
    })(),
    // A window date the broker answered with no contracts and rows it sent that could not be used, left out of the
    // levels; partial when a date or a quote could not be read.
    ...(rawLevels.partial === true ? { partial: true as const } : {}),
    ...(() => {
      const dates = arr(rawLevels.emptyExpirations).map(isoDate).filter((e): e is string => e !== null);
      return dates.length > 0 ? { emptyExpirations: dates } : {};
    })(),
    ...(() => {
      const omitted = readOmittedRows(rawLevels.omittedRows);
      return omitted !== null ? { omittedRows: omitted } : {};
    })(),
    // The status above measures the symbol's own contracts: "complete" never
    // includes an adjusted series the window's books left out, so it is named.
    ...(levelExcludedRoots !== null ? {
      excludedRoots: levelExcludedRoots,
      excludedRootsNote: `${excludedRootsPhrase(levelExcludedRoots)} left out of the levels and their coverage, which measure the symbol's own contracts alone, so a "complete" status does not include them.`,
    } : {}),
  };

  const candidates = arr(body.candidates).map((value) => {
    const c = record(value);
    const legs = arr(c.legs).map((l) => {
      const leg = record(l);
      const strike = num(leg.strike);
      return {
        action: leg.action === 'sell' || leg.action === 'buy' ? leg.action : null,
        type: leg.type === 'call' || leg.type === 'put' ? leg.type : null,
        strike,
        pctFromSpot: pctFromSpot(strike),
        bid: num(leg.bid), ask: num(leg.ask), mid: num(leg.mid), spreadPct: num(leg.spreadPct),
        iv: num(leg.iv), delta: num(leg.delta), gamma: num(leg.gamma), theta: num(leg.theta), vega: num(leg.vega),
        openInterest: count(leg.openInterest), volume: count(leg.volume),
      };
    });
    const position = record(c.position);
    const liquidity = record(c.liquidity);
    const greek = (v: unknown) => { const n = num(v); return n === null ? null : significant(n); };
    return {
      legs,
      anchorDelta: num(c.anchorDelta),
      width: num(c.width),
      netMid: num(c.netMid),
      netNatural: num(c.netNatural),
      // What crossing every leg at the natural price gives up, in percent of the mid.
      naturalSlippagePct: num(c.naturalSlippagePct),
      maxProfit: num(c.maxProfit),
      maxLoss: num(c.maxLoss),
      returnOnRisk: num(c.returnOnRisk),
      breakevens: arr(c.breakevens).map((b) => {
        const price = num(record(b).price);
        return {
          price,
          pctFromSpot: pctFromSpot(price),
          // Outside the ATM straddle's range: the market prices a move past it.
          outsideExpectedMove: price === null || lower === null || upper === null ? null : price < lower || price > upper,
        };
      }),
      probabilityOfProfit: probability(c.probabilityOfProfit),
      probabilityOfMaxProfit: probability(c.probabilityOfMaxProfit),
      // The thinnest leg's open interest and the widest leg's spread.
      liquidity: {
        minOpenInterest: count(liquidity.minOpenInterest),
        maxSpreadPct: num(liquidity.maxSpreadPct) !== null && num(liquidity.maxSpreadPct)! >= 0 ? num(liquidity.maxSpreadPct) : null,
      },
      position: {
        delta: greek(position.delta), gamma: greek(position.gamma), theta: greek(position.theta), vega: greek(position.vega),
        source: position.source === 'model' || position.source === 'broker' ? position.source : null,
      },
    };
  });

  const request = record(body.request);
  const skipped = Object.fromEntries(Object.entries(record(body.skipped))
    .map(([reason, n]) => [reason, count(n)] as const)
    .filter(([, n]) => n !== null && n > 0));

  const shaped = {
    symbol: str(body.symbol),
    dataSource: 'live' as const,
    provider: str(body.provider),
    asOf: str(body.asOf),
    expiration: str(body.expiration),
    daysToExpiration: count(body.daysToExpiration),
    spotPrice: spot,
    // The scanned chain's rows the broker sent that could not be used: no candidate is built on them.
    ...(() => {
      const omitted = readOmittedRows(body.omittedRows);
      return omitted !== null ? { omittedRows: omitted } : {};
    })(),
    ...(severalRoots ? {
      root,
      roots,
      rootNote: `The date is listed under the ${roots.join(' and ')} roots, different series (their settlement and the day their trading stops differ): every candidate's legs, the smile its probabilities read and the expected move are the ${root} root's (the most open interest), so the contracts are ${root}'s.`,
    } : {}),
    ...(excludedRoots !== null ? {
      excludedRoots,
      excludedRootsNote: `${excludedRootsPhrase(excludedRoots)} left out of the scanned chain: no candidate is built on them.`,
    } : {}),
    // A spot that printed before the last session's open skews everything read
    // against it; resolved.S carries the flag, and this says what it touches.
    ...(record(record(body.resolved).S).stale === true
      ? { spotNote: "The spot printed before the last session's open (resolved.S.asOf, the broker's own time), so every pctFromSpot, the expected move and each breakeven's place against it are read against a stale price." }
      : {}),
    strategy: str(request.strategy),
    request: {
      deltaMin: num(request.deltaMin), deltaMax: num(request.deltaMax), width: num(request.width),
      minOpenInterest: num(request.minOpenInterest), maxSpreadPct: num(request.maxSpreadPct), minCredit: num(request.minCredit),
      maxNaturalSlippagePct: num(request.maxNaturalSlippagePct),
      sortBy: str(request.sortBy), maxResults: count(request.maxResults), levels: str(request.levels),
    },
    expectedMove,
    expectedMoveUnavailable: str(body.expectedMoveUnavailable),
    levels,
    // What falls between today and the expiration, as get_live_dealer_positioning
    // reports it: null when the calendar could not be read.
    events: (() => {
      if (body.events === null || typeof body.events !== 'object') return null;
      const raw = record(body.events);
      return {
        from: isoDate(raw.from),
        through: isoDate(raw.through),
        earningsOnOrBefore: isoDate(raw.earningsOnOrBefore),
        exDividendOnOrBefore: exDividend(raw.exDividendOnOrBefore),
      };
    })(),
    matched: count(body.matched),
    returned: 0,
    limitedBySize: false,
    skipped,
    candidates: [] as typeof candidates,
    units: {
      prices: 'per share; one contract is 100 shares',
      netMid: 'sold mids minus bought mids: positive is a credit, negative a debit',
      netNatural: 'sold bids minus bought asks, the price crossing every leg',
      position: 'one of each leg, times 100, signed for the position (sold legs negative): theta per calendar day, vega per vol point; source "model" is Black-Scholes at each leg\'s IV, "broker" the legs\' published Greeks',
      pctFromSpot: 'percent of spotPrice, signed (below spot is negative)',
      probabilities: 'risk-neutral, lognormal, at the chain\'s own implied volatility at each boundary: model values, not forecasts',
      // Add reading rules beside the units while preserving the existing definitions.
      ...scanUnits(candidates, expectedMove !== null),
    },
    resolved: body.resolved ?? null,
    // The proxy's own success warnings (on success the rate ladder's fallback): the shaper used to drop them.
    ...(warningsOf(body.warnings).length > 0 ? { warnings: warningsOf(body.warnings) } : {}),
    ...('rateLimit' in options ? { rateLimit: options.rateLimit ?? null } : {}),
    guide: {} as Guide,
  };
  shaped.candidates = candidates;
  shaped.returned = candidates.length;
  shaped.guide = scanGuide(shaped, options);

  // Fit the final count-dependent guide, budget and candidates together. In particular, an unknown matched count
  // gains its count line only once rows are removed; that line must not be added outside the measured payload.
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const budget = MAX_RESPONSE_BYTES - RESPONSE_MARGIN_BYTES;
  while (shaped.candidates.length > 1 && bytes(shaped) > budget) {
    shaped.candidates = shaped.candidates.slice(0, -1);
    shaped.returned = shaped.candidates.length;
    shaped.limitedBySize = true;
    shaped.guide = scanGuide(shaped, options);
  }
  return shaped;
}

const warningsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string') : []);

/** The rules whose destination is `units`: definitions beside the fields they govern. */
function scanUnits(candidates: Array<Record<string, unknown>>, withExpectedMove: boolean): Record<string, string> {
  const u: Record<string, string> = {
    anchorDelta: 'the anchor\'s absolute published delta; for a two-anchor candidate (iron condor, strangles) the mean of '
      + 'the two; for a body (straddle, iron butterfly) the call\'s; null when none was sent',
  };
  if (candidates.some((c) => c.width !== null && c.width !== undefined)) {
    u.width = 'the wing distance actually listed; for an iron condor or iron butterfly, the wider of its two wings (the '
      + 'legs\' strikes show both)';
  }
  u.legs = 'a leg\'s Greeks are the broker\'s as published, not checked against the quote, and can be a snapshot older '
    + 'than it; spreadPct is (ask - bid) over the mid, in percent, null when the mid is zero; iv is null when unpublished '
    + 'or unusable (0, or above 5)';
  u.payoff = 'payoff at expiration, from the mid: maxProfit or maxLoss null means unbounded, not unknown; returnOnRisk is '
    + 'maxProfit over maxLoss, null when either is unbounded or the max loss is 0';
  u.positionSource = 'source "model" only when every leg has a usable IV, priced with the resolved rate and yield; '
    + '"broker" sums the legs\' published Greeks and is null (never 0) where a leg lacks one; the legs keep the broker\'s '
    + 'own Greeks, which can be older than the quote';
  // an evaluation found "the chance the price ... ends where the position makes money" headlined as the chance the trade
  // wins: the description's "risk-neutral ... lognormal" and "the chain's own smile" had not come along
  u.probabilityOfProfit = 'the risk-neutral probability under a lognormal model (not a forecast of the trade winning) '
    + 'that the price at expiration ends where the position makes money at the mid, each breakeven read at the implied '
    + 'volatility the chain\'s own smile gives at that price (not a leg\'s own IV at its strike), with the resolved rate and '
    + 'dividend yield; null (never 0) when '
    + 'not computable (such as no usable IV in the smile), or when the reported probability is missing or invalid '
    + '(non-finite or outside 0-1)';
  u.probabilityOfMaxProfit = 'the same for the region of maximum profit; null when that region is a single price (a '
    + 'butterfly or straddle body) or unbounded, or when no usable IV prices a boundary of it - never read as 0';
  // An evaluation found "beat them" read backwards (PoP as an upper bound for short premium): the direction
  // is said outright.
  u.probabilityLimits = 'no view on direction; IV has tended to exceed realized, so values have tended to understate, '
    + 'not overstate, short-premium profit frequency; ignores early assignment, fills, costs. Delta is not used as a probability';
  // An evaluation found breakevens judged by their strikes against the range; an evaluation found the range,
  // now named in more answers, called one-sigma beside ivOneSigma (27 bytes of room at 21 dense candidates, so
  // expectedMoveIv's ivOneSigma sentence was shortened to pay for it).
  if (withExpectedMove) {
    u.expectedMove = 'this expiry\'s ATM straddle: callMid+putMid at strike nearest spot with both; lower/upper: '
      + 'spot -/+ straddle (not one-sigma: see ivOneSigma). pctOfSpot: fraction of spot (0.049 = 4.9%); pctFromSpot: '
      + 'percent. outsideExpectedMove compares '
      + 'breakeven price, not strike, to lower/upper';
  }
  u.naturalSlippagePct = '(netMid - netNatural) over the size of netMid, in percent: what crossing every leg at the '
    + 'natural price gives up against the mid, the execution cost a limit at the mid may or may not avoid';
  u.liquidity = 'minOpenInterest is the thinnest leg\'s open interest, null when any leg\'s is unknown (never 0); '
    + 'maxSpreadPct is the widest leg\'s spread in percent, null when a leg\'s mid is zero';
  return u;
}

/**
 * The scan's guide: each rule under a stable key when its predicate holds on the shaped answer.
 */
function scanGuide(shaped: Record<string, any>, options: StrategyScanOptions): Guide {
  const g: Guide = {};
  const strategy = shaped.strategy;
  const levels = shaped.levels;
  const provider = shaped.provider;
  g.bandDelta = 'The delta band runs on the delta the broker publishes: outside trading hours that is the broker\'s last '
    + 'published value at its own time convention, so a leg\'s delta and the model position.delta priced with the time '
    + 'left now can read outside the band asked for.';
  g.skipped = 'Every leg of every candidate has a two-sided quote (bid and ask, the ask above zero and at or above the '
    + 'bid), a sold leg a bid above zero; a candidate missing one is counted in skipped by reason and never priced from a '
    + 'last trade or a mark, and a spread whose credit or debit reaches its width is skipped as not a real price. A reason '
    + 'absent from skipped is a zero count.';
  if (strategy === 'iron_condor' || strategy === 'iron_butterfly') {
    g.condorWing = 'An iron condor or butterfly whose credit exceeds one wing keeps money on that whole side: no breakeven '
      + 'there, and the max loss is on the wider wing (fewer than two breakevens is that case, not missing data).';
  }
  if (shaped.expectedMove !== null) {
    g.expectedMoveIv = 'expectedMove.atmIv is the at-the-money straddle\'s IV: the mean of its usable call/put IVs, '
      + 'or the sole usable leg\'s IV; null only when neither is usable. '
      + 'ivOneSigma is the one-sigma move size, spot x atmIv x sqrt(years to expiration), null with atmIv.';
  } else {
    g.expectedMoveMissing = 'There is no expected move: expectedMoveUnavailable says why ("atm-quote-missing": the '
      + 'at-the-money strike lacks a two-sided quote on a leg; "no-strike-with-both-legs"), and every outsideExpectedMove '
      + 'is null: unknown, not inside.';
  }
  g.levelsScope = 'The levels are the gamma flip, call wall, put wall and gamma magnet computed on levels.scope '
    + '"expiration" (this expiration\'s chain alone) or "window" (the four nearest listed expirations that may still trade).';
  if (levels.scope === 'window') {
    g.levelsWindow = 'The window leaves out an expiration whose series has stopped trading: from 4:15 PM New York time on '
      + 'its day it is left out unless the broker lists nothing else, decided when the book was built (asOf; a cached '
      + 'answer keeps it). The window is the near-term positioning that moves the market now (get_live_dealer_positioning\'s '
      + 'default window), not this expiration\'s: for a far expiration its levels can sit well away from the ones that '
      + 'matter at expiry.';
  }
  g.levelCoverage = 'A level is published only under complete coverage (the flip on the flip sweep\'s coverage, the walls '
    + 'and magnet on net-gamma coverage). In levels.status, "complete" means every active leg was included; "partial" '
    + 'means only some active legs were included; "unmeasured" means active legs exist but no eligible legs were included; '
    + '"empty" means no active legs; "unknown" means missing or invalid coverage counts. A null level with any of those '
    + 'last four statuses is withheld for coverage, not absent; a null beside "complete" is one the computation did not '
    + 'find. "unavailable" means a missing or invalid reported value, including a level missing despite complete coverage.';
  const method = levels.gammaFlipMethod;
  if (method !== null) {
    g.flipMethod = `levels.gammaFlipMethod "${method}": "repriced" = gamma recomputed from IV for every leg; "frozen-gamma" = `
      + 'no leg had a usable IV, every published gamma held constant; "mixed" = some of each. The method qualifies the level.'
      + (method === 'frozen-gamma' || method === 'mixed' ? ' A held gamma is an approximation that can move the level or create one, even over complete coverage.' : '');
  }
  if (levels.gammaFlip !== null) {
    g.flipResolution = 'levels.gammaFlipResolution is the width of the bracket the sign change was found in, not a '
      + 'confidence interval or an error bound.'
      + (levels.gammaFlipResolution === null ? ' It is null beside this reported flip: the sampling step was missing, invalid or nonpositive, so the step is unknown - not "no flip".' : '');
  }
  g.dealerRegime = levels.dealerRegime !== null
    ? 'levels.dealerRegime is the computation\'s stated regime when it states one (the sign of net gamma at spot, '
      + 'interpolated between the strikes bracketing it), and otherwise derived from the sign of net GEX: positive, negative, '
      + 'or "neutral" when the measured net GEX is exactly zero - so it is not always an at-spot reading; published only '
      + 'with a measured net gamma under complete coverage.'
    : 'levels.dealerRegime is null: there is no measured book under complete coverage (levels.status.dealerRegime says '
      + 'why); it is never "neutral" by default.';
  if (levels.gammaFlip === null) {
    const status = levels.gammaFlipSearchStatus;
    g.flipSearch = 'The flip search samples within 20% of spot, and a pair of crossings within one sample can be missed, '
      + 'so no detected flip does not prove there is none.'
      + (status === 'unresolved' ? ' "unresolved": the search reached no conclusion about a crossing.' : '')
      + (status === null ? ' A null gammaFlipSearchStatus: no leg entered the search, or no recognized status was reported.' : '')
      + (status === 'found' ? ' "found" beside a null flip: found but withheld for coverage.' : '');
  }
  if (levels.openInterestUnpublishedExpirations !== undefined) {
    g.openInterestUnpublished = 'An expiration in levels.openInterestUnpublishedExpirations had a zero on every contract '
      + '(as Schwab prints on index options): its legs are excluded, so a level they feed is withheld for incomplete coverage.';
  }
  if (shaped.matched === 0) {
    g.matchedZero = 'matched 0 is a genuine zero over a chain that was read: no candidate passed (skipped says why); an '
      + 'empty book is never answered this way.';
  }
  if (shaped.omittedRows !== undefined) {
    g.omittedRows = 'omittedRows counts the chain rows that could not be used - quarantined (failed validation), '
      + 'invalidStrike, notSuccess (marked failed by the broker), unquoted (quotes unreadable), with their total - and no '
      + 'candidate is built on them.';
  }
  if (levels.emptyExpirations !== undefined || levels.omittedRows !== undefined || levels.partial === true) {
    g.windowGaps = 'levels.emptyExpirations are window dates the broker lists but answered with no contracts, left out of '
      + 'the levels; the window\'s unusable rows (levels.omittedRows) are left out too; levels.partial is true when a date '
      + 'or a quote could not be read.';
  }
  g.events = shaped.events === null
    ? 'events is null: the calendar could not be read (the scan is unaffected); that is not "no events".'
    : 'events gives the first earnings date and the first ex-dividend date on file between today (New York) and the '
      + 'expiration: a null date means none on file, not none scheduled; the time of day of an earnings release is not on '
      + 'file; the ex-dividend entry carries its per-share amount and declared (false when no declaration dated on or '
      + 'before today is on file).';
  g.sortOrder = 'The sortBy orderings do not rank trades as better or worse.';
  if (strategy === 'iron_condor' || strategy === 'short_strangle' || strategy === 'long_strangle') {
    g.sharedAnchor = 'skipped "shared-anchor-strike" counts the pairs the ladder dropped: a put strike whose best call was '
      + 'taken earlier gets its best pair with a call still free, or none.';
  }
  if ((shaped.matched !== null && shaped.returned < shaped.matched) || shaped.limitedBySize) {
    g.matchedCount = 'matched counts every candidate kept (after the filters and the ladder) before maxResults; '
      + 'limitedBySize true means the last-sorted candidates were dropped to fit the response.';
  }
  g.asOf = 'asOf is when the chain was read; a cached re-scan keeps it, so it does not date the quotes.';
  const resolved = shaped.resolved !== null && typeof shaped.resolved === 'object' ? shaped.resolved : null;
  const r = resolved?.r;
  const suppliedR = r !== null && typeof r === 'object' && r.source === 'supplied';
  g.rate = (suppliedR ? '' : 'When not supplied, resolved.r is the Treasury series matched to the scanned expiration\'s '
    + 'tenor (the nearest at or above it: 1 month, 3 months, 6 months, 1 year ...), falling back to the 3-month series '
    + 'when the matched one cannot be read. ')
    + 'The levels in the scan are priced at this rate, so they can differ from get_live_dealer_positioning\'s window '
    + 'levels, which take the 3-month rate.';
  if (resolved?.q !== null && typeof resolved?.q === 'object' && resolved.q.source === 'profile_yield') {
    g.profileYield = 'resolved.q.source "profile_yield": no usable trailing yield was resolved, so q is the trailing annual '
      + 'dividend over the live spot - it moves slightly with spot from call to call - and resolved.q.asOf is when the '
      + 'profile record was last updated, not when the division was made.';
  }
  if (provider === 'moomoo') {
    g.moomooDelay = 'moomoo serves US option quotes in real time only once the moomoo account holds assets or a US '
      + 'position; until then they may be delayed (about 15 minutes) with nothing in the data to say so: read moomoo option '
      + 'prices on such an account as possibly delayed.';
  }
  if (resolved?.S !== null && typeof resolved?.S === 'object') g.spotClock = spotClockGuide(provider);
  if ('rateLimit' in options) {
    const budget = rateLimitGuide(options.rateLimit ?? null);
    if (budget) {
      g.rateLimit = budget + (provider === 'moomoo'
        ? ' moomoo settles to what it spent: the expirations list, the contract list when it is not cached for the day, '
          + 'and one snapshot per 400 codes, the underlying\'s among them.'
        : '');
    }
  }
  return g;
}
