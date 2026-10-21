import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { LiveApiClient, LiveRateLimit } from '../../proxy/liveApiClient.js';
import { summarizeStrategyScan } from './strategyScanShaping.js';
import { plainDecimal, register } from './strategyScan.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';

const full = (n: number) => ({ total: n, included: n });
const coverage = (over: Record<string, unknown> = {}) => ({
  gamma: full(20), delta: full(20), vega: full(20), vanna: full(20), charm: full(20), vomma: full(20), gammaFlip: full(20),
  gammaFlipSearchStatus: 'found', gammaFlipMethod: 'mixed', gammaFlipResolution: 0.154, ...over,
});

const leg = (action: 'sell' | 'buy', type: 'put' | 'call', strike: number) => ({
  action, type, strike, bid: 1.2, ask: 1.3, mid: 1.25, spreadPct: 8, iv: 0.3, delta: -0.2, gamma: 0.02, theta: -0.04, vega: 0.1,
  openInterest: 500, volume: 20,
});

const candidate = (over: Record<string, unknown> = {}) => ({
  legs: [leg('sell', 'put', 95), leg('buy', 'put', 90)],
  anchorDelta: 0.2, width: 5, netMid: 1, netNatural: 0.8, maxProfit: 1, maxLoss: 4,
  breakevens: [{ price: 94, pctFromSpot: -6 }], returnOnRisk: 0.25,
  probabilityOfProfit: 0.78, probabilityOfMaxProfit: 0.72,
  liquidity: { minOpenInterest: 500, maxSpreadPct: 8 },
  position: { delta: 5, gamma: -1, theta: 2, vega: -3, source: 'model' },
  ...over,
});

const scan = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, symbol: 'SPY', dataSource: 'live', provider: 'tradier', asOf: '2026-09-28T15:00:00.000Z',
  expiration: '2026-10-16', daysToExpiration: 18, spotPrice: 100,
  resolved: { r: { value: 0.04 }, q: { value: 0.01 } },
  request: { strategy: 'bull_put_spread', deltaMin: 0.15, deltaMax: 0.35, width: 5, minOpenInterest: null, maxSpreadPct: null, minCredit: null, sortBy: 'delta', maxResults: 10, levels: 'expiration' },
  expectedMove: { strike: 100, callMid: 2.5, putMid: 2.4, straddle: 4.9, pctOfSpot: 0.049, lower: 95.1, upper: 104.9, atmIv: 0.3, ivOneSigma: 5.2 },
  expectedMoveUnavailable: null,
  levels: { scope: 'expiration', expirations: ['2026-10-16'], gammaFlip: 97.5, callWall: 110, putWall: 90, gammaMagnet: 100, netGex: -5.5e8, regime: 'positive', coverage: coverage() },
  matched: 3, skipped: { 'missing-quote': 2, 'no-wing-strike': 0 },
  candidates: [candidate()],
  ...over,
});

