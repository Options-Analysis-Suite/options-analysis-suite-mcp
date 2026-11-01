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

// The published book's wire (proxy/lib/assetExposureV2.ts, the route's always-present block): each side's resolved
// bases, the coverage per metric and the delta balance; a strike's GEX in the assumed book is call gex minus put gex.
const METRICS = ['gamma', 'delta', 'vega', 'vanna', 'charm', 'vomma'] as const;
const coverage = (over: Partial<Record<(typeof METRICS)[number], [number, number]>> = {}) => Object.fromEntries(METRICS.map((m) => {
  const [included, total] = over[m] ?? [2, 2];
  return [m, { included, total }];
}));
const side = (gex: number, charm: number) => ({ gex, dex: 0, vega: 1, vanna: 1, charmFixedRef: charm, rollBasis: 0, charm, vomma: 1 });
const bases = (callGex: number, putGex: number, dexBalance: number | null, over: Partial<Record<(typeof METRICS)[number], [number, number]>> = {}) => ({
  call: side(callGex, 3), put: side(putGex, 1), coverage: coverage(over), dexBalance,
});
const bookBlock = (strikes: Array<{ strike: number; bases: ReturnType<typeof bases> }>, over: Record<string, unknown> = {}) => ({
  available: true, methodology: 2, referenceKind: 'spot', roll: { status: 'notApplicable', carry: null },
  totals: bases(3000, 1000, -500), strikes, definition: 'expiry-scoped', expiryQualifier: null, ...over,
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

  it('never sends the stored net GEX and DEX or their curves: the exposure is the published book', () => {
    // the row still stores the earlier calculation's totals and curves; none of them is read into the answer
    const legacyOnly = summarizeOptionsSnapshot(snapshot({
      gexByStrike: [{ strike: 650, callGex: 6, putGex: 4, netGex: 10 }],
      dexByStrike: [{ strike: 650, callDex: 1, putDex: 2, netDex: -3 }],
    }), { curves: ['gex', 'dex'] });
    expect(legacyOnly.metrics).not.toHaveProperty('netGex');
    expect(legacyOnly.metrics).not.toHaveProperty('netDex');
    expect(legacyOnly.curves).toEqual({ gex: null, dex: null });
    expect(legacyOnly).toMatchObject({ exposures: null, exposuresUnavailable: 'the stored book is unreadable' });
    expect(JSON.stringify(legacyOnly)).not.toMatch(/4200000|-2800000|"net(Gex|Dex)"/);
    // with the book: its totals in `exposures`, its strikes the curves, the stored totals still absent
    const withBook = summarizeOptionsSnapshot(snapshot({ exposureV2: bookBlock([{ strike: 650, bases: bases(6, 4, -3) }]) }), { curves: ['gex'] });
    expect(withBook.metrics).not.toHaveProperty('netGex');
    expect(withBook.exposures).toMatchObject({ gex: 2000, putMinusCallDeltaBalance: -500 });
    expect((withBook.curves as any).gex.largestAbsolute).toEqual({ strike: 650, gex: 2 });
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
    // The book's per-strike bases from the route's block (proxy/lib/assetExposureV2.ts); a strike's GEX in the assumed
    // book is call minus put.
    const block = bookBlock([
      { strike: 400, bases: bases(1_600_000, 600_000, 1) },
      { strike: 650, bases: bases(16, 6, 1) },
      { strike: 655, bases: bases(32, 12, 1) },
      { strike: 660, bases: bases(48, 18, 1) },
    ]);
    const shaped = summarizeOptionsSnapshot(snapshot({ exposureV2: block }), { curves: ['gex'], curveLimit: 2 });
    const summary = (shaped.curves as any).gex;

    expect(summary.strikes).toBe(4);
    expect(summary.total).toBe(1_000_060);
    expect(summary.largestAbsolute).toEqual({ strike: 400, gex: 1_000_000 });
    expect(summary.nearSpot).toHaveLength(2);
  });

  it('reads the dex curve from the delta balance, a different value from the GEX', () => {
    const block = bookBlock([
      { strike: 650, bases: bases(2, 1, -3_400_000) },
      { strike: 655, bases: bases(2, 1, 400_000) },
    ]);
    const shaped = summarizeOptionsSnapshot(snapshot({ exposureV2: block }), { curves: ['gex', 'dex'] });
    const dex = (shaped.curves as any).dex;
    expect(dex.total).toBe(-3_000_000);
    expect(dex.largestAbsolute).toEqual({ strike: 650, putMinusCallDeltaBalance: -3_400_000 });
    expect(dex.nearSpot[0].putMinusCallDeltaBalance).toBe(-3_400_000);
    expect((shaped.curves as any).gex.total).toBe(2);
  });

  it('withholds an exposure total when no strike carried a value', () => {
    // The bug this replaced read a key that does not exist and reported
    // total: 0 - a flat dealer book, stated with total confidence, for a symbol
    // whose exposure was simply unreadable. Zero is a claim; absence is not.
    const block = bookBlock([650, 655].map((strike) => ({ strike, bases: bases(5, 1, 1, { gamma: [0, 2] }) })));
    const shaped = summarizeOptionsSnapshot(snapshot({ exposureV2: block }), { curves: ['gex'] });
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
      exposureV2: bookBlock(strikes.map((s) => ({ strike: s, bases: bases(s * 14, s, -s * 7, s % 3 === 0 ? { gamma: [1, 2] } : {}) }))),
      volSkew: Object.fromEntries(['2026-09-18', '2026-10-16', '2026-11-20', '2026-12-18']
        .map((exp) => [exp, strikes.map((s) => ({ strike: s, iv: 0.14 }))])),
    }), { curves: ['maxPain', 'gex', 'dex', 'skew'], curveLimit: 40 });

    expect(new TextEncoder().encode(JSON.stringify(shaped)).byteLength).toBeLessThan(50 * 1024);
    expect((shaped.curves as any).maxPain.minimumTotalPain.strike).toBe(650);
    expect((shaped.curves as any).gex.nearSpot).toHaveLength(40);
    expect((shaped.curves as any).dex.strikes).toBe(900);
  });

  it('survives an empty or malformed snapshot without throwing', () => {
    for (const response of [{}, { ticker: null }, { maxPainCurve: 'nope' }, { volSkew: [] }]) {
      expect(() => summarizeOptionsSnapshot(response as any, { curves: ['maxPain', 'gex', 'dex', 'skew'] })).not.toThrow();
    }
    const shaped = summarizeOptionsSnapshot({} as any, { curves: ['maxPain', 'gex'] });
    expect(shaped.metrics.spotPrice).toBeNull();
    expect((shaped.curves as any).maxPain).toBeNull();
    expect((shaped.curves as any).gex).toBeNull();
    expect(shaped.exposures).toBeNull();
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
      exposureV2: bookBlock([{ strike: 650, bases: bases(3, 1, 2, { delta: [1, 2] }) }], { totals: bases(3, 1, 2, { vega: [1, 2] }) }),
      volSkew: { '2026-09-18': [{ strike: 650, iv: 0.14 }] },
    }), { curves: ['maxPain', 'gex', 'dex', 'skew'] });
    expect(shaped.exposures).not.toBeNull();

    expectSanitizerLeavesIntact(shaped);
  });

  it('keeps every key the batch comparison emits', () => {
    const shaped = summarizeMetricsBatch({ data: [{ symbol: 'SPY', atmIv: 0.1 }] }, ['SPY', 'QQQ']);
    expectSanitizerLeavesIntact(shaped);
  });
});

