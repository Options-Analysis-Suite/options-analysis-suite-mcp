import { describe, expect, it } from 'bun:test';
import { summarizeFailToDeliver } from './failToDeliverShaping.js';
import { sanitizeMcpWireOutput } from '../helpers.js';

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

describe('a threshold list that could not be read', () => {
  const rows = [
    { date: '2026-10-06', symbol: 'AAPL', quantity: 1000, price: 231.4, value: 231400, onThresholdList: null, thresholdSource: 'unread' },
    { date: '2026-10-05', symbol: 'AAPL', quantity: 500, price: 230.1, value: 115050, onThresholdList: null, thresholdSource: 'unread' },
  ];

  it('never says "No threshold-list overlap" nor 0 days: unknown, with a note', () => {
    const out = summarizeFailToDeliver({ symbol: 'AAPL', data: rows, summary: { daysOnThreshold: null }, partial: true, unavailable: ['thresholdList'] } as any) as any;
    expect(out.summary.daysOnThreshold).toBeNull();
    expect(out._threshold_note).toBeUndefined();
    expect(out.partial).toBe(true);
    expect(out.partialNote).toMatch(/threshold list could not be read/);
  });

  // Review: the row shaping turned the unknown membership into false in every list.
  it('each row keeps its membership unknown (null), never false, in every list; no threshold events claimed', () => {
    const out = sanitizeMcpWireOutput(summarizeFailToDeliver({ symbol: 'AAPL', data: rows, summary: { daysOnThreshold: null }, partial: true, unavailable: ['thresholdList'] } as any)) as any;
    for (const row of [out.latestFTD, out.summary.latestFTD, ...out.recentHistory, ...out.notableSpikes]) {
      expect(row.onThresholdList).toBeNull();
      expect(row.thresholdSource).toBe('unread');
    }
    expect(out.thresholdEvents).toBeNull();
  });

  it('no FTD rows beside an unread threshold list: the partial fields are carried there too', () => {
    const out = summarizeFailToDeliver({ symbol: 'AAPL', data: [], summary: { daysOnThreshold: null }, partial: true, unavailable: ['thresholdList'] } as any) as any;
    expect(out.partial).toBe(true);
    expect(out.unavailable).toEqual(['thresholdList']);
    expect(out.summary.daysOnThreshold).toBeNull();
  });

  it('a read with no overlap keeps its note and 0 (the control)', () => {
    const out = summarizeFailToDeliver({ symbol: 'AAPL', data: rows.map(r => ({ ...r, onThresholdList: false, thresholdSource: 'none' })), summary: { daysOnThreshold: 0 } } as any) as any;
    expect(out.summary.daysOnThreshold).toBe(0);
    expect(out._threshold_note).toBe('No threshold-list overlap in the requested window.');
    expect(out.recentHistory.every((r: any) => r.onThresholdList === false)).toBe(true);
    expect(out.thresholdEvents).toEqual([]);
  });
});
