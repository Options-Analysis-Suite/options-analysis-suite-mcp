import { describe, test, expect } from 'bun:test';
import {
  flattenObjects,
  pickBestComparisons,
  truncateArrays,
  shapeRecord,
  truncateRecord,
  trimToSizeBudget,
  humanizeSignalsDeep,
  TRUNCATION_THRESHOLD,
  FFT_SAFE_SIZE_BUDGET,
  PRESERVE_KEYS,
  SKIP_TRUNCATE_KEYS,
} from './fftResponseShaping.js';

// ─── Helpers ─────────────────────────────────────────────────────────

/** Build a minimal comparison entry. */
function makeComp(overrides: Record<string, unknown> = {}) {
  return {
    strike: 100,
    type: 'call',
    moneyness: 'OTM',
    marketBid: 1.0,
    marketAsk: 1.2,
    marketMid: 1.1,
    volume: 500,
    openInterest: 2000,
    modelPrices: { blackScholes: 1.15 },
    modelSignals: { blackScholes: 'buy' },
    modelDiffs: { blackScholes: 4.5 },
    agreement: 'mixed',
    avgModelPrice: 1.15,
    priceSpread: 0.0,
    expiration: '2026-04-24',
    daysToExpiry: 28,
    ...overrides,
  };
}

/** Build a single-model FFT record as synced from the web app. */
function makeSingleModelRecord() {
  return {
    id: 1,
    user_id: 1,
    symbol: 'TSLA',
    timestamp: Date.now(),
    data: {
      expiration: '2026-04-24',
      daysToExpiry: 28,
      spot: 374.25,
      processType: 'heston',
      scanTimeMs: 120,
      summary: { totalScanned: 50, buySignals: 12, sellSignals: 8, bestEdge: 15.2, avgEdge: 3.1, avgAbsEdge: 5.4 },
      bestValues: { bestCall: { strike: 380, edge: 15.2 }, bestPut: { strike: 360, edge: 12.1 } },
    },
    details: {
      calibration: { rmse: 0.023, isFallback: false, timeMs: 85, executionPath: 'worker' },
    },
  };
}

/** Build a multi-model FFT record with N comparison entries. */
function makeMultiModelRecord(numComparisons: number, spot = 374.25) {
  const comparison = Array.from({ length: numComparisons }, (_, i) => {
    const strike = 300 + i * 2;
    const distFromSpot = Math.abs(strike - spot);
    return makeComp({
      strike,
      moneyness: distFromSpot < 5 ? 'ATM' : strike > spot ? 'OTM' : 'ITM',
      agreement: i % 10 === 0 ? 'unanimous_buy' : i % 7 === 0 ? 'majority_sell' : 'mixed',
      modelDiffs: { bs: 2 + i * 0.3, heston: -(1 + i * 0.2), vg: 5 + i * 0.5 },
      priceSpread: 0.1 + i * 0.01,
      marketMid: 1.0 + i * 0.1,
    });
  });
  return {
    id: 2,
    user_id: 1,
    symbol: 'AAPL',
    timestamp: Date.now(),
    data: {
      processType: 'multiModel',
      expiration: '2026-04-24',
      daysToExpiry: 28,
      spot,
      scanTimeMs: 450,
      models: ['blackScholes', 'heston', 'varianceGamma', 'merton', 'kou', 'bates', 'sabr'],
      failedModels: [{ model: 'sabr', error: 'did not converge' }],
    },
    details: { comparison },
  };
}

// ─── flattenObjects ──────────────────────────────────────────────────

describe('flattenObjects', () => {
  test('preserves calibration, summary, and bestValues inline', () => {
    const obj = {
      spot: 374.25,
      calibration: { rmse: 0.023, isFallback: false },
      summary: { totalScanned: 50, buySignals: 12 },
      bestValues: { bestCall: { strike: 380 } },
      someOther: { nested: true },
    };
    const result = flattenObjects(obj);
    expect(result.calibration).toEqual({ rmse: 0.023 });
    expect(result.summary).toEqual({ totalScanned: 50, buySignals: 12 });
    expect(result.bestValues).toEqual({ bestCall: { strike: 380 } });
    expect(result.someOther).toBe('[nested object]');
    expect(result.spot).toBe(374.25);
  });

  test('renames calibration isFallback to a prose-readable fallback flag only when true', () => {
    expect(flattenObjects({ calibration: { rmse: 0.023, isFallback: true } }).calibration)
      .toEqual({ rmse: 0.023, fallback: true });
    expect(flattenObjects({ calibration: { rmse: 0.023, isFallback: false } }).calibration)
      .toEqual({ rmse: 0.023 });
  });

  test('keeps arrays intact', () => {
    const obj = { models: ['bs', 'heston'], count: 5 };
    const result = flattenObjects(obj);
    expect(result.models).toEqual(['bs', 'heston']);
    expect(result.count).toBe(5);
  });

  test('handles null and undefined values', () => {
    const obj = { a: null, b: undefined, c: 'text' };
    const result = flattenObjects(obj);
    expect(result.a).toBeNull();
    expect(result.b).toBeUndefined();
    expect(result.c).toBe('text');
  });
});