describe('summarizeMetricsBatch ranking', () => {
  // each row's book (the batch opt-in, proxy/lib/snapshotExposureV2.ts batchRowExposureV2) beside the stored legacy
  // totals, which are never read: the stored netGex and netDex carry the opposite sign of the book's here
  const book = (gex: number, dex: number) => ({ available: true, netGex: { value: gex, status: 'complete' }, netDex: { value: dex, status: 'complete' }, referenceKind: 'spot', charmBasis: 'cash' });
  const rows = [
    { symbol: 'SPY', date: '2026-09-09', atmIv: 0.14, hv20d: 0.10, hv60d: 0.12, ivRank: 20, totalOi: 100, netGex: -5e9, spotPrice: 650, netDex: 1e9, ivSkew25d: 0.03, exposureV2: book(5e9, -1e9) },
    { symbol: 'QQQ', date: '2026-09-09', atmIv: 0.19, hv20d: 0.17, hv60d: null, ivRank: 55, totalOi: 80, netGex: 2e9, spotPrice: 560, netDex: -2e9, ivSkew25d: 0.04, exposureV2: book(-2e9, 2e9) },
    { symbol: 'IWM', date: '2026-09-09', atmIv: 0.22, hv20d: 0.15, hv60d: 0.16, ivRank: null, totalOi: 60, netGex: -1e9, spotPrice: 220, netDex: 7, ivSkew25d: null, exposureV2: book(1e9, 0) },
  ];

  it('carries spot, the book\'s exposures, the skew and the IV minus realized spreads on every row', () => {
    const shaped: any = summarizeMetricsBatch({ data: rows }, ['SPY', 'QQQ', 'IWM']);
    expect(shaped.metrics[0]).toMatchObject({ symbol: 'SPY', spotPrice: 650, netGex: 5e9, netDex: -1e9, ivSkew25d: 0.03, ivMinusHv20d: 0.04, ivMinusHv60d: 0.02 });
    expect(shaped.metrics[2].netDex).toBe(0);
    expect(shaped.exposuresCommon).toEqual({ referenceKind: 'spot', charmBasis: 'cash' });
    expect(shaped.metrics[1].ivMinusHv60d).toBeNull();
    expect(shaped.metrics[2].ivSkew25d).toBeNull();
    expect(shaped.rankMeta).toBeUndefined();
  });

  it('ranks the rows by the metric asked for, descending by default, with a null metric last and counted', () => {
    const shaped: any = summarizeMetricsBatch({ data: rows }, ['SPY', 'QQQ', 'IWM'], { rankBy: 'ivRank' });
    expect(shaped.metrics.map((r: any) => r.symbol)).toEqual(['QQQ', 'SPY', 'IWM']);
    expect(shaped.rankMeta).toEqual({ rankBy: 'ivRank', order: 'desc', ranked: 2, unranked: 1, unrankedSymbols: ['IWM'] });
    const asc: any = summarizeMetricsBatch({ data: rows }, ['SPY', 'QQQ', 'IWM'], { rankBy: 'ivMinusHv20d', order: 'asc' });
    expect(asc.metrics.map((r: any) => r.symbol)).toEqual(['QQQ', 'SPY', 'IWM']);
    expect(asc.rankMeta.order).toBe('asc');
    const gex: any = summarizeMetricsBatch({ data: rows }, ['SPY', 'QQQ', 'IWM'], { rankBy: 'netGex' });
    expect(gex.metrics.map((r: any) => r.symbol)).toEqual(['SPY', 'IWM', 'QQQ']);
    expect(gex.rankMeta).toMatchObject({ ranked: 3, unranked: 0, unrankedReasons: {} });
  });

  it('a row without its book has no exposure figure, whatever the stored row carries, and says why', () => {
    const shaped: any = summarizeMetricsBatch({ data: [{ symbol: 'SPY', netGex: 5e9, netDex: -1e9 }] }, ['SPY'], { rankBy: 'netDex' });
    expect(shaped.metrics[0]).toMatchObject({ netGex: null, netDex: null, exposureUnavailable: 'the stored book is unreadable' });
    expect(shaped.rankMeta).toMatchObject({ ranked: 0, unranked: 1, unrankedReasons: { unavailable: 1 } });
  });

  it('keeps the request order when nothing is asked to rank by', () => {
    const shaped: any = summarizeMetricsBatch({ data: rows }, ['IWM', 'SPY', 'QQQ']);
    expect(shaped.metrics.map((r: any) => r.symbol)).toEqual(['IWM', 'SPY', 'QQQ']);
  });
});

