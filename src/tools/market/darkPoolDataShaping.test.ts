import { describe, expect, test } from 'bun:test';
import { summarizeDarkPoolResponse, summarizeDarkPoolVenue } from './darkPoolDataShaping.js';

describe('summarizeDarkPoolVenue', () => {
  test('keeps recent weekly rows and adds trend samples for long histories', () => {
    const payload = {
      symbol: 'AAPL',
      weeklyData: Array.from({ length: 20 }, (_, index) => ({
        weekEnding: `2026-01-${String(20 - index).padStart(2, '0')}`,
        totalShares: 1000 + index * 10,
        totalTrades: 100 + index,
        averageSharesPerTrade: 10 + index,
        marketMakers: 'N/A',
      })),
    };

    const summary = summarizeDarkPoolVenue(payload, 4, 4) as any;

    expect(summary.symbol).toBe('AAPL');
    expect(summary.weeklyData).toHaveLength(4);
    expect(summary.weeklyData.map((point: any) => point.weekEnding)).toEqual([
      '2026-01-20',
      '2026-01-19',
      '2026-01-18',
      '2026-01-17',
    ]);
    expect(summary.trendSample.length).toBeGreaterThan(0);
    expect(summary.summary.latestWeek).toBe('2026-01-20');
    expect(summary.summary.avgWeeklyShares).toBe(1095);
    expect(summary._weeklyData_meta).toMatchObject({
      summarized: true,
      recent_weeks: 4,
    });
  });

  test('preserves existing summary fields and handles short histories without a trim note', () => {
    const payload = {
      symbol: 'AAPL',
      summary: {
        volumeTrend: '12.5',
      },
      weeklyData: [
        { weekEnding: '2026-01-02', totalShares: 2000, totalTrades: 200, averageSharesPerTrade: 10 },
        { weekEnding: '2025-12-26', totalShares: 1800, totalTrades: 180, averageSharesPerTrade: 10 },
      ],
    };

    const summary = summarizeDarkPoolVenue(payload, 4, 4) as any;

    expect(summary.summary.volumeTrend).toBe('12.5');
    expect(summary._weeklyData_meta).toBeUndefined();
    expect(summary.trendSample).toEqual([]);
  });
});

describe('summarizeDarkPoolResponse', () => {
  test('shapes both OTC and ATS payloads', () => {
    const payload = {
      otcTrading: {
        symbol: 'AAPL',
        weeklyData: [
          { weekEnding: '2026-01-02', totalShares: 2000, totalTrades: 200, averageSharesPerTrade: 10 },
        ],
      },
      atsData: {
        symbol: 'AAPL',
        weeklyData: [
          { weekEnding: '2026-01-02', totalShares: 1000, totalTrades: 100 },
        ],
      },
    };

    const summary = summarizeDarkPoolResponse(payload) as any;

    expect(summary.otcTrading.weeklyData[0].weekEnding).toBe('2026-01-02');
    expect(summary.atsData.weeklyData[0].totalShares).toBe(1000);
  });
});
