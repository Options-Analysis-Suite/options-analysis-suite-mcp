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

  it('carries the proxy\'s openInterestUnpublished flag, and the note says the open interest was withheld', () => {
    // The proxy withholds a blanket zero (Schwab prints 0 on every index
    // option) and says so; the shaper rebuilds the answer by hand, so the
    // flag has to be carried on purpose or the model reads "null OI" with no
    // reason while the tool's description promises one.
    const chain = wideChain();
    const withheld: LiveChainResponse = {
      ...chain,
      openInterestUnpublished: true,
      calls: chain.calls!.map((o) => ({ ...o, openInterest: null })),
      puts: chain.puts!.map((o) => ({ ...o, openInterest: null })),
    };
    const shaped = summarizeLiveChain(withheld) as any;
    expect(shaped.openInterestUnpublished).toBe(true);
    expect(shaped.totals.calls.openInterest).toBeNull();
    expect(shaped.view.note).toMatch(/open interest/i);
    const plain = summarizeLiveChain(wideChain()) as any;
    expect(plain.openInterestUnpublished).toBeUndefined();
    expect(plain.view.note).not.toMatch(/withheld/i);
  });

  it('a row has a mid only where both sides are quoted above zero, as get_live_quote\'s; a zero bid keeps its ask and mark', () => {
    // Live re-run: Tradier's SPY 785-790 calls showed bid 0, ask 0.01 and
    // mid 0.005, a midpoint of a missing side nobody can trade at.
    const shaped = summarizeLiveChain({
      spotPrice: 770,
      calls: [call(785, 0.01, { bid: 0, ask: 0.01, mid: 0.005, mark: 0.005 }), call(780, 0.05, { bid: 0.02, ask: 0.04, mid: 0.03 })],
      puts: [put(760, -0.1, { bid: 0, ask: 0, mid: null }), put(765, -0.2, { bid: 0.5, ask: 0.6, mid: 0.55 })],
    }, { strikeRange: 10 }) as any;
    const at = (side: 'calls' | 'puts', strike: number) => shaped.nearTheMoney[side].find((r: any) => r.strike === strike);
    expect(at('calls', 785)).toMatchObject({ bid: 0, ask: 0.01, mid: null, mark: 0.005 });
    expect(at('calls', 780)).toMatchObject({ mid: 0.03 });
    expect(at('puts', 760)).toMatchObject({ bid: 0, ask: 0, mid: null });
    expect(at('puts', 765)).toMatchObject({ mid: 0.55 });
  });

  it('withholds the Greeks of a contract whose IV is not usable, with the reason, and keeps them where the IV is a volatility', () => {
    // Final re-run: Public's XSP 762-764 calls carried iv null (a sentinel)
    // beside delta 1, gamma 0 and vega 0, the zero-vol limits of the same
    // failed solve, not measurements.
    const chain = wideChain();
    const at = (strike: number) => chain.calls!.findIndex((o) => o.strike === strike);
    chain.calls![at(499)] = { ...chain.calls![at(499)]!, iv: 0, delta: 1, gamma: 0, theta: -0.01, vega: 0 };
    chain.calls![at(500)] = { ...chain.calls![at(500)]!, iv: 12, delta: 1, gamma: 0, vega: 0 };
    chain.calls![at(501)] = { ...chain.calls![at(501)]!, iv: null, delta: 0.97, gamma: 0.001, vega: 0.002 };
    const shaped = summarizeLiveChain(chain) as any;
    const near = (strike: number) => shaped.nearTheMoney.calls.find((r: any) => r.strike === strike);
    for (const strike of [499, 500, 501]) {
      expect(near(strike), String(strike)).toMatchObject({ iv: null, delta: null, gamma: null, theta: null, vega: null, greeksReason: 'iv-unusable' });
      expect(near(strike).bid, String(strike)).not.toBeNull();
    }
    const kept = near(502);
    expect(kept.iv).not.toBeNull();
    expect(typeof kept.delta).toBe('number');
    expect(kept.greeksReason).toBeUndefined();
  });

  it('chooses a 25-delta wing only among contracts whose delta it would show, and none when no such contract remains', () => {
    // Review: the wing was chosen on a delta the row then
    // withheld, so a "25-delta wing" displayed delta null beside a usable
    // contract one strike away.
    const shaped = summarizeLiveChain({
      spotPrice: 772,
      calls: [call(782, 0.25, { iv: null }), call(783, 0.26, { iv: 0.2 })],
      puts: [put(760, -0.25, { iv: 0 }), put(759, -0.24, { iv: 0.21 })],
    }, { strikeRange: 10 }) as any;
    expect(shaped.wings.call25Delta).toMatchObject({ strike: 783, delta: 0.26 });
    expect(shaped.wings.put25Delta).toMatchObject({ strike: 759, delta: -0.24 });
    const none = summarizeLiveChain({ spotPrice: 772, calls: [call(782, 0.25, { iv: null })], puts: [put(760, -0.25, { iv: 9 })] }, { strikeRange: 10 }) as any;
    expect(none.wings).toEqual({ call25Delta: null, put25Delta: null });
  });

  it('carries when the spot printed and whether it is stale, and the note says the at-the-money pair is read against a stale spot', () => {
    // Broker re-run: Public's chain spot was its 04:00 pre-market print and
    // the "at-the-money" pair sat two strikes off with nothing saying why.
    const stale = summarizeLiveChain({ ...wideChain(), spotTime: '2026-10-02T07:59:57.000Z', spotStale: true } as LiveChainResponse) as any;
    expect(stale).toMatchObject({ spotTime: '2026-10-02T07:59:57.000Z', spotStale: true });
    expect(stale.view.note).toContain('The spot printed before the last session\'s open (spotTime), so the at-the-money pair and the strike window are read against a stale price.');
    const fresh = summarizeLiveChain({ ...wideChain(), spotTime: '2026-10-02T19:59:57.000Z', spotStale: false } as LiveChainResponse) as any;
    expect(fresh).toMatchObject({ spotStale: false });
    expect(fresh.view.note).not.toContain('stale price');
    const unknown = summarizeLiveChain(wideChain()) as any;
    expect(unknown).toMatchObject({ spotTime: null, spotStale: null });
  });

  it('names the roots a chain was merged from, and a row priced from another root says so', () => {
    const chain = wideChain();
    const merged: LiveChainResponse = {
      ...chain, root: 'SPXW', roots: ['SPX', 'SPXW'],
      calls: chain.calls!.map((o) => ({ ...o, root: o.strike === 501 ? 'SPX' : 'SPXW', openInterestByRoot: { SPX: 227, SPXW: 939 }, volumeByRoot: { SPX: null, SPXW: 25 } })),
      puts: chain.puts!.map((o) => ({ ...o, root: 'SPXW' })),
    };
    const shaped = summarizeLiveChain(merged) as any;
    expect(shaped).toMatchObject({ root: 'SPXW', roots: ['SPX', 'SPXW'] });
    // Each root's own open interest and volume ride on the row beside the sum.
    expect(shaped.nearTheMoney.calls[0]).toMatchObject({ openInterestByRoot: { SPX: 227, SPXW: 939 }, volumeByRoot: { SPX: null, SPXW: 25 } });
    expect(shaped.nearTheMoney.puts[0].openInterestByRoot).toBeUndefined();
    expect(shaped.view.note).toMatch(/SPX and SPXW/);
    const near = shaped.nearTheMoney.calls as any[];
    expect(near.find((r) => r.strike === 501).root).toBe('SPX');
    expect(near.find((r) => r.strike === 500).root).toBeUndefined();
    const plain = summarizeLiveChain(wideChain()) as any;
    expect(plain.roots).toBeUndefined();
    expect(plain.nearTheMoney.calls[0].root).toBeUndefined();
  });

  it('a chain under one root names it, and the note says so only where the root is not the symbol', () => {
    const chain = wideChain();
    const weekly = summarizeLiveChain({
      ...chain, symbol: 'SPX', root: 'SPXW', roots: ['SPXW'],
      calls: chain.calls!.map((o) => ({ ...o, root: 'SPXW' })), puts: chain.puts!.map((o) => ({ ...o, root: 'SPXW' })),
    }) as any;
    expect(weekly).toMatchObject({ root: 'SPXW', roots: ['SPXW'] });
    expect(weekly.view.note).toMatch(/Every contract is under the SPXW root, not SPX\./);
    expect(weekly.view.note).not.toMatch(/summed across/);
    expect(weekly.nearTheMoney.calls[0].root).toBeUndefined();
    const equity = summarizeLiveChain({
      ...chain, symbol: 'AAPL', root: 'AAPL', roots: ['AAPL'],
      calls: chain.calls!.map((o) => ({ ...o, root: 'AAPL' })), puts: chain.puts!.map((o) => ({ ...o, root: 'AAPL' })),
    }) as any;
    expect(equity).toMatchObject({ root: 'AAPL', roots: ['AAPL'] });
    expect(equity.view.note).not.toMatch(/root/);
    // Review: a rootless row beside the rooted ones is not
    // under that root, and "every contract" said it was.
    const partly = summarizeLiveChain({
      ...chain, symbol: 'SPX', root: 'SPXW', roots: ['SPXW'],
      calls: chain.calls!.map((o) => ({ ...o, root: 'SPXW' })), puts: chain.puts!.map((o, i) => (i === 0 ? { ...o } : { ...o, root: 'SPXW' })),
    }) as any;
    const contracts = chain.calls!.length + chain.puts!.length;
    expect(partly.view.note).toMatch(new RegExp(`${contracts - 1} of ${contracts} contracts are under the SPXW root, not SPX; the rest name root null, none from the broker\\.`));
    expect(partly.view.note).not.toMatch(/Every contract/);
  });

  it('names an adjusted series the proxy left out, with its contract count, and the note says why', () => {
    const chain = wideChain();
    const shaped = summarizeLiveChain({ ...chain, excludedRoots: [{ root: 'AAPL1', contracts: 12 }] }) as any;
    expect(shaped.excludedRoots).toEqual([{ root: 'AAPL1', contracts: 12 }]);
    expect(shaped.view.note).toMatch(/12 contracts under the AAPL1 root/);
    expect(shaped.view.note).toMatch(/adjusted series/);
    const plain = summarizeLiveChain(wideChain()) as any;
    expect(plain.excludedRoots).toBeUndefined();
    expect(plain.view.note).not.toMatch(/adjusted/);
  });

  it('an empty book naming adjusted roots shapes to zero contracts, no rows, and the note naming each root', () => {
    const shaped = summarizeLiveChain({ ...wideChain(), calls: [], puts: [], excludedRoots: [{ root: 'AAPL1', contracts: 2 }, { root: 'AAPL2', contracts: 1 }] }) as any;
    expect(shaped.totals.calls.contracts).toBe(0);
    expect(shaped.nearTheMoney).toEqual({ calls: [], puts: [] });
    expect(shaped.view.note).toMatch(/0 contracts in the full chain\. 2 contracts under the AAPL1 root and 1 contracts under the AAPL2 root/);
  });

  it('on a merged chain a row the broker named no root for says so with null, never by silence', () => {
    const chain = wideChain();
    const merged: LiveChainResponse = {
      ...chain, root: 'SPX', roots: ['SPX', 'SPXW'],
      calls: chain.calls!.map((o) => (o.strike === 500 ? { ...o } : { ...o, root: 'SPX' })),
      puts: chain.puts!.map((o) => ({ ...o, root: 'SPX' })),
    };
    const shaped = summarizeLiveChain(merged) as any;
    const near = shaped.nearTheMoney.calls as any[];
    expect(near.find((r) => r.strike === 500).root).toBeNull();
    expect(near.find((r) => r.strike === 499).root).toBeUndefined();
    expect(shaped.view.note).toMatch(/null where the broker named none/);
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
    // through as numbers. Same band here; the quote stays.
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
    // The Greeks beside it come from the same failed solve: withheld with the
    // reason (the user's ruling after the final live re-run, 2026-10-04).
    expect(shaped.nearTheMoney.calls.find((c) => c.strike === 755)).toMatchObject({ delta: null, greeksReason: 'iv-unusable' });
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