describe('a snapshot whose curves could not be read', () => {
  const base = { ticker: 'AAPL', date: '2026-10-07', spotPrice: 231.4, maxPain: 230, netGex: 1e9, atmIv: 0.27, putCallRatio: 0.8,
    maxPainCurve: null, gexByStrike: null, dexByStrike: null, volSkew: null };

  it('says the curves are unknown (null) with a note, never that they have not caught up (false)', () => {
    const out = summarizeOptionsSnapshot({ ...base, partial: true, unavailable: ['curves'] } as any, { curves: ['maxPain'] }) as any;
    expect(out.curvesAvailableForThisSession).toBeNull();
    expect(out.partial).toBe(true);
    expect(out.unavailable).toEqual(['curves']);
    expect(out.partialNote).toMatch(/could not be read/);
  });

  it('curves absent with every read made: false, no partial fields (the control)', () => {
    const out = summarizeOptionsSnapshot(base as any) as any;
    expect(out.curvesAvailableForThisSession).toBe(false);
    expect('partial' in out).toBe(false);
  });
});

describe('a futures price row whose chain could not be read (review)', () => {
  const row = { ticker: '/ESZ6', date: '2026-10-07', spotPrice: 7700 };

  it('is never "a price row only": the chain is unknown, with partial, unavailable and a note', () => {
    const out = sanitizeMcpWireOutput(shapeOptionsSnapshot({ ...row, partial: true, unavailable: ['chain'] } as any)) as any;
    expect(out.partial).toBe(true);
    expect(out.unavailable).toEqual(['chain']);
    expect(JSON.stringify(out)).not.toMatch(/no options metrics to report|price row only/);
    expect(out.message).toMatch(/could not be read/);
  });

  it('a price row whose chain was read (none on file): the price-only answer (the control)', () => {
    const out = shapeOptionsSnapshot(row as any) as any;
    expect(out.message).toMatch(/no options metrics to report/);
    expect('partial' in out).toBe(false);
  });
});
