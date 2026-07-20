import { describe, expect, test } from 'bun:test';
import {
  shouldSummarizeIvHistory,
  sortIvHistoryPoints,
  summarizeIvHistory,
  trimIvHistoryToRecent,
} from './ivHistoryShaping.js';

describe('sortIvHistoryPoints', () => {
  test('sorts history rows newest-first by market date', () => {
    const sorted = sortIvHistoryPoints([
      { market_date: '2026-01-03', spot_price: 103 },
      { market_date: '2026-01-05', spot_price: 105 },
      { market_date: '2026-01-04', spot_price: 104 },
    ]);

    expect(sorted.map((point) => point.market_date)).toEqual([
      '2026-01-05',
      '2026-01-04',
      '2026-01-03',
    ]);
  });
});

describe('trimIvHistoryToRecent', () => {
  test('keeps the latest rows instead of the oldest rows', () => {
    const payload = {
      symbol: 'SPY',
      data: [
        { market_date: '2026-01-02', spot_price: 102 },
        { market_date: '2026-01-05', spot_price: 105 },
        { market_date: '2026-01-03', spot_price: 103 },
        { market_date: '2026-01-04', spot_price: 104 },
      ],
    };

    const trimmed = trimIvHistoryToRecent(payload, 2) as any;

    expect(trimmed.data.map((point: any) => point.market_date)).toEqual([
      '2026-01-05',
      '2026-01-04',
    ]);
    expect(trimmed._data_meta).toEqual({ showing: 2, total: 4, truncated: true });
    expect(payload.data.map((point: any) => point.market_date)).toEqual([
      '2026-01-02',
      '2026-01-05',
      '2026-01-03',
      '2026-01-04',
    ]);
  });
});

describe('summarizeIvHistory', () => {
  test('builds a compact recent/trend summary while preserving scalar metadata', () => {
    const payload = {
      symbol: 'SPY',
      source: 'proxy',
      days: 120,
      startDate: null,
      endDate: null,
      data: [
        { market_date: '2026-01-02', spot_price: 101, atm_iv: 0.17, put_call_ratio: 1.0, volume_oi_ratio: 0.5 },
        { market_date: '2026-01-05', spot_price: 105, atm_iv: 0.23, atm_iv_30d: 0.24, put_call_ratio: 1.3, volume_oi_ratio: 0.8 },
        { market_date: '2026-01-01', spot_price: 100, atm_iv: 0.16, put_call_ratio: 0.9, volume_oi_ratio: 0.4 },
        { market_date: '2026-01-04', spot_price: 104, atm_iv: 0.22, put_call_ratio: 1.2, volume_oi_ratio: 0.7 },
        { market_date: '2026-01-03', spot_price: 102, atm_iv: 0.19, atm_iv_30d: 0.18, put_call_ratio: 1.1, volume_oi_ratio: 0.6 },
      ],
    };

    const summary = summarizeIvHistory(payload, 2, 3) as any;

    expect(summary.symbol).toBe('SPY');
    expect(summary.source).toBe('proxy');
    expect(summary.startDate).toBe('2026-01-01');
    expect(summary.endDate).toBe('2026-01-05');
    expect(summary.pointCount).toBe(5);
    expect(summary.latest).toEqual({
      market_date: '2026-01-05',
      spot_price: 105,
      atm_iv: 0.23,
      atm_iv_30d: 0.24,
      put_call_ratio: 1.3,
      volume_oi_ratio: 0.8,
    });
    expect(summary.earliest).toEqual({
      market_date: '2026-01-01',
      spot_price: 100,
      atm_iv: 0.16,
      atm_iv_30d: undefined,
      put_call_ratio: 0.9,
      volume_oi_ratio: 0.4,
    });
    expect(summary.summary).toEqual({
      avgAtmIv: 0.194,
      minAtmIv: 0.16,
      maxAtmIv: 0.24,
      atmIvChange: 0.08,
      avgSpotPrice: 102.4,
      minSpotPrice: 100,
      maxSpotPrice: 105,
      spotChangePct: 5,
      avgPutCallRatio: 1.1,
      maxVolumeOiRatio: 0.8,
    });
    expect(summary.data.map((point: any) => point.market_date)).toEqual([
      '2026-01-05',
      '2026-01-04',
    ]);
    expect(summary.trendSample.map((point: any) => point.market_date)).toEqual([
      '2026-01-03',
      '2026-01-01',
    ]);
    expect(summary._data_meta).toEqual({
      summarized: true,
      recent: 2,
      trend_samples: 2,
      total_trading_days: 5,
    });
  });

  test('supports payloads that use a history array instead of data', () => {
    const payload = {
      symbol: 'SPY',
      history: [
        { market_date: '2026-01-01', spot_price: 100, atm_iv: 0.16 },
        { market_date: '2026-01-02', spot_price: 101, atm_iv_30d: 0.17 },
        { market_date: '2026-01-03', spot_price: 102, atm_iv: 0.18 },
      ],
    };

    const summary = summarizeIvHistory(payload, 1, 2) as any;

    expect(summary.history.map((point: any) => point.market_date)).toEqual(['2026-01-03']);
    expect(summary._history_meta).toEqual({
      summarized: true,
      recent: 1,
      trend_samples: 1,
      total_trading_days: 3,
    });
  });
});

describe('shouldSummarizeIvHistory', () => {
  test('only summarizes genuinely large histories', () => {
    const small = {
      data: Array.from({ length: 90 }, (_, index) => ({
        market_date: `2026-01-${String(index + 1).padStart(2, '0')}`,
      })),
    };
    const large = {
      data: Array.from({ length: 91 }, (_, index) => ({
        market_date: `2026-01-${String(index + 1).padStart(2, '0')}`,
      })),
    };

    expect(shouldSummarizeIvHistory(small)).toBeFalse();
    expect(shouldSummarizeIvHistory(large)).toBeTrue();
  });
});
