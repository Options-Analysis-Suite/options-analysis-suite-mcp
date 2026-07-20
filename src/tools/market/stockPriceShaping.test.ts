import { describe, expect, it } from 'bun:test';
import { summarizeStockPrices } from './stockPriceShaping.js';

describe('summarizeStockPrices', () => {
  it('returns a compact trend summary while preserving requested bars', () => {
    const summarized = summarizeStockPrices([
      { date: '2026-03-24', open: 249.55, high: 254.825, low: 249.55, close: 251.64, volume: 44494061 },
      { date: '2026-03-25', open: 254.095, high: 255, low: 251.6, close: 252.62, volume: 28476668 },
      { date: '2026-03-26', open: 252.115, high: 257, low: 250.77, close: 252.89, volume: 41686373 },
    ], 3) as Record<string, any>;

    expect(summarized.data).toHaveLength(3);
    expect(summarized.latest.date).toBe('2026-03-26');
    expect(summarized.summary.sessionsReturned).toBe(3);
    expect(summarized.summary.startDate).toBe('2026-03-24');
    expect(summarized.summary.endDate).toBe('2026-03-26');
    expect(summarized.summary.closeReturnPct).toBeCloseTo(((252.89 - 251.64) / 251.64) * 100, 2);
    expect(summarized.summary.highestClose).toEqual({ date: '2026-03-26', close: 252.89 });
    expect(summarized.summary.lowestClose).toEqual({ date: '2026-03-24', close: 251.64 });
    expect(summarized._data_meta).toEqual({ showing: 3, requested_days: 3 });
  });

  it('returns a stable empty structure for empty payloads', () => {
    const summarized = summarizeStockPrices([], 30) as Record<string, any>;

    expect(summarized.data).toEqual([]);
    expect(summarized.summary.sessionsReturned).toBe(0);
  });
});
