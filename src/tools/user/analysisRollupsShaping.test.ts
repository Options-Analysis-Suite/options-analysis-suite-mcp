import { describe, expect, test } from 'bun:test';
import { shapeAnalysisRollupRecord, summarizeAnalysisRollupsResponse } from './analysisRollupsShaping.js';

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