// ─── truncateArrays ─────────────────────────────────────────────────

describe('truncateArrays', () => {
  test('skips arrays at or under maxItems', () => {
    const obj = { items: [1, 2, 3, 4, 5] };
    truncateArrays(obj, 5);
    expect(obj.items).toEqual([1, 2, 3, 4, 5]);
  });

  test('truncates generic arrays with simple slice', () => {
    const obj = { items: [1, 2, 3, 4, 5, 6, 7, 8] };
    truncateArrays(obj, 3);
    const result = obj.items as any;
    expect(result._count).toBe(8);
    expect(result._preview).toEqual([1, 2, 3]);
    expect(result._meta).toEqual({ showing: 3, total: 8, truncated: true });
  });

  test('never truncates models or failedModels arrays', () => {
    const models = ['bs', 'heston', 'vg', 'merton', 'kou', 'bates', 'sabr'];
    const failedModels = Array.from({ length: 10 }, (_, i) => ({ model: `m${i}` }));
    const obj = { models: [...models], failedModels: [...failedModels] };
    truncateArrays(obj, 3);
    expect(obj.models).toEqual(models);
    expect(obj.failedModels).toEqual(failedModels);
  });

  test('uses signal-aware selection for comparison arrays', () => {
    const comparison = [
      makeComp({ strike: 300, agreement: 'mixed', modelDiffs: { bs: 1 } }),
      makeComp({ strike: 350, agreement: 'unanimous_buy', modelDiffs: { bs: 30 } }),
      makeComp({ strike: 375, agreement: 'unanimous_sell', modelDiffs: { bs: 40 } }),
      makeComp({ strike: 400, agreement: 'majority_buy', modelDiffs: { bs: 5 } }),
      makeComp({ strike: 450, agreement: 'mixed', modelDiffs: { bs: 2 } }),
      makeComp({ strike: 500, agreement: 'mixed', modelDiffs: { bs: 1 } }),
    ];
    const obj = { comparison: [...comparison] };
    truncateArrays(obj, 3);
    const result = obj.comparison as any;
    expect(result._count).toBe(6);
    expect(result._preview).toHaveLength(3);
    expect(result._meta?.selection).toBe('strongest signals');
    // Unanimous entries should be picked first
    const strikes = result._preview.map((c: any) => c.strike);
    expect(strikes).toContain(350); // unanimous_buy
    expect(strikes).toContain(375); // unanimous_sell
  });
});

// ─── pickBestComparisons ─────────────────────────────────────────────

