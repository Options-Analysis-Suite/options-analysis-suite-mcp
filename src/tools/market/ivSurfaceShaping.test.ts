import { describe, expect, test } from 'bun:test';
import { summarizeIvSurface } from './ivSurfaceShaping.js';

describe('summarizeIvSurface', () => {
  test('builds term-structure and skew summaries from representative smile nodes', () => {
    const payload = {
      ticker: 'SPY',
      date: '2026-03-26',
      spotPrice: 100,
      expirations: ['2026-04-01', '2026-04-08'],
      rowCount: 6,
      data: [
        { expiration: '2026-04-01', strike: 95, yte: 0.01, iv: 0.24, putIV: 0.26, callIV: 0.23 },
        { expiration: '2026-04-01', strike: 100, yte: 0.01, iv: 0.2, putIV: 0.21, callIV: 0.19 },
        { expiration: '2026-04-01', strike: 105, yte: 0.01, iv: 0.18, putIV: 0.19, callIV: 0.17 },
        { expiration: '2026-04-08', strike: 95, yte: 0.03, iv: 0.29, putIV: 0.31, callIV: 0.28 },
        { expiration: '2026-04-08', strike: 100, yte: 0.03, iv: 0.25, putIV: 0.26, callIV: 0.24 },
        { expiration: '2026-04-08', strike: 105, yte: 0.03, iv: 0.22, putIV: 0.23, callIV: 0.21 },
      ],
    };

    const summary = summarizeIvSurface(payload) as any;

    expect(summary.atmTermStructure).toEqual([
      { expiration: '2026-04-01', yte: 0.01, atmStrike: 100, atmIV: 0.2, callIV: 0.19, putIV: 0.21 },
      { expiration: '2026-04-08', yte: 0.03, atmStrike: 100, atmIV: 0.25, callIV: 0.24, putIV: 0.26 },
    ]);
    expect(summary.skewSummary).toEqual([
      {
        expiration: '2026-04-01',
        yte: 0.01,
        atmStrike: 100,
        atmIV: 0.2,
        putStrike: 95,
        putIV: 0.26,
        callStrike: 105,
        callIV: 0.17,
        putCallSkew: 0.09,
      },
      {
        expiration: '2026-04-08',
        yte: 0.03,
        atmStrike: 100,
        atmIV: 0.25,
        putStrike: 95,
        putIV: 0.31,
        callStrike: 105,
        callIV: 0.21,
        putCallSkew: 0.1,
      },
    ]);
    expect(summary.surfacePreview).toHaveLength(6);
    expect(summary.surfacePreview[0].bucket).toBe('put wing');
    expect(summary.surfacePreview[1].bucket).toBe('atm');
    expect(summary.surfacePreview[2].bucket).toBe('call wing');
  });

  test('handles sparse expirations without duplicating strikes', () => {
    const payload = {
      ticker: 'SPY',
      date: '2026-03-26',
      spotPrice: 100,
      expirations: ['2026-04-01'],
      data: [
        { expiration: '2026-04-01', strike: 100, yte: 0.01, iv: 0.2, putIV: 0.21, callIV: 0.19 },
        { expiration: '2026-04-01', strike: 103, yte: 0.01, iv: 0.205, putIV: 0.215, callIV: 0.195 },
      ],
    };

    const summary = summarizeIvSurface(payload) as any;

    expect(summary.atmTermStructure).toEqual([
      { expiration: '2026-04-01', yte: 0.01, atmStrike: 100, atmIV: 0.2, callIV: 0.19, putIV: 0.21 },
    ]);
    expect(summary.skewSummary).toEqual([]);
    expect(summary.surfacePreview).toEqual([
      { expiration: '2026-04-01', bucket: 'atm', strike: 100, relativeStrike: 1, yte: 0.01, iv: 0.2, putIV: 0.21, callIV: 0.19 },
      { expiration: '2026-04-01', bucket: 'call wing', strike: 103, relativeStrike: 1.03, yte: 0.01, iv: 0.205, putIV: 0.215, callIV: 0.195 },
    ]);
  });
});
