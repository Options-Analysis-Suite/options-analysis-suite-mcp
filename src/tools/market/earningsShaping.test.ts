import { describe, expect, it } from 'bun:test';
import { summarizeEarnings, summarizeEarningsMoves } from './earningsShaping.js';

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

describe('summarizeEarningsMoves', () => {
  const route = {
    schemaVersion: 1, symbol: 'AAPL', asOf: '2026-10-02', straddleWindowStart: '2025-10-01',
    events: Array.from({ length: 8 }, (_, i) => ({
      date: `2026-0${(i % 9) + 1}-15`, timing: 'amc', preSession: 'x', reportSession: 'y', nextSession: 'z',
      closes: { pre: 100.123456, report: 102.1, next: 103 },
      priorCloseToReportClosePct: 1.9745123, reportCloseToNextClosePct: 0.8815,
      implied: { movePct: 3.123456, source: 'straddle', straddle: 3.1234567, spot: 100, expiration: '2026-01-16', strike: 100, asOf: 'x', tenor: null, reason: null },
      ivCrush: { pct: 33.33333, tenor: '7d', preIv: 0.612345678, postIv: 0.4, preSession: 'x', postSession: 'z' },
      realizedOverImplied: { priorToReport: 0.632156, reportToNext: null },
    })),
    summary: { events: 8, impliedSources: { straddle: 8, atmIv: 0, none: 0 }, avgAbsPriorCloseToReportClosePct: 1.9745123, avgAbsReportCloseToNextClosePct: 0.8815, avgRealizedOverImplied: { priorToReport: 0.632156, reportToNext: null } },
    notes: { moves: 'm', implied: 'i', crush: 'c' },
    priceHistory: { state: 'current', unconfirmed: 0 },
  };

  it('keeps the events, the summary, the notes and the price-history state, rounded to four decimals with nulls kept', () => {
    const shaped = summarizeEarningsMoves(route) as any;
    expect(shaped.events).toHaveLength(8);
    expect(shaped.events[0].priorCloseToReportClosePct).toBe(1.9745);
    expect(shaped.events[0].closes.pre).toBe(100.1235);
    expect(shaped.events[0].implied.straddle).toBe(3.1235);
    expect(shaped.events[0].ivCrush.preIv).toBe(0.6123);
    expect(shaped.events[0].realizedOverImplied).toEqual({ priorToReport: 0.6322, reportToNext: null });
    expect(shaped.summary.avgRealizedOverImplied).toEqual({ priorToReport: 0.6322, reportToNext: null });
    expect(shaped.notes).toEqual(route.notes);
    expect(shaped.priceHistory).toEqual({ state: 'current', unconfirmed: 0 });
    expect(shaped.straddleWindowStart).toBe('2025-10-01');
    expect(shaped.dataAvailable).toBe(true);
  });

  it('a route answer with no events says so rather than publishing empty averages as numbers', () => {
    const shaped = summarizeEarningsMoves({ ...route, events: [], summary: { ...route.summary, events: 0, avgAbsPriorCloseToReportClosePct: null, avgAbsReportCloseToNextClosePct: null, avgRealizedOverImplied: { priorToReport: null, reportToNext: null } } }) as any;
    expect(shaped.events).toEqual([]);
    expect(shaped.summary.avgAbsPriorCloseToReportClosePct).toBeNull();
    expect(shaped.dataAvailable).toBe(false);
  });
});

describe('summarizeEarningsMoves with no events', () => {
  it('says why the answer is empty, so "no moves" is not read as an outage', () => {
    const shaped = summarizeEarningsMoves({ symbol: 'SPY', asOf: '2026-10-03', straddleWindowStart: '2025-10-01', events: [], summary: null, notes: null }) as Record<string, unknown>;
    expect(shaped.dataAvailable).toBe(false);
    expect(shaped.reason).toBe('no-past-earnings-with-closes');
  });
});