describe('pickBestComparisons', () => {
  test('unanimous beats majority beats mixed', () => {
    const arr = [
      makeComp({ strike: 100, agreement: 'mixed', modelDiffs: { bs: 1 } }),
      makeComp({ strike: 200, agreement: 'majority_buy', modelDiffs: { bs: 1 } }),
      makeComp({ strike: 300, agreement: 'unanimous_sell', modelDiffs: { bs: 1 } }),
    ];
    const result = pickBestComparisons(arr, 2);
    expect(result[0].strike).toBe(300); // unanimous
    expect(result[1].strike).toBe(200); // majority
  });

  test('uses modelDiffs to break ties within same agreement tier', () => {
    const arr = [
      makeComp({ strike: 100, agreement: 'mixed', modelDiffs: { bs: 5 } }),
      makeComp({ strike: 200, agreement: 'mixed', modelDiffs: { bs: 40 } }),
      makeComp({ strike: 300, agreement: 'mixed', modelDiffs: { bs: 20 } }),
    ];
    const result = pickBestComparisons(arr, 2);
    expect(result[0].strike).toBe(200); // highest abs diff (40)
    expect(result[1].strike).toBe(300); // second highest (20)
  });

  test('ATM proximity acts as tiebreaker with spot', () => {
    const arr = [
      makeComp({ strike: 100, agreement: 'mixed', modelDiffs: { bs: 5 }, moneyness: 'ITM' }),
      makeComp({ strike: 375, agreement: 'mixed', modelDiffs: { bs: 5 }, moneyness: 'ATM' }),
      makeComp({ strike: 500, agreement: 'mixed', modelDiffs: { bs: 5 }, moneyness: 'OTM' }),
    ];
    const result = pickBestComparisons(arr, 1, 374);
    expect(result[0].strike).toBe(375); // ATM gets +20 bonus
  });

  test('spot-based distance scoring favours near-money strikes', () => {
    // Both non-ATM, same agreement and diffs — spot distance decides
    const arr = [
      makeComp({ strike: 200, agreement: 'mixed', modelDiffs: { bs: 5 }, moneyness: 'ITM' }),
      makeComp({ strike: 370, agreement: 'mixed', modelDiffs: { bs: 5 }, moneyness: 'OTM' }),
    ];
    const result = pickBestComparisons(arr, 1, 374);
    expect(result[0].strike).toBe(370); // much closer to spot
  });
});

// ─── shapeRecord ─────────────────────────────────────────────────────

