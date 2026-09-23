import { describe, expect, it } from 'bun:test';
import { shapeOptionsSnapshot, summarizeMetricsBatch, summarizeOptionsSnapshot } from './optionsSnapshotShaping.js';
import { sanitizeMcpWireOutput } from '../helpers.js';

/**
 * The invariant is that the sanitizer must not change our output AT ALL.
 *
 * Two weaker versions of this check shipped first and both accepted real data
 * loss. Comparing key SETS missed a key stripped in one place but emitted in
 * another. Comparing PATHS then missed a changed VALUE - a mutation rewriting
 * historyRequested from 60 to 0 passed every test - and collapsed array
 * positions, so a strip on element 1 hid behind element 0.
 *
 * Deep equality has neither hole and is simpler than either. The lesson is that
 * the guard should assert the actual invariant rather than a proxy for it.
 */
function expectSanitizerLeavesIntact(shaped: unknown): void {
  // Cloned FIRST. Comparing the sanitizer's output against the same object it
  // was handed passes trivially if the sanitizer edits in place: a mutation
  // that rewrote a value in both the input and the output went unnoticed. The
  // expected value has to be captured before the call, not derived from it.
  const expected = structuredClone(shaped);
  expect(sanitizeMcpWireOutput(shaped as Record<string, unknown>)).toEqual(expected as Record<string, unknown>);
}

const snapshot = (over: Record<string, unknown> = {}) => ({
  ticker: 'SPY',
  date: '2026-09-09',
  spotPrice: 655,
  maxPain: 650,
  netGex: 4_200_000,
  netDex: -2_800_000,
  atmIv: 0.142,
  atmIv7d: 0.15,
  atmIv30d: 0.146,
  atmIv90d: 0.152,
  putCallRatio: 1.12,
  ivSkew25d: 0.03,
  dividendYield: 0.012,
  totalVolume: 5_000_000,
  totalOi: 18_500_000,
  callVolume: 2_600_000,
  putVolume: 2_400_000,
  callOi: 9_800_000,
  putOi: 8_700_000,
  expectedMovePct: 0.018,
  ivRank: 22.4,
  ivPercentile: 31.7,
  hv20d: 0.121,
  hv60d: 0.138,
  maxPainCurve: null,
  gexByStrike: null,
  dexByStrike: null,
  volSkew: null,
  analyticsExpiry: '2026-09-18',
  chainExpiry: '2026-09-18',
  ...over,
});

const painRow = (strike: number, totalPain: number) => ({
  strike, callPain: totalPain / 2, putPain: totalPain / 2, totalPain,
});

