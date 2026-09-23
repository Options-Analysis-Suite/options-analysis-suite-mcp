import { describe, expect, test } from 'bun:test';
import {
  labelOptionsAnalyticsHistory,
  shouldSummarizeOptionsAnalyticsHistory,
  sortOptionsAnalyticsPoints,
  summarizeOptionsAnalyticsHistory,
} from './optionsAnalyticsHistoryShaping.js';

describe('sortOptionsAnalyticsPoints', () => {
  test('sorts analytics snapshots newest-first by date', () => {
    const sorted = sortOptionsAnalyticsPoints([
      { date: '2026-01-03', spot_price: 103 },
      { date: '2026-01-05', spot_price: 105 },
      { date: '2026-01-04', spot_price: 104 },
    ]);

    expect(sorted.map((point) => point.date)).toEqual([
      '2026-01-05',
      '2026-01-04',
      '2026-01-03',
    ]);
  });
});

describe('summarizeOptionsAnalyticsHistory', () => {
  test('builds a compact recent/trend summary for large histories', () => {
    const payload = {
      symbol: 'SPY',
      interval: 'daily',
      count: 5,
      data: [
        { date: '2026-01-02', spot_price: 101, atm_iv: 0.17, hv_20d: 0.12, put_call_ratio: 1.0, expected_move_pct: 0.035, iv_rank: 0.4, iv_percentile: 0.5, net_gex: 150, net_dex: 200, net_vex: 10, net_vanna: 75, net_charm: -60, net_vomma: 90, dividend_yield: 0.011, risk_free_rate: 0.043, max_pain: 99, term_structure_slope: 0.007, iv_skew_25d: 0.035, vwiv: 0.21 },
        { date: '2026-01-05', spot_price: 105, atm_iv: 0.23, atm_iv_30d: 0.24, hv_20d: 0.15, put_call_ratio: 1.3, expected_move_pct: 0.05, iv_rank: 0.7, iv_percentile: 0.8, net_gex: 300, net_dex: -500, net_vex: 20, net_vanna: -180, net_charm: 110, net_vomma: 130, dividend_yield: 0.013, risk_free_rate: 0.045, max_pain: 100, term_structure_slope: 0.01, iv_skew_25d: 0.05, vwiv: 0.26 },
        { date: '2026-01-01', spot_price: 100, atm_iv: 0.16, hv_20d: 0.11, put_call_ratio: 0.9, expected_move_pct: 0.03, iv_rank: 0.3, iv_percentile: 0.4, net_gex: -100, net_dex: 100, net_vex: -5, net_vanna: 50, net_charm: -40, net_vomma: 70, dividend_yield: 0.01, risk_free_rate: 0.042, max_pain: 98, term_structure_slope: 0.005, iv_skew_25d: 0.03, vwiv: 0.2 },
        { date: '2026-01-04', spot_price: 104, atm_iv: 0.22, hv_20d: 0.14, put_call_ratio: 1.2, expected_move_pct: 0.045, iv_rank: 0.6, iv_percentile: 0.7, net_gex: -250, net_dex: -400, net_vex: 25, net_vanna: 160, net_charm: -95, net_vomma: 140, dividend_yield: 0.0125, risk_free_rate: 0.044, max_pain: 100, term_structure_slope: 0.009, iv_skew_25d: 0.045, vwiv: 0.24 },
        { date: '2026-01-03', spot_price: 102, atm_iv: 0.19, atm_iv_30d: 0.18, hv_20d: 0.13, put_call_ratio: 1.1, expected_move_pct: 0.04, iv_rank: 0.5, iv_percentile: 0.6, net_gex: 200, net_dex: -300, net_vex: -15, net_vanna: -120, net_charm: 85, net_vomma: -100, dividend_yield: 0.0115, risk_free_rate: 0.0435, max_pain: 99, term_structure_slope: 0.008, iv_skew_25d: 0.04, vwiv: 0.22 },
      ],
    };

    const summary = summarizeOptionsAnalyticsHistory(payload, 2, 3) as any;

    expect(summary.symbol).toBe('SPY');
    expect(summary.interval).toBe('daily');
    expect(summary.count).toBe(5);
    expect(summary.startDate).toBe('2026-01-01');
    expect(summary.endDate).toBe('2026-01-05');
    expect(summary.latest).toEqual({
      date: '2026-01-05',
      spot_price: 105,
      max_pain: 100,
      atm_iv: 0.24,
      hv_20d: 0.15,
      hv_60d: undefined,
      iv_rank: 0.7,
      iv_percentile: 0.8,
      put_call_ratio: 1.3,
      expected_move_30d_fraction: 0.05,
      term_structure_slope: 0.01,
      iv_skew_25d: 0.05,
      vwiv: 0.26,
      risk_free_rate: 0.045,
      net_gex: 300,
      net_dex: -500,
      net_vex: 20,
      net_vanna: -180,
      net_charm: 110,
      net_vomma: 130,
    });
    expect(summary.summary).toEqual({
      avgAtmIv: 0.194,
      minAtmIv: 0.16,
      maxAtmIv: 0.24,
      atmIvChange: 0.08,
      avgHv20d: 0.13,
      avgPutCallRatio: 1.1,
      avgExpectedMove30dFraction: 0.04,
      maxExpectedMove30dFraction: 0.05,
      avgRiskFreeRate: 0.0435,
      latestRiskFreeRate: 0.045,
      spotChangePct: 5,
      latestIvRank: 0.7,
      latestIvPercentile: 0.8,
      maxAbsNetGex: 300,
      maxAbsNetDex: 500,
      maxAbsNetVex: 25,
      maxAbsNetVanna: 180,
      maxAbsNetCharm: 110,
      maxAbsNetVomma: 140,
    });
    expect(summary.data.map((point: any) => point.date)).toEqual([
      '2026-01-05',
      '2026-01-04',
    ]);
    expect(summary.trendSample.map((point: any) => point.date)).toEqual([
      '2026-01-03',
      '2026-01-01',
    ]);
    expect(summary._data_meta).toEqual({
      summarized: true,
      order: 'newest first',
      recent: 2,
      trend_samples: 2,
      total_snapshots: 5,
    });
    // option_ticker_snapshots.expected_move_pct is a 30-day decimal FRACTION
    // of spot (iv * sqrt(30/365)); the column name reaches no reader here,
    // and the unit is stated once for the point field and both aggregates.
    expect(summary.units.expectedMove30dFraction).toContain('decimal fraction');
    expect(summary.latest).not.toHaveProperty('expected_move_pct');
    expect(summary.summary).not.toHaveProperty('avgExpectedMovePct');
    // The stored dividend_yield is 0 on every row the producer writes
    // (scan_strikes.div_rate, the vendor's divRate, is 0 on all 1,009,414 rows of
    // 2026-09-16), so a zero here read as "pays no dividend". Withheld from
    // the point, the earliest/latest and both aggregates, on every path.
    for (const point of [summary.latest, summary.earliest, ...summary.data, ...summary.trendSample]) {
      expect(point).not.toHaveProperty('dividend_yield');
    }
    expect(summary.summary).not.toHaveProperty('avgDividendYield');
    expect(summary.summary).not.toHaveProperty('latestDividendYield');
  });
});

