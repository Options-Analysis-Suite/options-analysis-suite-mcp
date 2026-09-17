import { describe, expect, test } from 'bun:test';
import { shapeAnalysisRollupRecord, summarizeAnalysisRollupsResponse, withholdLegacyMixedVega } from './analysisRollupsShaping.js';

describe('shapeAnalysisRollupRecord', () => {
  test('flattens nested sync rows into assistant-friendly rollup rows', () => {
    const shaped = shapeAnalysisRollupRecord({
      id: 12,
      user_id: 7,
      key: 'AAPL|day|1774594800000',
      symbol: 'AAPL',
      period: 'day',
      period_start: 1774594800000,
      data: {
        id: 8,
        key: 'AAPL|day|1774594800000',
        symbol: 'AAPL',
        period: 'day',
        periodStart: 1774594800000,
        count: 55,
        avgDelta: 0.585072791281252,
        avgGamma: 0.055291349220279555,
        avgVega: 0.2835710100206656,
        avgTheta: -0.6047934788148752,
        avgVol: 0.3584588469999997,
        minVol: 0.335376162,
        maxVol: 0.905465417,
        avgSpot: 248.86801636363637,
        models: ['BlackScholes', 'Heston', 'SABR', 'Binomial', 'JumpDiffusion'],
      },
    }) as Record<string, unknown>;

    expect(shaped).toEqual({
      symbol: 'AAPL',
      period: 'day',
      periodStart: '2026-03-27',
      periodStartTimestamp: 1774594800000,
      count: 55,
      avgDelta: 0.5851,
      avgGamma: 0.055291,
      avgVega: 0.2836,
      avgTheta: -0.6048,
      avgVol: 0.3585,
      minVol: 0.3354,
      maxVol: 0.9055,
      avgSpot: 248.87,
      models: ['Black-Scholes', 'Heston', 'SABR', 'Binomial', 'Jump Diffusion'],
      modelCount: 5,
    });
  });
});

describe('avgVega across the Digital-model boundary', () => {
  // applyGreekScaling leaves the Digital model's vega per unit of volatility
  // and scales every other model's per percentage point. The web producer now
  // normalizes Digital before averaging and stamps avgVegaUnit; a rollup
  // computed before that, mixing Digital with any other model, holds a number
  // in no unit at all (a Black-Scholes 0.2765 and a Digital -27.0979 averaged
  // to -13.41), and no caveat repairs an aggregate that is already mixed.
  const row = (data: Record<string, unknown>) => ({
    symbol: 'AAPL', period: 'day', period_start: 1774594800000,
    data: { count: 2, avgVega: -13.4107, models: ['BlackScholes', 'Digital'], ...data },
  });

  test('withholds a legacy mixed average and says why', () => {
    const shaped = shapeAnalysisRollupRecord(row({})) as Record<string, unknown>;
    expect(shaped.avgVega).toBeUndefined();
    expect(String(shaped.avgVegaWithheld)).toContain('Digital');
    // The recovery advice names the event that actually re-queues the
    // rollups: sync activation. "The next time the web app runs" was not it,
    // because a startup whose storage initialization precedes sign-in
    // recomputes the rows before any owner can accept them.
    expect(String(shaped.avgVegaWithheld)).toContain('activates sync');
    expect(shaped).not.toHaveProperty('avgVegaUnit');
  });

  test('keeps a legacy Digital-only average and names its unit', () => {
    const shaped = shapeAnalysisRollupRecord(row({ models: ['Digital'], avgVega: -27.0979 })) as Record<string, unknown>;
    expect(shaped.avgVega).toBe(-27.0979);
    expect(shaped.avgVegaUnit).toBe('per_unit_vol');
    expect(shaped).not.toHaveProperty('avgVegaWithheld');
  });

  test('keeps a normalized average whatever the models, and a legacy row with no Digital', () => {
    const normalized = shapeAnalysisRollupRecord(row({ avgVega: 0.0028, avgVegaUnit: 'per_vol_point' })) as Record<string, unknown>;
    expect(normalized.avgVega).toBe(0.0028);
    expect(normalized).not.toHaveProperty('avgVegaWithheld');
    expect(normalized).not.toHaveProperty('avgVegaUnit');
    const plain = shapeAnalysisRollupRecord(row({ models: ['BlackScholes', 'Heston'], avgVega: 0.28 })) as Record<string, unknown>;
    expect(plain.avgVega).toBe(0.28);
    expect(plain).not.toHaveProperty('avgVegaWithheld');
    expect(plain).not.toHaveProperty('avgVegaUnit');
  });

  test('the same verdict is applied in place to a raw row for the full path', () => {
    const mixed: Record<string, unknown> = { avgVega: -13.4107, models: ['BlackScholes', 'Digital'] };
    withholdLegacyMixedVega(mixed);
    expect(mixed).not.toHaveProperty('avgVega');
    expect(String(mixed.avgVegaWithheld)).toContain('Digital');
    const digitalOnly: Record<string, unknown> = { avgVega: -27.1, models: ['Digital'] };
    withholdLegacyMixedVega(digitalOnly);
    expect(digitalOnly).toEqual({ avgVega: -27.1, models: ['Digital'], avgVegaUnit: 'per_unit_vol' });
    const normalized: Record<string, unknown> = { avgVega: 0.0028, models: ['BlackScholes', 'Digital'], avgVegaUnit: 'per_vol_point' };
    withholdLegacyMixedVega(normalized);
    expect(normalized).toEqual({ avgVega: 0.0028, models: ['BlackScholes', 'Digital'], avgVegaUnit: 'per_vol_point' });
  });

  test('the summary states the unit once', () => {
    const summary = summarizeAnalysisRollupsResponse({ data: [row({})] }) as Record<string, any>;
    expect(summary.units.avgVega).toContain('per 1 percentage point');
    expect(summary.units.avgVega).toContain('avgVegaWithheld');
  });
});

