import { describe, expect, test } from 'bun:test';
import {
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
      expected_move_pct: 0.05,
      term_structure_slope: 0.01,
      iv_skew_25d: 0.05,
      vwiv: 0.26,
      dividend_yield: 0.013,
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
      avgExpectedMovePct: 0.04,
      maxExpectedMovePct: 0.05,
      avgDividendYield: 0.0116,
      latestDividendYield: 0.013,
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
      recent: 2,
      trend_samples: 2,
      total_snapshots: 5,
    });
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
