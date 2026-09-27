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
import { measuredLevel, metricCoverage, RESPONSE_MARGIN_BYTES } from './dealerPositioningShaping.js';

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
    straddle: num(move.straddle),
    lower,
    upper,
    pctOfSpot: num(move.pctOfSpot) === null ? null : num(move.pctOfSpot)! * 100,
    atmIv: num(move.atmIv),
    ivOneSigma: num(move.ivOneSigma),
  } : null;

  // The levels are gated as get_live_dealer_positioning gates them: the flip
  // on the flip's own coverage, the walls and magnet on gamma coverage.
  const rawLevels = record(body.levels);
  const cov = record(rawLevels.coverage);
  const gammaCoverage = metricCoverage(cov.gamma);
  const flipCoverage = metricCoverage(cov.gammaFlip);
  const flip = measuredLevel(rawLevels.gammaFlip, flipCoverage.status);
  const callWall = measuredLevel(rawLevels.callWall, gammaCoverage.status);
  const putWall = measuredLevel(rawLevels.putWall, gammaCoverage.status);
  const magnet = measuredLevel(rawLevels.gammaMagnet, gammaCoverage.status);
  const searchStatus = cov.gammaFlipSearchStatus;
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
    status: { gammaFlip: flip.status, callWall: callWall.status, putWall: putWall.status, gammaMagnet: magnet.status },
    gammaFlipSearchStatus: flip.value === null && (searchStatus === 'found' || searchStatus === 'not-found' || searchStatus === 'unresolved')
      ? searchStatus
      : flip.value !== null ? 'found' : null,
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
    return {
      legs,
      anchorDelta: num(c.anchorDelta),
      width: num(c.width),
      netMid: num(c.netMid),
      netNatural: num(c.netNatural),
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
      position: {
        delta: num(position.delta), gamma: num(position.gamma), theta: num(position.theta), vega: num(position.vega),
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
    strategy: str(request.strategy),
    request: {
      deltaMin: num(request.deltaMin), deltaMax: num(request.deltaMax), width: num(request.width),
      minOpenInterest: num(request.minOpenInterest), maxSpreadPct: num(request.maxSpreadPct), minCredit: num(request.minCredit),
      sortBy: str(request.sortBy), maxResults: count(request.maxResults), levels: str(request.levels),
    },
    expectedMove,
    expectedMoveUnavailable: str(body.expectedMoveUnavailable),
    levels,
    matched: count(body.matched),
    returned: 0,
    limitedBySize: false,
    skipped,
    candidates: [] as typeof candidates,
    units: {
      prices: 'per share; one contract is 100 shares',
      netMid: 'sold mids minus bought mids: positive is a credit, negative a debit',
      netNatural: 'sold bids minus bought asks, the price crossing every leg',
      position: 'one of each leg, times 100, signed for the position (sold legs negative), from the broker\'s published leg Greeks',
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
