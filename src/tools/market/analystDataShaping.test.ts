import { describe, expect, test } from 'bun:test';
import { summarizeAnalystData } from './analystDataShaping.js';

describe('summarizeAnalystData', () => {
  test('compacts estimates, parses publishers, and collapses daily rating history into streaks', () => {
    const payload = {
      symbol: 'AAPL',
      estimates: [
        { date: '2029-09-27', epsAvg: 10.5, epsLow: 9.8, epsHigh: 11.3, revenueAvg: 520_000_000_000, revenueLow: 510_000_000_000, revenueHigh: 530_000_000_000, numAnalystsEps: 20, numAnalystsRevenue: 15, ebitAvg: 1 },
        { date: '2028-09-27', epsAvg: 9.2, epsLow: 8.7, epsHigh: 10.0, revenueAvg: 490_000_000_000, revenueLow: 480_000_000_000, revenueHigh: 500_000_000_000, numAnalystsEps: 18, numAnalystsRevenue: 14 },
        { date: '2027-09-27', epsAvg: 8.1, epsLow: 7.9, epsHigh: 8.7, revenueAvg: 460_000_000_000, revenueLow: 455_000_000_000, revenueHigh: 470_000_000_000, numAnalystsEps: 17, numAnalystsRevenue: 13 },
      ],
      price_target_summary: {
        symbol: 'AAPL',
        publishers: '["StreetInsider","Barrons"]',
        allTimeCount: 200,
      },
      price_target_consensus: {
        targetLow: 200,
        targetHigh: 300,
      },
      rating_snapshot: {
        rating: 'B',
        overallScore: 3,
      },
      historical_rating: [
        { date: '2026-03-26', rating: 'B', overallScore: 3, priceToBookScore: 1, debtToEquityScore: 1, returnOnAssetsScore: 5, returnOnEquityScore: 5, priceToEarningsScore: 2, discountedCashFlowScore: 3 },
        { date: '2026-03-25', rating: 'B', overallScore: 3, priceToBookScore: 1, debtToEquityScore: 1, returnOnAssetsScore: 5, returnOnEquityScore: 5, priceToEarningsScore: 2, discountedCashFlowScore: 3 },
        { date: '2026-03-24', rating: 'C', overallScore: 2, priceToBookScore: 1, debtToEquityScore: 2, returnOnAssetsScore: 4, returnOnEquityScore: 4, priceToEarningsScore: 2, discountedCashFlowScore: 2 },
      ],
      upgrades_downgrades: [
        { date: '2026-03-24', action: 'upgrade', newGrade: 'Buy', previousGrade: 'Hold', gradingCompany: 'Firm A', ignored: 'x' },
        { date: '2026-03-23', action: 'maintain', newGrade: 'Buy', previousGrade: 'Buy', gradingCompany: 'Firm B' },
      ],
      fetched_at: '2026-03-27T00:00:00Z',
    };

    const summary = summarizeAnalystData(payload, 2, 10, 1, '2026-03-27T00:00:00Z') as any;

    expect(summary.estimates).toEqual([
      {
        date: '2027-09-27',
        epsAvg: 8.1,
        epsLow: 7.9,
        epsHigh: 8.7,
        revenueAvg: 460000000000,
        revenueLow: 455000000000,
        revenueHigh: 470000000000,
        numAnalystsEps: 17,
        numAnalystsRevenue: 13,
      },
      {
        date: '2028-09-27',
        epsAvg: 9.2,
        epsLow: 8.7,
        epsHigh: 10,
        revenueAvg: 490000000000,
        revenueLow: 480000000000,
        revenueHigh: 500000000000,
        numAnalystsEps: 18,
        numAnalystsRevenue: 14,
      },
    ]);
    expect(summary._estimates_meta).toEqual({ showing: 2, total: 3, truncated: true });
    expect(summary.price_target_summary.publishers).toEqual(['StreetInsider', 'Barrons']);
    expect(summary.historical_rating).toEqual([
      {
        rating: 'B',
        overallScore: 3,
        priceToBookScore: 1,
        debtToEquityScore: 1,
        returnOnAssetsScore: 5,
        returnOnEquityScore: 5,
        priceToEarningsScore: 2,
        discountedCashFlowScore: 3,
        fromDate: '2026-03-26',
        throughDate: '2026-03-25',
        observationCount: 2,
      },
      {
        rating: 'C',
        overallScore: 2,
        priceToBookScore: 1,
        debtToEquityScore: 2,
        returnOnAssetsScore: 4,
        returnOnEquityScore: 4,
        priceToEarningsScore: 2,
        discountedCashFlowScore: 2,
        fromDate: '2026-03-24',
        throughDate: '2026-03-24',
        observationCount: 1,
      },
    ]);
    expect(summary._historical_rating_meta).toEqual({ collapsed: true, raw_observations: 3, streaks: 2 });
    expect(summary.upgrades_downgrades).toEqual([
      {
        date: '2026-03-24',
        action: 'upgrade',
        newGrade: 'Buy',
        previousGrade: 'Hold',
        gradingCompany: 'Firm A',
      },
    ]);
    expect(summary._upgrades_downgrades_meta).toEqual({ showing: 1, total: 2, truncated: true });
  });

  test('prefers nearest future estimate periods, then the most recent past periods', () => {
    const payload = {
      symbol: 'AAPL',
      estimates: [
        { date: '2028-09-27', epsAvg: 9.2 },
        { date: '2025-09-27', epsAvg: 7.4 },
        { date: '2027-09-27', epsAvg: 8.1 },
        { date: '2024-09-27', epsAvg: 6.7 },
      ],
    };

    const summary = summarizeAnalystData(payload, 4, 10, 20, '2026-03-27T00:00:00Z') as any;

    expect(summary.estimates.map((entry: { date: string }) => entry.date)).toEqual([
      '2027-09-27',
      '2028-09-27',
      '2025-09-27',
      '2024-09-27',
    ]);
  });

  test('passes through non-object payloads unchanged', () => {
    expect(summarizeAnalystData(null)).toBeNull();
    expect(summarizeAnalystData('raw')).toBe('raw');
  });

  test('returns an explanatory empty state for ETF-like symbols without analyst coverage', () => {
    const summary = summarizeAnalystData({
      symbol: 'SPY',
      estimates: [],
      price_target_summary: null,
      price_target_consensus: null,
      rating_snapshot: null,
      historical_rating: [],
      upgrades_downgrades: [],
      fetched_at: '2026-03-27T00:00:00Z',
    }, 8, 10, 20, '2026-03-27T00:00:00Z', {
      company_name: 'State Street SPDR S&P 500 ETF Trust',
      industry: 'Asset Management',
    }) as any;

    expect(summary.estimates).toEqual([]);
    expect(summary.price_target_summary).toBeNull();
    expect(summary.historical_rating).toEqual([]);
    expect(summary._analyst_note).toContain('No meaningful sell-side analyst coverage');
  });
});