describe('summarizeStrategyScan', () => {
  it('publishes levels under complete coverage, with every distance from spot', () => {
    const shaped = summarizeStrategyScan(scan());
    expect(shaped.levels).toMatchObject({
      scope: 'expiration', gammaFlip: 97.5, callWall: 110, putWall: 90, gammaMagnet: 100,
      pctFromSpot: { gammaFlip: -2.5, callWall: 10, putWall: -10, gammaMagnet: 0 },
      status: { gammaFlip: 'complete', callWall: 'complete', dealerRegime: 'complete' },
      // As get_live_dealer_positioning reports them: how the flip was found,
      // its search step, and the regime (gamma at spot, not the net's sign).
      gammaFlipMethod: 'mixed', gammaFlipResolution: 0.154, dealerRegime: 'positive',
    });
    const [c] = shaped.candidates;
    expect(c.legs.map((l) => l.pctFromSpot)).toEqual([-5, -10]);
    expect(c.breakevens).toEqual([{ price: 94, pctFromSpot: -6, outsideExpectedMove: true }]);
    // A fraction of spot, as get_live_dealer_positioning publishes it, with
    // the two mids the straddle sums.
    expect(shaped.expectedMove!.pctOfSpot).toBe(0.049);
    expect(shaped.expectedMove).toMatchObject({ callMid: 2.5, putMid: 2.4, straddle: 4.9 });
    // A zero count is not a reason to show.
    expect(shaped.skipped).toEqual({ 'missing-quote': 2 });
    expect(shaped).toMatchObject({ matched: 3, returned: 1, limitedBySize: false, strategy: 'bull_put_spread' });
  });

  it('names the expirations whose open interest the broker did not publish beside the levels, and nothing otherwise', () => {
    const withheld = summarizeStrategyScan(scan({ levels: { ...scan().levels, gammaFlip: null, openInterestUnpublishedExpirations: ['2026-02-30', '2026-10-05'], coverage: coverage({ gamma: { total: 40, included: 0 }, gammaFlip: { total: 40, included: 0 }, gammaFlipSearchStatus: undefined }) } }));
    expect(withheld.levels).toMatchObject({ openInterestUnpublishedExpirations: ['2026-10-05'], gammaFlipSearchStatus: null, callWall: null });
    expect((summarizeStrategyScan(scan()).levels as any).openInterestUnpublishedExpirations).toBeUndefined();
  });

  it('says beside the spot what a stale spot skews, and nothing otherwise', () => {
    const stale = summarizeStrategyScan(scan({ resolved: { ...scan().resolved, S: { value: 767.22, source: 'broker-public', asOf: '2026-10-02T07:59:57.000Z', stale: true } } })) as any;
    expect(stale.spotNote).toBe("The spot printed before the last session's open (resolved.S.asOf, the broker's own time), so every pctFromSpot, the expected move and each breakeven's place against it are read against a stale price.");
    expect((summarizeStrategyScan(scan()) as any).spotNote).toBeUndefined();
  });

  it('withholds levels on incomplete coverage, as the live positioning tool does', () => {
    const partial = summarizeStrategyScan(scan({ levels: { ...scan().levels, coverage: coverage({ gamma: { total: 20, included: 19 } }) } }));
    expect(partial.levels).toMatchObject({ callWall: null, putWall: null, gammaMagnet: null, gammaFlip: 97.5, status: { callWall: 'partial', dealerRegime: 'partial' }, dealerRegime: null });
    const noFlip = summarizeStrategyScan(scan({
      levels: { ...scan().levels, gammaFlip: null, coverage: coverage({ gammaFlipSearchStatus: 'not-found' }) },
    }));
    expect(noFlip.levels).toMatchObject({ gammaFlip: null, gammaFlipSearchStatus: 'not-found' });
    const flipPartial = summarizeStrategyScan(scan({ levels: { ...scan().levels, coverage: coverage({ gammaFlip: { total: 20, included: 10 } }) } }));
    expect(flipPartial.levels).toMatchObject({ gammaFlip: null, status: { gammaFlip: 'partial' }, gammaFlipResolution: null });
    // Without a regime from the route, the net's sign stands in, as the live tool does.
    const noRegime = summarizeStrategyScan(scan({ levels: { ...scan().levels, regime: undefined } }));
    expect(noRegime.levels.dealerRegime).toBe('negative');
    // the review's input: complete coverage but no finite net gamma (an overflow
    // serialized as null) is no measured book, so no regime, as the live tool.
    for (const scope of ['expiration', 'window']) {
      const unmeasured = summarizeStrategyScan(scan({ levels: { ...scan().levels, scope, netGex: null, regime: 'positive', coverage: coverage({ gamma: { total: 1, included: 1 } }) } }));
      expect(unmeasured.levels.dealerRegime, scope).toBeNull();
      // Its status says why, as the live tool's levelStatus does.
      expect(unmeasured.levels.status.dealerRegime, scope).toBe('unavailable');
    }
  });

  it('a breakeven inside the expected move says so, and none is claimed without one', () => {
    const inside = summarizeStrategyScan(scan({ candidates: [candidate({ breakevens: [{ price: 97 }] })] }));
    expect(inside.candidates[0].breakevens[0].outsideExpectedMove).toBe(false);
    const noMove = summarizeStrategyScan(scan({ expectedMove: null, expectedMoveUnavailable: 'atm-quote-missing' }));
    expect(noMove.expectedMove).toBeNull();
    expect(noMove.expectedMoveUnavailable).toBe('atm-quote-missing');
    expect(noMove.candidates[0].breakevens[0].outsideExpectedMove).toBeNull();
  });

  it('carries each candidate\'s liquidity and its position Greeks\' source, to 15 significant digits', () => {
    const shaped = summarizeStrategyScan(scan({ candidates: [candidate({ position: { delta: 15.440000000000001, gamma: -1, theta: 2, vega: -65.64999999999999, source: 'broker' } })] }));
    expect(shaped.candidates[0].liquidity).toEqual({ minOpenInterest: 500, maxSpreadPct: 8 });
    expect(shaped.candidates[0].position).toEqual({ delta: 15.44, gamma: -1, theta: 2, vega: -65.65, source: 'broker' });
    const flip = summarizeStrategyScan(scan({ levels: { ...scan().levels, coverage: coverage({ gammaFlipResolution: 0.15312200000005305 }) } }));
    expect(flip.levels.gammaFlipResolution).toBe(0.153122);
    const odd = summarizeStrategyScan(scan({ candidates: [candidate({ position: { delta: 1, source: 'guess' }, liquidity: { minOpenInterest: -1, maxSpreadPct: 'x' } })] }));
    expect(odd.candidates[0].position.source).toBeNull();
    expect(odd.candidates[0].liquidity).toEqual({ minOpenInterest: null, maxSpreadPct: null });
  });

  it('a probability outside 0 to 1 is not a probability', () => {
    const odd = summarizeStrategyScan(scan({ candidates: [candidate({ probabilityOfProfit: 1.2, probabilityOfMaxProfit: -0.1 })] }));
    expect(odd.candidates[0]).toMatchObject({ probabilityOfProfit: null, probabilityOfMaxProfit: null });
  });

  it('drops the last candidates to fit the response, and says so', async () => {
    // Four-leg candidates with long decimals, 25 of them, past the ceiling.
    // Every number at full precision except the counts, which are whole.
    const lengthen = (value: unknown, key = ''): unknown => {
      if (typeof value === 'number') return key === 'openInterest' || key === 'volume' ? 123_456 : value + Math.PI / 1e3;
      if (Array.isArray(value)) return value.map((v) => lengthen(v));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, lengthen(v, k)]));
      return value;
    };
    const heavy = Array.from({ length: 25 }, (_, i) => lengthen(candidate({
      legs: [leg('buy', 'put', 80 + i), leg('sell', 'put', 85 + i), leg('sell', 'call', 110 + i), leg('buy', 'call', 115 + i)],
      breakevens: [{ price: 83 }, { price: 112 }],
    })));
    const shaped = summarizeStrategyScan(scan({ candidates: heavy, matched: 25, spotPrice: 100.123456789 }));
    expect(shaped.limitedBySize).toBe(true);
    expect(shaped.returned).toBeLessThan(25);
    expect(shaped.returned).toBeGreaterThan(15);
    // The first-sorted are kept: the dropped are the last.
    expect(shaped.candidates[0].legs[0].strike).toBeCloseTo(80, 2);
    expect(new TextEncoder().encode(JSON.stringify(shaped)).length).toBeLessThanOrEqual(50 * 1024 - 2 * 1024);
    const result = await toolHandler(async () => shaped)({});
    expect((result.structuredContent as any).responseBudget).toBeUndefined();
    expect((result.structuredContent as any).candidates).toHaveLength(shaped.returned);
  });

  it('survives an empty or malformed response', () => {
    for (const response of [{}, { candidates: 'x' }, { levels: null }, { expectedMove: 3 }]) {
      expect(() => summarizeStrategyScan(response as any)).not.toThrow();
    }
    expect(summarizeStrategyScan({} as any)).toMatchObject({ candidates: [], returned: 0, spotPrice: null });
  });
});

