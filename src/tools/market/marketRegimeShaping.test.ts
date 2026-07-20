import { describe, expect, test } from 'bun:test';
import { shapeMarketRegimeResponse } from './marketRegimeShaping.js';

describe('shapeMarketRegimeResponse', () => {
  test('replaces raw vector internals with compact feature z-scores in default market summaries', () => {
    const payload = {
      market: {
        date: '2026-03-26',
        label: 'NORMAL',
        stress_score: 0.1766,
        confidence: 0.7187,
        drivers: [
          { feature: 'vol_level', contribution: 0.2488, z: 2.0733 },
          { feature: 'term_structure', contribution: 0.145, z: 1.4499 },
        ],
        exposures: {
          spotPrice: 532.17,
          netGamma: 123456,
        },
        vector: {
          z: {
            curvature: 0.1187,
            vol_level: 2.0733,
            turbulence: 0.7265,
          },
          raw: {
            curvature: 0.07127,
            vol_level: 0.262423,
            turbulence: 1.697672,
          },
          data_quality: {
            curvature: 'aggregated',
            vol_level: 'aggregated',
            turbulence: 'aggregated',
          },
        },
      },
    };

    const result = shapeMarketRegimeResponse(payload) as Record<string, unknown>;
    const market = result.market as Record<string, unknown>;

    expect(market.label).toBe('NORMAL');
    expect(market.stress_score).toBe(0.1766);
    expect(market.exposures).toEqual({
      spotPrice: 532.17,
      netGamma: 123456,
    });
    expect(market.feature_z_scores).toEqual({
      'Curvature': 0.1187,
      'Vol Level': 2.0733,
      'Turbulence': 0.7265,
    });
    expect(market.drivers).toEqual([
      { feature: 'Vol Level', contribution: 0.2488, z: 2.0733 },
      { feature: 'Term Structure', contribution: 0.145, z: 1.4499 },
    ]);
    expect(market.vector).toBeUndefined();
    expect(market._feature_vector_meta).toEqual({ raw_internals_omitted: true });
  });

  test('passes through payloads without a market object unchanged', () => {
    expect(shapeMarketRegimeResponse({ symbols: [] })).toEqual({ symbols: [] });
    expect(shapeMarketRegimeResponse(null)).toBeNull();
    expect(shapeMarketRegimeResponse('raw')).toBe('raw');
  });

  test('drops vector even when z-scores are unavailable', () => {
    const payload = {
      market: {
        label: 'NORMAL',
        vector: {
          raw: {
            curvature: 0.07127,
          },
        },
      },
    };

    const result = shapeMarketRegimeResponse(payload) as Record<string, unknown>;
    const market = result.market as Record<string, unknown>;

    expect(market.vector).toBeUndefined();
    expect(market.feature_z_scores).toBeUndefined();
    expect(market._feature_vector_meta).toBeUndefined();
  });

  test('humanizes the top_driver feature for public-tier responses', () => {
    // Public/non-Pro callers receive only top_driver (no full drivers
    // array) per the proxy gating in /regime/current. Without
    // humanization the LLM would surface raw 'skew_pressure' alongside
    // humanized 'Skew Pressure' values from the Pro path.
    const payload = {
      market: {
        date: '2026-04-29',
        label: 'NORMAL',
        stress_score: 0.18,
        top_driver: { feature: 'skew_pressure', z: 1.4 },
      },
    };

    const result = shapeMarketRegimeResponse(payload) as Record<string, unknown>;
    const market = result.market as Record<string, unknown>;

    expect(market.top_driver).toEqual({ feature: 'Skew Pressure', z: 1.4 });
    expect(market.drivers).toBeUndefined();
  });
});
