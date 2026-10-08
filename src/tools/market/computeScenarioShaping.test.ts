import { describe, expect, it } from 'bun:test';
import { summarizeScenario } from './computeScenarioShaping.js';

/**
 * The route's answer is exact; the model's copy is rounded. P&L is money
 * (two decimals), everything else four. `full` is the route's answer
 * untouched: the base price per leg and the position-value grid stay.
 */
const payload = {
  schemaVersion: 1, symbol: 'SPY', asOf: '2026-10-02T19:00:00.000Z', dayCount: 'calendar', greekConvention: 'dapi',
  inputs: { spot: { value: 500, source: 'snapshot', asOf: '2026-10-01', stale: false }, r: { value: 0.0412345678, source: 'fred-DGS3MO', asOf: '2026-10-01' }, q: { value: 0.012, source: 'supplied', asOf: null } },
  legs: [{ index: 0, type: 'call', side: 'long', quantity: 1, strike: 500, expiration: '2026-10-17', t: 0.04106776180698152, tSource: 'expiration', iv: { value: 0.18, source: 'stored-chain-strike', asOf: '2026-10-01', strikeUsed: 500 }, entryPremium: { value: 8.123456789, source: 'model' }, model: 'black-scholes', basePrice: 8.123456789 }],
  base: { positionValue: 812.3456789, entryValue: 812.3456789, greeks: { delta: 52.123456789, gamma: 2.000012345, theta: -12.3456789, vega: 40.00004, rho: 5.5 } },
  grid: {
    axes: { spotMoves: [-2, 0, 2], ivShocks: [0], daysElapsed: [0, 15] },
    spots: [490, 500, 510],
    pnl: [[[-312.345678, -400.1]], [[0, -123.456]], [[387.654321, 300.99999]]],
    positionValue: [[[500.0000001, 412.2]], [[812.3456789, 688.9]], [[1200.0000001, 1113.3]]],
  },
  portfolioFit: {
    shockModel: 'uniform-percent-all-underlyings',
    positions: [{ index: 0, symbol: 'AAPL', inputs: {}, legs: [{ index: 0, type: 'put', basePrice: 3.3333333, entryPremium: { value: 3, source: 'supplied' } }], greeks: { delta: 30.123456789 } }],
    greeks: { held: { delta: 30.123456789 }, candidate: { delta: 52.123456789 }, combined: { delta: 82.246913578 } },
    correlation: { method: 'pearson-daily-log-returns', window: 60, minObservations: 40, pairs: [{ symbol: 'AAPL', rho: 0.6123456789, observations: 60, asOf: '2026-10-01', unconfirmed: 0, reason: null }] },
    stress: { axes: {}, heldPnl: [[[10.123456, 20]]], combinedPnl: [[[-302.222222, -380.1]]] },
  },
  warnings: ['SPY: spot snapshot 2026-10-01 is 1 days old'],
  notes: { pnl: 'x' },
};

describe('summarizeScenario', () => {
  it('rounds P&L to cents and everything else to four decimals, dropping the per-leg base price and the position-value grid', () => {
    const shaped = summarizeScenario(payload, { full: false }) as any;
    expect(shaped.grid.pnl).toEqual([[[-312.35, -400.1]], [[0, -123.46]], [[387.65, 301]]]);
    expect(shaped.grid.positionValue).toBeUndefined();
    expect(shaped.legs[0].basePrice).toBeUndefined();
    expect(shaped.legs[0].entryPremium).toEqual({ value: 8.1235, source: 'model' });
    expect(shaped.legs[0].t).toBe(0.0411);
    expect(shaped.base.greeks.delta).toBe(52.1235);
    expect(shaped.base.positionValue).toBe(812.35);
    expect(shaped.inputs.r.value).toBe(0.0412);
    expect(shaped.portfolioFit.stress.heldPnl).toEqual([[[10.12, 20]]]);
    expect(shaped.portfolioFit.stress.combinedPnl).toEqual([[[-302.22, -380.1]]]);
    expect(shaped.portfolioFit.positions[0].legs[0].basePrice).toBeUndefined();
    expect(shaped.portfolioFit.correlation.pairs[0].rho).toBe(0.6123);
    expect(shaped.portfolioFit.greeks.combined.delta).toBe(82.2469);
    expect(shaped.warnings).toEqual(payload.warnings);
    expect(shaped.notes).toEqual(payload.notes);
    expect(shaped.inputs.spot).toEqual(payload.inputs.spot);
  });

  it('keeps nulls as nulls and never invents a number for an unpriced cell', () => {
    const withNull = { ...payload, grid: { ...payload.grid, pnl: [[[null, 1.006]]] } };
    const shaped = summarizeScenario(withNull, { full: false }) as any;
    expect(shaped.grid.pnl).toEqual([[[null, 1.01]]]);
  });

  it('full returns the route\'s answer untouched', () => {
    expect(summarizeScenario(payload, { full: true })).toEqual(payload);
  });
});