describe('scan_option_strategies', () => {
  const capture = () => {
    const calls: Array<{ path: string; params: Record<string, string> }> = [];
    let handler: any;
    const server = { registerTool: (_name: string, _config: unknown, h: unknown) => { handler = h; } };
    register(server as any, { get: async (path: string, params: Record<string, string>) => { calls.push({ path, params }); return scan(); } } as any);
    return { calls, run: (input: Record<string, unknown>) => handler(input) };
  };

  it('sends the parameters in plain decimals and only those given', async () => {
    const { calls, run } = capture();
    await run({ symbol: 'spy', expiration: '2026-10-16', strategy: 'iron_condor', width: 5, deltaMin: 0.1, deltaMax: 0.25, maxSpreadPct: 12.5, levels: 'window', distinct: false });
    expect(calls).toEqual([{
      path: '/live/strategy-scan/SPY',
      params: { expiration: '2026-10-16', strategy: 'iron_condor', width: '5', deltaMin: '0.1', deltaMax: '0.25', maxSpreadPct: '12.5', levels: 'window', distinct: 'false' },
    }]);
    await run({ symbol: 'SPY', expiration: '2026-10-16', strategy: 'short_put', minCredit: 1e-7, deltaMin: 0.30000000001, width: 1e-11 });
    expect(calls[1].params).toMatchObject({ minCredit: '0.0000001', deltaMin: '0.30000000001', width: '0.00000000001' });
    // A supplied rate and yield go the same way, and only when given.
    await run({ symbol: 'SPX', expiration: '2026-10-16', strategy: 'short_put', r: 0.0425, q: 0 });
    expect(calls[2].params).toEqual({ expiration: '2026-10-16', strategy: 'short_put', r: '0.0425', q: '0' });
  });

  it('writes every number out as the decimal it reads back from, never rounded', () => {
    for (const x of [0, 5, 0.1, 0.30000000001, 12.5, 1e-7, 1.5e-11, 1e21, 2.5e25, 123456.789, 5e-324, Number.MAX_SAFE_INTEGER]) {
      const text = plainDecimal(x);
      expect(text, String(x)).toMatch(/^-?\d+(\.\d+)?$/);
      expect(Number(text), String(x)).toBe(x);
    }
    expect(plainDecimal(1e21)).toBe('1000000000000000000000');
    expect(plainDecimal(-2.5e-8)).toBe('-0.000000025');
  });
});

describe('slippage and events', () => {
  it('publishes each candidate\'s natural slippage, the cap asked for, and the events before the expiration', () => {
    const shaped: any = summarizeStrategyScan(scan({
      request: { ...scan().request, maxNaturalSlippagePct: 25 },
      events: { from: '2026-09-28', through: '2026-10-16', earningsOnOrBefore: '2026-10-10', exDividendOnOrBefore: { date: '2026-10-01', amount: 0.3, declared: false } },
      candidates: [candidate({ naturalSlippagePct: 20 })],
    }));
    expect(shaped.request.maxNaturalSlippagePct).toBe(25);
    expect(shaped.candidates[0].naturalSlippagePct).toBe(20);
    expect(shaped.events).toEqual({ from: '2026-09-28', through: '2026-10-16', earningsOnOrBefore: '2026-10-10', exDividendOnOrBefore: { date: '2026-10-01', amount: 0.3, declared: false } });
    expect((summarizeStrategyScan(scan({ events: null })) as any).events).toBeNull();
  });
});

