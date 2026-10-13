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

describe('short data publishes ISO dates and numbers', () => {
  // Thirty-third run: dates as FINRA writes them ("20260930"), and
  // avgShortPercentage the string "52.13" beside the number 52.13.
  it('short volume: rows, lastUpdate, averages and year stats', () => {
    const out = summarizeShortVolume({
      symbol: 'AAPL',
      lastUpdate: '20260930',
      history: [{ date: '20260930', shortVolume: 100, totalVolume: 250, shortPercent: '40.00' }],
      averages: { avgShortPercentage: '52.13', avgShortVolume: '1234567', label: 'trailing 20 days' },
      yearStats: { maxShortPercentage: '71.2', maxShortDate: '20260105', minShortPercentage: 30.5, minShortDate: '20260302' },
    }) as any;
    expect(out.lastUpdate).toBe('2026-09-30');
    expect(out.latest.date).toBe('2026-09-30');
    expect(out.recentHistory[0].date).toBe('2026-09-30');
    expect(out.trailingAverages).toEqual({ avgShortPercentage: 52.13, avgShortVolume: 1234567, label: 'trailing 20 days' });
    expect(out.yearStats).toEqual({ maxShortPercentage: 71.2, maxShortDate: '2026-01-05', minShortPercentage: 30.5, minShortDate: '2026-03-02' });
  });

  it('short interest: settlement dates', () => {
    const out = summarizeShortInterest({
      symbol: 'AAPL', lastUpdate: '20260915',
      history: [{ settlementDate: '20260915', shortInterest: 100 }],
    }) as any;
    expect(JSON.stringify(out)).not.toMatch(/"\d{8}"/);
    expect(out.lastUpdate).toBe('2026-09-15');
  });

});

