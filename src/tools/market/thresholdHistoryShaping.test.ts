import { describe, expect, it } from 'bun:test';
import { summarizeThresholdHistory } from './thresholdHistoryShaping.js';

describe('summarizeThresholdHistory', () => {
  it('builds a current-status summary for symbols still on the threshold list', () => {
    const checkedDates = [
      '2026-03-27',
      '2026-03-26',
      '2026-03-25',
      '2026-03-24',
      '2026-03-23',
      '2026-03-20',
    ];

    const summarized = summarizeThresholdHistory({
      symbol: 'AMC',
      thresholdDates: ['2026-03-20', '2026-03-24', '2026-03-25', '2026-03-26', '2026-03-27'],
      totalDatesChecked: 6,
      datesOnThreshold: 5,
      source: 'supabase',
    }, checkedDates, 3) as Record<string, any>;

    expect(summarized.symbol).toBe('AMC');
    expect(summarized.status).toBe('Currently on threshold list');
    expect(summarized.summary.isCurrentlyOnThreshold).toBe(true);
    expect(summarized.summary.currentStreakDays).toBe(4);
    expect(summarized.summary.longestStreakDays).toBe(4);
    expect(summarized.summary.checkedDaysSinceLastThreshold).toBe(0);
    expect(summarized.summary.daysOnThresholdPct).toBe(83.3);
    expect(summarized.summary.source).toBe('Reg SHO threshold list');
    expect(summarized.recentThresholdDates).toEqual(['2026-03-27', '2026-03-26', '2026-03-25']);
    expect(summarized._recent_threshold_meta).toEqual({ showing: 3, total: 5, truncated: true });
  });

  it('marks symbols as recently cleared when the latest threshold date is still near the front of the checked window', () => {
    const checkedDates = [
      '2026-03-27',
      '2026-03-26',
      '2026-03-25',
      '2026-03-24',
      '2026-03-23',
      '2026-03-20',
      '2026-03-19',
    ];

    const summarized = summarizeThresholdHistory({
      symbol: 'GME',
      thresholdDates: ['2026-03-24', '2026-03-23'],
      totalDatesChecked: 7,
      datesOnThreshold: 2,
    }, checkedDates) as Record<string, any>;

    expect(summarized.status).toBe('Recently cleared');
    expect(summarized.summary.isCurrentlyOnThreshold).toBe(false);
    expect(summarized.summary.currentStreakDays).toBe(0);
    expect(summarized.summary.longestStreakDays).toBe(2);
    expect(summarized.summary.checkedDaysSinceLastThreshold).toBe(3);
    expect(summarized.summary.latestThresholdDate).toBe('2026-03-24');
  });

  it('returns a stable empty summary when the symbol never appeared on the threshold list', () => {
    const checkedDates = [
      '2026-03-27',
      '2026-03-26',
      '2026-03-25',
      '2026-03-24',
    ];

    const summarized = summarizeThresholdHistory({
      symbol: 'AAPL',
      thresholdDates: [],
      totalDatesChecked: 4,
      datesOnThreshold: 0,
      source: 'supabase',
    }, checkedDates) as Record<string, any>;

    expect(summarized.status).toBe('Not on threshold list');
    expect(summarized.summary.isCurrentlyOnThreshold).toBe(false);
    expect(summarized.summary.currentStreakDays).toBe(0);
    expect(summarized.summary.longestStreakDays).toBe(0);
    expect(summarized.summary.checkedDaysSinceLastThreshold).toBeNull();
    expect(summarized.summary.source).toBe('Reg SHO threshold list');
    expect(summarized.recentThresholdDates).toEqual([]);
    expect(String(summarized._threshold_note)).toContain('did not appear on the threshold list');
  });
});
