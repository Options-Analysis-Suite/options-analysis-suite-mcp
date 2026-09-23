/**
 * Shaping a live single-expiration chain.
 *
 * The size guard is why this exists: one SPY expiration is 300-1000 contracts
 * against a 50KB ceiling, and the guard's fallback keeps the LOWEST strikes,
 * which for SPY is deep-ITM calls and nothing near the money. So these check
 * both that the output is small and that it kept the part that matters.
 *
 * They also pin the no-fabrication rules. Every field is a real row: a missing
 * quote stays null, and a wing with no delta anywhere is null rather than a
 * strike-based guess a model would quote as if it were a 25-delta.
 */
import { describe, it, expect } from 'bun:test';
import { summarizeLiveChain, type LiveChainResponse, type LiveOption } from './liveChainShaping.js';
import { applyResponseSizeGuard, sanitizeMcpWireOutput, utf8ByteLength } from '../helpers.js';

const call = (strike: number, delta: number, over: Partial<LiveOption> = {}): LiveOption => ({
  strike, type: 'call', bid: 1, ask: 1.2, mid: 1.1, iv: 0.2, delta,
  volume: 10, openInterest: 100, ...over,
});
const put = (strike: number, delta: number, over: Partial<LiveOption> = {}): LiveOption => ({
  strike, type: 'put', bid: 1, ask: 1.2, mid: 1.1, iv: 0.22, delta,
  volume: 20, openInterest: 50, ...over,
});

/** A realistically wide chain: 400 strikes either side, like SPY. */
function wideChain(): LiveChainResponse {
  const calls: LiveOption[] = []; const puts: LiveOption[] = [];
  for (let strike = 100; strike <= 900; strike += 1) {
    const moneyness = (500 - strike) / 500;
    calls.push(call(strike, Math.max(0.01, Math.min(0.99, 0.5 + moneyness * 2))));
    puts.push(put(strike, -Math.max(0.01, Math.min(0.99, 0.5 - moneyness * 2))));
  }
  return {
    symbol: 'SPY', expiration: '2026-09-18', dataSource: 'live', provider: 'tradier',
    asOf: '2026-09-10T15:00:00.000Z', spotPrice: 500, calls, puts,
  };
}

