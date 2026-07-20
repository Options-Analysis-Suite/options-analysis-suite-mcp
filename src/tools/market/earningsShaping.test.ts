import { describe, expect, it } from 'bun:test';
import { summarizeEarnings } from './earningsShaping.js';

describe('summarizeEarnings', () => {
  it('returns an explanatory empty result for null-only ETF-like earnings rows', () => {
    const summarized = summarizeEarnings({
      symbol: 'SPY',
      earnings_history: [
        { date: '2017-11-29', epsActual: null, epsEstimated: null, revenueActual: null, revenueEstimated: null },
        { date: '2017-08-15', epsActual: null, epsEstimated: null, revenueActual: null, revenueEstimated: null },
      ],
      fetched_at: '2026-03-02T09:34:57.422+00:00',
    }) as Record<string, any>;

    expect(summarized.earnings_history).toEqual([]);
    expect(String(summarized._earnings_note)).toContain('ETF');
  });

  it('keeps meaningful rows and adds upcoming/latest summary context', () => {
    const summarized = summarizeEarnings({
      symbol: 'AAPL',
      earnings_history: [
        { date: '2026-04-30', epsActual: null, epsEstimated: 1.95, revenueActual: null, revenueEstimated: 109083851330 },
        { date: '2026-01-29', epsActual: 2.84, epsEstimated: 2.67, revenueActual: 143756000000, revenueEstimated: 138391007589 },
        { date: '2025-10-30', epsActual: 1.85, epsEstimated: 1.78, revenueActual: 102466000000, revenueEstimated: 102227074560 },
      ],
    }) as Record<string, any>;

    expect(summarized.earnings_history).toHaveLength(3);
    expect(summarized.summary.upcoming.date).toBe('2026-04-30');
    expect(summarized.summary.latestReported.date).toBe('2026-01-29');
    expect(summarized.summary.latestReported.epsSurprisePct).toBeCloseTo(((2.84 - 2.67) / 2.67) * 100, 6);
  });

  it('drops stale incomplete orphan rows like ETF placeholder earnings history', () => {
    const summarized = summarizeEarnings({
      symbol: 'SPY',
      earnings_history: [
        { date: '2006-05-15', epsActual: null, epsEstimated: 2.11, revenueActual: null, revenueEstimated: null },
        { date: '2006-02-15', epsActual: null, epsEstimated: 2.02, revenueActual: null, revenueEstimated: null },
        { date: '2005-05-15', epsActual: null, epsEstimated: 1.83, revenueActual: null, revenueEstimated: null },
        { date: '2005-02-15', epsActual: 1.81, epsEstimated: null, revenueActual: null, revenueEstimated: null },
      ],
      fetched_at: '2026-03-02T09:34:57.422+00:00',
    }, 8, '2026-03-27T00:00:00.000Z') as Record<string, any>;

    expect(summarized.earnings_history).toEqual([]);
    expect(String(summarized._earnings_note)).toContain('ETF');
  });

  it('caps to the requested number of meaningful rows', () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      date: `2025-${String(index + 1).padStart(2, '0')}-01`,
      epsActual: index + 1,
      epsEstimated: index + 0.5,
      revenueActual: null,
      revenueEstimated: null,
    }));

    const summarized = summarizeEarnings({
      symbol: 'ABC',
      earnings_history: rows,
    }, 8) as Record<string, any>;

    expect(summarized.earnings_history).toHaveLength(8);
    expect(summarized._earnings_history_meta).toEqual({ showing: 8, total: 10, truncated: true });
  });
});
