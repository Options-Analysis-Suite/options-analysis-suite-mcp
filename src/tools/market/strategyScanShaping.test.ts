import { describe, expect, it } from 'bun:test';
import { summarizeStrategyScan } from './strategyScanShaping.js';
import { plainDecimal, register } from './strategyScan.js';
import { toolHandler } from '../helpers.js';

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
    // Review's input: complete coverage but no finite net gamma (an overflow
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
