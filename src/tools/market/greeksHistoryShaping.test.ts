import { describe, expect, test } from 'bun:test';
import {
  shouldSummarizeGreeksHistory,
  sortGreeksHistoryPoints,
  summarizeGreeksHistory,
  trimGreeksHistoryToRecent,
} from './greeksHistoryShaping.js';

describe('sortGreeksHistoryPoints', () => {
  test('sorts rows newest-first by market date', () => {
    const sorted = sortGreeksHistoryPoints([
      { market_date: '2026-01-03', delta: 0.48 },
      { market_date: '2026-01-05', delta: 0.51 },
      { market_date: '2026-01-04', delta: 0.5 },
    ]);

    expect(sorted.map((point) => point.market_date)).toEqual([
      '2026-01-05',
      '2026-01-04',
      '2026-01-03',
    ]);
  });
});

describe('trimGreeksHistoryToRecent', () => {
  test('keeps the latest rows instead of the oldest rows', () => {
    const payload = {
      symbol: 'AAPL',
      data: [
        { market_date: '2026-01-02', delta: 0.46 },
        { market_date: '2026-01-05', delta: 0.55 },
        { market_date: '2026-01-03', delta: 0.5 },
        { market_date: '2026-01-04', delta: 0.52 },
      ],
    };

    const trimmed = trimGreeksHistoryToRecent(payload, 2) as any;

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

describe('summarizeGreeksHistory', () => {
  test('builds a compact recent/trend summary while preserving scalar metadata', () => {
    const payload = {
      symbol: 'AAPL',
      startDate: null,
      endDate: null,
      dteMin: 5,
      dteMax: 45,
      moneyness: 'atm',
      data: [
        { market_date: '2026-01-02', delta: 0.47, gamma: 0.0032, theta: -0.048, vega: 0.215 },
        { market_date: '2026-01-05', delta: 0.55, gamma: 0.004, theta: -0.043, vega: 0.23 },
        { market_date: '2026-01-01', delta: 0.45, gamma: 0.003, theta: -0.05, vega: 0.21 },
        { market_date: '2026-01-04', delta: 0.52, gamma: 0.0038, theta: -0.045, vega: 0.225 },
        { market_date: '2026-01-03', delta: 0.5, gamma: 0.0035, theta: -0.047, vega: 0.22 },
      ],
    };

    const summary = summarizeGreeksHistory(payload, 2, 3) as any;

    expect(summary.symbol).toBe('AAPL');
    expect(summary.dteMin).toBe(5);
    expect(summary.dteMax).toBe(45);
    expect(summary.moneyness).toBe('atm');
    expect(summary.startDate).toBe('2026-01-01');
    expect(summary.endDate).toBe('2026-01-05');
    expect(summary.pointCount).toBe(5);
    expect(summary.latest).toEqual({
      market_date: '2026-01-05',
      delta: 0.55,
      gamma: 0.004,
      theta: -0.043,
      vega: 0.23,
    });
    expect(summary.earliest).toEqual({
      market_date: '2026-01-01',
      delta: 0.45,
      gamma: 0.003,
      theta: -0.05,
      vega: 0.21,
    });
    expect(summary.summary).toEqual({
      avgDelta: 0.498,
      avgGamma: 0.0035,
      avgTheta: -0.0466,
      avgVega: 0.22,
      deltaChange: 0.1,
      gammaChange: 0.001,
      thetaChange: 0.007,
      vegaChange: 0.02,
      maxGamma: 0.004,
      maxVega: 0.23,
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
});

describe('shouldSummarizeGreeksHistory', () => {
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

    expect(shouldSummarizeGreeksHistory(small)).toBeFalse();
    expect(shouldSummarizeGreeksHistory(large)).toBeTrue();
  });
});
