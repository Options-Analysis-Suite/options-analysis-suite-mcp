import { describe, expect, it } from 'bun:test';
import { summarizeFailToDeliver } from './failToDeliverShaping.js';

describe('summarizeFailToDeliver', () => {
  it('builds a compact summary with recent rows, spikes, and trend samples', () => {
    const summarized = summarizeFailToDeliver({
      symbol: 'AMC',
      data: [
        { date: '2026-02-27', quantity: 1770712, price: 1.14, value: 2018611.68, onThresholdList: false, thresholdSource: 'none' },
        { date: '2026-02-23', quantity: 3907, price: 1.2, value: 4688.4, onThresholdList: false, thresholdSource: 'none' },
        { date: '2026-02-19', quantity: 730594, price: 1.24, value: 905936.56, onThresholdList: true, thresholdSource: 'sec' },
        { date: '2026-02-18', quantity: 2722774, price: 1.25, value: 3403467.5, onThresholdList: true, thresholdSource: 'sec' },
        { date: '2026-02-17', quantity: 1923814, price: 1.23, value: 2366291.22, onThresholdList: false, thresholdSource: 'none' },
        { date: '2026-02-13', quantity: 1445682, price: 1.22, value: 1763732.04, onThresholdList: false, thresholdSource: 'none' },
      ],
      summary: {
        maxFTDShares: 2722774,
        maxFTDDate: '2026-02-18',
        trend: '633.97',
        daysOnThreshold: 2,
        dateRange: { start: '2026-02-13', end: '2026-02-27' },
      },
    }, 3, 2, 2) as Record<string, any>;

    expect(summarized.symbol).toBe('AMC');
    expect(summarized.latestFTD.date).toBe('2026-02-27');
    expect(summarized.summary.recentTrendPct).toBe(633.97);
    expect(summarized.summary.recentTrend).toBe('surging');
    expect(summarized.summary.daysOnThreshold).toBe(2);
    expect(summarized.recentHistory).toHaveLength(3);
    expect(summarized.notableSpikes).toHaveLength(2);
    expect(summarized.notableSpikes[0].date).toBe('2026-02-18');
    expect(summarized.thresholdEvents).toHaveLength(2);
    expect(summarized.trendSample).toHaveLength(2);
    expect(summarized._recent_history_meta).toEqual({ showing: 3, total: 6, truncated: true });
  });

  it('returns a stable empty summary when no FTD rows exist', () => {
    const summarized = summarizeFailToDeliver({
      symbol: 'AAPL',
      data: [],
      summary: { trend: '0.00' },
    }) as Record<string, any>;

    expect(summarized.symbol).toBe('AAPL');
    expect(summarized.summary.totalDataPoints).toBe(0);
    expect(summarized.summary.recentTrend).toBe('stable');
    expect(summarized.recentHistory).toEqual([]);
    expect(summarized.notableSpikes).toEqual([]);
    expect(summarized.thresholdEvents).toEqual([]);
  });
});
