import { describe, expect, it } from 'bun:test';
import {
  summarizeShortInterest,
  summarizeShortVolume,
} from './marketFlowShaping.js';

describe('summarizeShortVolume', () => {
  it('normalizes duplicate percent fields and returns a compact recent summary', () => {
    const summarized = summarizeShortVolume({
      symbol: 'SPY',
      lastUpdate: '2026-03-26',
      latest: {
        date: '20260326',
        shortVolume: 14230658,
        totalVolume: 28086532,
        shortPercent: '50.67',
        shortExemptVolume: 15113,
        markets: ['NYSE', 'NASDAQ', 'ORF'],
      },
      history: [
        { date: '20260326', shortVolume: 14230658, totalVolume: 28086532, shortPercent: '50.67', markets: 'NYSE, NASDAQ, ORF' },
        { date: '20260325', shortVolume: 13187895, totalVolume: 23861246, shortPercentage: '55.27', markets: 'NYSE, NASDAQ, ORF' },
        { date: '20260324', shortVolume: 12239279, totalVolume: 23316554, shortInterestPercentFloat: 52.49, markets: 'NYSE, NASDAQ, ORF' },
      ],
      averages: { avgShortPercentage: '55.13' },
      yearStats: { averageShortPercentage: '55.68' },
    }, 2) as Record<string, any>;

    expect(summarized.latest.shortPercent).toBe(50.67);
    expect(summarized.latest.markets).toEqual(['NYSE', 'NASDAQ', 'ORF']);
    expect(summarized.summary.latestVsTrailingAveragePctPoints).toBeCloseTo(-4.46, 2);
    expect(summarized.summary.recentTrend).toBe('near_average');
    expect(summarized.recentHistory).toHaveLength(2);
    expect(summarized._recent_history_meta).toEqual({ showing: 2, total: 3, truncated: true });
  });
});

describe('summarizeShortInterest', () => {
  it('returns a compact biweekly short-interest summary with recent trend context', () => {
    const summarized = summarizeShortInterest({
      symbol: 'SPY',
      lastUpdate: '2026-03-13',
      latest: {
        settlementDate: '20260313',
        shortInterest: 117848132,
        previousShortInterest: 102395225,
        changeNumber: 15452907,
        changePercent: 15.09,
        avgDailyVolume: 93765316,
        daysToCover: 1.26,
      },
      history: [
        { settlementDate: '20260313', shortInterest: 117848132, changePercent: 15.09, avgDailyVolume: 93765316, daysToCover: 1.26 },
        { settlementDate: '20260227', shortInterest: 102395225, changePercent: -15.13, avgDailyVolume: 76590500, daysToCover: 1.34 },
        { settlementDate: '20260213', shortInterest: 120648942, changePercent: 10.17, avgDailyVolume: 92565535, daysToCover: 1.3 },
        { settlementDate: '20260130', shortInterest: 109516152, changePercent: 1.98, avgDailyVolume: 83540222, daysToCover: 1.31 },
      ],
      stats: {
        avgShortInterest: 112602112.75,
        maxShortInterest: 120648942,
        maxDate: '20260213',
        minShortInterest: 102395225,
        minDate: '20260227',
        avgDaysToCover: 1.3,
        periodsAvailable: 4,
      },
    }, 3) as Record<string, any>;

    expect(summarized.latest.shortInterest).toBe(117848132);
    expect(summarized.summary.periodsAvailable).toBe(4);
    expect(summarized.summary.latestVsAveragePct).toBeCloseTo(4.66, 2);
    expect(summarized.summary.recentTrend).toBe('rising');
    expect(summarized.recentHistory).toHaveLength(3);
    expect(summarized._recent_history_meta).toEqual({ showing: 3, total: 4, truncated: true });
  });

  it('backfills float metadata from company profile and derives shortPercentOfFloat when missing', () => {
    const summarized = summarizeShortInterest({
      symbol: 'AMC',
      lastUpdate: '2026-03-13',
      freeFloat: null,
      sharesOutstanding: null,
      latest: {
        settlementDate: '20260313',
        shortInterest: 118075647,
        previousShortInterest: 124113519,
        changeNumber: -6037872,
        changePercent: -4.86,
        avgDailyVolume: 28478764,
        daysToCover: 4.15,
        shortPercentOfFloat: null,
      },
      history: [
        {
          settlementDate: '20260313',
          shortInterest: 118075647,
          changePercent: -4.86,
          avgDailyVolume: 28478764,
          daysToCover: 4.15,
          shortPercentOfFloat: null,
        },
        {
          settlementDate: '20260227',
          shortInterest: 124113519,
          changePercent: -1.28,
          avgDailyVolume: 29568148,
          daysToCover: 4.2,
          shortPercentOfFloat: null,
        },
      ],
      stats: {
        avgShortInterest: 121094583,
        avgDaysToCover: 4.18,
        periodsAvailable: 2,
      },
    }, 8, {
      free_float_shares: 310000000,
      shares_outstanding: 370000000,
    }) as Record<string, any>;

    expect(summarized.freeFloat).toBe(310000000);
    expect(summarized.sharesOutstanding).toBe(370000000);
    expect(summarized.latest.shortPercentOfFloat).toBeCloseTo(38.09, 2);
    expect(summarized.recentHistory[1].shortPercentOfFloat).toBeCloseTo(40.04, 2);
  });
});