describe('shapeRecord', () => {
  test('preserves calibration in details for single-model records', () => {
    const record = makeSingleModelRecord();
    shapeRecord(record);
    expect(record.details.calibration as Record<string, unknown>).toEqual({
      rmse: 0.023,
      timeMs: 85,
      executionPath: 'worker',
    });
  });

  test('preserves summary and bestValues in data', () => {
    const record = makeSingleModelRecord();
    shapeRecord(record);
    expect(record.data.summary).toBeDefined();
    expect((record.data.summary as any).buySignals).toBe(12);
    expect(record.data.bestValues).toBeDefined();
    expect((record.data.bestValues as any).bestCall.strike).toBe(380);
  });

  test('compacts bestValues entries: keeps signal fields, drops verbose pricing', () => {
    const record: any = {
      symbol: 'SPY',
      timestamp: Date.now(),
      data: {
        spot: 659.22,
        summary: {
          totalScanned: 117,
          buySignals: 97,
          sellSignals: 20,
          signalCounts: { weakBuy: 3, weak_buy: 2, strongSell: 4 },
          agreementCounts: { majority_buy: 5 },
          scanTimeMs: 1.4,
        },
        bestValues: {
          bestEdgePut: {
            edge: 1.2729,
            type: 'put',
            delta: -0.161,
            signal: 'strongBuy',
            strike: 660,
            volume: 7619,
            marketIV: 0.445,
            marketAsk: 4.88,
            marketBid: 4.85,
            marketMid: 4.865,
            moneyness: 'ATM',
            priceDiff: 1.2879,
            priceDiffPct: 26.47,
            modelPrice: 6.1529,
            errorMetrics: { absError: 1.2879, relError: 0.2647, halfSpreadRatio: 85.86 },
            openInterest: 1546,
            qualityFlags: [],
          },
        },
      },
      details: {},
    };
    shapeRecord(record);
    const bep = (record.data.bestValues as any).bestEdgePut;
    // Signal-bearing fields preserved
    expect(bep.type).toBe('put');
    expect(bep.strike).toBe(660);
    expect(bep.signal).toBe('strong buy');
    expect(bep.edge).toBe(1.2729);
    expect(bep.priceDiff).toBe(1.2879);
    expect(bep.priceDiffPct).toBe(26.47);
    expect(bep.marketMid).toBe(4.865);
    expect(bep.moneyness).toBe('ATM');
    expect(bep.volume).toBe(7619);
    expect(bep.openInterest).toBe(1546);
    // Verbose pricing dropped to save space
    expect(bep.delta).toBeUndefined();
    expect(bep.marketIV).toBeUndefined();
    expect(bep.marketAsk).toBeUndefined();
    expect(bep.marketBid).toBeUndefined();
    expect(bep.modelPrice).toBeUndefined();
    expect(bep.errorMetrics).toBeUndefined();
    expect(bep.qualityFlags).toBeUndefined();
    // Summary micro-stats dropped
    expect((record.data.summary as any).scanTimeMs).toBeUndefined();
    expect((record.data.summary as any).buySignals).toBe(97);
    expect((record.data.summary as any).signalCounts).toEqual({ 'weak buy': 5, 'strong sell': 4 });
    expect((record.data.summary as any).agreementCounts).toEqual({ 'majority buy': 5 });
  });

  test('preserves signal and priceDiffPct on Shape C portfolio-scan model entries', () => {
    // Shape C (multi-model portfolio scan) — the AI needs to know which
    // models flagged each position and by how much. Greeks compaction is
    // fine but dropping signal/priceDiffPct would gut the tool's purpose.
    const record: any = {
      symbol: 'SPY',
      timestamp: Date.now(),
      data: {
        spot: 652.41,
        type: 'portfolio_scan',
        models: ['blackScholes'],
        symbol: 'SPY',
        multiModel: false,
        positions: [
          {
            strike: 550,
            quantity: 1,
            expiration: '2026-05-15',
            optionType: 'call',
            marketMid: 114.7,
            agreement: 'majority_sell',
            avgModelPrice: 114.2,
            models: [
              {
                model: 'blackScholes',
                price: 114.7333,
                signal: 'weakSell',
                priceDiffPct: -0.46,
                greeks: {
                  Delta: 0.95,
                  Gamma: 0.002,
                  Theta: -0.12,
                  Vega: 0.08,
                  Rho: 0.15,
                  // Higher-order greeks that SHOULD be dropped by compactGreeks
                  Vanna: 0.01,
                  Charm: -0.002,
                  Vomma: 0.0001,
                  Speed: 0.00001,
                  Color: 0.00002,
                  Zomma: 0.0000001,
                },
              },
            ],
          },
        ],
      },
      details: {},
    };
    shapeRecord(record);
    const position = (record.data.positions as any)[0];
    const model = position.models[0];
    // Signal-bearing fields — MUST survive, the tool exists to surface these
    expect(model.signal).toBe('weak sell');
    expect(model.priceDiffPct).toBe(-0.46);
    expect(model.model).toBe('Black-Scholes');
    expect(model.price).toBe(114.7333);
    // Primary greeks preserved
    expect(model.greeks).toEqual({
      Delta: 0.95,
      Gamma: 0.002,
      Theta: -0.12,
      Vega: 0.08,
      Rho: 0.15,
    });
    // Higher-order greeks dropped to save size
    expect((model.greeks as any).Vanna).toBeUndefined();
    expect((model.greeks as any).Charm).toBeUndefined();
    expect((model.greeks as any).Vomma).toBeUndefined();
    // Position-level fields preserved
    expect(position.strike).toBe(550);
    expect(position.agreement).toBe('majority_sell');
    expect(position.expiration).toBe('2026-05-15');
  });

  test('flattens unknown nested objects', () => {
    const record = {
      data: { spot: 100, unknownNested: { deep: true } },
      details: { unknownNested: { deep: true } },
    };
    shapeRecord(record);
    expect(record.data.unknownNested as unknown).toBe('[nested object]');
    expect(record.details.unknownNested as unknown).toBe('[nested object]');
  });

  test('handles records with null/missing data or details', () => {
    const record = { data: null, details: undefined } as any;
    expect(() => shapeRecord(record)).not.toThrow();
  });
});

// ─── truncateRecord ──────────────────────────────────────────────────