describe('summarizeLiveChain', () => {
  it('fits well inside the 50KB response ceiling', () => {
    const shaped = summarizeLiveChain(wideChain());
    expect(utf8ByteLength(JSON.stringify(shaped))).toBeLessThan(50 * 1024);
    // And the raw chain would not have.
    expect(utf8ByteLength(JSON.stringify(wideChain()))).toBeGreaterThan(50 * 1024);
  });

  it('keeps strikes AROUND spot, which is what truncation loses', () => {
    const shaped = summarizeLiveChain(wideChain(), { strikeRange: 3 });
    const strikes = shaped.nearTheMoney.calls.map((c) => c.strike);
    expect(strikes).toEqual([497, 498, 499, 500, 501, 502, 503]);
  });

  it('carries provenance into the summary, not just the envelope', () => {
    // The summary is what the model reads. A quote it cannot date or attribute
    // is a quote it will relay without either.
    const shaped = summarizeLiveChain(wideChain());
    expect(shaped.dataSource).toBe('live');
    expect(shaped.provider).toBe('tradier');
    expect(shaped.asOf).toBe('2026-09-10T15:00:00.000Z');
    expect(shaped.spotPrice).toBe(500);
  });

  it('picks the ATM pair by distance to spot, in both directions', () => {
    // Nearest, not "round down" and not "first at or above spot": an off-grid
    // spot has to resolve on absolute distance or the ATM strike jumps a full
    // increment as spot crosses a midpoint.
    const strikes = (spotPrice: number) => {
      const chain: LiveChainResponse = {
        spotPrice, calls: [call(495, 0.6), call(500, 0.5), call(505, 0.4)],
        puts: [put(495, -0.4), put(500, -0.5), put(505, -0.6)],
      };
      const shaped = summarizeLiveChain(chain);
      return [shaped.atm?.call?.strike, shaped.atm?.put?.strike];
    };
    expect(strikes(502.4), 'below the midpoint').toEqual([500, 500]);
    expect(strikes(503.0), 'above the midpoint').toEqual([505, 505]);
    expect(strikes(500), 'exactly on a strike').toEqual([500, 500]);
  });

  it('finds the 25-delta wings by delta, not by strike', () => {
    const shaped = summarizeLiveChain({
      spotPrice: 100,
      calls: [call(100, 0.52), call(110, 0.26), call(120, 0.08)],
      puts: [put(100, -0.48), put(90, -0.24), put(80, -0.07)],
    });
    expect(shaped.wings.call25Delta?.strike).toBe(110);
    expect(shaped.wings.put25Delta?.strike).toBe(90);
  });

  it('treats a ZERO delta as real, because at expiration it is', () => {
    // An earlier version read an exact zero as "missing" - a workaround for
    // upstream zero-filling that was false in both directions. With deltas of
    // 0 and 1 it picked 1 as the 25-delta wing, although 0 is nearer to 0.25.
    // Absence is expressed as null now, so a zero is a quote.
    const shaped = summarizeLiveChain({
      spotPrice: 100,
      calls: [call(100, 0), call(110, 1)],
      puts: [put(100, 0)],
    });
    expect(shaped.wings.call25Delta?.strike).toBe(100);
    expect(shaped.atm?.call?.delta).toBe(0);
  });

  it('reports an unpublished Greek as absent', () => {
    const shaped = summarizeLiveChain({
      spotPrice: 500,
      calls: [call(500, 0, { delta: null, iv: null })],
      puts: [],
    });
    expect(shaped.wings.call25Delta).toBeNull();
    expect(shaped.atm?.call?.delta).toBeNull();
    expect(shaped.atm?.call?.iv).toBeNull();
  });

  // Nineteenth run (tastytrade, MU, 2026-09-23): the ATM rows carried delta
  // and no gamma, theta or vega, on every broker in every run. The adapters
  // map all three and `last` (packages/shared brokerService.ts), and row()
  // dropped them, so "live Greeks" was delta alone.
  it("carries the broker's gamma, theta, vega and last on every contract row", () => {
    const greeks = { gamma: 0.012345678, theta: -0.456789012, vega: 0.312345678, last: 1.15 };
    const shaped = summarizeLiveChain({
      spotPrice: 500,
      calls: [call(495, 0.6, greeks), call(500, 0.5, greeks), call(505, 0.25, greeks)],
      puts: [put(495, -0.25, greeks), put(500, -0.5, greeks), put(505, -0.6, greeks)],
    });
    const rows = [shaped.atm!.call!, shaped.atm!.put!, shaped.wings.call25Delta!, shaped.wings.put25Delta!,
      ...shaped.nearTheMoney.calls, ...shaped.nearTheMoney.puts];
    expect(rows.length).toBe(10);
    for (const r of rows) {
      expect(r).toMatchObject(greeks);
      expect(Object.keys(r)).toEqual(['strike', 'bid', 'ask', 'mid', 'mark', 'last', 'iv', 'delta', 'gamma', 'theta', 'vega', 'volume', 'openInterest']);
    }
  });

  it('reports an unpublished gamma, theta, vega or last as absent, not zero', () => {
    const shaped = summarizeLiveChain({ spotPrice: 500, calls: [call(500, 0.5)], puts: [] });
    expect(shaped.atm?.call).toMatchObject({ gamma: null, theta: null, vega: null, last: null });
  });

  it('still fits the 50KB ceiling at the widest strikeRange with long published decimals', () => {
    const chain = wideChain();
    const long = { gamma: 0.001234567891, theta: -0.123456789012, vega: 0.987654321098, last: 123.456789, mark: 123.456789, iv: 0.514250373 };
    chain.calls = chain.calls!.map((o) => ({ ...o, ...long, delta: (o.delta as number) + 0.000000001 }));
    chain.puts = chain.puts!.map((o) => ({ ...o, ...long, delta: (o.delta as number) - 0.000000001 }));
    const shaped = summarizeLiveChain(chain, { strikeRange: 40 });
    expect(shaped.nearTheMoney.calls.length).toBe(81);
    // About 40KB at 12-digit decimals, against the 50KB ceiling (helpers.ts
    // MAX_RESPONSE_BYTES, measured on compact JSON), so nothing is truncated.
    expect(utf8ByteLength(JSON.stringify(shaped))).toBeLessThan(50 * 1024);
  });

  // review: 101 strikes a side from 475 to 525 in 0.5 steps with
  // full-precision decimals took the shaped payload from 35,197 to 53,291
  // bytes at strikeRange 40, past the 51,200-byte guard, which kept the first
  // 50 rows a side (480 to 504.5 instead of 480 to 520): a lopsided window.
  function denseChain(): LiveChainResponse {
    const calls: LiveOption[] = []; const puts: LiveOption[] = [];
    for (let i = 0; i <= 100; i += 1) {
      const strike = 475 + i / 2;
      const long = (base: number, scale: number) => base + Math.sqrt(i + 2) / scale;
      const shared = {
        bid: long(10, 7), ask: long(10.5, 7), mid: long(10.25, 7), mark: long(10.25, 7), last: long(10.1, 7),
        iv: long(0.3, 700), gamma: long(0.01, 7e5), theta: -long(0.1, 7e3), vega: long(0.3, 7e4),
        volume: 1_234_567 + i, openInterest: 7_654_321 + i,
      };
      calls.push(call(strike, long(0.2, 170), shared));
      puts.push(put(strike, -long(0.2, 170), shared));
    }
    return { symbol: 'MU', expiration: '2026-10-02', dataSource: 'live', provider: 'tastytrade', asOf: '2026-09-23T19:10:46.783Z', spotPrice: 500, calls, puts };
  }

  it('narrows the window evenly on both sides when the requested range would exceed the response budget', () => {
    const shaped = summarizeLiveChain(denseChain(), { strikeRange: 40 });
    expect(shaped.view.requestedStrikeRange).toBe(40);
    expect(shaped.view.narrowedForSize).toBe(true);
    const range = shaped.view.strikeRange;
    expect(range).toBeGreaterThan(20);
    expect(range).toBeLessThan(40);
    for (const side of [shaped.nearTheMoney.calls, shaped.nearTheMoney.puts]) {
      expect(side.length).toBe(2 * range + 1);
      expect(side[0].strike).toBe(500 - range / 2);
      expect(side[side.length - 1].strike).toBe(500 + range / 2);
    }
    // One range wider would not have fitted: the narrowing is the least it can be.
    const wider = summarizeLiveChain(denseChain(), { strikeRange: range + 1 });
    expect(wider.view.narrowedForSize).toBe(true);
    expect(wider.view.strikeRange).toBe(range);
    // And the size guard passes it through whole, with no truncation.
    const wire = applyResponseSizeGuard(shaped);
    expect(utf8ByteLength(wire)).toBeLessThanOrEqual(50 * 1024);
    expect(JSON.parse(wire)).toEqual(JSON.parse(JSON.stringify(sanitizeMcpWireOutput(shaped))));
  });

  it('does not narrow a range that fits, and says so', () => {
    const shaped = summarizeLiveChain(denseChain());
    expect(shaped.view).toMatchObject({ strikeRange: 8, requestedStrikeRange: 8, narrowedForSize: false });
    expect(shaped.nearTheMoney.calls.length).toBe(17);
  });

  it("reports a broker IV outside the platform's usable band as absent, and counts it", () => {
    // Seen live on SPY after hours (2026-09-18, Tradier): a 0DTE deep-ITM
    // call with `iv: 10, delta: 1` and deep-ITM puts with `iv: 0` beside real
    // deltas. Those are the broker's solver giving up (a mid below intrinsic
    // has no IV), not a 1000% or a 0% vol, and the exposure engine already
    // treats them as absent (packages/shared exposure-compute isUsableIV, the
    // proxy's capIv: finite, above 0, at most 5). This tool passed them
    // through as numbers. Same band here; the delta and the quote stay.
    const shaped = summarizeLiveChain({
      spotPrice: 762.6,
      calls: [call(755, 1, { iv: 10 }), call(763, 0.4, { iv: 0.1314 }), call(800, 0.02, { iv: 5 })],
      puts: [put(769, -0.95, { iv: 0 }), put(770, -0.96, { iv: 0 }), put(763, -0.6, { iv: 0.1192 }), put(700, -0.01, { iv: 5.0001 })],
    }, { strikeRange: 40 });
    const ivAt = (side: 'calls' | 'puts', strike: number) => shaped.nearTheMoney[side].find((c) => c.strike === strike)?.iv;
    expect(ivAt('calls', 755)).toBeNull();
    expect(ivAt('calls', 763)).toBe(0.1314);
    expect(ivAt('calls', 800)).toBe(5);
    expect(ivAt('puts', 769)).toBeNull();
    expect(ivAt('puts', 770)).toBeNull();
    expect(ivAt('puts', 763)).toBe(0.1192);
    expect(ivAt('puts', 700)).toBeNull();
    // The delta the broker published beside it is still real.
    expect(shaped.nearTheMoney.calls.find((c) => c.strike === 755)?.delta).toBe(1);
    expect(shaped.totals.calls.contractsWithoutUsableIv).toBe(1);
    expect(shaped.totals.puts.contractsWithoutUsableIv).toBe(3);
    // And the ATM pair, which is what a model quotes first.
    expect(shaped.atm?.call?.iv).toBe(0.1314);
  });

  it('does not count a contract with no quote as quoted', () => {
    // A two-sided zero is NO quote, not a quote of zero.
    const shaped = summarizeLiveChain({
      spotPrice: 100,
      calls: [call(100, 0.5, { bid: 0, ask: 0 }), call(105, 0.4, { bid: 0, ask: 0.05 })],
      puts: [],
    });
    expect(shaped.totals.calls.contracts).toBe(2);
    expect(shaped.totals.calls.quoted).toBe(1);
  });

  it('keeps a genuine zero BID, which is real market information', () => {
    // Unlike a Greek, a zero bid is meaningful: nobody is buying it. Blanking
    // it would hide a dead contract rather than describe one.
    const shaped = summarizeLiveChain({
      spotPrice: 100, calls: [call(100, 0.5, { bid: 0, ask: 0.05 })], puts: [],
    });
    expect(shaped.atm?.call?.bid).toBe(0);
    expect(shaped.atm?.call?.ask).toBe(0.05);
  });

  it('returns null wings when no contract carries a delta', () => {
    // A closed-market Schwab chain reports -999 IV and no Greeks. A
    // strike-based substitute would be quoted as a 25-delta wing and would not
    // be one.
    const shaped = summarizeLiveChain({
      spotPrice: 100,
      calls: [call(100, 0 as number, { delta: null }), call(110, 0, { delta: null })],
      puts: [put(100, 0, { delta: null })],
    });
    expect(shaped.wings.call25Delta).toBeNull();
    expect(shaped.wings.put25Delta).toBeNull();
    // The ATM pair is still available: it needs only strikes.
    expect(shaped.atm?.call?.strike).toBe(100);
  });

  it('keeps a missing quote null rather than inventing one', () => {
    const shaped = summarizeLiveChain({
      spotPrice: 100,
      calls: [call(100, 0.5, { bid: null, ask: null, mid: null, iv: null })],
      puts: [],
    });
    expect(shaped.atm?.call).toMatchObject({ strike: 100, bid: null, ask: null, mid: null, iv: null });
  });

  it("carries the broker's published valuation through for a one-sided market", () => {
    // A one-sided market has no midpoint, but the broker still priced the
    // contract. Dropping that told a model "no price" about a contract its own
    // broker had priced - and the shaped window is centred on spot, so the
    // contract it happens to for can be the ATM one.
    const shaped = summarizeLiveChain({
      spotPrice: 100,
      calls: [call(100, 0.5, { bid: null, ask: 2, mid: null, mark: 1.6 })],
      puts: [],
    });
    expect(shaped.atm?.call).toMatchObject({ mid: null, mark: 1.6 });
  });

  it('does not present a mark as if it were a midpoint', () => {
    const shaped = summarizeLiveChain({
      spotPrice: 100,
      calls: [call(100, 0.5, { bid: null, ask: null, mid: null, mark: null })],
      puts: [],
    });
    expect(shaped.atm?.call).toMatchObject({ mid: null, mark: null });
  });

  it('aggregates over the WHOLE chain, not the shaped slice', () => {
    // The totals are the reason a summary can answer "how much volume traded",
    // so they must not silently describe only the strikes that survived.
    const shaped = summarizeLiveChain(wideChain(), { strikeRange: 1 });
    expect(shaped.totals.calls.contracts).toBe(801);
    expect(shaped.totals.calls.volume).toBe(801 * 10);
    expect(shaped.totals.puts.openInterest).toBe(801 * 50);
    expect(shaped.totals.putCallVolumeRatio).toBe(2);
    expect(shaped.totals.putCallOpenInterestRatio).toBe(0.5);
  });

  it('survives an empty or malformed chain without throwing', () => {
    for (const chain of [
      {}, { calls: [], puts: [] }, { spotPrice: null, calls: [call(1, 0.5)] },
      { spotPrice: 100, calls: undefined, puts: undefined },
      { spotPrice: 100, calls: [{ strike: null }] as LiveOption[] },
    ] as LiveChainResponse[]) {
      expect(() => summarizeLiveChain(chain)).not.toThrow();
    }
    expect(summarizeLiveChain({}).atm).toBeNull();
  });

  it('does not divide by zero when there are no calls', () => {
    const shaped = summarizeLiveChain({ spotPrice: 100, calls: [], puts: [put(100, -0.5)] });
    expect(shaped.totals.putCallVolumeRatio).toBeNull();
    expect(shaped.totals.putCallOpenInterestRatio).toBeNull();
  });
});

