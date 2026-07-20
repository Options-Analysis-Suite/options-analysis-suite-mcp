import { describe, expect, it } from 'bun:test';
import { summarizeYieldCurve } from './yieldCurveShaping.js';

describe('summarizeYieldCurve', () => {
  it('builds a compact curve summary with inversion flags and trend context', () => {
    const summarized = summarizeYieldCurve({
      currentDate: '2026-03-27',
      curve: [
        { term: '1M', yield: 4.8, index: 0 },
        { term: '3M', yield: 4.6, index: 1 },
        { term: '2Y', yield: 4.1, index: 4 },
        { term: '10Y', yield: 4.25, index: 8 },
        { term: '30Y', yield: 4.55, index: 10 },
      ],
      analysis: {
        shape: 'Normal',
        spread_2_10: 0.15,
        spread_3m_10y: -0.35,
      },
      historical: [
        {
          date: '2026-03-20',
          curve: [
            { term: '3M', yield: 4.7 },
            { term: '2Y', yield: 4.2 },
            { term: '10Y', yield: 4.2 },
            { term: '30Y', yield: 4.5 },
          ],
        },
        {
          date: '2026-02-28',
          curve: [
            { term: '3M', yield: 4.9 },
            { term: '2Y', yield: 4.35 },
            { term: '10Y', yield: 4.15 },
            { term: '30Y', yield: 4.45 },
          ],
        },
      ],
      source: 'FRED',
    }, 1) as Record<string, any>;

    expect(summarized.currentDate).toBe('2026-03-27');
    expect(summarized.curveShape).toBe('Normal');
    expect(summarized.keyRates['10Y']).toBe(4.25);
    expect(summarized.spreads.twoTen).toBe(0.15);
    expect(summarized.inversion.twoTenInverted).toBe(false);
    expect(summarized.inversion.threeMonthTenYearInverted).toBe(true);
    expect(summarized.curveExtremes.highestYieldTerm).toBe('1M');
    expect(summarized.trendSummary.comparedToDate).toBe('2026-02-28');
    expect(summarized.trendSummary.tenYearChange).toBe(0.1);
    expect(summarized.historicalSample).toHaveLength(1);
    expect(summarized._historical_meta).toEqual({ sampled: 1, total: 2, evenly_spaced: true });
  });

  it('returns a stable fallback summary when only a 10Y benchmark is available', () => {
    const summarized = summarizeYieldCurve({
      currentDate: '2026-03-27',
      yieldCurve: {
        '10Y': { value: 4.31, rate: 0.0431, date: '2026-03-27' },
      },
      source: 'Yahoo Finance (fallback)',
    }) as Record<string, any>;

    expect(summarized.keyRates['10Y']).toBe(4.31);
    expect(String(summarized._curve_note)).toContain('fallback benchmark rate');
  });
});