describe('truncateRecord', () => {
  test('preserves models array on multi-model records', () => {
    const record = makeMultiModelRecord(200);
    truncateRecord(record);
    expect(record.data.models).toEqual([
      'blackScholes', 'heston', 'varianceGamma', 'merton', 'kou', 'bates', 'sabr',
    ]);
  });

  test('preserves failedModels array', () => {
    const record = makeMultiModelRecord(200);
    truncateRecord(record);
    expect(record.data.failedModels).toEqual([{ model: 'sabr', error: 'did not converge' }]);
  });

  test('truncates comparison on oversized records', () => {
    const record = makeMultiModelRecord(200);
    truncateRecord(record);
    const comp = record.details.comparison as any;
    expect(comp._count).toBe(200);
    expect(comp._preview).toHaveLength(5);
    expect(comp._meta?.selection).toBe('strongest signals');
  });

  test('passes spot from data to comparison selection', () => {
    const spot = 374.25;
    // Build a record where all entries are 'mixed' with similar diffs,
    // so ATM proximity becomes the deciding factor
    const comparison = Array.from({ length: 10 }, (_, i) => {
      const strike = 300 + i * 20;
      return makeComp({
        strike,
        moneyness: Math.abs(strike - spot) < 5 ? 'ATM' : 'OTM',
        agreement: 'mixed',
        modelDiffs: { bs: 5 },
        priceSpread: 0.1,
        marketMid: 1.0,
      });
    });
    const record = {
      id: 1, user_id: 1, symbol: 'AAPL', timestamp: Date.now(),
      data: { processType: 'multiModel', spot, models: ['bs'] },
      details: { comparison },
    };
    truncateRecord(record);
    const preview = (record.details.comparison as any)._preview;
    const strikes = preview.map((c: any) => c.strike) as number[];
    // Strikes nearest to spot (380, 360) should be favoured over far wings (300, 500)
    expect(strikes).toContain(380); // closest to 374.25
    expect(strikes).not.toContain(300); // deep wing, far from spot
  });
});

// ─── Integration: under-budget rows stay intact ──────────────────────

describe('size-aware truncation', () => {
  test('small single-model record stays fully intact', () => {
    const record = makeSingleModelRecord();
    const res = { data: [record] };

    // Shape
    for (const r of res.data) shapeRecord(r);

    // Should be well under threshold
    expect(JSON.stringify(res).length).toBeLessThan(TRUNCATION_THRESHOLD);

    // So truncation pass would NOT run — verify data is untouched
    expect(record.data.summary).toBeDefined();
    expect(record.data.bestValues).toBeDefined();
    expect(record.details.calibration).toBeDefined();
  });

  test('AAPL-sized record exceeds threshold after shaping', () => {
    const record = makeMultiModelRecord(250);
    const res = { data: [record] };
    for (const r of res.data) shapeRecord(r);
    // 250 comparisons should exceed 40KB
    expect(JSON.stringify(res).length).toBeGreaterThan(TRUNCATION_THRESHOLD);
  });

  test('moderate multi-model record stays under threshold', () => {
    // ~50 comparisons should fit
    const record = makeMultiModelRecord(50);
    const res = { data: [record] };
    for (const r of res.data) shapeRecord(r);
    expect(JSON.stringify(res).length).toBeLessThan(TRUNCATION_THRESHOLD);
  });
});

// ─── trimToSizeBudget ────────────────────────────────────────────────

describe('trimToSizeBudget', () => {
  /** Build an oversized-but-valid FFT record of roughly N bytes. */
  function makeBloatRecord(timestamp: number, approxBytes: number) {
    return {
      symbol: 'TEST',
      timestamp,
      data: {
        spot: 100,
        summary: { totalScanned: 10, buySignals: 1, sellSignals: 1 },
        bestValues: {},
        blob: 'x'.repeat(Math.max(0, approxBytes - 200)),
      },
      details: {},
    };
  }

  test('drops oldest rows until under budget, keeps newest, adds note', () => {
    // 10 records @ ~3 KB each, newest timestamp = highest (sync is DESC)
    const records = Array.from({ length: 10 }, (_, i) =>
      makeBloatRecord(2_000_000_000_000 - i * 1000, 3000),
    );
    const res: any = { data: [...records], count: 10 };

    trimToSizeBudget(res, 15 * 1024); // 15 KB budget ⇒ must trim

    // Trimmed but not empty
    expect(res.data.length).toBeGreaterThan(0);
    expect(res.data.length).toBeLessThan(10);
    // Newest row (highest timestamp) is index 0 and still present
    expect(res.data[0].timestamp).toBe(2_000_000_000_000);
    // Surviving rows are a prefix of the original array — strictly
    // monotonically decreasing timestamps, dropped rows are the oldest
    for (let i = 0; i < res.data.length; i += 1) {
      expect(res.data[i].timestamp).toBe(2_000_000_000_000 - i * 1000);
    }
    // Final payload is under budget
    expect(JSON.stringify(res).length).toBeLessThanOrEqual(15 * 1024);
    // Note set, count updated
    expect(res._truncation_meta).toMatchObject({
      requested: 10,
      returned: res.data.length,
      selection: 'newest',
    });
    expect(res.count).toBe(res.data.length);
  });

  test('no-op when response already fits', () => {
    const records = [
      { symbol: 'A', timestamp: 200, data: { spot: 100 }, details: {} },
      { symbol: 'B', timestamp: 100, data: { spot: 101 }, details: {} },
    ];
    const res: any = { data: [...records], count: 2 };
    trimToSizeBudget(res, 100 * 1024);
    expect(res.data.length).toBe(2);
    expect(res._truncation_meta).toBeUndefined();
    expect(res.count).toBe(2);
  });

  test('preserves at least 1 row even if the first row alone exceeds the budget', () => {
    const records = [makeBloatRecord(2_000_000_000_000, 5000)];
    const res: any = { data: [...records], count: 1 };
    trimToSizeBudget(res, 100); // absurdly tiny budget
    // Guard against trimming to zero
    expect(res.data.length).toBe(1);
    // Length === 1 means the while loop never entered, so no note
    expect(res._truncation_meta).toBeUndefined();
  });

  test('no-op on null or malformed input', () => {
    expect(() => trimToSizeBudget(null)).not.toThrow();
    expect(() => trimToSizeBudget(undefined)).not.toThrow();
    expect(() => trimToSizeBudget({ data: 'not an array' } as any)).not.toThrow();
    expect(() => trimToSizeBudget({ data: [] } as any)).not.toThrow();
  });

  test('default budget equals FFT_SAFE_SIZE_BUDGET constant', () => {
    expect(FFT_SAFE_SIZE_BUDGET).toBe(48 * 1024);
    // Default budget should leave headroom below the 50 KB MCP hard limit
    expect(FFT_SAFE_SIZE_BUDGET).toBeLessThan(50 * 1024);
  });
});