describe('summarizeOptionsSnapshot', () => {
  it('returns the scalars without any curve being asked for', () => {
    const shaped = summarizeOptionsSnapshot(snapshot());
    expect(shaped.symbol).toBe('SPY');
    expect(shaped.date).toBe('2026-09-09');
    expect(shaped.metrics.maxPain).toBe(650);
    expect(shaped.metrics.atmIv30d).toBe(0.146);
    expect(shaped).not.toHaveProperty('curves');
    // The 30-day expected move is a decimal fraction of spot and is named so,
    // here as in the batch comparison: the proxy's `expectedMovePct` name does
    // not reach the model, where 0.018 under it reads as 0.018%.
    expect(shaped.metrics.expectedMove30dFraction).toBe(0.018);
    expect(shaped.metrics).not.toHaveProperty('expectedMovePct');
    expect(shaped.units.expectedMove30dFraction).toContain('decimal fraction');
    // The stored dividend_yield is 0 on every row the producer has ever
    // written (24 positive rows in 21.3 million on 2026-09-18), so the field
    // is a zero nobody computed: AAPL read as "pays no dividend". Not
    // published until the producer writes it; the live positioning tool
    // resolves q from the company profile instead.
    expect(shaped.metrics).not.toHaveProperty('dividendYield');
  });

  it('separates "no curve this session" from "no curve at all"', () => {
    // Curves live in another table and come back null when its date does not
    // match the snapshot's. Reporting that as simply absent would tell a caller
    // to stop asking about a symbol whose curve arrives tomorrow.
    expect(summarizeOptionsSnapshot(snapshot()).curvesAvailableForThisSession).toBe(false);
    expect(summarizeOptionsSnapshot(snapshot({ maxPainCurve: [painRow(650, 10)] }))
      .curvesAvailableForThisSession).toBe(true);
  });

  it('reports the true max-pain minimum, not the minimum of the window it returns', () => {
    // The window is centred on spot. If the minimum sits outside it, deriving
    // max pain from the returned rows gives the wrong strike - so it is
    // computed over every row and stated.
    const curve = [
      painRow(500, 1), // the true minimum, far from spot
      painRow(645, 90), painRow(650, 80), painRow(655, 70), painRow(660, 85),
    ];
    const shaped = summarizeOptionsSnapshot(snapshot({ maxPainCurve: curve }), { curves: ['maxPain'], curveLimit: 3 });
    const maxPain = (shaped.curves as any).maxPain;

    expect(maxPain.strikes).toBe(5);
    expect(maxPain.minimumTotalPain).toEqual({ strike: 500, totalPain: 1 });
    expect(maxPain.nearSpot.map((r: any) => r.strike)).toEqual([650, 655, 660]);
  });

  it('keeps exposure totals over the WHOLE curve, not the returned slice', () => {
    // Shape from proxy/services/SnapshotComputeService.ts:434, the writer -
    // NOT from openapi/examples.ts, which is a simplification and whose `gex`
    // key does not exist in the stored payload.
    const gex = [
      { strike: 400, callGex: 600_000, putGex: 400_000, netGex: 1_000_000 },
      { strike: 650, callGex: 6, putGex: 4, netGex: 10 },
      { strike: 655, callGex: 12, putGex: 8, netGex: 20 },
      { strike: 660, callGex: 18, putGex: 12, netGex: 30 },
    ];
    const shaped = summarizeOptionsSnapshot(snapshot({ gexByStrike: gex }), { curves: ['gex'], curveLimit: 2 });
    const summary = (shaped.curves as any).gex;

    expect(summary.strikes).toBe(4);
    expect(summary.total).toBe(1_000_060);
    expect(summary.largestAbsolute).toEqual({ strike: 400, netGex: 1_000_000 });
    expect(summary.nearSpot).toHaveLength(2);
  });

  it('reads netDex, which is a different key from netGex', () => {
    const dex = [
      { strike: 650, callDex: 1, putDex: 2, netDex: -3_400_000 },
      { strike: 655, callDex: 1, putDex: 2, netDex: 400_000 },
    ];
    const shaped = summarizeOptionsSnapshot(snapshot({ dexByStrike: dex }), { curves: ['dex'] });
    const summary = (shaped.curves as any).dex;
    expect(summary.total).toBe(-3_000_000);
    expect(summary.largestAbsolute).toEqual({ strike: 650, netDex: -3_400_000 });
    expect(summary.nearSpot[0].netDex).toBe(-3_400_000);
  });

  it('withholds an exposure total when no strike carried a value', () => {
    // The bug this replaced read a key that does not exist and reported
    // total: 0 - a flat dealer book, stated with total confidence, for a symbol
    // whose exposure was simply unreadable. Zero is a claim; absence is not.
    const shaped = summarizeOptionsSnapshot(
      snapshot({ gexByStrike: [{ strike: 650 }, { strike: 655 }] }),
      { curves: ['gex'] },
    );
    const summary = (shaped.curves as any).gex;
    expect(summary.strikes).toBe(2);
    expect(summary.strikesWithValue).toBe(0);
    expect(summary.total).toBeNull();
    expect(summary.largestAbsolute).toBeNull();
  });

  it('reads a skew curve keyed by expiration, which is how it is stored', () => {
    // _computeVolSkew groups by expiration: { [expiry]: [{ strike, iv }] }.
    // Expecting parallel strikes/iv arrays made every real curve read as null.
    const shaped = summarizeOptionsSnapshot(snapshot({
      volSkew: {
        '2026-09-18': [{ strike: 640, iv: 0.18 }, { strike: 655, iv: 0.14 }, { strike: 670, iv: 0.15 }],
        '2026-10-16': [{ strike: 655, iv: 0.16 }],
      },
    }), { curves: ['skew'] });
    const skew = (shaped.curves as any).skew;

    expect(skew).not.toBeNull();
    expect(skew.expirations).toHaveLength(2);
    // Expiration identity is preserved: a skew point is only meaningful with
    // the expiration it was measured at.
    expect(skew.expirations[0].expiration).toBe('2026-09-18');
    expect(skew.expirations[0].points).toEqual([
      { strike: 640, iv: 0.18 }, { strike: 655, iv: 0.14 }, { strike: 670, iv: 0.15 },
    ]);
    expect(skew.expirations[1].expiration).toBe('2026-10-16');
  });

  it('keeps both wings when it thins a skew curve', () => {
    // Sampling every nth point dropped the last one: 24 points at limit 12 took
    // indices 0,2,...,22. The wings ARE the skew - a curve whose final point is
    // an IV spike reads as flat once its end is gone.
    const points = Array.from({ length: 24 }, (_, i) => ({ strike: 600 + i * 5, iv: 0.14 }));
    points[points.length - 1].iv = 0.42; // the spike that must survive
    const shaped = summarizeOptionsSnapshot(
      snapshot({ volSkew: { '2026-09-18': points } }),
      { curves: ['skew'], curveLimit: 12 },
    );
    const curve = (shaped.curves as any).skew.expirations[0];

    expect(curve.points).toHaveLength(12);
    expect(curve.points[0].strike).toBe(600);
    expect(curve.points.at(-1).strike).toBe(715);
    expect(curve.points.at(-1).iv).toBe(0.42);
  });

  it('stays inside the response budget on a wide chain with every curve asked for', () => {
    const strikes = Array.from({ length: 900 }, (_, i) => 200 + i);
    const shaped = summarizeOptionsSnapshot(snapshot({
      maxPainCurve: strikes.map((s) => painRow(s, Math.abs(s - 650) * 1000)),
      gexByStrike: strikes.map((s) => ({ strike: s, callGex: s, putGex: s, netGex: s * 13 })),
      dexByStrike: strikes.map((s) => ({ strike: s, callDex: s, putDex: s, netDex: -s * 7 })),
      volSkew: Object.fromEntries(['2026-09-18', '2026-10-16', '2026-11-20', '2026-12-18']
        .map((exp) => [exp, strikes.map((s) => ({ strike: s, iv: 0.14 }))])),
    }), { curves: ['maxPain', 'gex', 'dex', 'skew'], curveLimit: 40 });

    expect(new TextEncoder().encode(JSON.stringify(shaped)).byteLength).toBeLessThan(50 * 1024);
    expect((shaped.curves as any).maxPain.minimumTotalPain.strike).toBe(650);
  });

  it('survives an empty or malformed snapshot without throwing', () => {
    for (const response of [{}, { ticker: null }, { maxPainCurve: 'nope' }, { volSkew: [] }]) {
      expect(() => summarizeOptionsSnapshot(response as any, { curves: ['maxPain', 'gex', 'dex', 'skew'] })).not.toThrow();
    }
    const shaped = summarizeOptionsSnapshot({} as any, { curves: ['maxPain'] });
    expect(shaped.metrics.spotPrice).toBeNull();
    expect((shaped.curves as any).maxPain).toBeNull();
  });

  /**
   * When a symbol has no options snapshot the proxy falls back to a different
   * table: a price row with spot, open, high, low and volume, and none of the
   * options keys. Read as a snapshot it would report twenty-two null metrics,
   * which a model cannot tell from "this symbol has no IV rank". The row's
   * `source` label is not the tell - the proxy's provenance spread rewrites
   * it - and neither is the asset class: futures contracts with listed options
   * get full snapshots. The tell is a spot with no options keys beside it. An
   * empty body is not a price row and keeps the null-metrics shape above.
   */
  it('says a price-only row is not an options snapshot rather than reporting null metrics', () => {
    const priceRow = {
      ticker: '/NQM6', date: '2026-09-15', spotPrice: 20_115.25, change: 42.5, changePct: 0.21,
      volume: 412_000, high: 20_190, low: 20_020, open: 20_070,
      source: 'ticker_snapshots', provider: 'futures_crypto',
    };
    const shaped: any = shapeOptionsSnapshot(priceRow as any, { curves: ['gex'] });
    expect(shaped.dataAvailable).toBe(false);
    expect(shaped.symbol).toBe('/NQM6');
    expect(shaped.message).toContain('No options snapshot for /NQM6');
    expect(shaped.metrics).toBeUndefined();
    expect(shaped.curves).toBeUndefined();
    expectSanitizerLeavesIntact(shaped);

    // The same row WITH an options key is a snapshot whose other metrics are
    // null, and is shaped as one. An empty body is not a price row either.
    const withOptions: any = shapeOptionsSnapshot({ ...priceRow, maxPain: null } as any);
    expect(withOptions.dataAvailable).toBeUndefined();
    expect(withOptions.metrics.spotPrice).toBe(20_115.25);
    const empty: any = shapeOptionsSnapshot({} as any);
    expect(empty.dataAvailable).toBeUndefined();
    expect(empty.metrics.spotPrice).toBeNull();
  });
});

