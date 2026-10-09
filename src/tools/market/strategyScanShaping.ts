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
import { exDividend, isoDate, measuredLevel, measuredValue, metricCoverage, readRegime, RESOLUTION_DIGITS, RESPONSE_MARGIN_BYTES, significant } from './dealerPositioningShaping.js';
import { readOmittedRows } from './omittedRows.js';

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

export function summarizeStrategyScan(response: Record<string, unknown>) {
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
  } : null;

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
    },
    resolved: body.resolved ?? null,
  };

  // Worst-sorted candidates go first when the answer would pass the ceiling.
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const budget = MAX_RESPONSE_BYTES - RESPONSE_MARGIN_BYTES - bytes(shaped);
  let kept = candidates;
  while (kept.length > 1 && bytes(kept) > budget) {
    kept = kept.slice(0, -1);
    shaped.limitedBySize = true;
  }
  shaped.candidates = kept;
  shaped.returned = kept.length;
  return shaped;
}
