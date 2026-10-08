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
    // Sampled from the weeks older than the recent ones, never repeating one.
    expect(summary.trendSample.map((point: any) => point.weekEnding)).toEqual(['2026-01-16', '2026-01-11', '2026-01-06', '2026-01-01']);
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

    // A numeric string the proxy sent is published as a number (it read the
    // string "-0.17" in the thirty-third run), and a history no longer than
    // the recent rows has no older weeks to sample, so no trendSample.
    expect(summary.summary.volumeTrend).toBe(12.5);
    expect(summary._weeklyData_meta).toBeUndefined();
    expect(summary).not.toHaveProperty('trendSample');
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

describe('an empty dark pool history still publishes numbers (review)', () => {
  test('the proxy\'s no-rows answer: its summary strings become numbers too', () => {
    const out = summarizeDarkPoolVenue({ symbol: 'X', weeklyData: [], summary: { volumeTrend: '0.00', note: 'none' } }) as any;
    expect(out.summary).toEqual({ volumeTrend: 0, note: 'none' });
    expect(out.weeklyData).toEqual([]);
    const both = summarizeDarkPoolResponse({ otcTrading: { symbol: 'X', weeklyData: [], summary: { volumeTrend: '-0.17' } } }) as any;
    expect(both.otcTrading.summary.volumeTrend).toBe(-0.17);
  });
});