describe('labelOptionsAnalyticsHistory', () => {
  // Ninth run: the summary said `order: "newest first"` and the raw shape,
  // which runs the other way (the proxy sorts ascending), said nothing.
  // Every raw path ends here, so the marker goes here, beside the trim
  // meta the 30-day default already writes.
  test('says the raw shape runs oldest first, keeping any trim meta beside it', () => {
    const bare: any = labelOptionsAnalyticsHistory({ data: [{ date: '2026-09-14' }, { date: '2026-09-15' }] });
    expect(bare._data_meta).toEqual({ order: 'oldest first' });
    const trimmed: any = labelOptionsAnalyticsHistory({
      data: [{ date: '2026-09-15' }],
      _data_meta: { trimmed: true, original_length: 40, returned: 30 },
    });
    expect(trimmed._data_meta).toEqual({ trimmed: true, original_length: 40, returned: 30, order: 'oldest first' });
    const history: any = labelOptionsAnalyticsHistory({ history: [{ date: '2026-09-15' }] });
    expect(history._history_meta).toEqual({ order: 'oldest first' });
    expect(history._data_meta).toBeUndefined();
    // Nothing to label, nothing to mark.
    expect((labelOptionsAnalyticsHistory({ symbol: 'SPY' }) as any)._data_meta).toBeUndefined();
  });

  // The summarizer only runs past 90 rows. A 30-day request, the default,
  // went out with the column name on every row and no units; this is the
  // shape those rows take on the short and `full` paths.
  test('renames the column on every point, attaches the units, and touches nothing else', () => {
    const labelled: any = labelOptionsAnalyticsHistory({
      symbol: 'SPY',
      source: 'option_ticker_snapshots',
      data: [
        { date: '2026-09-15', spot_price: 650.12, expected_move_pct: 0.018, total_volume: 5 },
        { date: '2026-09-14', spot_price: 648.3 },
        null,
      ],
    });
    expect(labelled.data[0]).toEqual({ date: '2026-09-15', spot_price: 650.12, expected_move_30d_fraction: 0.018, total_volume: 5 });
    // The short and `full` paths carry raw rows: the unwritten dividend
    // yield must not ride through here either.
    const withYield: any = labelOptionsAnalyticsHistory({ data: [{ date: '2026-09-15', dividend_yield: 0, expected_move_pct: 0.018 }, { date: '2026-09-14', dividend_yield: 0 }] });
    expect(withYield.data[0]).toEqual({ date: '2026-09-15', expected_move_30d_fraction: 0.018 });
    expect(withYield.data[1]).toEqual({ date: '2026-09-14' });
    expect(labelled.data[0]).not.toHaveProperty('expected_move_pct');
    expect(labelled.data[1]).toEqual({ date: '2026-09-14', spot_price: 648.3 });
    expect(labelled.data[2]).toBeNull();
    expect(labelled.symbol).toBe('SPY');
    expect(labelled.source).toBe('option_ticker_snapshots');
    expect(labelled.units.expectedMove30dFraction).toContain('decimal fraction');
  });

  test('carries the provenance once, not three times', () => {
    // The proxy's history route returns `{ ...provenance, metadata:
    // provenance, provenance }`: the same fifteen keys at the top level, under
    // `metadata` and under `provenance`, which a 20-row answer paid for three
    // times. One copy stays, under `provenance`; the top-level twins and
    // `metadata` go only where they are the same values, so a field the proxy
    // sets differently at the top level is kept.
    const provenance = {
      provider: 'scanner-history', source: 'option_ticker_snapshots', historySnapshotId: 'h1',
      fetchedAt: '2026-09-16T20:00:00.000Z', receivedAt: '2026-09-16T20:00:00.000Z', staleAfter: '2026-09-17T20:00:00.000Z',
      fromCache: false, openInterestDate: '2026-09-16', openInterestSource: 'eod-vendor', volumeSource: 'eod-vendor', greeksSource: 'eod-vendor',
    };
    const labelled: any = labelOptionsAnalyticsHistory({
      symbol: 'AAPL', count: 1, interval: 'daily',
      ...provenance,
      metadata: { ...provenance },
      provenance: { ...provenance },
      data: [{ date: '2026-09-16', expected_move_pct: 0.071 }],
    });
    expect(labelled.provenance).toEqual(provenance);
    expect(labelled).not.toHaveProperty('metadata');
    for (const key of Object.keys(provenance)) expect(labelled, key).not.toHaveProperty(key);
    expect(labelled.symbol).toBe('AAPL');
    expect(labelled.count).toBe(1);
    expect(labelled.interval).toBe('daily');
    expect(labelled.data[0]).toEqual({ date: '2026-09-16', expected_move_30d_fraction: 0.071 });

    // A top-level value that differs from the provenance copy is not a twin
    // and stays; a metadata block that differs stays too.
    const differing: any = labelOptionsAnalyticsHistory({
      ...provenance, fromCache: true,
      metadata: { ...provenance, note: 'x' },
      provenance: { ...provenance },
      data: [],
    });
    expect(differing.fromCache).toBe(true);
    expect(differing.metadata).toEqual({ ...provenance, note: 'x' });
    expect(differing).not.toHaveProperty('fetchedAt');

    // Without a `provenance` block nothing is touched.
    const bare: any = labelOptionsAnalyticsHistory({ ...provenance, data: [] });
    expect(bare.fetchedAt).toBe(provenance.fetchedAt);

    // The summary shape too. Eighth run, SPY days: 400: the raw shape
    // carried one provenance and the summary carried all three again,
    // because summarizeOptionsAnalyticsHistory spread the proxy response
    // untouched. And it says which way its rows run, since the raw shape
    // is the proxy's ascending order and the summary's `data` is the
    // newest rows newest first.
    const rows = Array.from({ length: 120 }, (_, i) => ({ date: `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}`, spot_price: 100 + i, expected_move_pct: 0.02 }));
    const summarized: any = summarizeOptionsAnalyticsHistory({
      symbol: 'AAPL', count: rows.length, interval: 'daily',
      ...provenance,
      metadata: { ...provenance },
      provenance: { ...provenance },
      data: rows,
    });
    expect(summarized.provenance).toEqual(provenance);
    expect(summarized).not.toHaveProperty('metadata');
    for (const key of Object.keys(provenance)) expect(summarized, key).not.toHaveProperty(key);
    expect(summarized._data_meta).toMatchObject({ summarized: true, order: 'newest first', total_snapshots: 120 });
    expect(summarized.data[0].date > summarized.data[1].date).toBe(true);
  });

  test('reads the `history` key as well, and leaves a payload with no points alone', () => {
    const labelled: any = labelOptionsAnalyticsHistory({ history: [{ expected_move_pct: 0.02 }] });
    expect(labelled.history[0]).toEqual({ expected_move_30d_fraction: 0.02 });
    for (const payload of [null, undefined, 7, 'x', [], {}, { data: 'nope' }]) {
      expect(labelOptionsAnalyticsHistory(payload as any)).toEqual(payload as any);
    }
  });
});

describe('shouldSummarizeOptionsAnalyticsHistory', () => {
  test('summarizes only when the snapshot count exceeds the large-window threshold', () => {
    const small = {
      data: Array.from({ length: 90 }, (_, index) => ({
        date: `2026-01-${String(index + 1).padStart(2, '0')}`,
      })),
    };
    const large = {
      data: Array.from({ length: 91 }, (_, index) => ({
        date: `2026-01-${String(index + 1).padStart(2, '0')}`,
      })),
    };

    expect(shouldSummarizeOptionsAnalyticsHistory(small)).toBeFalse();
    expect(shouldSummarizeOptionsAnalyticsHistory(large)).toBeTrue();
  });
});
