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
    // As the proxy sends them (SupabaseService.getOptionsChain): the side's
    // own mid IV and the smoothed SMV, each capped to the usable band.
    cMidIv: optionType === 'call' ? impliedVolatility : null,
    pMidIv: optionType === 'put' ? impliedVolatility : null,
    smoothSmvVol: impliedVolatility,
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

  it('leaves the same-day expiry out of the expiration summaries and near-ATM pairs when a later expiration exists', () => {
    // The description promises to avoid same-day expiry noise, and the
    // representative contracts did; the term structure and the near-ATM pairs
    // did not. An end-of-day file carries the expiry that ended that session
    // (AAPL on 2026-09-16 held 47 rows expiring 2026-09-16, years-to-expiry
    // 0), and it led the output: its "ATM" call at delta 0.26 was also its
    // "25-delta" call, and it was named nearestExpiration. At zero time to
    // expiry those are not a term structure; they are the same contract twice.
    const sameDay = (strike: number, optionType: 'call' | 'put', delta: number, mid: number) =>
      makeContract({ strike, expiration: '2026-03-26', optionType, dte: 0, mid, impliedVolatility: 0.27, delta, openInterest: 900, volume: 40000 });
    const later = (expiration: string, dte: number, strike: number, optionType: 'call' | 'put', delta: number, mid: number) =>
      makeContract({ strike, expiration, optionType, dte, mid, impliedVolatility: 0.24, delta, openInterest: 3000, volume: 9000 });
    const payload = {
      ticker: 'AAPL',
      date: '2026-03-26',
      spotPrice: 100,
      pricingTier: 'historical',
      contracts: [
        sameDay(100, 'call', 0.26, 0.05), sameDay(100, 'put', -0.74, 0.3), sameDay(103, 'call', 0.02, 0.01), sameDay(97, 'put', -0.98, 3.0),
        later('2026-03-28', 2, 100, 'call', 0.51, 1.8), later('2026-03-28', 2, 100, 'put', -0.49, 1.7),
        later('2026-03-28', 2, 103, 'call', 0.25, 0.6), later('2026-03-28', 2, 97, 'put', -0.25, 0.55),
        later('2026-04-17', 22, 100, 'call', 0.53, 5.5), later('2026-04-17', 22, 100, 'put', -0.47, 5.4),
        later('2026-04-17', 22, 105, 'call', 0.25, 2.1), later('2026-04-17', 22, 95, 'put', -0.25, 2.0),
      ],
    };

    const summarized = summarizeOptionsChain(payload) as Record<string, any>;
    expect(summarized.expirations.map((e: Record<string, unknown>) => e.expiration)).toEqual(['2026-03-28', '2026-04-17']);
    expect(summarized.nearAtmPairs.map((p: Record<string, unknown>) => p.expiration)).toEqual(['2026-03-28', '2026-04-17']);
    expect(summarized.summary.nearestExpiration).toBe('2026-03-28');
    // The chain still HAD three expirations; the count is about the file.
    expect(summarized.summary.expirationCount).toBe(3);

    // With nothing later on file the same-day expiry is the whole chain and
    // stays: an empty summary of a chain that exists is the wrong answer.
    const onlySameDay = summarizeOptionsChain({ ...payload, contracts: payload.contracts.filter((c) => c.dte === 0) }) as Record<string, any>;
    expect(onlySameDay.expirations.map((e: Record<string, unknown>) => e.expiration)).toEqual(['2026-03-26']);
    expect(onlySameDay.nearAtmPairs).toHaveLength(1);
    expect(onlySameDay.summary.nearestExpiration).toBe('2026-03-26');
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
    expect(summarized.expirations[0]).toMatchObject({ atmCallIvSource: 'mid', atmPutIvSource: 'mid', call25DeltaIvSource: 'mid', put25DeltaIvSource: 'mid' });
  });

  it('names the source of every IV it reports, and builds the skew from side mids only', () => {
    // The proxy fills a contract's impliedVolatility from the side's mid IV
    // where usable and otherwise from the smoothed SMV (capIv on both), and
    // carries cMidIv, pMidIv and smoothSmvVol beside it. Stored (smv 0.3,
    // call mid 0, put mid 0) therefore arrives as impliedVolatility 0.3 on
    // both wings, and the summary reported put25DeltaIv 0.3, call25DeltaIv
    // 0.3 and a skew of 0 with nothing saying the wings were the same
    // smoothed number. Every IV field now carries its source, and the skew
    // is built only from two side mids.
    const contract = (strike: number, optionType: 'call' | 'put', delta: number, sideMid: number | null, smooth: number) => ({
      ...makeContract({ strike, expiration: '2026-05-15', optionType, dte: 50, mid: 2, impliedVolatility: sideMid ?? smooth, delta, openInterest: 1000, volume: 100 }),
      cMidIv: optionType === 'call' ? sideMid : null,
      pMidIv: optionType === 'put' ? sideMid : null,
      smoothSmvVol: smooth,
    });
    const base = { ticker: 'AAPL', date: '2026-03-26', spotPrice: 100, pricingTier: 'historical' };

    const smoothedWings = summarizeOptionsChain({ ...base, contracts: [
      contract(100, 'call', 0.5, 0.25, 0.25), contract(100, 'put', -0.5, 0.26, 0.25),
      contract(105, 'call', 0.24, null, 0.3), contract(95, 'put', -0.26, null, 0.3),
    ] }) as Record<string, any>;
    expect(smoothedWings.expirations[0]).toMatchObject({
      atmCallIv: 0.25, atmCallIvSource: 'mid', atmPutIv: 0.26, atmPutIvSource: 'mid',
      put25DeltaIv: 0.3, put25DeltaIvSource: 'smoothed', call25DeltaIv: 0.3, call25DeltaIvSource: 'smoothed',
      putCallSkew: null,
    });

    // One wing a side mid, the other smoothed: still no skew, both named.
    const oneWing = summarizeOptionsChain({ ...base, contracts: [
      contract(100, 'call', 0.5, 0.25, 0.25), contract(100, 'put', -0.5, 0.26, 0.25),
      contract(105, 'call', 0.24, 0.22, 0.23), contract(95, 'put', -0.26, null, 0.31),
    ] }) as Record<string, any>;
    expect(oneWing.expirations[0]).toMatchObject({ call25DeltaIvSource: 'mid', put25DeltaIvSource: 'smoothed', putCallSkew: null });

    // A contract with no usable IV at all: null value, null source.
    const noIv = summarizeOptionsChain({ ...base, contracts: [
      contract(100, 'call', 0.5, 0.25, 0.25), contract(100, 'put', -0.5, 0.26, 0.25),
      { ...contract(105, 'call', 0.24, null, 0.3), impliedVolatility: null, smoothSmvVol: null }, contract(95, 'put', -0.26, 0.3, 0.3),
    ] }) as Record<string, any>;
    expect(noIv.expirations[0]).toMatchObject({ call25DeltaIv: null, call25DeltaIvSource: null, put25DeltaIvSource: 'mid', putCallSkew: null });

    // A payload without the per-side columns cannot say where its IV came
    // from: the value is reported, the source is null, and no skew is built.
    const noColumns = summarizeOptionsChain({ ...base, contracts: [
      contract(100, 'call', 0.5, 0.25, 0.25), contract(100, 'put', -0.5, 0.26, 0.25),
      contract(105, 'call', 0.24, 0.22, 0.22), contract(95, 'put', -0.26, 0.3, 0.3),
    ].map(({ cMidIv: _c, pMidIv: _p, smoothSmvVol: _s, ...rest }) => rest) }) as Record<string, any>;
    expect(noColumns.expirations[0]).toMatchObject({ call25DeltaIv: 0.22, call25DeltaIvSource: null, put25DeltaIv: 0.3, put25DeltaIvSource: null, putCallSkew: null });

    // The skew's basis rides beside it, because get_iv_surface publishes a
    // putCallSkew on a different basis (fixed 95% and 105% strikes).
    expect(smoothedWings.putCallSkewBasis).toBe('25-delta put IV minus 25-delta call IV, side mid IVs only; null unless both wings are side mids');

    // The trimmed contracts in the near-money lists carry the source too.
    expect(smoothedWings.nearAtmPairs[0].call).toMatchObject({ impliedVolatility: 0.25, ivSource: 'mid' });
    for (const item of [...smoothedWings.liquidNearMoney.calls, ...smoothedWings.liquidNearMoney.puts]) {
      expect(['mid', 'smoothed', null]).toContain(item.ivSource);
    }
  });

  it('says which contract each 25-delta wing actually is', () => {
    // APT on 2026-09-16 (spot 5.25, 50-cent strikes): the nearest-to-25-delta
    // OTM put is the strike-5 contract at delta -0.212, the ATM put itself,
    // so put25DeltaIv equalled atmPutIv on every expiration and nothing on
    // the row said the "25-delta" wing was the ATM strike. Each wing now
    // carries the strike and delta of the contract it is.
    const base = { ticker: 'APT', date: '2026-09-16', spotPrice: 5.25, pricingTier: 'historical' };
    const contract = (strike: number, optionType: 'call' | 'put', delta: number, iv: number) =>
      makeContract({ symbol: 'APT', strike, expiration: '2026-10-02', optionType, dte: 16, mid: 0.4, impliedVolatility: iv, delta, openInterest: 100, volume: 10 });
    const apt = summarizeOptionsChain({ ...base, contracts: [
      contract(4.5, 'call', 0.91, 2.27), contract(4.5, 'put', -0.09, 1.41),
      contract(5, 'call', 0.788, 3.15781), contract(5, 'put', -0.212, 2.587),
      contract(5.5, 'call', 0.163, 0.99), contract(5.5, 'put', -0.837, 0.9),
      contract(6, 'call', 0.05, 1.19), contract(6, 'put', -0.95, 0.93),
    ] }) as Record<string, any>;
    expect(apt.expirations[0]).toMatchObject({
      atmStrike: 5,
      put25DeltaStrike: 5, put25DeltaDelta: -0.212, put25DeltaIv: 2.587,
      call25DeltaStrike: 5.5, call25DeltaDelta: 0.163, call25DeltaIv: 0.99,
    });

    // On a normal grid the wings are their own strikes, not the ATM's: the
    // strike and delta are the pick's, not the ATM contract's.
    const grid = summarizeOptionsChain({ ...base, ticker: 'SPY', spotPrice: 100, contracts: [
      makeContract({ strike: 100, expiration: '2026-05-15', optionType: 'call', dte: 50, mid: 4.5, impliedVolatility: 0.25, delta: 0.5, openInterest: 2500, volume: 1000 }),
      makeContract({ strike: 100, expiration: '2026-05-15', optionType: 'put', dte: 50, mid: 4.4, impliedVolatility: 0.26, delta: -0.5, openInterest: 2400, volume: 980 }),
      makeContract({ strike: 105, expiration: '2026-05-15', optionType: 'call', dte: 50, mid: 2.1, impliedVolatility: 0.22, delta: 0.24, openInterest: 1900, volume: 500 }),
      makeContract({ strike: 95, expiration: '2026-05-15', optionType: 'put', dte: 50, mid: 2.3, impliedVolatility: 0.3, delta: -0.26, openInterest: 2000, volume: 520 }),
    ] }) as Record<string, any>;
    expect(grid.expirations[0]).toMatchObject({ atmStrike: 100, put25DeltaStrike: 95, put25DeltaDelta: -0.26, call25DeltaStrike: 105, call25DeltaDelta: 0.24 });

    // With no OTM contract on a side the pick falls back to the whole side,
    // so the "25-delta put" is an ITM one; the delta beside it says so.
    const noOtmPuts = summarizeOptionsChain({ ...base, spotPrice: 4.4, contracts: [
      contract(5, 'call', 0.3, 1.1), contract(5, 'put', -0.7, 1.2),
      contract(5.5, 'call', 0.15, 1.3), contract(5.5, 'put', -0.85, 1.4),
    ] }) as Record<string, any>;
    expect(noOtmPuts.expirations[0]).toMatchObject({ put25DeltaStrike: 5, put25DeltaDelta: -0.7, put25DeltaIv: 1.2 });

    // No contract on a side at all: null strike, null delta, as the IV is.
    const callsOnly = summarizeOptionsChain({ ...base, contracts: [contract(5, 'call', 0.788, 3.1), contract(5.5, 'call', 0.163, 0.99)] }) as Record<string, any>;
    expect(callsOnly.expirations[0]).toMatchObject({ put25DeltaStrike: null, put25DeltaDelta: null, put25DeltaIv: null, call25DeltaStrike: 5.5, call25DeltaDelta: 0.163 });
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