describe('humanizeSignalsDeep', () => {
  test('humanizes camelCase signal values throughout a nested payload', () => {
    const payload = {
      data: [
        {
          symbol: 'TSLA',
          bestValues: {
            bestEdgePut: { signal: 'strongSell', strike: 370, edge: 0.28 },
            bestEdgeCall: { signal: 'weakBuy', strike: 420 },
          },
          comparison: [
            {
              agreement: 'majority_buy',
              modelDiffs: { blackScholes: 4.5, varianceGamma: -2.2 },
              modelPrices: { blackScholes: 13.2 },
              modelSignals: { varianceGamma: 'strongSell' },
            },
          ],
          models: ['blackScholes', 'varianceGamma'],
          positions: [
            {
              strike: 380,
              models: [
                { model: 'blackScholes', signal: 'strongBuy', priceDiffPct: 1.2 },
                { model: 'heston', signal: 'sell', priceDiffPct: -0.4 },
              ],
            },
          ],
        },
      ],
    };
    humanizeSignalsDeep(payload);
    expect(payload.data[0].bestValues.bestEdgePut.signal).toBe('strong sell');
    expect(payload.data[0].bestValues.bestEdgeCall.signal).toBe('weak buy');
    expect(payload.data[0].positions[0].models[0].signal).toBe('strong buy');
    expect(payload.data[0].positions[0].models[0].model).toBe('Black-Scholes');
    expect(payload.data[0].positions[0].models[1].signal).toBe('sell');
    expect(payload.data[0].models).toEqual(['Black-Scholes', 'Variance Gamma']);
    const comparison = payload.data[0].comparison[0] as any;
    expect(comparison.agreement).toBe('majority buy');
    expect(comparison.modelDiffs).toEqual({ 'Black-Scholes': 4.5, 'Variance Gamma': -2.2 });
    expect(comparison.modelPrices).toEqual({ 'Black-Scholes': 13.2 });
    expect(comparison.modelSignals).toEqual({ 'Variance Gamma': 'strong sell' });
  });

  test('leaves non-signal fields untouched and is null/array safe', () => {
    const payload = {
      strike: 100,
      models: [{ model: 'sabr', priceDiffPct: 0.3 }, null],
      meta: { kind: 'fft' },
    };
    humanizeSignalsDeep(payload);
    expect(payload.strike).toBe(100);
    expect(payload.models[0]).toEqual({ model: 'SABR', priceDiffPct: 0.3 });
    expect(payload.meta.kind).toBe('fft');
    expect(() => humanizeSignalsDeep(null)).not.toThrow();
    expect(() => humanizeSignalsDeep('string')).not.toThrow();
    expect(() => humanizeSignalsDeep(42)).not.toThrow();
  });
});