describe('summarizeMetricsBatch', () => {
  it('names the symbols the endpoint did not return', () => {
    // The batch endpoint OMITS a symbol it has no snapshot for. Seven rows for
    // a ten-symbol request reads as a complete answer about a set the caller
    // never asked about, so the difference is reported.
    const shaped = summarizeMetricsBatch(
      { count: 2, data: [{ symbol: 'SPY', date: '2026-09-09', atmIv: 0.14 }, { symbol: 'QQQ', date: '2026-09-09', atmIv: 0.19 }] },
      ['SPY', 'QQQ', 'IWM', 'DIA'],
    );

    expect(shaped.requested).toBe(4);
    expect(shaped.returned).toBe(2);
    expect(shaped.missingSymbols).toEqual(['IWM', 'DIA']);
    expect(shaped.metrics.map((r) => r.symbol)).toEqual(['SPY', 'QQQ']);
  });

  it('reports nothing missing when every symbol came back', () => {
    const shaped = summarizeMetricsBatch({ data: [{ symbol: 'SPY' }] }, ['SPY']);
    expect(shaped.missingSymbols).toEqual([]);
  });

  it('returns the rows in the order they were asked for', () => {
    // The endpoint answers alphabetically. A model that asked for
    // "AAPL, MSFT, NVDA, SPY, QQQ" to compare them got QQQ before SPY, and a
    // table built row by row against the request came out misaligned. A
    // symbol the endpoint returned that was not asked for goes last, kept.
    const shaped = summarizeMetricsBatch(
      { data: [{ symbol: 'AAPL' }, { symbol: 'MSFT' }, { symbol: 'NVDA' }, { symbol: 'QQQ' }, { symbol: 'SPY' }, { symbol: 'XYZ' }] },
      ['SPY', 'QQQ', 'AAPL', 'NVDA', 'MSFT'],
    );
    expect(shaped.metrics.map((r) => r.symbol)).toEqual(['SPY', 'QQQ', 'AAPL', 'NVDA', 'MSFT', 'XYZ']);
    expect(shaped.returned).toBe(6);
  });

  it('publishes the expected move as the 30-day fraction it is, never under a percent name', () => {
    // option_ticker_snapshots.expected_move_pct is iv * sqrt(30 / 365): a
    // decimal fraction of spot over 30 calendar days, despite the column name.
    // 0.018 under a key ending in "Pct" reads as 0.018%, so the summary names
    // the unit in the key and says it again in `units`.
    const shaped = summarizeMetricsBatch({ data: [{ symbol: 'SPY', expectedMovePct: 0.018 }] }, ['SPY']);
    expect(shaped.metrics[0].expectedMove30dFraction).toBe(0.018);
    expect(shaped.metrics[0]).not.toHaveProperty('expectedMovePct');
    expect(shaped.units.expectedMove30dFraction).toContain('decimal fraction');
  });

  it('survives a malformed batch without throwing', () => {
    for (const response of [{}, { data: null }, { data: [null, 7] }]) {
      expect(() => summarizeMetricsBatch(response as any, ['SPY'])).not.toThrow();
    }
    expect(summarizeMetricsBatch({} as any, ['SPY']).missingSymbols).toEqual(['SPY']);
  });
});

describe('shaper output survives the shared wire sanitizer', () => {
  // The sanitizer strips and renames a fixed set of key names GLOBALLY, and a
  // shaper cannot see that by reading its own file. `isFallback` was chosen in
  // good faith and silently deleted on the way out, taking the flag that
  // qualified a rejected fit while leaving the parameters it qualified. This
  // pins the CLASS rather than that one name.
  it('keeps every key it emits', () => {
    const shaped = summarizeOptionsSnapshot(snapshot({
      maxPainCurve: [painRow(650, 10)],
      gexByStrike: [{ strike: 650, callGex: 1, putGex: 2, netGex: 3 }],
      dexByStrike: [{ strike: 650, callDex: 1, putDex: 2, netDex: 3 }],
      volSkew: { '2026-09-18': [{ strike: 650, iv: 0.14 }] },
    }), { curves: ['maxPain', 'gex', 'dex', 'skew'] });

    expectSanitizerLeavesIntact(shaped);
  });

  it('keeps every key the batch comparison emits', () => {
    const shaped = summarizeMetricsBatch({ data: [{ symbol: 'SPY', atmIv: 0.1 }] }, ['SPY', 'QQQ']);
    expectSanitizerLeavesIntact(shaped);
  });
});