// The scanned chain's rows left out, and a partial levels window, are carried.
describe('rows left out and a partial levels window', () => {
  const OMITTED = { total: 1, quarantined: 1, invalidStrike: 0, notSuccess: 0, unquoted: 0 };
  it('carries the scanned chain\'s omittedRows and the levels\' partial, emptyExpirations and omittedRows', () => {
    const shaped: any = summarizeStrategyScan(scan({
      omittedRows: OMITTED,
      levels: { scope: 'window', expirations: ['2026-10-16', '2026-10-23'], gammaFlip: 97.5, callWall: 110, putWall: 90, gammaMagnet: 100, netGex: -5.5e8, regime: 'positive', coverage: coverage(), partial: true, emptyExpirations: ['2026-10-23'], omittedRows: OMITTED },
    }));
    expect(shaped.omittedRows).toEqual(OMITTED);
    expect(shaped.levels).toMatchObject({ partial: true, emptyExpirations: ['2026-10-23'], omittedRows: OMITTED });
  });

  it('none: no fields (control)', () => {
    const shaped: any = summarizeStrategyScan(scan());
    expect(shaped.omittedRows).toBeUndefined();
    expect(shaped.levels.partial).toBeUndefined();
  });
});

// Review: the proxy names the series a scan of
// a date under several roots read, and the adjusted series its chain and its
// levels window left out; this shaper dropped all of it, so SPX candidates had
// no series and an AAPL window read "complete" with AAPL1 contracts unsaid.
describe('the scanned series and the adjusted series left out', () => {
  const levels = (over: Record<string, unknown> = {}) => ({
    scope: 'window', expirations: ['2026-10-16', '2026-10-23'], gammaFlip: 97.5, callWall: 110, putWall: 90, gammaMagnet: 100,
    netGex: -5.5e8, regime: 'positive', coverage: coverage(), ...over,
  });

  it('names the series the candidates, smile and straddle are, on a date listed under several roots', () => {
    const shaped: any = summarizeStrategyScan(scan({
      symbol: 'SPX', root: 'SPXW', roots: ['SPX', 'SPXW'],
      expectedMove: { strike: 100, callMid: 2.5, putMid: 2.4, straddle: 4.9, pctOfSpot: 0.049, lower: 95.1, upper: 104.9, atmIv: 0.3, ivOneSigma: 5.2, root: 'SPXW' },
    }));
    expect(shaped).toMatchObject({ root: 'SPXW', roots: ['SPX', 'SPXW'] });
    expect(shaped.expectedMove.root).toBe('SPXW');
    expect(shaped.rootNote).toBe('The date is listed under the SPX and SPXW roots, different series (their settlement and the day their trading stops differ): every candidate\'s legs, the smile its probabilities read and the expected move are the SPXW root\'s (the most open interest), so the contracts are SPXW\'s.');
  });

  it('names the adjusted series left out of the scanned chain and of the levels, and qualifies the levels\' "complete"', () => {
    const shaped: any = summarizeStrategyScan(scan({
      symbol: 'AAPL',
      excludedRoots: [{ root: 'AAPL1', contracts: 3 }],
      levels: levels({ excludedRoots: [{ root: 'AAPL1', contracts: 5 }] }),
    }));
    expect(shaped.excludedRoots).toEqual([{ root: 'AAPL1', contracts: 3 }]);
    expect(shaped.excludedRootsNote).toBe('3 contracts under the AAPL1 root (an adjusted series, a different deliverable at the same strikes) are left out of the scanned chain: no candidate is built on them.');
    expect(shaped.levels.excludedRoots).toEqual([{ root: 'AAPL1', contracts: 5 }]);
    // The levels stay published: they measure the symbol's own contracts in full, and the note says so.
    expect(shaped.levels).toMatchObject({ gammaFlip: 97.5, status: { gammaFlip: 'complete' } });
    expect(shaped.levels.excludedRootsNote).toBe('5 contracts under the AAPL1 root (an adjusted series, a different deliverable at the same strikes) are left out of the levels and their coverage, which measure the symbol\'s own contracts alone, so a "complete" status does not include them.');
    // One contract reads in the singular.
    const one: any = summarizeStrategyScan(scan({ excludedRoots: [{ root: 'AAPL1', contracts: 1 }] }));
    expect(one.excludedRootsNote).toStartWith('1 contract under the AAPL1 root (an adjusted series, a different deliverable at the same strikes) is left out');
  });

  it('a date under one root, and a window that left nothing out, name none of it (control)', () => {
    // Roots with no series named (the proxy always names one) say nothing rather than a null series.
    for (const body of [scan(), scan({ root: 'SPY', roots: ['SPY'] }), scan({ roots: ['SPX', 'SPXW'] }), scan({ excludedRoots: [], levels: levels({ excludedRoots: [] }) })]) {
      const shaped: any = summarizeStrategyScan(body);
      for (const key of ['root', 'roots', 'rootNote', 'excludedRoots', 'excludedRootsNote']) expect(shaped).not.toHaveProperty(key);
      expect(shaped.levels).not.toHaveProperty('excludedRoots');
      expect(shaped.levels).not.toHaveProperty('excludedRootsNote');
      expect(shaped.expectedMove).not.toHaveProperty('root');
    }
  });

  it('reaches the model through the tool, keys and values intact', async () => {
    let handler: any;
    const server = { registerTool: (_name: string, _config: unknown, h: unknown) => { handler = h; } };
    register(server as any, { get: async () => scan({
      symbol: 'SPX', root: 'SPXW', roots: ['SPX', 'SPXW'], excludedRoots: [{ root: 'SPX7', contracts: 2 }],
      levels: levels({ excludedRoots: [{ root: 'SPX7', contracts: 4 }] }),
    }) } as any);
    const result = await handler({ symbol: 'SPX', expiration: '2026-10-16', strategy: 'short_put', levels: 'window' });
    expect(result.structuredContent).toMatchObject({
      root: 'SPXW', roots: ['SPX', 'SPXW'], excludedRoots: [{ root: 'SPX7', contracts: 2 }],
      levels: { excludedRoots: [{ root: 'SPX7', contracts: 4 }] },
    });
    // The tool's advertised output schema (a passthrough of the shared market fields) accepts it whole.
    expect(marketDataOutputSchema.safeParse(result.structuredContent).success).toBe(true);
  });
});