describe('unknown counts in whole-chain totals', () => {
  const opt = (over: Record<string, unknown> = {}) => ({
    strike: 100, type: 'call', bid: 1, ask: 1.2, mid: 1.1, mark: 1.1,
    iv: 0.2, delta: 0.5, volume: 10, openInterest: 20, ...over,
  });

  it('does not fold an unpublished count into the sum', () => {
    // A side whose counts the broker omitted summed to 0, which is
    // indistinguishable from a side that genuinely traded nothing - and the
    // put/call ratio built on it read as a real 0.
    const shaped = summarizeLiveChain({
      spotPrice: 100,
      calls: [opt()],
      puts: [opt({ type: 'put', volume: null, openInterest: null })],
    } as any);

    expect(shaped.totals.calls.volume).toBe(10);
    expect(shaped.totals.puts.volume).toBeNull();
    expect(shaped.totals.puts.contractsMissingVolume).toBe(1);
    expect(shaped.totals.putCallVolumeRatio).toBeNull();
    expect(shaped.totals.putCallOpenInterestRatio).toBeNull();
  });

  it('still sums what WAS reported when only some contracts are missing', () => {
    const shaped = summarizeLiveChain({
      spotPrice: 100,
      calls: [opt({ volume: 7 }), opt({ strike: 101, volume: null })],
      puts: [opt({ type: 'put', volume: 3 })],
    } as any);

    expect(shaped.totals.calls.volume).toBe(7);
    expect(shaped.totals.calls.contractsMissingVolume).toBe(1);
    // The ratio is still computable, and the omission is visible beside it.
    expect(shaped.totals.putCallVolumeRatio).toBeCloseTo(3 / 7, 4);
  });

  it('reports a genuine published zero as zero, not as unknown', () => {
    const shaped = summarizeLiveChain({
      spotPrice: 100,
      calls: [opt({ volume: 0, openInterest: 0 })],
      puts: [opt({ type: 'put', volume: 0, openInterest: 0 })],
    } as any);

    expect(shaped.totals.calls.volume).toBe(0);
    expect(shaped.totals.calls.contractsMissingVolume).toBe(0);
  });
});