describe('summarizeAnalysisRollupsResponse', () => {
  test('adds a cross-period summary while keeping compact rollup rows', () => {
    const summarized = summarizeAnalysisRollupsResponse({
      data: [
        {
          symbol: 'AAPL',
          period: 'day',
          period_start: 1774594800000,
          data: {
            count: 55,
            avgDelta: 0.585072791281252,
            avgGamma: 0.055291349220279555,
            avgVega: 0.2835710100206656,
            avgTheta: -0.6047934788148752,
            avgVol: 0.3584588469999997,
            minVol: 0.335376162,
            maxVol: 0.905465417,
            avgSpot: 248.86801636363637,
            models: ['BlackScholes', 'Heston', 'SABR', 'Binomial', 'JumpDiffusion'],
          },
        },
        {
          symbol: 'AAPL',
          period: 'day',
          period_start: 1774508400000,
          data: {
            count: 20,
            avgDelta: 0.45,
            avgGamma: 0.04,
            avgVega: 0.18,
            avgTheta: -0.35,
            avgVol: 0.28,
            minVol: 0.22,
            maxVol: 0.31,
            avgSpot: 240,
            models: ['BlackScholes', 'Heston'],
          },
        },
      ],
      count: 2,
    }) as Record<string, any>;

    expect(summarized.data).toHaveLength(2);
    expect(summarized.summary).toEqual({
      periodsReturned: 2,
      totalAnalyses: 75,
      latestPeriod: '2026-03-27',
      earliestPeriod: '2026-03-26',
      modelsUsed: ['Black-Scholes', 'Heston', 'SABR', 'Binomial', 'Jump Diffusion'],
      minObservedVol: 0.22,
      maxObservedVol: 0.9055,
      avgSpotChangePct: 3.7,
      avgDeltaChange: 0.1351,
    });
  });

  test('passes through non-object payloads unchanged', () => {
    expect(summarizeAnalysisRollupsResponse(null)).toBeNull();
    expect(summarizeAnalysisRollupsResponse('raw')).toBe('raw');
  });
});