describe('short-volume stats: a field is a date by its name, never by its eight digits', () => {
  // Review: "12345678" stayed a string (no calendar date) and "20260105"
  // went out as "2026-01-05" in every averages and yearStats field.
  it('eight-digit numeric strings in the numeric fields are numbers', () => {
    const out = summarizeShortVolume({
      symbol: 'X',
      history: [],
      averages: { avgShortVolume: '12345678', avgTotalVolume: '20260105', avgShortPercentage: '52.13' },
      yearStats: { totalShortVolume: '20260105', totalVolume: '12345678', averageShortPercentage: '20260105' },
    }) as any;
    expect(out.trailingAverages).toEqual({ avgShortVolume: 12345678, avgTotalVolume: 20260105, avgShortPercentage: 52.13 });
    expect(out.yearStats).toEqual({ totalShortVolume: 20260105, totalVolume: 12345678, averageShortPercentage: 20260105 });
  });

  it('the date fields are ISO when they are calendar dates, else null', () => {
    const out = summarizeShortVolume({
      symbol: 'X',
      history: [],
      yearStats: { maxShortDate: '20260105', minShortDate: '20261340' },
    }) as any;
    expect(out.yearStats).toEqual({ maxShortDate: '2026-01-05', minShortDate: null });
    const other = summarizeShortVolume({
      symbol: 'X',
      history: [],
      yearStats: { maxShortDate: '2026-03-02', minShortDate: 20260105 },
    }) as any;
    expect(other.yearStats).toEqual({ maxShortDate: '2026-03-02', minShortDate: null });
  });

  it('JSON numbers and seven-digit values are unchanged', () => {
    const out = summarizeShortVolume({
      symbol: 'X',
      history: [],
      averages: { avgShortVolume: 20260105, avgTotalVolume: 12345678, avgShortPercentage: '1234567' },
      yearStats: { totalShortVolume: 1234567, totalVolume: '1234567', maxShortPercentage: 52.13 },
    }) as any;
    expect(out.trailingAverages).toEqual({ avgShortVolume: 20260105, avgTotalVolume: 12345678, avgShortPercentage: 1234567 });
    expect(out.yearStats).toEqual({ totalShortVolume: 1234567, totalVolume: 1234567, maxShortPercentage: 52.13 });
  });

  it('every numeric field the proxy sends is null when it holds no number', () => {
    const out = summarizeShortVolume({
      symbol: 'X',
      history: [],
      averages: { avgShortVolume: 'N/A', avgTotalVolume: 'N/A', avgShortPercentage: 'N/A' },
      yearStats: {
        averageShortPercentage: 'N/A', maxShortPercentage: 'N/A', minShortPercentage: 'N/A', totalShortVolume: 'N/A', totalVolume: 'N/A',
      },
    }) as any;
    expect(out.trailingAverages).toEqual({ avgShortVolume: null, avgTotalVolume: null, avgShortPercentage: null });
    expect(out.yearStats).toEqual({
      averageShortPercentage: null, maxShortPercentage: null, minShortPercentage: null, totalShortVolume: null, totalVolume: null,
    });
  });

  it('empty, non-string, non-finite and overflowing values; a field the proxy does not send keeps its text', () => {
    const overflow = `1${'0'.repeat(400)}`;
    const out = summarizeShortVolume({
      symbol: 'X',
      history: [],
      averages: { avgShortVolume: '', avgTotalVolume: true, avgShortPercentage: null, label: 'trailing 20 days', code: '20261399', big: overflow },
      yearStats: { totalShortVolume: overflow, totalVolume: Number.NaN, maxShortPercentage: {}, minShortPercentage: '52.13%' },
    }) as any;
    expect(out.trailingAverages).toEqual({
      avgShortVolume: null, avgTotalVolume: null, avgShortPercentage: null, label: 'trailing 20 days', code: 20261399, big: null,
    });
    expect(out.yearStats).toEqual({ totalShortVolume: null, totalVolume: null, maxShortPercentage: null, minShortPercentage: 52.13 });
  });

  it("the proxy's own answers: a full one, and the no-rows one with its empty dates", () => {
    const full = summarizeShortVolume({
      symbol: 'SPY',
      lastUpdate: '2026-01-05',
      history: [{ date: '20260105', shortVolume: 14230658, totalVolume: 28086532, shortPercent: '50.67' }],
      averages: { avgShortVolume: 20260105, avgTotalVolume: 41234567, avgShortPercentage: '49.13' },
      yearStats: {
        averageShortPercentage: '51.02', maxShortPercentage: '63.40', maxShortDate: '20260105',
        minShortPercentage: '38.10', minShortDate: '20250611', totalShortVolume: 3226010578, totalVolume: 6573012004,
      },
    }) as any;
    expect(full.trailingAverages).toEqual({ avgShortVolume: 20260105, avgTotalVolume: 41234567, avgShortPercentage: 49.13 });
    expect(full.yearStats).toEqual({
      averageShortPercentage: 51.02, maxShortPercentage: 63.4, maxShortDate: '2026-01-05',
      minShortPercentage: 38.1, minShortDate: '2025-06-11', totalShortVolume: 3226010578, totalVolume: 6573012004,
    });
    // The no-rows answer is an honest empty (it was a latest day of 0 shares at 0.00% with averages and year
    // statistics of zeros): no latest day, no averages, no year statistics, and no figure made from them.
    const empty = summarizeShortVolume({ symbol: 'ZZZQ', lastUpdate: null, latest: null, history: [], averages: null, yearStats: null }) as any;
    expect(empty).toEqual({
      symbol: 'ZZZQ',
      lastUpdate: null,
      latest: null,
      summary: {
        trailingAverageShortPercent: null,
        latestVsTrailingAveragePctPoints: null,
        recentTrend: null,
        highestRecentShortPercent: null,
        lowestRecentShortPercent: null,
      },
      recentHistory: [],
      trailingAverages: null,
      yearStats: null,
      _recent_history_meta: undefined,
    });
  });

  it('the row dates and lastUpdate are dates or null, never a string that is not one', () => {
    const volume = summarizeShortVolume({
      symbol: 'X',
      lastUpdate: 'yesterday',
      history: [{ date: '20261340', shortVolume: 1, totalVolume: 2 }, { date: '2026-02-30', shortVolume: 1, totalVolume: 2 }],
    }) as any;
    expect(volume.lastUpdate).toBeNull();
    expect(volume.recentHistory.map((row: any) => row.date)).toEqual([null, null]);
    const interest = summarizeShortInterest({
      symbol: 'X',
      lastUpdate: '2026-09-15',
      history: [{ settlementDate: '20261340', shortInterest: 100 }],
      stats: { maxDate: '20261399', minDate: '20260915' },
    }) as any;
    expect(interest.lastUpdate).toBe('2026-09-15');
    expect(interest.recentHistory[0].settlementDate).toBeNull();
    expect(interest.summary.maxDate).toBeNull();
    expect(interest.summary.minDate).toBe('2026-09-15');
  });
});