describe('summarizeStrategyScan guide and units', () => {
  const BUDGET = { limit: 120, remaining: 115, resetSeconds: 20, provider: 'tradier' };
  const s = (over: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) => (summarizeStrategyScan as any)(scan(over), opts) as any;
  const g = (over: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) => s(over, opts).guide as Record<string, string>;
  const lv = (over: Record<string, unknown>) => ({ levels: { ...scan().levels, ...over } });

  it('units gains its rows and keeps every existing value', () => {
    const u = s().units;
    expect(u.prices).toBe('per share; one contract is 100 shares');
    expect(u.probabilities).toBe('risk-neutral, lognormal, at the chain\'s own implied volatility at each boundary: model values, not forecasts');
    expect(u.anchorDelta).toMatch(/absolute published delta/);
    expect(u.anchorDelta).toContain('for a two-anchor candidate (iron condor, strangles) the mean of the two');
    expect(u.anchorDelta).toContain('for a body (straddle, iron butterfly) the call\'s');
    expect(u.legs).toMatch(/spreadPct is \(ask - bid\) over the mid/);
    expect(u.payoff).toMatch(/UNBOUNDED, not unknown|unbounded, not unknown/i);
    expect(u.positionSource).toMatch(/only when every leg has a usable IV/);
    expect(u.probabilityOfProfit).toMatch(/at the mid/);
    expect(u.probabilityOfProfit).toMatch(/^the risk-neutral probability under a lognormal model \(not a forecast of the trade winning\) that the price at expiration ends where the position makes money at the mid, each breakeven read at the implied volatility the chain's own smile gives at that price \(not a leg's own IV at its strike\), with the resolved rate and dividend yield;/);
    expect(u.probabilityOfMaxProfit).toMatch(/single price/);
    expect(u.probabilityOfMaxProfit).toMatch(/no usable IV/);
    expect(u.probabilityLimits).toMatch(/early assignment/);
    expect(u.probabilityLimits).toMatch(/Delta is not used as a probability/);
    expect(u.naturalSlippagePct).toMatch(/netMid - netNatural/);
    expect(u.liquidity).toMatch(/thinnest leg/);
  });

  it('the direction of the IV caveat, and what outsideExpectedMove compares', () => {
    // read backwards as "a rough upper bound on how often a short put is profitable"
    expect(s().units.probabilityLimits).toBe('no view on direction; IV has tended to exceed realized, so values have '
      + 'tended to understate, not overstate, short-premium profit frequency; ignores early assignment, fills, costs. '
      + 'Delta is not used as a probability');
    // a breakeven below lower was called inside the range because its strike sits above lower
    expect(s().units.expectedMove).toMatch(/outsideExpectedMove compares breakeven price, not strike, to lower\/upper$/);
  });

  it('lower/upper is the straddle range, not a one-sigma range', () => {
    // Distinguish the spot -/+ straddle range from ivOneSigma in the same result.
    expect(s().units.expectedMove).toContain('lower/upper: spot -/+ straddle (not one-sigma: see ivOneSigma). pctOfSpot');
    expect(g().expectedMoveIv).toMatch(/ ivOneSigma is the one-sigma move size, spot x atmIv x sqrt\(years to expiration\), null with atmIv\.$/);
  });

  it('units.width on a wing strategy, units.expectedMove beside an expected move', () => {
    expect(s().units.width).toMatch(/wider of its two wings/);
    expect(s({ candidates: [candidate({ width: null })] }).units.width).toBeUndefined();
    expect(s().units.expectedMove).toContain('pctOfSpot: fraction of spot (0.049 = 4.9%); pctFromSpot: percent');
    expect(s({ expectedMove: null, expectedMoveUnavailable: 'atm-quote-missing' }).units.expectedMove).toBeUndefined();
  });

  it('always: bandDelta, skipped, levelsScope, levelCoverage, dealerRegime, events, sortOrder, asOf, rate', () => {
    const x = g();
    expect(x.bandDelta).toMatch(/delta the broker publishes/);
    expect(x.skipped).toMatch(/never priced from a last trade or a mark/);
    expect(x.levelsScope).toMatch(/"expiration"/);
    expect(x.levelCoverage).toMatch(/withheld for coverage, not absent/);
    expect(x.dealerRegime).toMatch(/sign of net GEX/i);
    expect(x.events).toMatch(/could not be read/);
    expect(x.sortOrder).toMatch(/do not rank trades/);
    expect(x.asOf).toMatch(/does not date the quotes/);
    expect(x.rate).toMatch(/3-month/);
  });

  it('events: the on-file line beside a read calendar, the unreadable line beside a null one', () => {
    expect(g({ events: { from: '2026-09-28', through: '2026-10-16', earningsOnOrBefore: null, exDividendOnOrBefore: null } }).events).toMatch(/none on file, not none scheduled/);
  });

  it('condorWing and sharedAnchor by strategy', () => {
    expect(g().condorWing).toBeUndefined();
    expect(g({ request: { ...scan().request, strategy: 'iron_condor' } }).condorWing).toMatch(/no breakeven there/);
    expect(g().sharedAnchor).toBeUndefined();
    expect(g({ request: { ...scan().request, strategy: 'short_strangle' } }).sharedAnchor).toMatch(/shared-anchor-strike/);
  });

  it('the expected move: expectedMoveIv beside one, expectedMoveMissing without', () => {
    expect(g().expectedMoveIv).toContain("the mean of its usable call/put IVs, or the sole usable leg's IV; null only when neither is usable");
    expect(g().expectedMoveMissing).toBeUndefined();
    const missing = g({ expectedMove: null, expectedMoveUnavailable: 'atm-quote-missing' });
    expect(missing.expectedMoveMissing).toMatch(/unknown, not inside/);
    expect(missing.expectedMoveIv).toBeUndefined();
  });

  it('the window: levelsWindow on scope "window" only', () => {
    expect(g().levelsWindow).toBeUndefined();
    expect(g(lv({ scope: 'window' })).levelsWindow).toMatch(/4:15 PM New York/);
    expect(g(lv({ scope: 'window' })).levelsWindow).toMatch(/near-term positioning/);
  });

  it('the flip: method, resolution, search caveat on a null flip', () => {
    expect(g().flipMethod).toMatch(/approximation/);
    expect(g().flipMethod).toMatch(/even over complete coverage\./);
    expect(g().flipMethod).not.toMatch(/whatever the coverage/);
    expect(g(lv({ coverage: coverage({ gammaFlipMethod: 'repriced' }) })).flipMethod).not.toMatch(/approximation/);
    expect(g().flipResolution).toMatch(/not a confidence interval/);
    expect(g(lv({ coverage: coverage({ gammaFlipResolution: null }) })).flipResolution).toMatch(/step is unknown/);
    expect(g().flipSearch).toBeUndefined();
    expect(g(lv({ gammaFlip: null, coverage: coverage({ gammaFlipSearchStatus: 'unresolved' }) })).flipSearch).toMatch(/no conclusion/);
    expect(g(lv({ gammaFlip: null, coverage: coverage({ gammaFlipSearchStatus: 'not-found' }) })).flipSearch).toMatch(/20% of spot/);
  });

  it('openInterestUnpublished, windowGaps and omittedRows when present', () => {
    expect(g().openInterestUnpublished).toBeUndefined();
    expect(g(lv({ openInterestUnpublishedExpirations: ['2026-10-16'] })).openInterestUnpublished).toMatch(/zero on every contract/);
    expect(g().windowGaps).toBeUndefined();
    expect(g(lv({ partial: true })).windowGaps).toMatch(/could not be read/);
    expect(g().omittedRows).toBeUndefined();
    expect(g({ omittedRows: { quarantined: 1, invalidStrike: 0, notSuccess: 0, unquoted: 0, total: 1 } }).omittedRows).toMatch(/quarantined/);
  });

  it('matchedZero on zero matches; matchedCount when fewer are returned than matched', () => {
    expect(g().matchedZero).toBeUndefined();
    expect(g({ matched: 0, candidates: [] }).matchedZero).toMatch(/genuine zero/);
    expect(g().matchedCount).toMatch(/before maxResults/);
    expect(g({ matched: 1 }).matchedCount).toBeUndefined();
  });

  it('inputs: profileYield, the tenor clause of rate unless supplied, the spot clock', () => {
    expect(g().profileYield).toBeUndefined();
    const resolved = { S: { value: 100, source: 'broker-moomoo', asOf: '2026-09-28T14:59:00Z', stale: false }, r: { value: 0.04, source: 'fred', asOf: '2026-09-25' }, q: { value: 0.01, source: 'profile_yield', asOf: '2026-08-01' } };
    const x = g({ resolved, provider: 'moomoo' });
    expect(x.profileYield).toMatch(/moves slightly with spot/);
    expect(x.rate).toMatch(/matched to the scanned expiration's tenor/);
    expect(x.spotClock).toMatch(/moomoo[^.]*update time/);
    expect(x.moomooDelay).toMatch(/15 minutes/);
    expect(g({ resolved: { ...resolved, r: { value: 0.04, source: 'supplied', asOf: null } } }).rate).not.toMatch(/matched to the scanned expiration's tenor/);
    expect(g().moomooDelay).toBeUndefined();
  });

  it('the budget inside the answer and the proxy warnings surfaced', () => {
    const plain = s({ warnings: ['Risk-free: 1M unavailable; falling back to 3M'] }, { rateLimit: BUDGET });
    expect(plain.rateLimit).toEqual(BUDGET);
    expect(plain.guide.rateLimit).toMatch(/budget after this call/);
    expect(plain.guide.rateLimit).not.toMatch(/400 codes/);
    expect(plain.warnings).toEqual(['Risk-free: 1M unavailable; falling back to 3M']);
    expect(g({ provider: 'moomoo' }, { rateLimit: BUDGET }).rateLimit).toMatch(/400 codes/);
    expect(s().warnings).toBeUndefined();
    expect(s().rateLimit).toBeUndefined();
  });

  it('a zero-candidate answer carries every guide its predicates make true', () => {
    const x = g({ matched: 0, candidates: [] });
    for (const key of ['bandDelta', 'skipped', 'levelsScope', 'matchedZero', 'asOf']) expect(x[key]).toBeDefined();
  });
});

describe('scan_option_strategies through the handler - guide, budget and warnings', () => {
  it('the guide, the budget inside the fit and the proxy warnings reach both channels, and the schema accepts them', async () => {
    let handler: any;
    const budget = { limit: 120, remaining: 117, resetSeconds: 31, provider: 'tradier' };
    const server = { registerTool: (_name: string, _config: unknown, h: unknown) => { handler = h; } };
    register(server as any, {
      get: async (_p: string, _q: unknown, onRateLimit?: (r: typeof budget) => void) => { onRateLimit?.(budget); return scan({ warnings: ['Risk-free: 1M unavailable; falling back to 3M'] }); },
    } as any);
    const result = await handler({ symbol: 'SPY', expiration: '2026-10-16', strategy: 'bull_put_spread' });
    const wire = result.structuredContent;
    expect(JSON.parse(result.content[0].text)).toEqual(wire);
    expect(wire.rateLimit).toEqual(budget);
    expect(wire.warnings).toEqual(['Risk-free: 1M unavailable; falling back to 3M']);
    expect(wire.guide.rateLimit).toMatch(/budget after this call/);
    expect(wire.units.payoff).toMatch(/unbounded/);
    expect(marketDataOutputSchema.safeParse(wire).success).toBe(true);
  });
});

describe('scan', () => {
  it('naturalSlippagePct explains the execution cost a limit at the mid may or may not avoid', () => {
    expect((summarizeStrategyScan(scan()) as any).units.naturalSlippagePct).toMatch(/a limit at the mid may or may not avoid/);
  });
});

describe('unknown values and the final fit', () => {
  const budget: LiveRateLimit = { limit: 120, remaining: 117, resetSeconds: 31, provider: 'tradier' };

  async function registeredScan(payload: Record<string, unknown>) {
    const server = new McpServer({ name: 'scan-guide-review', version: '1' });
    register(server, {
      get: async (_path: string, _params: unknown, onRateLimit?: (value: LiveRateLimit) => void) => {
        onRateLimit?.(budget);
        return payload;
      },
    } as unknown as LiveApiClient);
    const client = new Client({ name: 'scan-guide-consumer', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'scan_option_strategies',
        arguments: { symbol: 'SPY', expiration: '2026-10-16', strategy: 'iron_condor', width: 5 },
      });
      expect(result.isError).not.toBe(true);
      const wire = result.structuredContent as any;
      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual(wire);
      return wire;
    } finally {
      await client.close();
      await server.close();
    }
  }

  it('distinguishes unavailable level data from incomplete coverage and defines every status', async () => {
    const states = [
      { coverage: undefined, value: undefined, status: 'unknown', meaning: /"unknown"[^.]*missing or invalid coverage/ },
      { coverage: { total: 0, included: 0 }, value: null, status: 'empty', meaning: /"empty"[^.]*no active legs/ },
      { coverage: { total: 20, included: 0 }, value: null, status: 'unmeasured', meaning: /"unmeasured"[^.]*no eligible legs were included/ },
      { coverage: { total: 20, included: 19 }, value: 110, status: 'partial', meaning: /"partial"[^.]*only some[^.]*included/ },
      { coverage: full(20), value: undefined, status: 'unavailable', meaning: /"unavailable"[^.]*missing or invalid[^.]*complete coverage/ },
      { coverage: full(20), value: null, status: 'complete', meaning: /null beside "complete"[^.]*did not find/ },
    ];
    for (const state of states) {
      const wire = await registeredScan(scan({ levels: {
        ...scan().levels, callWall: state.value, coverage: coverage({ gamma: state.coverage }),
      } }));
      expect(wire.levels.callWall).toBeNull();
      expect(wire.levels.status.callWall).toBe(state.status);
      expect(wire.guide.levelCoverage).toMatch(state.meaning);
      expect(wire.guide.levelCoverage).not.toContain('a levels.status other than "complete" is withheld for coverage');
    }
  });

  it('keeps invalid probabilities unknown without diagnosing absent smile IV', async () => {
    for (const probabilityOfProfit of [1.5, -0.1, Number.NaN, undefined]) {
      const wire = await registeredScan(scan({ candidates: [candidate({ probabilityOfProfit })] }));
      expect(wire.candidates[0].probabilityOfProfit).toBeNull();
      expect(wire.candidates[0].legs[0].iv).toBe(0.3);
      expect(wire.units.probabilityOfProfit).toMatch(/missing or invalid/);
      expect(wire.units.probabilityOfProfit).toMatch(/outside 0-1/);
      expect(wire.units.probabilityOfProfit).toMatch(/no usable IV/);
      expect(wire.units.probabilityOfProfit).toMatch(/never 0/);
    }
  });

  it('explains a missing or invalid step beside a reported flip without calling it unreported', async () => {
    for (const gammaFlipResolution of [undefined, 0, -1, Number.NaN]) {
      const wire = await registeredScan(scan({ levels: {
        ...scan().levels, coverage: coverage({ gammaFlipResolution }),
      } }));
      expect(wire.levels.gammaFlip).toBe(97.5);
      expect(wire.levels.gammaFlipResolution).toBeNull();
      expect(wire.guide.flipResolution).toMatch(/missing, invalid or nonpositive/);
      expect(wire.guide.flipResolution).toMatch(/step is unknown/);
      expect(wire.guide.flipResolution).not.toContain('the sampling step was not reported');
    }
  });

  it('fits the final count guide with candidates and rateLimit when matched is unknown', async () => {
    const denseLeg = (strike: number) => ({
      ...leg('sell', 'put', strike), bid: 1.23456789012345, ask: 2.23456789012345, mid: 1.73456789012345,
      spreadPct: 57.6576576576576, iv: 0.234567890123456, delta: 0.234567890123456, gamma: 0.0234567890123456,
      theta: -0.0234567890123456, vega: 0.123456789012345, openInterest: 1000, volume: 100,
    });
    const dense = candidate({
      legs: [denseLeg(90), denseLeg(85), denseLeg(110), denseLeg(115)],
      breakevens: [{ price: 89.1234567890123 }, { price: 111.123456789012 }], anchorDelta: 0.234567890123456,
      netMid: 1.23456789012345, netNatural: 1.12345678901234, naturalSlippagePct: 9.23456789012345,
      maxProfit: 1.23456789012345, maxLoss: 3.76543210987655, returnOnRisk: 0.327868852459016,
      probabilityOfProfit: 0.812345678901234, probabilityOfMaxProfit: 0.712345678901234,
      position: { delta: 1.23456789012345, gamma: 0.234567890123456, theta: 1.23456789012345, vega: -1.23456789012345, source: 'model' },
      liquidity: { minOpenInterest: 1000, maxSpreadPct: 57.6576576576576 },
    });
    // Sweep a full candidate's worth of room: the late-added count line must never cross the shaper's own budget.
    for (let padding = 0; padding <= 2500; padding += 64) {
      const warning = 'x'.repeat(padding);
      const payload = { symbol: 'SPY', provider: 'tradier', matched: null,
        candidates: Array.from({ length: 25 }, () => dense), warnings: [warning] };
      const shaped = summarizeStrategyScan(payload, { rateLimit: budget });
      const wire = await registeredScan(payload);
      expect(shaped.limitedBySize).toBe(true);
      expect(new TextEncoder().encode(JSON.stringify(shaped)).length).toBeLessThanOrEqual(49_152);
      expect(new TextEncoder().encode(JSON.stringify(wire)).length).toBeLessThanOrEqual(49_152);
      expect(wire.returned).toBeGreaterThan(1);
      expect(wire.returned).toBeLessThan(25);
      expect(wire.limitedBySize).toBe(true);
      expect(wire.responseBudget).toBeUndefined();
      expect(wire.matched).toBeNull();
      expect(wire.guide.matchedCount).toMatch(/last-sorted candidates were dropped/);
      expect(wire.rateLimit).toEqual(budget);
      expect(wire.warnings).toEqual([warning]);
    }
  });

  it('the expanded units retain all 21 distinct candidates within the response budget', async () => {
    const denseLeg = (strike: number) => ({
      ...leg('sell', 'put', strike), bid: 1.23456789012345, ask: 2.23456789012345, mid: 1.73456789012345,
      spreadPct: 57.6576576576576, iv: 0.234567890123456, delta: 0.234568, gamma: 0.0234567890123456,
      theta: -0.0234567890123456, vega: 0.123456789012345, openInterest: 1000, volume: 100,
    });
    const candidates = Array.from({ length: 21 }, (_, i) => candidate({
      legs: [
        { ...denseLeg(70 + i), action: 'sell', type: 'put' }, { ...denseLeg(65 + i), action: 'buy', type: 'put' },
        { ...denseLeg(110 + i), action: 'sell', type: 'call' }, { ...denseLeg(115 + i), action: 'buy', type: 'call' },
      ],
      breakevens: [{ price: 70 + i - 1.23456789012345 }, { price: 110 + i + 1.23456789012345 }],
      anchorDelta: 0.234567890123456, netMid: 1.23456789012345, netNatural: 1.12345678901234,
      naturalSlippagePct: 9.23456789012345, maxProfit: 1.23456789012345, maxLoss: 3.76543210987655,
      returnOnRisk: 0.327868852459016, probabilityOfProfit: 0.812345678901234, probabilityOfMaxProfit: 0.712345678901234,
      position: { delta: 1.23456789012345, gamma: 0.234567890123456, theta: 1.23456789012345, vega: -1.23456789012345, source: 'model' },
      liquidity: { minOpenInterest: 1000, maxSpreadPct: 57.6576576576576 },
    }));
    for (const ivOneSigma of [5.2, 5.234567890123456]) {
      const shaped = summarizeStrategyScan({ symbol: 'SPY', provider: 'tradier', spotPrice: 100,
        request: { strategy: 'iron_condor', maxResults: 25 },
        expectedMove: { ...scan().expectedMove, ivOneSigma }, matched: 21, candidates });
      expect(shaped.returned).toBe(21);
      expect(shaped.limitedBySize).toBe(false);
      const result = await toolHandler(async () => shaped)({});
      const wire = result.structuredContent as any;
      expect(wire.returned).toBe(21);
      expect(wire.responseBudget).toBeUndefined();
      expect(wire.units).toEqual(shaped.units);
      expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(49_152);
    }
  });
});
