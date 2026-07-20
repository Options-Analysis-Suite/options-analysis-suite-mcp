import { describe, expect, it } from 'bun:test';
import { summarizeOptionsChain } from './optionsChainShaping.js';

function makeContract({
  symbol = 'SPY',
  strike,
  expiration,
  optionType,
  dte,
  mid,
  impliedVolatility,
  delta,
  openInterest,
  volume,
}: {
  symbol?: string;
  strike: number;
  expiration: string;
  optionType: 'call' | 'put';
  dte: number;
  mid: number;
  impliedVolatility: number;
  delta: number;
  openInterest: number;
  volume: number;
}) {
  return {
    optionSymbol: `${symbol}${expiration.replace(/-/g, '')}${optionType === 'call' ? 'C' : 'P'}${String(Math.round(strike * 1000)).padStart(8, '0')}`,
    underlyingSymbol: symbol,
    strike,
    expiration,
    optionType,
    dte,
    bid: Math.max(mid - 0.05, 0),
    ask: mid + 0.05,
    mid,
    lastPrice: mid,
    impliedVolatility,
    delta,
    gamma: 0.01,
    theta: -0.05,
    vega: 0.1,
    openInterest,
    volume,
    pricingSource: 'historical',
    spotPrice: 100,
  };
}

describe('summarizeOptionsChain', () => {
  it('builds representative expiration summaries across the curve', () => {
    const payload = {
      ticker: 'SPY',
      date: '2026-03-26',
      spotPrice: 100,
      pricingTier: 'historical',
      contracts: [
        makeContract({ strike: 100, expiration: '2026-03-28', optionType: 'call', dte: 1, mid: 2.4, impliedVolatility: 0.21, delta: 0.52, openInterest: 3000, volume: 400 }),
        makeContract({ strike: 100, expiration: '2026-03-28', optionType: 'put', dte: 1, mid: 2.2, impliedVolatility: 0.22, delta: -0.48, openInterest: 2800, volume: 390 }),
        makeContract({ strike: 105, expiration: '2026-03-28', optionType: 'call', dte: 1, mid: 0.6, impliedVolatility: 0.24, delta: 0.24, openInterest: 1200, volume: 200 }),
        makeContract({ strike: 95, expiration: '2026-03-28', optionType: 'put', dte: 1, mid: 0.7, impliedVolatility: 0.27, delta: -0.26, openInterest: 1400, volume: 220 }),

        makeContract({ strike: 100, expiration: '2026-04-08', optionType: 'call', dte: 12, mid: 3.3, impliedVolatility: 0.23, delta: 0.51, openInterest: 2600, volume: 280 }),
        makeContract({ strike: 100, expiration: '2026-04-08', optionType: 'put', dte: 12, mid: 3.1, impliedVolatility: 0.24, delta: -0.49, openInterest: 2550, volume: 260 }),

        makeContract({ strike: 100, expiration: '2026-04-30', optionType: 'call', dte: 34, mid: 4.8, impliedVolatility: 0.25, delta: 0.53, openInterest: 2200, volume: 190 }),
        makeContract({ strike: 100, expiration: '2026-04-30', optionType: 'put', dte: 34, mid: 4.7, impliedVolatility: 0.26, delta: -0.47, openInterest: 2100, volume: 180 }),

        makeContract({ strike: 100, expiration: '2026-05-30', optionType: 'call', dte: 64, mid: 6.4, impliedVolatility: 0.27, delta: 0.54, openInterest: 1900, volume: 150 }),
        makeContract({ strike: 100, expiration: '2026-05-30', optionType: 'put', dte: 64, mid: 6.2, impliedVolatility: 0.28, delta: -0.46, openInterest: 1800, volume: 145 }),

        makeContract({ strike: 100, expiration: '2026-08-01', optionType: 'call', dte: 128, mid: 8.5, impliedVolatility: 0.29, delta: 0.55, openInterest: 1600, volume: 110 }),
        makeContract({ strike: 100, expiration: '2026-08-01', optionType: 'put', dte: 128, mid: 8.1, impliedVolatility: 0.3, delta: -0.45, openInterest: 1500, volume: 105 }),

        makeContract({ strike: 100, expiration: '2026-12-15', optionType: 'call', dte: 264, mid: 12.5, impliedVolatility: 0.31, delta: 0.56, openInterest: 1300, volume: 80 }),
        makeContract({ strike: 100, expiration: '2026-12-15', optionType: 'put', dte: 264, mid: 12.1, impliedVolatility: 0.32, delta: -0.44, openInterest: 1250, volume: 75 }),
      ],
    };

    const summarized = summarizeOptionsChain(payload) as Record<string, any>;
    expect(summarized.expirations.map((item: Record<string, unknown>) => item.dte)).toEqual([1, 12, 34, 64, 128, 264]);
    expect(summarized.nearAtmPairs).toHaveLength(4);
    expect(summarized.expirations[0].atmStraddleMid).toBe(4.6);
  });

  it('filters deep OTM clutter out of the default liquid and active buckets', () => {
    const payload = {
      ticker: 'SPY',
      date: '2026-03-26',
      spotPrice: 100,
      pricingTier: 'historical',
      contracts: [
        makeContract({ strike: 100, expiration: '2026-04-17', optionType: 'call', dte: 21, mid: 2.5, impliedVolatility: 0.2, delta: 0.5, openInterest: 5000, volume: 7000 }),
        makeContract({ strike: 100, expiration: '2026-04-17', optionType: 'put', dte: 21, mid: 2.4, impliedVolatility: 0.21, delta: -0.5, openInterest: 5200, volume: 6800 }),
        makeContract({ strike: 104, expiration: '2026-04-17', optionType: 'call', dte: 21, mid: 0.9, impliedVolatility: 0.23, delta: 0.26, openInterest: 4200, volume: 3900 }),
        makeContract({ strike: 96, expiration: '2026-04-17', optionType: 'put', dte: 21, mid: 1.0, impliedVolatility: 0.25, delta: -0.27, openInterest: 4300, volume: 4100 }),

        makeContract({ strike: 150, expiration: '2026-04-17', optionType: 'call', dte: 21, mid: 0.01, impliedVolatility: 0.45, delta: 0.001, openInterest: 200000, volume: 150000 }),
        makeContract({ strike: 50, expiration: '2026-04-17', optionType: 'put', dte: 21, mid: 0.01, impliedVolatility: 0.5, delta: -0.001, openInterest: 180000, volume: 140000 }),
      ],
    };

    const summarized = summarizeOptionsChain(payload) as Record<string, any>;
    expect(summarized.liquidNearMoney.calls[0].strike).toBe(100);
    expect(summarized.liquidNearMoney.puts[0].strike).toBe(100);
    expect(summarized.activeNearMoney.calls.some((item: Record<string, unknown>) => item.strike === 150)).toBe(false);
    expect(summarized.activeNearMoney.puts.some((item: Record<string, unknown>) => item.strike === 50)).toBe(false);
  });

  it('filters near-money contracts with near-zero or near-one delta that are not representative', () => {
    const payload = {
      ticker: 'SPY',
      date: '2026-03-26',
      spotPrice: 100,
      pricingTier: 'historical',
      contracts: [
        makeContract({ strike: 100, expiration: '2026-03-27', optionType: 'call', dte: 1, mid: 1.9, impliedVolatility: 0.22, delta: 0.51, openInterest: 4000, volume: 30000 }),
        makeContract({ strike: 100, expiration: '2026-03-27', optionType: 'put', dte: 1, mid: 1.8, impliedVolatility: 0.23, delta: -0.49, openInterest: 4100, volume: 32000 }),
        makeContract({ strike: 101, expiration: '2026-03-27', optionType: 'call', dte: 1, mid: 0.05, impliedVolatility: 0.31, delta: 0.01, openInterest: 50000, volume: 400000 }),
        makeContract({ strike: 99, expiration: '2026-03-27', optionType: 'put', dte: 1, mid: 0.06, impliedVolatility: 0.32, delta: -0.99, openInterest: 48000, volume: 390000 }),
      ],
    };

    const summarized = summarizeOptionsChain(payload) as Record<string, any>;
    expect(summarized.activeNearMoney.calls.some((item: Record<string, unknown>) => item.strike === 101)).toBe(false);
    expect(summarized.activeNearMoney.puts.some((item: Record<string, unknown>) => item.strike === 99)).toBe(false);
    expect(summarized.liquidNearMoney.calls[0].strike).toBe(100);
    expect(summarized.liquidNearMoney.puts[0].strike).toBe(100);
  });

  it('prefers non-0DTE near-money contracts in default liquid and active buckets when available', () => {
    const payload = {
      ticker: 'SPY',
      date: '2026-03-26',
      spotPrice: 100,
      pricingTier: 'historical',
      contracts: [
        makeContract({ strike: 101, expiration: '2026-03-26', optionType: 'call', dte: 0, mid: 0.12, impliedVolatility: 0.29, delta: 0.12, openInterest: 12000, volume: 250000 }),
        makeContract({ strike: 99, expiration: '2026-03-26', optionType: 'put', dte: 0, mid: 0.14, impliedVolatility: 0.31, delta: -0.88, openInterest: 15000, volume: 260000 }),
        makeContract({ strike: 100, expiration: '2026-03-26', optionType: 'call', dte: 0, mid: 0.65, impliedVolatility: 0.22, delta: 0.55, openInterest: 5000, volume: 90000 }),
        makeContract({ strike: 100, expiration: '2026-03-26', optionType: 'put', dte: 0, mid: 0.6, impliedVolatility: 0.23, delta: -0.45, openInterest: 5200, volume: 95000 }),

        makeContract({ strike: 100, expiration: '2026-03-27', optionType: 'call', dte: 1, mid: 1.8, impliedVolatility: 0.24, delta: 0.51, openInterest: 3000, volume: 25000 }),
        makeContract({ strike: 100, expiration: '2026-03-27', optionType: 'put', dte: 1, mid: 1.7, impliedVolatility: 0.25, delta: -0.49, openInterest: 3200, volume: 27000 }),
        makeContract({ strike: 101, expiration: '2026-03-27', optionType: 'call', dte: 1, mid: 1.15, impliedVolatility: 0.25, delta: 0.38, openInterest: 2400, volume: 18000 }),
        makeContract({ strike: 99, expiration: '2026-03-27', optionType: 'put', dte: 1, mid: 1.2, impliedVolatility: 0.26, delta: -0.41, openInterest: 2500, volume: 19000 }),
      ],
    };

    const summarized = summarizeOptionsChain(payload) as Record<string, any>;
    expect(summarized.liquidNearMoney.calls.every((item: Record<string, unknown>) => item.dte === 1)).toBe(true);
    expect(summarized.liquidNearMoney.puts.every((item: Record<string, unknown>) => item.dte === 1)).toBe(true);
    expect(summarized.activeNearMoney.calls.every((item: Record<string, unknown>) => item.dte === 1)).toBe(true);
    expect(summarized.activeNearMoney.puts.every((item: Record<string, unknown>) => item.dte === 1)).toBe(true);
  });

  it('diversifies near-money buckets across representative expirations instead of clustering in the front expiry', () => {
    const payload = {
      ticker: 'SPY',
      date: '2026-03-26',
      spotPrice: 100,
      pricingTier: 'historical',
      contracts: [
        makeContract({ strike: 100, expiration: '2026-03-27', optionType: 'call', dte: 1, mid: 1.8, impliedVolatility: 0.24, delta: 0.51, openInterest: 5000, volume: 60000 }),
        makeContract({ strike: 101, expiration: '2026-03-27', optionType: 'call', dte: 1, mid: 1.3, impliedVolatility: 0.25, delta: 0.39, openInterest: 4700, volume: 58000 }),
        makeContract({ strike: 100, expiration: '2026-03-27', optionType: 'put', dte: 1, mid: 1.7, impliedVolatility: 0.25, delta: -0.49, openInterest: 5200, volume: 62000 }),
        makeContract({ strike: 99, expiration: '2026-03-27', optionType: 'put', dte: 1, mid: 1.25, impliedVolatility: 0.26, delta: -0.41, openInterest: 4900, volume: 59000 }),

        makeContract({ strike: 100, expiration: '2026-03-31', optionType: 'call', dte: 5, mid: 3.0, impliedVolatility: 0.23, delta: 0.52, openInterest: 1800, volume: 9000 }),
        makeContract({ strike: 100, expiration: '2026-03-31', optionType: 'put', dte: 5, mid: 2.9, impliedVolatility: 0.24, delta: -0.48, openInterest: 1900, volume: 9200 }),

        makeContract({ strike: 100, expiration: '2026-04-17', optionType: 'call', dte: 22, mid: 5.5, impliedVolatility: 0.22, delta: 0.53, openInterest: 2500, volume: 7000 }),
        makeContract({ strike: 100, expiration: '2026-04-17', optionType: 'put', dte: 22, mid: 5.4, impliedVolatility: 0.23, delta: -0.47, openInterest: 2550, volume: 7100 }),

        makeContract({ strike: 100, expiration: '2026-06-20', optionType: 'call', dte: 86, mid: 8.2, impliedVolatility: 0.21, delta: 0.55, openInterest: 3000, volume: 5000 }),
        makeContract({ strike: 100, expiration: '2026-06-20', optionType: 'put', dte: 86, mid: 8.0, impliedVolatility: 0.22, delta: -0.45, openInterest: 3100, volume: 5200 }),
      ],
    };

    const summarized = summarizeOptionsChain(payload) as Record<string, any>;
    expect(new Set(summarized.liquidNearMoney.calls.map((item: Record<string, unknown>) => item.expiration)).size).toBeGreaterThan(1);
    expect(new Set(summarized.liquidNearMoney.puts.map((item: Record<string, unknown>) => item.expiration)).size).toBeGreaterThan(1);
    expect(new Set(summarized.activeNearMoney.calls.map((item: Record<string, unknown>) => item.expiration)).size).toBeGreaterThan(1);
    expect(new Set(summarized.activeNearMoney.puts.map((item: Record<string, unknown>) => item.expiration)).size).toBeGreaterThan(1);
  });

  it('uses 25-delta OTM options for skew instead of extreme wings', () => {
    const payload = {
      ticker: 'AAPL',
      date: '2026-03-26',
      spotPrice: 100,
      pricingTier: 'historical',
      contracts: [
        makeContract({ strike: 100, expiration: '2026-05-15', optionType: 'call', dte: 50, mid: 4.5, impliedVolatility: 0.25, delta: 0.5, openInterest: 2500, volume: 1000 }),
        makeContract({ strike: 100, expiration: '2026-05-15', optionType: 'put', dte: 50, mid: 4.4, impliedVolatility: 0.26, delta: -0.5, openInterest: 2400, volume: 980 }),
        makeContract({ strike: 105, expiration: '2026-05-15', optionType: 'call', dte: 50, mid: 2.1, impliedVolatility: 0.22, delta: 0.24, openInterest: 1900, volume: 500 }),
        makeContract({ strike: 95, expiration: '2026-05-15', optionType: 'put', dte: 50, mid: 2.3, impliedVolatility: 0.3, delta: -0.26, openInterest: 2000, volume: 520 }),
        makeContract({ strike: 120, expiration: '2026-05-15', optionType: 'call', dte: 50, mid: 0.2, impliedVolatility: 0.4, delta: 0.03, openInterest: 3000, volume: 200 }),
        makeContract({ strike: 80, expiration: '2026-05-15', optionType: 'put', dte: 50, mid: 0.25, impliedVolatility: 0.45, delta: -0.04, openInterest: 3200, volume: 210 }),
      ],
    };

    const summarized = summarizeOptionsChain(payload) as Record<string, any>;
    expect(summarized.expirations[0].call25DeltaIv).toBe(0.22);
    expect(summarized.expirations[0].put25DeltaIv).toBe(0.3);
    expect(summarized.expirations[0].putCallSkew).toBeCloseTo(0.08, 6);
  });

  it('returns a stable empty summary when the chain has no contracts', () => {
    const summarized = summarizeOptionsChain({
      ticker: 'XYZ',
      date: '2026-03-26',
      spotPrice: null,
      pricingTier: 'unavailable',
      contractCount: 0,
      contracts: [],
    }) as Record<string, any>;

    expect(summarized.contractCount).toBe(0);
    expect(summarized.expirations).toEqual([]);
    expect(summarized.liquidNearMoney.calls).toEqual([]);
    expect(summarized.activeNearMoney.puts).toEqual([]);
  });
});
