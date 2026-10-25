import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { LiveApiClient, LiveRateLimit } from '../../proxy/liveApiClient.js';
import { register } from './dealerPositioning.js';
import { inDeltaBand, significantDeep, summarizeDealerPositioning, withinPercent } from './dealerPositioningShaping.js';
import { sanitizeMcpWireOutput, toolHandler } from '../helpers.js';

const coverage = (total = 824, included = total) => ({
  strikes: 412, strikesWithGamma: 412, strikesWithDelta: 412,
  gamma: { total, included }, delta: { total, included },
  vega: { total, included }, vanna: { total, included },
  charm: { total, included }, vomma: { total, included },
  gammaFlip: { total, included },
  gammaFlipResolution: 0.0185,
  gammaFlipSearchStatus: 'found',
});

const strikeRow = (strike: number, netGamma: number) => ({
  strike,
  callGamma: Math.abs(netGamma), putGamma: -Math.abs(netGamma) / 2, netGamma,
  callDelta: -1000, putDelta: 2000, netDelta: 1000,
  callVega: 10, putVega: 5, netVega: 15,
  coverage: coverage(2),
});

const live = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  symbol: 'MU',
  dataSource: 'live',
  provider: 'tastytrade',
  asOf: '2026-09-10T14:31:02.000Z',
  expirations: ['2026-09-18', '2026-09-25', '2026-10-16', '2026-11-20'],
  expirationsAvailable: 18,
  strikesUsed: 412,
  coverage: coverage(),
  resolved: { r: 0.043, q: 0.004, source: 'treasury_curve' },
  snapshot: {
    spotPrice: 120,
    netGamma: 140_000, netDelta: -3_400_000,
    netVega: 88_000, netVanna: 1_200, netCharm: -450, netVomma: 900,
    callWall: 130, putWall: 110, gammaFlip: 118.5,
    absGamma: 125, gammaConcentration: 0.42,
    regime: 'positive',
    topStrikes: [],
  },
  byStrike: [strikeRow(100, 10), strikeRow(118, 50), strikeRow(120, 90), strikeRow(122, 40), strikeRow(140, 5)],
  ...over,
});

it('the no-crossing caveat retains the 136 complete rows that fitted at an earlier build', async () => {
  const byStrike = Array.from({ length: 1600 }, (_, i) => ({
    ...strikeRow(50 + i * 0.5, i * Math.PI * 1e10),
    netGamma: 1234.5, netDelta: -2345.6, netVega: 34.5,
    callOpenInterest: 123456, putOpenInterest: 654321, coverage: coverage(4, 4),
  }));
  for (const spotPrice of [120, 120.01, 120.02]) {
    const shaped = summarizeDealerPositioning(live({ byStrike,
      snapshot: { ...live().snapshot, spotPrice, gammaFlip: null },
      coverage: { ...coverage(), gammaFlipSearchStatus: 'not-found' },
    }), { strikeRange: 150, rateLimit: { provider: 'tastytrade', limit: 120, remaining: 100, resetSeconds: 30 } });
    expect(shaped.strikes.returned).toBeGreaterThanOrEqual(136);
    const result = await toolHandler(async () => shaped)({});
    const wire = result.structuredContent as any;
    expect(wire.strikes.returned).toBeGreaterThanOrEqual(136);
    expect(wire.responseBudget).toBeUndefined();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(wire);
    expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(49_152);
  }
});

it('the found-flip clause keeps the complete rows a found flip fitted at an earlier build', async () => {
  const byStrike = Array.from({ length: 1600 }, (_, i) => ({
    ...strikeRow(50 + i * 0.5, i * Math.PI * 1e10),
    netGamma: 1234.5, netDelta: -2345.6, netVega: 34.5,
    callOpenInterest: 123456, putOpenInterest: 654321, coverage: coverage(4, 4),
  }));
  for (const { gammaFlipMethod, minimumRows } of [
    { gammaFlipMethod: undefined, minimumRows: 136 }, { gammaFlipMethod: 'mixed', minimumRows: 135 },
  ]) for (const spotPrice of [120, 120.01, 120.02]) {
    const shaped = summarizeDealerPositioning(live({ byStrike,
      snapshot: { ...live().snapshot, spotPrice, gammaFlip: 118.5 },
      coverage: { ...coverage(), gammaFlipMethod, gammaFlipSearchStatus: 'found', gammaFlipResolution: 0.0185 },
    }), { strikeRange: 150, rateLimit: { provider: 'tastytrade', limit: 120, remaining: 100, resetSeconds: 30 } });
    expect(shaped.guide.levelStatus).toContain('nearest to spot among crossings found by sampling');
    expect(shaped.strikes.returned).toBeGreaterThanOrEqual(minimumRows);
    const result = await toolHandler(async () => shaped)({});
    const wire = result.structuredContent as any;
    expect(wire.strikes.returned).toBe(shaped.strikes.returned);
    expect(wire.responseBudget).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(49_152);
  }
});

it('a complete null flip does not invent an unreported search status', () => {
  for (const status of [null, 'unrecognized']) {
    const shaped = summarizeDealerPositioning(live({
      snapshot: { ...live().snapshot, gammaFlip: null },
      coverage: { ...coverage(), gammaFlipSearchStatus: status },
    }));
    expect(shaped.coverage.gammaFlip.status).toBe('complete');
    expect(shaped.coverage.gammaFlipSearchStatus).toBeNull();
    expect(shaped.guide.flipSearch).toContain('no recognized status');
    expect(shaped.guide.levelStatus).not.toContain('coverage.gammaFlipSearchStatus: not-found or unresolved');
    expect(shaped.guide.levelStatus).toContain('See coverage.gammaFlipSearchStatus.');
  }
});

describe('summarizeDealerPositioning', () => {
  it('publishes computed sums and the flip step to 15 significant digits, dropping only binary noise', () => {
    // SPY on 2026-09-28: a strike's summed vega came out -27496.350000000002
    // and the flip step 0.15312200000005305.
    const noisy = summarizeDealerPositioning(live({
      coverage: { ...coverage(), gammaFlipResolution: 0.15312200000005305 },
      snapshot: { ...live().snapshot, netVega: -84306.23000000001 },
      byStrike: [{ ...strikeRow(120, 90), netVega: -27496.350000000002, netDelta: 1234.5678901234567 }],
    }));
    const row = noisy.strikes.nearSpot[0];
    expect(row.netVega).toBe(-27496.35);
    // Fifteen digits are kept: a value that has them is not rounded further.
    expect(row.netDex).toBe(1234.56789012346);
    expect(noisy.exposure.netVega).toBe(-84306.23);
    expect(noisy.coverage.gammaFlipResolution).toBe(0.153122);
    expect(JSON.stringify(noisy.limitations)).toContain('a step of 0.153122 in price');
  });

  it('publishes whole numbers exactly: a count is not noise, and the largest double stays finite', () => {
    const side = {
      strikes: 3, netGamma: 5_000, callGamma: 8_000, putGamma: -3_000,
      gammaCoverage: { total: 6, included: 6 },
      callOpenInterest: 1_000_000_000_000_001, callOpenInterestCoverage: { total: 3, included: 3 },
      putOpenInterest: 400, putOpenInterestCoverage: { total: 3, included: 3 },
    };
    const shaped = summarizeDealerPositioning(live({
      snapshot: { ...live().snapshot, netGamma: Number.MAX_VALUE },
      spotSides: { atSpotStrike: 120, above: side, below: side, callOpenInterestShareAbove: 0.5 },
    }));
    expect(shaped.spotSides!.above.callOpenInterest).toBe(1_000_000_000_000_001);
    expect(shaped.exposure.netGex).toBe(Number.MAX_VALUE);
    expect(shaped.exposureStatus.netGex).toBe('complete');
  });

  it('rounds every number in a payload to 15 significant digits, leaving the rest as it is', () => {
    const payload = {
      ratio: 0.12531986276320103, mid: 11.190000000000001, count: 1_000_000_000_000_001, flag: true, name: 'SPY', none: null,
      rows: [{ spread: 2.197802197802198, strike: 765 }, 17.994999999999997],
      nested: { deeper: { iv: 0.13540000000000002, printed: 0.1234 } },
    };
    expect(significantDeep(payload)).toEqual({
      ratio: 0.125319862763201, mid: 11.19, count: 1_000_000_000_000_001, flag: true, name: 'SPY', none: null,
      rows: [{ spread: 2.1978021978022, strike: 765 }, 17.995],
      nested: { deeper: { iv: 0.1354, printed: 0.1234 } },
    });
  });

  it('surfaces the levels a reader asks for by name', () => {
    const shaped = summarizeDealerPositioning(live());
    expect(shaped.levels).toMatchObject({
      gammaFlip: 118.5, callWall: 130, putWall: 110, dealerRegime: 'positive',
    });
    expect(shaped.exposure).toMatchObject({ netGex: 140_000, netDex: -3_400_000, netVega: 88_000 });
    expect(shaped.spotPrice).toBe(120);
    expect(shaped.dataSource).toBe('live');
  });

  it('keeps the net totals over the WHOLE book when it trims the strikes', () => {
    // The window is centred on spot. Summing the returned rows gives a
    // different number wearing the same name, so the totals must not be
    // recomputed from the slice.
    const shaped = summarizeDealerPositioning(live(), { strikeRange: 3 });
    expect(shaped.strikes.nearSpot).toHaveLength(3);
    expect(shaped.strikes.total).toBe(5);
    expect(shaped.strikes.nearSpot.map((row) => row.strike)).toEqual([118, 120, 122]);
    // Twelfth run: the walls are chosen per side and the rows carried net
    // gamma only, so a reader could not check a wall against them. Each
    // row now carries the two sides under the gamma coverage the net has.
    expect(shaped.strikes.nearSpot[1]).toMatchObject({ strike: 120, netGex: 90, callGex: 90, putGex: -45 });
    // Empty coverage supports a zero on each side and nothing else.
    const empty = summarizeDealerPositioning(live({ byStrike: [
      { ...strikeRow(120, 0), callGamma: 0, putGamma: 0, coverage: { ...coverage(0), gamma: { total: 0, included: 0 } } },
      { ...strikeRow(121, 0), callGamma: 5, putGamma: 0, coverage: { ...coverage(0), gamma: { total: 0, included: 0 } } },
    ] }));
    expect(empty.strikes.nearSpot[0]).toMatchObject({ callGex: 0, putGex: 0 });
    expect(empty.strikes.nearSpot[1]).toMatchObject({ callGex: null, putGex: 0 });
    // Untouched by the trim.
    expect(shaped.exposure.netGex).toBe(140_000);
  });

  it('reports the expirations the numbers were computed over', () => {
    // Exposure across four expirations is not exposure across one. Without the
    // window, two answers cannot be compared at all.
    const shaped = summarizeDealerPositioning(live());
    expect(shaped.window.expirations).toEqual(['2026-09-18', '2026-09-25', '2026-10-16', '2026-11-20']);
    expect(shaped.window.expirationsAvailable).toBe(18);
    expect(shaped.window.strikesUsed).toBe(412);
    // Whether the caller named the expiration or took the nearest four, and
    // nothing invented when the route did not say.
    expect(shaped.window.expirationSelection).toBeNull();
    expect(summarizeDealerPositioning(live({ expirationSelection: 'requested', expirations: ['2026-09-25'] })).window)
      .toMatchObject({ expirations: ['2026-09-25'], expirationSelection: 'requested' });
    expect(summarizeDealerPositioning(live({ expirationSelection: 'nearest' })).window.expirationSelection).toBe('nearest');
    expect(summarizeDealerPositioning(live({ expirationSelection: 'all' })).window.expirationSelection).toBeNull();
  });

  it('shapes each expiration alone, with its expected move, under its own coverage', () => {
    const entry = (over: Record<string, unknown> = {}) => ({
      expiration: '2026-09-18', daysToExpiration: 0,
      netGamma: 90_000, netDelta: -1_000, callGamma: 120_000, putGamma: -30_000, grossGamma: 150_000,
      shareOfGrossGamma: 0.6,
      coverage: { gamma: { total: 10, included: 10 }, delta: { total: 10, included: 10 } },
      expectedMove: {
        strike: 120, callMid: 2.5, putMid: 2.1, straddle: 4.6, pctOfSpot: 4.6 / 120,
        lower: 115.4, upper: 124.6, atmIv: 0.25, ivOneSigma: 1.6,
      },
      expectedMoveUnavailable: null,
      ...over,
    });
    const shaped = summarizeDealerPositioning(live({ byExpiration: [
      entry(),
      entry({
        expiration: '2026-09-25', daysToExpiration: 7, shareOfGrossGamma: 0.4,
        expectedMove: null, expectedMoveUnavailable: 'atm-quote-missing',
      }),
      // Partial gamma coverage: the net stays, the sides and the gross go.
      entry({ expiration: '2026-10-16', daysToExpiration: 28, shareOfGrossGamma: null,
        coverage: { gamma: { total: 10, included: 7 }, delta: { total: 10, included: 10 } } }),
      // A share outside [0, 1] is not a share.
      entry({ expiration: '2026-11-20', shareOfGrossGamma: 1.2 }),
      { daysToExpiration: 3 },
    ] }));
    expect(shaped.byExpiration).toHaveLength(4);
    expect(shaped.byExpiration[0]).toMatchObject({
      expiration: '2026-09-18', daysToExpiration: 0, netGex: 90_000, netDex: -1_000,
      callGex: 120_000, putGex: -30_000, grossGex: 150_000, shareOfGrossGex: 0.6,
      status: { netGex: 'complete', netDex: 'complete' },
      expectedMove: { strike: 120, straddle: 4.6, lower: 115.4, upper: 124.6, atmIv: 0.25 },
    });
    expect(shaped.byExpiration[1]).toMatchObject({ expectedMove: null, expectedMoveUnavailable: 'atm-quote-missing' });
    expect(shaped.byExpiration[2]).toMatchObject({
      netGex: 90_000, callGex: null, putGex: null, grossGex: null, shareOfGrossGex: null,
      status: { netGex: 'partial' },
    });
    expect(shaped.byExpiration[3].shareOfGrossGex).toBeNull();
    // Coverage the engine did not report is unknown: no values, no sides.
    const unreported = summarizeDealerPositioning(live({ byExpiration: [
      entry({ shareOfGrossGamma: null, coverage: { gamma: null, delta: null } }),
    ] })).byExpiration[0];
    expect(unreported).toMatchObject({
      netGex: null, netDex: null, callGex: null, putGex: null, grossGex: null,
      status: { netGex: 'unknown', netDex: 'unknown' },
    });
    // A route that sent none: an empty list, nothing invented.
    expect(summarizeDealerPositioning(live()).byExpiration).toEqual([]);
    expect(summarizeDealerPositioning(live()).events).toBeNull();
    // No events block means unknown, never "no event".
    expect(shaped.byExpiration[0].events).toBeNull();
  });

  it('carries the event flags, and keeps a failed calendar read distinct from no event', () => {
    const shaped = summarizeDealerPositioning(live({
      byExpiration: [
        { expiration: '2026-09-18', coverage: {}, events: {
          earningsOnOrBefore: '2026-09-17',
          exDividendOnOrBefore: { date: '2026-09-16', amount: 0.25, declared: true },
        } },
        { expiration: '2026-11-20', coverage: {}, events: {
          earningsOnOrBefore: null, exDividendOnOrBefore: { date: 'soon', amount: 1, declared: true },
        } },
        { expiration: '2026-12-18', coverage: {}, events: null },
        { expiration: '2027-01-15', coverage: {}, events: {
          earningsOnOrBefore: '2026-02-30', exDividendOnOrBefore: { date: '2026-99-99', amount: 1, declared: true },
        } },
      ],
      events: {
        from: '2026-09-15', through: '2026-12-18', earnings: ['2026-09-17', 'bad', '2026-02-30', '2026-13-01'],
        exDividends: [{ date: '2026-09-16', amount: 0.25, declared: true }, { amount: 3 }, { date: '2026-10-01', amount: 0.3, declared: 'yes' }],
      },
    }));
    expect(shaped.byExpiration.map((e) => e.events)).toEqual([
      { earningsOnOrBefore: '2026-09-17', exDividendOnOrBefore: { date: '2026-09-16', amount: 0.25, declared: true } },
      // A malformed date is dropped.
      { earningsOnOrBefore: null, exDividendOnOrBefore: null },
      null,
      // So is a well-formed string that is no calendar day.
      { earningsOnOrBefore: null, exDividendOnOrBefore: null },
    ]);
    expect(shaped.events).toEqual({
      from: '2026-09-15', through: '2026-12-18', earnings: ['2026-09-17'],
      // Only `true` is declared.
      exDividends: [{ date: '2026-09-16', amount: 0.25, declared: true }, { date: '2026-10-01', amount: 0.3, declared: false }],
    });
  });

  it('carries the book split at spot, gating each value on its coverage', () => {
    const side = (over: Record<string, unknown> = {}) => ({
      strikes: 3, netGamma: 5_000, callGamma: 8_000, putGamma: -3_000,
      gammaCoverage: { total: 6, included: 6 },
      callOpenInterest: 1_200, callOpenInterestCoverage: { total: 3, included: 3 },
      putOpenInterest: 400, putOpenInterestCoverage: { total: 3, included: 3 },
      ...over,
    });
    const shaped = summarizeDealerPositioning(live({
      spotSides: {
        atSpotStrike: 120,
        above: side(),
        // Partial gamma: no sides. One call leg unsized: a labelled partial sum.
        below: side({ gammaCoverage: { total: 6, included: 5 }, callOpenInterestCoverage: { total: 3, included: 2 } }),
        callOpenInterestShareAbove: 0.6,
      },
    }));
    expect(shaped.spotSides!.atSpotStrike).toBe(120);
    expect(shaped.spotSides!.callOpenInterestShareAbove).toBe(0.6);
    expect(shaped.spotSides!.above).toMatchObject({
      strikes: 3, netGex: 5_000, callGex: 8_000, putGex: -3_000, callOpenInterest: 1_200, putOpenInterest: 400,
      status: { netGex: 'complete', callOpenInterest: 'complete', putOpenInterest: 'complete' },
    });
    expect(shaped.spotSides!.below).toMatchObject({
      netGex: 5_000, callGex: null, putGex: null, callOpenInterest: 1_200,
      status: { netGex: 'partial', callOpenInterest: 'partial', putOpenInterest: 'complete' },
    });
    expect(shaped.spotSides!.below.coverage.callOpenInterest).toEqual({ total: 3, included: 2, status: 'partial' });

    // A share outside [0, 1] is not a share; no block is unknown, not empty.
    expect(summarizeDealerPositioning(live({ spotSides: { above: side(), below: side(), callOpenInterestShareAbove: 1.5 } }))
      .spotSides!.callOpenInterestShareAbove).toBeNull();
    expect(summarizeDealerPositioning(live()).spotSides).toBeNull();
  });

  it('carries each strike\'s open interest, and null where a size was not published', () => {
    const shaped = summarizeDealerPositioning(live({
      byStrike: [
        { ...strikeRow(118, 50), callOpenInterest: 900, putOpenInterest: null },
        { ...strikeRow(120, 90), callOpenInterest: 12.5, putOpenInterest: 300 },
      ],
    }));
    expect(shaped.strikes.nearSpot.map((r) => [r.strike, r.callOpenInterest, r.putOpenInterest]))
      .toEqual([[118, 900, null], [120, null, 300]]);
  });

  it('carries the rate the gamma flip was repriced with', () => {
    // The flip is a repricing across spot levels: it is only as good as r and
    // q, so a reader must be able to see them.
    expect(summarizeDealerPositioning(live()).resolved).toEqual({
      r: 0.043, q: 0.004, source: 'treasury_curve',
    });
  });

  it('does not invent a regime when there is no net gamma', () => {
    // A regime is a claim about how the market will behave. "Neutral" for a
    // symbol we could not measure is a claim we have no basis for.
    const shaped = summarizeDealerPositioning(live({
      snapshot: { spotPrice: 120, netGamma: null, regime: null },
    }) as any);
    expect(shaped.levels.dealerRegime).toBeNull();
    expect(shaped.exposure.netGex).toBeNull();
  });

  it('derives a regime from the sign only when one was not stated', () => {
    for (const [netGamma, expected] of [[5, 'positive'], [-5, 'negative'], [0, 'neutral']] as const) {
      const shaped = summarizeDealerPositioning(live({
        snapshot: { spotPrice: 120, netGamma, regime: null },
      }) as any);
      expect(shaped.levels.dealerRegime, String(netGamma)).toBe(expected);
    }
    // An explicit regime always wins over the derived one.
    const stated = summarizeDealerPositioning(live({
      snapshot: { spotPrice: 120, netGamma: -5, regime: 'positive' },
    }) as any);
    expect(stated.levels.dealerRegime).toBe('positive');
  });

  it('does not present an unmeasured book as a flat one', () => {
    // The endpoint returns 0 for a sum with no measured terms, because a sum
    // cannot carry "unknown". The tool must not relay that as a measurement: a
    // chain the broker sent no Greeks for came back as six zero exposures and
    // a neutral dealer regime, which is a confident description of a market
    // nobody looked at.
    const shaped = summarizeDealerPositioning(live({
      coverage: { ...coverage(800, 0), strikes: 400, strikesWithGamma: 0, strikesWithDelta: 0 },
      snapshot: {
        spotPrice: 120, netGamma: 0, netDelta: 0, netVega: 0,
        netVanna: 0, netCharm: 0, netVomma: 0,
        callWall: null, putWall: null, gammaFlip: null, regime: 'neutral',
      },
      byStrike: [],
    }) as any);

    expect(shaped.exposure.netGex).toBeNull();
    expect(shaped.exposure.netDex).toBeNull();
    expect(shaped.exposure.netVega).toBeNull();
    expect(shaped.exposure.netVanna).toBeNull();
    expect(shaped.exposure.netCharm).toBeNull();
    expect(shaped.exposure.netVomma).toBeNull();
    expect(shaped.exposureStatus.netVega).toBe('unmeasured');
    expect(shaped.levels.dealerRegime).toBeNull();
    expect(shaped.coverage).toMatchObject({ strikesWithGamma: 0, strikesWithDelta: 0 });
  });

  it('forwards partial coverage rather than hiding it', () => {
    const shaped = summarizeDealerPositioning(live({
      coverage: { ...coverage(800), delta: { total: 800, included: 12 } },
    }) as any);
    expect(shaped.coverage.delta).toEqual({ total: 800, included: 12, status: 'partial' });
    // Gamma was measured, so its levels stand.
    expect(shaped.levels.gammaFlip).toBe(118.5);
    expect(shaped.exposure.netGex).toBe(140_000);
    // Delta includes only 12 of 800 active legs, so this is a partial sum.
    expect(shaped.exposure.netDex).toBe(-3_400_000);
    expect(shaped.exposureStatus.netDex).toBe('partial');
    expect(shaped.limitations.join(' ')).toMatch(/partial sums/i);
  });

  it('keeps observed zero exposures and a measured neutral regime', () => {
    const shaped = summarizeDealerPositioning(live({
      coverage: coverage(2),
      snapshot: { spotPrice: 100, netGamma: 0, netDelta: 0, netVega: 0, netVanna: 0, netCharm: 0, netVomma: 0, regime: 'neutral' },
    }));
    expect(shaped.exposure).toEqual({ netGex: 0, netDex: 0, netVega: 0, netVanna: 0, netCharm: 0, netVomma: 0 });
    expect(shaped.exposureStatus.netGex).toBe('complete');
    expect(shaped.levels.dealerRegime).toBe('neutral');
  });

  it('keeps an IV-supported gamma flip independently of observed gamma', () => {
    const shaped = summarizeDealerPositioning(live({
      coverage: { ...coverage(2), gamma: { total: 2, included: 0 } },
      snapshot: { ...live().snapshot, netGamma: 0, gammaFlip: 99.39, regime: 'neutral' },
    }));
    expect(shaped.exposure.netGex).toBeNull();
    expect(shaped.levels.gammaFlip).toBe(99.39);
    expect(shaped.levelStatus.gammaFlip).toBe('complete');
    expect(shaped.levels.dealerRegime).toBeNull();
  });

  it('retains partial sums while withholding levels from an incomplete book', () => {
    const shaped = summarizeDealerPositioning(live({ coverage: coverage(10, 3) }));
    expect(shaped.exposure.netGex).toBe(140_000);
    expect(shaped.exposure.netVanna).toBe(1_200);
    expect(shaped.exposureStatus.netVanna).toBe('partial');
    expect(shaped.levels.callWall).toBeNull();
    expect(shaped.levels.dealerRegime).toBeNull();
    expect(shaped.levels.gammaFlip).toBeNull();
    expect(shaped.levelStatus.callWall).toBe('partial');
    expect(shaped.levelStatus.gammaFlip).toBe('partial');
  });

  it('marks absent and legacy coverage unknown instead of implying measurement', () => {
    for (const rawCoverage of [undefined, null, {}, { strikes: 412, strikesWithGamma: 412, strikesWithDelta: 412 }]) {
      const shaped = summarizeDealerPositioning(live({ coverage: rawCoverage }));
      expect(shaped.exposure.netGex).toBeNull();
      expect(shaped.exposure.netVega).toBeNull();
      expect(shaped.exposureStatus.netGex).toBe('unknown');
      expect(shaped.levels.dealerRegime).toBeNull();
      expect(shaped.levels.gammaFlip).toBeNull();
      expect(shaped.coverage.gamma.status).toBe('unknown');
    }
  });

  it('rejects malformed or contradictory coverage counts conservatively', () => {
    for (const counts of [
      null, {}, [], { total: 1 }, { total: '1', included: 1 },
      { total: 1, included: true }, { total: -1, included: 0 },
      { total: 1, included: -1 }, { total: 1, included: 2 },
      { total: 1.5, included: 1 }, { total: 1, included: 0.5 },
      { total: Infinity, included: 1 }, { total: 1, included: NaN },
      { total: Number.MAX_SAFE_INTEGER + 1, included: 1 },
    ]) {
      const shaped = summarizeDealerPositioning(live({ coverage: { ...coverage(), gamma: counts } }));
      expect(shaped.exposure.netGex).toBeNull();
      expect(shaped.exposureStatus.netGex).toBe('unknown');
      expect(shaped.levels.dealerRegime).toBeNull();
    }
  });

  it('allows a known empty-book zero without inferring levels', () => {
    const shaped = summarizeDealerPositioning(live({
      coverage: coverage(0),
      snapshot: { ...live().snapshot, netGamma: 0, netDelta: 0, netVega: 0, netVanna: 0, netCharm: 0, netVomma: 0, regime: 'neutral' },
      byStrike: [],
    }));
    expect(shaped.exposure.netGex).toBe(0);
    expect(shaped.exposureStatus.netGex).toBe('empty');
    expect(shaped.levels.dealerRegime).toBeNull();
    expect(shaped.levels.gammaFlip).toBeNull();
    const inconsistent = summarizeDealerPositioning(live({ coverage: coverage(0) }));
    expect(inconsistent.exposure.netGex).toBeNull();
    expect(inconsistent.exposureStatus.netGex).toBe('unknown');
  });

  it('does not claim support for a missing or invalid reported exposure', () => {
    const shaped = summarizeDealerPositioning(live({ snapshot: { ...live().snapshot, netGamma: null, netVega: Infinity } }));
    expect(shaped.exposure.netGex).toBeNull();
    expect(shaped.exposureStatus.netGex).toBe('unavailable');
    expect(shaped.exposureStatus.netVega).toBe('unavailable');
    expect(shaped.levels.dealerRegime).toBeNull();
  });

  it('uses each strike metric coverage instead of relaying unmeasured zero rows', () => {
    const shaped = summarizeDealerPositioning(live({ byStrike: [
      { ...strikeRow(100, 0), netDelta: 0, netVega: 0, coverage: { ...coverage(2), gamma: { total: 2, included: 0 }, vega: { total: 2, included: 0 } } },
      { ...strikeRow(110, 20), coverage: { ...coverage(2), gamma: { total: 2, included: 1 } } },
      { ...strikeRow(120, 0), coverage: undefined },
    ] }));
    expect(shaped.strikes.nearSpot[0]).toMatchObject({ netGex: null, callGex: null, putGex: null, netDex: 0, netVega: null, status: { netGex: 'unmeasured', netDex: 'complete', netVega: 'unmeasured' } });
    // review: the route's gamma coverage is combined across the
    // two sides, so under partial coverage a side can be an unmeasured zero
    // (four expirations with no call gammas and usable put gammas: callGex
    // 0, putGex -40000, coverage 4/8). The sides go out only when the
    // row's gamma coverage is complete or empty; the partial net stays.
    expect(shaped.strikes.nearSpot[1]).toMatchObject({ netGex: 20, callGex: null, putGex: null, status: { netGex: 'partial' }, coverage: { gamma: { total: 2, included: 1 } } });
    expect(shaped.strikes.nearSpot[2]).toMatchObject({ netGex: null, netDex: null, netVega: null, status: { netGex: 'unknown' } });
  });

  it('keeps coverage and all forty requested strikes through the actual wire budget', async () => {
    const byStrike = Array.from({ length: 1_600 }, (_, i) => ({
      ...strikeRow(50 + i * 0.5, i * Math.PI * 1e10),
      netDelta: -i * Math.PI * 1e11, netVega: i * Math.PI * 1e8,
      coverage: coverage(824, 823),
    }));
    const shaped = summarizeDealerPositioning(live({ byStrike }), { strikeRange: 40 });
    expect(shaped.strikes.total).toBe(1_600);
    expect(shaped.strikes.nearSpot).toHaveLength(40);
    expect(new TextEncoder().encode(JSON.stringify(shaped)).byteLength).toBeLessThan(50 * 1024);
    const result = await toolHandler(async () => shaped)({});
    const wire = result.structuredContent as typeof shaped;
    expect(wire.strikes.nearSpot).toHaveLength(40);
    expect(wire.strikes.nearSpot[0].status.netGex).toBe('partial');
    expect(wire.coverage.gamma).toMatchObject({ status: 'complete' });
    expect((wire as any).responseBudget).toBeUndefined();
  });

  it('caps at 150 rows and drops the farthest to fit the row budget, saying so, on the worst-case rows', async () => {
    const budget: LiveRateLimit = { provider: 'tastytrade', limit: 120, remaining: 100, resetSeconds: 30 };
    async function throughTool(response: Record<string, unknown>) {
      const server = new McpServer({ name: 'dealer-wide-test', version: '1' });
      register(server, {
        get: async (path: string, _params?: Record<string, string>, onRateLimit?: (value: LiveRateLimit) => void) => {
          // the platform default answers methodology 1
          if (path === '/exposure/methodology') return { defaultMethodology: 1, stale: false };
          onRateLimit?.(budget);
          return response;
        },
      } as unknown as LiveApiClient);
      const client = new Client({ name: 'dealer-wide-consumer', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const result = await client.callTool({ name: 'get_live_dealer_positioning', arguments: { symbol: 'MU', strikeRange: 150 } });
        expect(result.isError).not.toBe(true);
        const wire = result.structuredContent as any;
        expect(JSON.parse((result.content as { type: string; text: string }[])[0].text)).toEqual(wire);
        expect(wire.rateLimit).toEqual(budget);
        expect(wire.guide.rateLimit).toMatch(/platform's own count/);
        expect(wire.guide.rowsLimited).toMatch(/farthest from spot first/);
        expect(wire.responseBudget).toBeUndefined();
        expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(49_152);
        return wire;
      } finally {
        await client.close();
        await server.close();
      }
    }
    // Partial coverage keeps every row's counts, and long decimals: the
    // largest rows this shaper emits. 5,000 asks past the cap.
    const byStrike = Array.from({ length: 1_600 }, (_, i) => ({
      ...strikeRow(50 + i * 0.5, i * Math.PI * 1e10),
      netDelta: -i * Math.PI * 1e11, netVega: i * Math.PI * 1e8,
      callOpenInterest: 123_456, putOpenInterest: 654_321,
      coverage: coverage(824, 823),
    }));
    const shaped = summarizeDealerPositioning(live({ byStrike }), { strikeRange: 5_000, rateLimit: budget });
    expect(shaped.strikes.limitedBySize).toBe(true);
    expect(shaped.strikes.nearSpot.length).toBeLessThan(150);
    expect(new TextEncoder().encode(JSON.stringify(shaped)).byteLength).toBeLessThanOrEqual(50 * 1024 - 2 * 1024);
    // What is kept is the nearest to spot (120): a contiguous run around it.
    const kept = shaped.strikes.nearSpot.map((r) => r.strike as number);
    const farthestKept = Math.max(...kept.map((k) => Math.abs(k - 120)));
    const nearerDropped = byStrike.filter((r) => Math.abs(r.strike - 120) < farthestKept && !kept.includes(r.strike));
    expect(nearerDropped).toEqual([]);
    const partialWire = await throughTool(live({ byStrike }));
    expect(partialWire.strikes).toEqual(shaped.strikes);
    expect(partialWire.guide).toEqual(shaped.guide);

    const complete = byStrike.map((r) => ({ ...r, strike: r.strike, netGamma: 1234.5, netDelta: -2345.6, netVega: 34.5, coverage: coverage(4, 4) }));
    const wide = summarizeDealerPositioning(live({ byStrike: complete }), { strikeRange: 5_000, rateLimit: budget }) as any;
    expect(wide.strikes.nearSpot.length).toBeGreaterThan(shaped.strikes.nearSpot.length);
    expect(wide.strikes.nearSpot.length).toBeGreaterThan(130);
    expect(wide.strikes.nearSpot.length).toBeLessThanOrEqual(150);
    expect(wide.strikes.nearSpot.length < 150).toBe(wide.strikes.limitedBySize);
    expect(wide.guide.rowsLimited !== undefined).toBe(wide.strikes.limitedBySize);
    expect(wide.strikes.nearSpot[0]).not.toHaveProperty('coverage');
    const completeWire = await throughTool(live({ byStrike: complete }));
    expect(completeWire.strikes).toEqual(wide.strikes);
    expect(completeWire.guide).toEqual(wide.guide);
  });

  it('takes every strike within a percent of spot, up to the cap', () => {
    const byStrike = Array.from({ length: 81 }, (_, i) => strikeRow(100 + i * 0.5, 10));
    // Spot 120, 5%: 114 to 126, 25 strikes at 0.5 apart.
    const shaped = summarizeDealerPositioning(live({ byStrike }), { strikeWindowPct: 5 });
    expect(shaped.strikes.inWindow).toBe(25);
    expect(shaped.strikes.windowPct).toBe(5);
    expect(shaped.strikes.nearSpot.map((r) => r.strike)).toEqual(Array.from({ length: 25 }, (_, i) => 114 + i * 0.5));
    const capped = summarizeDealerPositioning(live({ byStrike }), { strikeWindowPct: 5, strikeRange: 5 });
    expect(capped.strikes.nearSpot.map((r) => r.strike)).toEqual([119, 119.5, 120, 120.5, 121]);
    expect(capped.strikes.inWindow).toBe(25);
    // Without it, no window is reported.
    expect(summarizeDealerPositioning(live({ byStrike })).strikes).toMatchObject({ windowPct: null, inWindow: null });
 
    // A strike exactly on the edge is inside, whatever the subtraction
    // rounds to (6 - 4.8 is 1.2000000000000002 > 1.2).
    // And a strike just past an edge that is not on the cent grid stays out
    // (100 at 9.99999995% ends at 109.99999995, short of 110).
    for (const [spot, strikes, pct, inside] of [
      [4.8, [5, 6], 25, [5, 6]],
      [10.2, [10, 15.3, 15.31], 50, [10, 15.3]],
      [100, [100, 110], 9.99999995, [100]],
      [100, [100, 110], 10, [100, 110]],
      [0.35, [0.3, 0.4, 0.45], 14.285714285714286, [0.3, 0.4]],
      [5123.45, [4611.1, 4611.11, 5635.79, 5635.8], 10, [4611.11, 5635.79]],
    ] as const) {
      const edge = summarizeDealerPositioning(
        live({ snapshot: { ...live().snapshot, spotPrice: spot }, byStrike: strikes.map((k) => strikeRow(k, 10)) }),
        { strikeWindowPct: pct },
      );
      expect(edge.strikes.nearSpot.map((r) => r.strike)).toEqual([...inside]);
      expect(edge.strikes.inWindow).toBe(inside.length);
    }
  });

  it('takes every strike inside a delta band, on any expiration, up to the cap', () => {
    // Spot 120; call delta falls 0.02 a strike from 0.9 at 100, one expiration.
    const deltaRow = (k: number, call: number | null, put: number | null) => ({
      ...strikeRow(k, 10), deltasByExpiration: [{ expiration: '2026-09-18', call, put }],
    });
    const byStrike = Array.from({ length: 41 }, (_, i) => {
      const call = Math.round((0.9 - i * 0.02) * 100) / 100;
      return deltaRow(100 + i, call > 0 ? call : null, call > 0 ? Math.round((call - 1) * 100) / 100 : null);
    });
    // 0.2 to 0.8: strikes 105 (0.8) to 135 (0.2).
    const shaped = summarizeDealerPositioning(live({ byStrike, expirations: ['2026-09-18'] }), { strikeWindowDelta: 0.2 });
    expect(shaped.strikes.deltaBand).toBe(0.2);
    expect(shaped.strikes.windowPct).toBeNull();
    expect(shaped.strikes.inWindow).toBe(31);
    expect(shaped.strikes.nearSpot.map((r) => r.strike)).toEqual(Array.from({ length: 31 }, (_, i) => 105 + i));
    // One expiration: each row carries its deltas.
    const at = (k: number) => shaped.strikes.nearSpot.find((r) => r.strike === k)!;
    expect(at(110)).toMatchObject({ callDelta: 0.7, putDelta: -0.3 });
    // The cap still takes the strikes nearest spot.
    const capped = summarizeDealerPositioning(live({ byStrike, expirations: ['2026-09-18'] }), { strikeWindowDelta: 0.2, strikeRange: 3 });
    expect(capped.strikes.nearSpot.map((r) => r.strike)).toEqual([119, 120, 121]);
    expect(capped.strikes.inWindow).toBe(31);
    // Without it, no band is reported.
    expect(summarizeDealerPositioning(live({ byStrike })).strikes).toMatchObject({ deltaBand: null, inWindow: null });
  });

  it('keeps a strike any expiration prices inside the band, and publishes no single delta over several', () => {
    const two = (k: number, near: number | null, far: number | null) => ({
      ...strikeRow(k, 10),
      deltasByExpiration: [
        { expiration: '2026-09-18', call: near, put: null },
        { expiration: '2026-09-25', call: far, put: null },
      ],
    });
    const shaped = summarizeDealerPositioning(live({
      expirations: ['2026-09-18', '2026-09-25'],
      byStrike: [
        two(118, 0.6, 0.55), two(130, 0.05, 0.15), two(140, 0.01, 0.04), strikeRow(125, 10),
        // Listed on the far expiration only: one entry, still not the window's one delta.
        { ...strikeRow(121, 10), deltasByExpiration: [{ expiration: '2026-09-25', call: 0.45, put: -0.55 }] },
      ],
    }), { strikeWindowDelta: 0.1 });
    // 130 qualifies on the far expiration; 140 on neither; 125 carries no deltas.
    expect(shaped.strikes.nearSpot.map((r) => r.strike)).toEqual([118, 121, 130]);
    expect(shaped.strikes.inWindow).toBe(3);
    for (const row of shaped.strikes.nearSpot) expect(row).toMatchObject({ callDelta: null, putDelta: null });
  });

  it('publishes no per-row delta without a delta published, or on a route that sent none', () => {
    const shaped = summarizeDealerPositioning(live({
      expirations: ['2026-09-18'],
      byStrike: [
        { ...strikeRow(120, 10), deltasByExpiration: [{ expiration: '2026-09-18', call: null, put: -0.5 }] },
        strikeRow(121, 10),
        { ...strikeRow(122, 10), deltasByExpiration: [{ expiration: '2026-09-18', call: 'x', put: 7 }] },
      ],
    }));
    const at = (k: number) => shaped.strikes.nearSpot.find((r) => r.strike === k)!;
    expect(at(120)).toMatchObject({ callDelta: null, putDelta: -0.5 });
    expect(at(121)).toMatchObject({ callDelta: null, putDelta: null });
    expect(at(122)).toMatchObject({ callDelta: null, putDelta: null });
  });

  it('decides the window on the decimals, including ones that print in exponent form', () => {
    // String(1e-7) is '1e-7'; 1e-7 percent of 100 is 1e-7.
    expect(withinPercent(100.0000001, 100, 1e-7)).toBe(true);
    expect(withinPercent(100.0000002, 100, 1e-7)).toBe(false);
    expect(withinPercent(99.9999999, 100, 1e-7)).toBe(true);
    expect(withinPercent(6, 4.8, 25)).toBe(true);
    expect(withinPercent(110, 100, 9.99999995)).toBe(false);
  });

  it('returns the walls\' and the magnet\'s own rows when they sit outside the returned rows', () => {
    // live(): call wall 130, put wall 110, magnet (absGamma) 125, spot 120.
    const byStrike = [100, 110, 118, 120, 122, 125, 130, 140].map((k) => strikeRow(k, 10));
    const shaped = summarizeDealerPositioning(live({ byStrike }), { strikeRange: 3 });
    expect(shaped.strikes.nearSpot.map((r) => r.strike)).toEqual([118, 120, 122]);
    expect(shaped.strikes.atLevels.map((r) => [r.strike, r.levels])).toEqual([
      [110, ['putWall']], [125, ['gammaMagnet']], [130, ['callWall']],
    ]);
    expect(shaped.strikes.atLevels[2]).toMatchObject({ callGex: 10, putGex: -5 });
    // A level already among the rows is not repeated.
    const wider = summarizeDealerPositioning(live({ byStrike }), { strikeRange: 8 });
    expect(wider.strikes.atLevels).toEqual([]);
  });

  it('survives an empty or malformed response without throwing', () => {
    for (const response of [{}, { snapshot: null }, { byStrike: 'nope' }, { snapshot: { spotPrice: 'x' } }]) {
      expect(() => summarizeDealerPositioning(response as any)).not.toThrow();
    }
    const shaped = summarizeDealerPositioning({} as any);
    expect(shaped.spotPrice).toBeNull();
    expect(shaped.levels.gammaFlip).toBeNull();
    expect(shaped.strikes.nearSpot).toEqual([]);
  });

  it('keeps every key it emits past the shared wire sanitizer', () => {
    // The sanitizer strips and renames a fixed set of key names globally, and a
    // shaper cannot see that by reading its own file.
    const shaped = summarizeDealerPositioning(live());
    // Cloned FIRST: comparing against the same object the sanitizer was handed
    // passes trivially if it edits in place.
    const expected = structuredClone(shaped);
    expect(sanitizeMcpWireOutput(shaped as Record<string, unknown>)).toEqual(expected as Record<string, unknown>);
  });
});

describe('gamma flip method disclosure', () => {
  it('tells a reader when the flip rests on a frozen gamma', () => {
    // A leg with no IV cannot be repriced, so its gamma is held constant across
    // the sweep. That is a real approximation - dropping one leg's IV turned
    // "no flip" into a level - and "complete" coverage alone hides it.
    const shaped = summarizeDealerPositioning(live({
      coverage: {
        strikes: 400, strikesWithGamma: 400, strikesWithDelta: 400,
        gamma: { total: 400, included: 400 }, delta: { total: 400, included: 400 },
        vega: { total: 400, included: 400 }, vanna: { total: 400, included: 400 },
        charm: { total: 400, included: 400 }, vomma: { total: 400, included: 400 },
        gammaFlip: { total: 400, included: 400 },
        gammaFlipMethod: 'frozen-gamma',
      },
    }) as any);

    expect((shaped.coverage as any).gammaFlipMethod).toBe('frozen-gamma');
  });

  it('carries the step the flip was found at, and says what it costs', () => {
    // Resolution is the sampled bracket's width, not a confidence interval.
    const shaped = summarizeDealerPositioning(live() as any);

    expect((shaped.coverage as any).gammaFlipResolution).toBe(0.0185);
    expect(shaped.limitations.some((line) => line.includes('0.0185') && line.includes('sampled root')))
      .toBe(true);
    expect(shaped.limitations.join(' ')).toMatch(/can be missed/);
    expect(shaped.limitations.join(' ')).not.toMatch(/is invisible|are invisible/);
  });

  it('says the step is unknown rather than implying an exact level', () => {
    const shaped = summarizeDealerPositioning(live({
      coverage: { ...coverage(), gammaFlipResolution: null },
    }) as any);

    expect((shaped.coverage as any).gammaFlipResolution).toBeNull();
    expect(shaped.limitations.some((line) => line.includes('not reported'))).toBe(true);
  });

  it('keeps the bounded-search caveat when no flip was found', () => {
    const shaped = summarizeDealerPositioning(live({
      coverage: { ...coverage(), gammaFlipSearchStatus: 'not-found' },
      snapshot: { spotPrice: 120, netGamma: 140_000, gammaFlip: null, topStrikes: [] },
    }) as any);

    expect(shaped.levels.gammaFlip).toBeNull();
    expect(shaped.coverage.gammaFlipResolution).toBeNull();
    expect(shaped.coverage.gammaFlipSearchStatus).toBe('not-found');
    expect(shaped.limitations.some((line) => line.includes('sampled root'))).toBe(false);
    expect(shaped.limitations.join(' ')).toMatch(/20%/);
    expect(shaped.limitations.join(' ')).toMatch(/can be missed/);
    expect(shaped.limitations.join(' ')).toMatch(/does not prove/);
  });

  it('names the expirations whose open interest the broker did not publish, says why the levels are withheld, and reports no flip search that never ran', () => {
    // All-broker live run: Schwab's SPX window, 0 of 1,868 legs, every level
    // null and a "not-found" flip over a search that never ran.
    const shaped = summarizeDealerPositioning(live({
      expirations: ['2026-10-05', '2026-10-06'],
      openInterestUnpublishedExpirations: ['2026-10-05', '2026-10-06'],
      coverage: { ...coverage(), gamma: { total: 1868, included: 0 }, gammaFlip: { total: 1868, included: 0 }, gammaFlipSearchStatus: undefined },
      snapshot: { spotPrice: 7722.72, netGamma: 0, gammaFlip: null, topStrikes: [] },
    }) as any);
    expect(shaped.window.openInterestUnpublishedExpirations).toEqual(['2026-10-05', '2026-10-06']);
    expect(shaped.coverage.gammaFlipSearchStatus).toBeNull();
    expect(shaped.limitations.join(' ')).toContain('The broker published no open interest for 2026-10-05 and 2026-10-06 (a zero on every contract, as Schwab prints on index options), so their legs are excluded and a level they feed is withheld for incomplete coverage (`levelStatus` says which); the expected moves are priced from quotes and are unaffected.');
    const plain = summarizeDealerPositioning(live({}) as any);
    expect(plain.window.openInterestUnpublishedExpirations).toBeUndefined();
    expect(plain.limitations.join(' ')).not.toContain('published no open interest');
  });

  it('says what a stale spot skews when the broker\'s spot printed before the last session\'s open, and nothing otherwise', () => {
    // Broker re-run: Public's 03:59 print put the at-the-money pair and the
    // straddles three points low; only resolved.S carried the flag.
    const stale = summarizeDealerPositioning(live({ resolved: { S: { value: 767.22, source: 'broker-public', asOf: '2026-10-02T07:59:57.000Z', stale: true } } }) as any);
    expect(stale.limitations).toContain("The spot printed before the last session's open (resolved.S.asOf, the broker's own time), so the levels' distances from spot, the at-the-money straddles and the split at spot are read against a stale price.");
    const fresh = summarizeDealerPositioning(live({ resolved: { S: { value: 769.64, source: 'broker-tradier', asOf: '2026-10-03T00:00:00.004Z', stale: false } } }) as any);
    expect(fresh.limitations.join(' ')).not.toContain('stale price');
    expect(summarizeDealerPositioning(live({}) as any).limitations.join(' ')).not.toContain('stale price');
  });

  it('distinguishes an unresolved search from a measured absence of a crossing', () => {
    const shaped = summarizeDealerPositioning(live({
      coverage: { ...coverage(), gammaFlipSearchStatus: 'unresolved', gammaFlipResolution: null },
      snapshot: { ...live().snapshot, gammaFlip: null },
    }));

    expect(shaped.coverage.gammaFlipSearchStatus).toBe('unresolved');
    expect(shaped.levels.gammaFlip).toBeNull();
    expect(shaped.coverage.gammaFlipResolution).toBeNull();
    expect(shaped.limitations.join(' ')).toMatch(/unresolved/);
    expect(shaped.limitations.join(' ')).toMatch(/numerical/);
  });

  it('clears the resolution of a flip withheld by incomplete or unknown coverage', () => {
    for (const gammaFlip of [{ total: 3, included: 2 }, { total: 3, included: 0 }, undefined]) {
      const shaped = summarizeDealerPositioning(live({
        coverage: { ...coverage(), gammaFlip },
      }));
      expect(shaped.levels.gammaFlip).toBeNull();
      expect(shaped.coverage.gammaFlipResolution).toBeNull();
      expect(shaped.limitations.some((line) => line.includes('0.0185'))).toBe(false);
    }
  });

  it('keeps a missing or invalid search status unknown', () => {
    for (const gammaFlipSearchStatus of [undefined, null, 'complete', '', 1, {}]) {
      const shaped = summarizeDealerPositioning(live({
        coverage: { ...coverage(), gammaFlipSearchStatus },
      }));
      expect(shaped.coverage.gammaFlipSearchStatus).toBeNull();
      expect(shaped.levels.gammaFlip).toBe(118.5);
    }
  });

  it('does not quote a nonpositive or nonfinite resolution as a search step', () => {
    for (const gammaFlipResolution of [0, -0.02, NaN, Infinity]) {
      const shaped = summarizeDealerPositioning(live({
        coverage: { ...coverage(), gammaFlipResolution },
      }));
      expect(shaped.coverage.gammaFlipResolution).toBeNull();
      expect(shaped.limitations.join(' ')).toMatch(/not reported/);
    }
  });

  it('passes the method through unchanged when everything was repriced', () => {
    const shaped = summarizeDealerPositioning(live({
      coverage: {
        strikes: 1, strikesWithGamma: 1, strikesWithDelta: 1,
        gamma: { total: 1, included: 1 }, delta: { total: 1, included: 1 },
        vega: { total: 1, included: 1 }, vanna: { total: 1, included: 1 },
        charm: { total: 1, included: 1 }, vomma: { total: 1, included: 1 },
        gammaFlip: { total: 1, included: 1 }, gammaFlipMethod: 'repriced',
      },
    }) as any);
    expect((shaped.coverage as any).gammaFlipMethod).toBe('repriced');
  });
});

describe('inDeltaBand', () => {
  it('a call delta from d to 1-d or a put delta from -(1-d) to -d qualifies, ends included', () => {
    expect(inDeltaBand([{ expiration: 'x', call: 0.1, put: null }], 0.1)).toBe(true);
    expect(inDeltaBand([{ expiration: 'x', call: 0.9, put: null }], 0.1)).toBe(true);
    expect(inDeltaBand([{ expiration: 'x', call: null, put: -0.1 }], 0.1)).toBe(true);
    expect(inDeltaBand([{ expiration: 'x', call: null, put: -0.9 }], 0.1)).toBe(true);
    expect(inDeltaBand([{ expiration: 'x', call: 0.09, put: -0.91 }], 0.1)).toBe(false);
    expect(inDeltaBand([{ expiration: 'x', call: 0.95, put: -0.05 }], 0.1)).toBe(false);
  });

  it('the far end of the band is compared as the decimals printed, not as 1 - d in binary', () => {
    // 1 - 0.07 is 0.9299999999999999 in binary, below a printed 0.93.
    expect(inDeltaBand([{ expiration: 'x', call: 0.93, put: null }], 0.07)).toBe(true);
    expect(inDeltaBand([{ expiration: 'x', call: null, put: -0.93 }], 0.07)).toBe(true);
    expect(inDeltaBand([{ expiration: 'x', call: 0.67, put: null }], 0.33)).toBe(true);
    expect(inDeltaBand([{ expiration: 'x', call: 0.9300001, put: null }], 0.07)).toBe(false);
  });

  it('either leg qualifies the strike on its own', () => {
    expect(inDeltaBand([{ expiration: 'x', call: 0.05, put: -0.2 }], 0.1)).toBe(true);
    expect(inDeltaBand([{ expiration: 'x', call: 0.3, put: -0.97 }], 0.1)).toBe(true);
  });

  it('a strike qualifies when any one expiration prices it inside the band', () => {
    const entries = [
      { expiration: '2026-10-02', call: 0.03, put: -0.97 },
      { expiration: '2026-11-20', call: 0.18, put: -0.82 },
    ];
    expect(inDeltaBand(entries, 0.1)).toBe(true);
    expect(inDeltaBand(entries, 0.2)).toBe(false);
  });

  it('no usable delta on any expiration does not qualify', () => {
    expect(inDeltaBand([], 0.1)).toBe(false);
    expect(inDeltaBand([{ expiration: 'x', call: null, put: null }], 0.1)).toBe(false);
  });
});

// A window date the broker answered with no contracts, and rows left out, are said.
describe('a partial window', () => {
  const OMITTED = { total: 2, quarantined: 0, invalidStrike: 0, notSuccess: 0, unquoted: 2 };
  it('carries partial, emptyExpirations and omittedRows on the window, per expiration, and says them in limitations', () => {
    const shaped: any = summarizeDealerPositioning(live({
      partial: true,
      emptyExpirations: ['2026-09-25'],
      omittedRows: OMITTED,
      byExpiration: [{ expiration: '2026-09-18', daysToExpiration: 8, netGamma: 1, netDelta: 1, coverage: { gamma: { total: 2, included: 2 }, delta: { total: 2, included: 2 } }, omittedRows: OMITTED }],
    }));
    expect(shaped.window).toMatchObject({ partial: true, emptyExpirations: ['2026-09-25'], omittedRows: OMITTED });
    expect(shaped.byExpiration[0].omittedRows).toEqual(OMITTED);
    expect(shaped.limitations.some((l: string) => l.includes('2026-09-25'))).toBe(true);
    expect(shaped.limitations.some((l: string) => /2 rows that could not be used/.test(l))).toBe(true);
  });

  it('a complete window carries none of it (control)', () => {
    const shaped: any = summarizeDealerPositioning(live());
    expect(shaped.window.partial).toBeUndefined();
    expect(shaped.window.emptyExpirations).toBeUndefined();
    expect(shaped.window.omittedRows).toBeUndefined();
  });
});

// Review: "Adjusted-only expirations are mislabeled as the base
// symbol": a window date listed only under an adjusted series (AAPL1, a
// different deliverable) has nothing of the symbol's own to count. The proxy
// leaves it out; the window and the date name the roots, and the limitations say so.
describe('adjusted series left out of the window', () => {
  it('carries excludedRoots on the window and on each date that names them, and says so', () => {
    const shaped: any = summarizeDealerPositioning(live({
      excludedRoots: [{ root: 'AAPL1', contracts: 12 }],
      snapshot: { ...live().snapshot, gammaFlip: null },
      coverage: { ...coverage(), gammaFlipSearchStatus: 'not-found' },
      byExpiration: [
        { expiration: '2026-09-18', daysToExpiration: 8, netGamma: 1, netDelta: 1, coverage: { gamma: { total: 2, included: 2 }, delta: { total: 2, included: 2 } } },
        { expiration: '2026-09-25', daysToExpiration: 15, netGamma: 0, netDelta: 0, coverage: { gamma: null, delta: null }, excludedRoots: [{ root: 'AAPL1', contracts: 12 }] },
      ],
    }));
    expect(shaped.window.excludedRoots).toEqual([{ root: 'AAPL1', contracts: 12 }]);
    expect(shaped.byExpiration.map((entry: any) => entry.excludedRoots)).toEqual([undefined, [{ root: 'AAPL1', contracts: 12 }]]);
    expect(shaped.limitations).toContain('12 contracts under the AAPL1 root (an adjusted series, a different deliverable at the same strikes) are left out of the totals, the levels and their coverage, which measure the symbol\'s own contracts alone, so "complete" there does not include them; `byExpiration` names the dates.');
    expect(shaped.coverage.gammaFlip).toEqual({ total: 824, included: 824, status: 'complete' });
    expect(shaped.guide.flipMethod).toContain('complete means every counted leg entered it');
    expect(shaped.guide.levelStatus).toContain('complete coverage (every counted leg entered the search)');
  });

  it('a window that left nothing out names nothing (control)', () => {
    const shaped: any = summarizeDealerPositioning(live());
    expect(shaped.window.excludedRoots).toBeUndefined();
    expect(shaped.limitations.some((l: string) => /adjusted series/.test(l))).toBe(false);
    expect(shaped.byExpiration.every((entry: any) => entry.excludedRoots === undefined)).toBe(true);
  });
});

// Review: on a date listed under several roots the
// straddle is one series' (the primary), and the proxy names it.
describe('the straddle\'s series on a date under several roots', () => {
  const entry = (move: Record<string, unknown>) => ({
    expiration: '2026-10-16', daysToExpiration: 4, netGamma: 1, netDelta: 1,
    coverage: { gamma: { total: 2, included: 2 }, delta: { total: 2, included: 2 } },
    expectedMove: { strike: 6500, callMid: 30, putMid: 31, straddle: 61, pctOfSpot: 0.0094, lower: 6439, upper: 6561, atmIv: 0.14, ivOneSigma: 60, ...move },
  });
  it('carries expectedMove.root where the proxy names it, and none otherwise', () => {
    const shaped: any = summarizeDealerPositioning(live({ byExpiration: [entry({ root: 'SPXW' }), { ...entry({}), expiration: '2026-10-23' }] }));
    expect(shaped.byExpiration[0].expectedMove).toMatchObject({ straddle: 61, root: 'SPXW' });
    expect(shaped.byExpiration[1].expectedMove).not.toHaveProperty('root');
  });
});

describe('summarizeDealerPositioning guide', () => {
  const BUDGET = { limit: 120, remaining: 100, resetSeconds: 30, provider: 'tastytrade' };
  const d = (over: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) => summarizeDealerPositioning(live(over), opts as any) as any;
  const g = (over: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) => d(over, opts).guide as Record<string, string>;
  const entry = (over: Record<string, unknown> = {}) => ({
    expiration: '2026-09-18', daysToExpiration: 8, netGamma: 100, netDelta: -10, callGamma: 120, putGamma: -20, grossGamma: 140,
    shareOfGrossGamma: 0.4, coverage: { gamma: { total: 10, included: 10 }, delta: { total: 10, included: 10 } },
    expectedMove: { strike: 120, callMid: 2, putMid: 2.1, straddle: 4.1, pctOfSpot: 0.034, lower: 115.9, upper: 124.1, atmIv: 0.3, ivOneSigma: 5.1 },
    expectedMoveUnavailable: null, events: { earningsOnOrBefore: null, exDividendOnOrBefore: null }, ...over,
  });
  const snap = (over: Record<string, unknown>) => ({ snapshot: { ...live().snapshot, ...over } });

  it('exposure: the charm sign and the GEX sign convention with the squeeze caveat, always - netCharm null too', () => {
    for (const x of [g(), g(snap({ netCharm: null }))]) {
      expect(x.exposure).toMatch(/remaining-maturity sign/);
      expect(x.exposure).toMatch(/call gamma positive and put gamma negative/);
      expect(x.exposure).toMatch(/open interest does not say who holds/);
    }
  });

  it('walls, always', () => {
    expect(g().walls).toMatch(/largest positive call gamma/);
    expect(g().walls).toMatch(/put wall can sit above the call wall/);
  });

  it('levelStatus, always; the null-over-complete clause only beside a null flip with complete coverage', () => {
    expect(g().levelStatus).toMatch(/required coverage, not whether a level was found/);
    expect(g().levelStatus).not.toMatch(/over complete coverage/);
    const nullFlip = g({ ...snap({ gammaFlip: null }), coverage: { ...coverage(), gammaFlipSearchStatus: 'not-found' } });
    expect(nullFlip.levelStatus).toMatch(/null over complete coverage/);
  });

  it('dealerRegime: always; neutral and null explained when they occur', () => {
    expect(g().dealerRegime).toMatch(/interpolated at spot/);
    expect(g().dealerRegime).toMatch(/not the sign of netGex nor which side of gammaFlip/);
    expect(g().dealerRegime).not.toMatch(/"neutral"/);
    expect(g(snap({ regime: 'neutral' })).dealerRegime).toMatch(/"neutral"/);
    expect(g({ ...snap({ regime: null, netGamma: null }) }).dealerRegime).toMatch(/not established/);
  });

  it('magnet and concentration: what each is, always', () => {
    expect(g().magnet).toMatch(/largest absolute net gamma/);
    expect(g().concentration).toMatch(/Herfindahl/);
  });

  it('flipMethod: the method, the held-gamma caveat on frozen-gamma or mixed, an unreported method', () => {
    const repriced = g({ coverage: { ...coverage(), gammaFlipMethod: 'repriced' } }).flipMethod;
    expect(repriced).toMatch(/every leg recomputed from IV/);
    expect(repriced).not.toMatch(/approximation/);
    const mixed = g({ coverage: { ...coverage(), gammaFlipMethod: 'mixed' } }).flipMethod;
    expect(mixed).toContain('some legs were repriced from their IV and the rest held their published gamma.');
    expect(mixed).toMatch(/approximation/);
    const frozen = g({ coverage: { ...coverage(), gammaFlipMethod: 'frozen-gamma' } }).flipMethod;
    expect(frozen).toContain('no leg had a usable IV, so every published gamma was held constant.');
    expect(frozen).toMatch(/approximation/);
    expect(g().flipMethod).toMatch(/reported no method/);
    expect(g().flipMethod).toMatch(/counts every leg that entered the sweep, repriced or held/);
  });

  it('flipSearch: only when the search status is null', () => {
    expect(g().flipSearch).toBeUndefined();
    expect(g({ coverage: { ...coverage(), gammaFlipSearchStatus: null } }).flipSearch).toMatch(/no leg entered the search/);
  });

  it('rows: on any returned row, the delta clause by the window\'s expiration count', () => {
    expect(g().rows).toMatch(/complete or empty/);
    expect(g().rows).toMatch(/over several expirations/i);
    expect(g({ expirations: ['2026-09-18'] }).rows).toMatch(/broker's per-contract deltas/);
    expect(g({ byStrike: [] }).rows).toBeUndefined();
  });

  it('rowsAtLevels: when a wall or the magnet is set', () => {
    expect(g().rowsAtLevels).toMatch(/strikes.atLevels/);
    expect(g(snap({ callWall: null, putWall: null, absGamma: null })).rowsAtLevels).toBeUndefined();
  });

  it('inWindow with a window, and: a percent window with no spot is not applied', () => {
    expect(g().inWindow).toBeUndefined();
    expect(g({}, { strikeWindowPct: 10 }).inWindow).toMatch(/exceeds strikes.returned/);
    expect(g({}, { strikeWindowPct: 10 }).windowPctNoSpot).toBeUndefined();
    expect(g(snap({ spotPrice: null }), { strikeWindowPct: 10 }).windowPctNoSpot).toMatch(/not applied/);
  });

  it('byExpiration and expectedMove: with entries; the reason codes beside a null move', () => {
    expect(g().byExpiration).toBeUndefined();
    const withEntries = g({ byExpiration: [entry()] });
    expect(withEntries.byExpiration).toMatch(/computed alone/);
    expect(withEntries.byExpiration).toContain("shareOfGrossGex is its share of the window's gross gamma (gamma only, not a share of netCharm), published");
    expect(withEntries.byExpiration).not.toMatch(/0DTE concentration/);
    expect(withEntries.expectedMove).toMatch(/not a forecast/);
    expect(withEntries.expectedMove).toMatch(/about 0.8 of it/);
    expect(withEntries.expectedMove).not.toMatch(/atm-quote-missing/);
    const missing = g({ byExpiration: [entry({ expectedMove: null, expectedMoveUnavailable: 'atm-quote-missing' })] });
    expect(missing.expectedMove).toMatch(/atm-quote-missing/);
  });

  it('events beside an events object; eventsUnread beside a null one', () => {
    const read = g({ events: { from: '2026-09-10', through: '2026-11-20', earnings: [], exDividends: [] }, byExpiration: [entry()] });
    expect(read.events).toMatch(/none on file, not none scheduled/);
    expect(read.eventsUnread).toBeUndefined();
    expect(g({ events: null }).eventsUnread).toMatch(/could not be read/);
  });

  it('roots: a straddle naming its root, or an entry with no straddle', () => {
    expect(g({ byExpiration: [entry()] }).roots).toBeUndefined();
    expect(g({ byExpiration: [entry({ expectedMove: { ...entry().expectedMove, root: 'SPXW' } })] }).roots).toMatch(/never merged/);
  });

  it('the window: the strike counts and the moving window always; the 4:15 roll on a default window', () => {
    expect(g().strikeCounts).toMatch(/strikesUsed/);
    expect(g().windowMoves).toMatch(/different books/);
    expect(g({ expirationSelection: 'nearest' }).windowRoll).toMatch(/4:15 PM New York/);
    expect(g({ expirationSelection: 'requested' }).windowRoll).toBeUndefined();
  });

  it('timing: the clock always, Tradier\'s hourly Greeks and moomoo\'s delay by provider', () => {
    expect(g().clock).toMatch(/wall clock/);
    expect(g().cache).toMatch(/per proxy instance/);
    expect(g().tradierGreeks).toBeUndefined();
    expect(g({ provider: 'tradier' }).tradierGreeks).toMatch(/hourly/);
    expect(g().moomooDelay).toBeUndefined();
    expect(g({ provider: 'moomoo' }).moomooDelay).toMatch(/15 minutes/);
  });

  it('sameDay on a same-day entry; sameDayNamed on a named same-day book', () => {
    expect(g({ byExpiration: [entry()] }).sameDay).toBeUndefined();
    expect(g({ byExpiration: [entry({ daysToExpiration: 0 })] }).sameDay).toMatch(/one minute before the engine's close/);
    expect(g({ byExpiration: [entry({ daysToExpiration: 0 })] }).sameDayNamed).toBeUndefined();
    expect(g({ expirationSelection: 'requested', byExpiration: [entry({ daysToExpiration: 0 })] }).sameDayNamed).toMatch(/expired legs are inside/);
  });

  it('the lines models misread say what they do not mean', () => {
    const same = g({ byExpiration: [entry({ daysToExpiration: 0 })] }).sameDay!;
    expect(same).toMatch(/netCharm is not split by expiration; over several expirations this answer does not show its same-day share; as general possibilities, not a reading of this answer:/);
    expect(same).toMatch(/narrows onto their strikes until one minute before that close and holds that shape after it \(4:15 PM is the default-window cutoff, not a repricing boundary/);
    expect(g().concentration).toMatch(/its inverse is the effective number of equally weighted strikes, so it reads about 1 over the number of strikes only when gamma is spread evenly/);
    for (const m of ['repriced', 'frozen-gamma', 'mixed']) {
      expect(g({ coverage: { ...coverage(), gammaFlipMethod: m } }).flipMethod).toContain(`The flip method (coverage.gammaFlipMethod, not a coverage status) is "${m}":`);
    }
    expect(g({ events: null }).eventsUnread).toMatch(/could not be read - unknown, not no events;/);
    expect(g({ events: null }).eventsUnread).toMatch(/a separate dividends or earnings lookup lists only the dates on file, so finding none there does not show that none is scheduled/);
  });

  it('the same-day totals, empty event lists, held gamma over complete coverage', () => {
    const same = g({ byExpiration: [entry({ daysToExpiration: 0 })] }).sameDay!;
    expect(same).toMatch(/^On same-day legs, vanna, charm and vomma change sharply with small spot moves and time to expiry: one netCharm reading is not a steady rate into the close\. A same-day expiration's legs leave vanna, charm and vomma one minute before the engine's close for that date \(4:00 PM New York on a regular day\) and stay in gamma, delta and vega; the expiration itself stays in the default window until 4:15 PM New York, so from then until 4:15 those three totals neither include nor move with its legs\. netCharm is not split by expiration/);
    expect(same).toMatch(/not a reading of this answer: charm near the money can be the largest term in the book, a same-day leg's vanna changes sign near its strike, and on an expiration afternoon netCharm can be mostly the same-day legs and the clock\./);
    expect(same).not.toMatch(/1:00 PM|early close/);
    const read = g({ events: { from: '2026-09-10', through: '2026-11-20', earnings: [], exDividends: [] }, byExpiration: [entry()] }).events!;
    expect(read).toMatch(/the top-level events lists the dates on file from `from` through `through`\. An empty list or a null date means none on file, not none scheduled:/);
    expect(read).toMatch(/so for a fund or ETF an empty or null events answer says little\.$/);
    for (const m of ['frozen-gamma', 'mixed']) {
      const line = g({ coverage: { ...coverage(), gammaFlipMethod: m } }).flipMethod!;
      expect(line).toMatch(/can materially move the level or create one where there was none, even over complete coverage\./);
      expect(line).not.toMatch(/whatever the coverage/);
    }
    expect(g({ coverage: { ...coverage(), gammaFlipMethod: 'repriced' } }).flipMethod).toMatch(/coverage\.gammaFlip counts every leg that entered the sweep, repriced or held: complete means every counted leg entered it, and it can read complete under "mixed" or "frozen-gamma"; the method, not the count, says whether legs were repriced or held\./);
    const nullFlip = g({ ...snap({ gammaFlip: null }), coverage: { ...coverage(), gammaFlipSearchStatus: 'not-found' } });
    expect(nullFlip.levelStatus).toMatch(/Here gammaFlip's null over complete coverage \(every counted leg entered the search\) is a search result, not withheld, /);
    expect(nullFlip.levelStatus).toContain('and not proof of no flip: sampling within 20% of spot can miss two crossings in one interval or a crossing outside the range. See coverage.gammaFlipSearchStatus.');
  });

  it('the same-day lead carries its conclusion, and the null flip its caveat in the same sentence', () => {
    const same = g({ byExpiration: [entry({ daysToExpiration: 0 })] }).sameDay!;
    expect(same).toMatch(/^On same-day legs, vanna, charm and vomma change sharply with small spot moves and time to expiry: one netCharm reading is not a steady rate into the close\. A same-day expiration's legs leave/);
    const nullFlip = g({ ...snap({ gammaFlip: null }), coverage: { ...coverage(), gammaFlipSearchStatus: 'not-found' } });
    // lifted alone, "a search result, not withheld" dropped the caveat in the next sentence
    expect(nullFlip.levelStatus).toContain("Here gammaFlip's null over complete coverage (every counted leg entered the search) is a search result, not withheld, and not proof of no flip: sampling within 20% of spot can miss two crossings in one interval or a crossing outside the range. See coverage.gammaFlipSearchStatus.");
    expect(g().levelStatus).not.toMatch(/not proof of no flip/);
  });

  it('a found flip says it is the crossing nearest spot, in the guide', () => {
    // Keep the nearest-crossing rule in the guide alongside the other flip caveats.
    expect(g().levelStatus).toMatch(/gammaFlip is nearest to spot among crossings found by sampling; nearer or farther crossings may be missed\.$/);
    const nullFlip = g({ ...snap({ gammaFlip: null }), coverage: { ...coverage(), gammaFlipSearchStatus: 'not-found' } });
    expect(nullFlip.levelStatus).not.toMatch(/nearest to spot among crossings/);
  });

  it('legEligibility: on a partial or unmeasured metric', () => {
    expect(g().legEligibility).toBeUndefined();
    expect(g({ coverage: coverage(824, 800) }).legEligibility).toMatch(/which legs were summed/);
  });

  it('inputs: always the inputs line; the stored rate, the profile yield and the spot clock when they apply', () => {
    expect(g().inputs).toMatch(/never defaulted/);
    const resolved = { S: { value: 120, source: 'broker-moomoo', asOf: '2026-09-10T14:30:00Z', stale: false }, r: { value: 0.04, source: 'fred', asOf: '2026-09-09' }, q: { value: 0.01, source: 'profile_yield', asOf: '2026-08-01' } };
    const x = g({ resolved, provider: 'moomoo' });
    expect(x.rateSource).toMatch(/3-month Treasury/);
    expect(x.profileYield).toMatch(/moves slightly with spot/);
    expect(x.spotClock).toMatch(/moomoo[^.]*update time/);
    const supplied = g({ resolved: { ...resolved, r: { value: 0.04, source: 'supplied', asOf: null }, q: { value: 0, source: 'supplied', asOf: null } } });
    expect(supplied.rateSource).toBeUndefined();
    expect(supplied.profileYield).toBeUndefined();
  });

  it('the budget line and rateLimit inside the answer; the proxy warnings surfaced', () => {
    const shaped = d({ warnings: ['MU: the stored dividend yield could not be read; retry, or supply q explicitly'] }, { rateLimit: BUDGET });
    expect(shaped.rateLimit).toEqual(BUDGET);
    expect(shaped.guide.rateLimit).toMatch(/budget after this call/);
    expect(shaped.guide.rateLimit).toMatch(/reserves the rest once its count is known/);
    expect(shaped.warnings).toEqual(['MU: the stored dividend yield could not be read; retry, or supply q explicitly']);
    expect(d().warnings).toBeUndefined();
    expect(d().rateLimit).toBeUndefined();
  });

  it('rowsLimited: rows dropped for size say so, and the guide and the budget fit inside the shaper\'s own budget', () => {
    const wide = Array.from({ length: 300 }, (_, i) => ({ ...strikeRow(60 + i * 0.5, 1 + Math.sqrt(i + 2) / 7), netVega: 15 + Math.sqrt(i) / 3 }));
    const shaped = d({ byStrike: wide, byExpiration: [entry({ daysToExpiration: 0 })], expirationSelection: 'nearest' }, { strikeRange: 150, rateLimit: BUDGET });
    expect(shaped.strikes.limitedBySize).toBe(true);
    expect(shaped.guide.rowsLimited).toMatch(/farthest from spot first/);
    expect(new TextEncoder().encode(JSON.stringify(shaped)).length).toBeLessThanOrEqual(49_152);
  });
});

describe('dealer', () => {
  const g = (over: Record<string, unknown> = {}) => (summarizeDealerPositioning(live(over)) as any).guide as Record<string, string>;
  it('the spotSides legend beside a split, and one clause when the route sent none', () => {
    const split = g({ spotSides: { atSpotStrike: 120, above: { netGex: 1 }, below: { netGex: -1 }, callOpenInterestShareAbove: 0.4 } }).spotSides;
    expect(split).toMatch(/strictly above spot/);
    expect(split).toMatch(/atSpotStrike/);
    expect(split).toMatch(/callOpenInterestShareAbove/);
    expect(split).toMatch(/every call leg's size is known/);
    expect(g().spotSides).toMatch(/no split/);
  });
  it('the refresh scaling, the expiration-afternoon charm and the after-close shape', () => {
    expect(g().clock).toMatch(/spot squared/);
    const sameDay = g({ byExpiration: [{ expiration: '2026-09-10', daysToExpiration: 0, netGamma: 1, coverage: {} }] }).sameDay;
    expect(sameDay).toMatch(/mostly the same-day legs and the clock/);
    expect(sameDay).toMatch(/holds that shape after it/);
  });
  it('corrected: atmIv is the one usable leg\'s IV when only one has one; null when neither', () => {
    const move = g({ byExpiration: [{ expiration: '2026-09-18', daysToExpiration: 8, netGamma: 1, coverage: {}, expectedMove: { strike: 120, callMid: 2, putMid: 2, straddle: 4, pctOfSpot: 0.03, lower: 116, upper: 124, atmIv: 0.3, ivOneSigma: 5 } }] }).expectedMove;
    expect(move).toMatch(/the one usable leg's IV when only one has one/);
    expect(move).toMatch(/null only when neither/);
  });
});

describe('dealer guide obligation audit - emitted null and coverage rules', () => {
  const budget = { provider: 'tastytrade', limit: 120, remaining: 100, resetSeconds: 30 };
  async function wireFor(response: Record<string, unknown>, args: Record<string, unknown> = {}) {
    const server = new McpServer({ name: 'dealer-obligation-test', version: '1' });
    register(server, {
      get: async (path: string, _params?: Record<string, string>, onRateLimit?: (value: LiveRateLimit) => void) => {
        // the platform default answers methodology 1
        if (path === '/exposure/methodology') return { defaultMethodology: 1, stale: false };
        onRateLimit?.(budget);
        return response;
      },
    } as unknown as LiveApiClient);
    const client = new Client({ name: 'dealer-obligation-consumer', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: 'get_live_dealer_positioning', arguments: { symbol: 'TEST', ...args } });
      expect(result.isError).not.toBe(true);
      const wire = result.structuredContent as any;
      expect(JSON.parse((result.content as { type: string; text: string }[])[0].text)).toEqual(wire);
      return wire;
    } finally {
      await client.close();
      await server.close();
    }
  }

  it('distinguishes an unavailable level from a null over complete coverage', async () => {
    for (const rawFlip of [undefined, 'invalid', null]) {
      const wire = await wireFor(live({ snapshot: { ...live().snapshot, gammaFlip: rawFlip } }));
      expect(wire.levels.gammaFlip).toBeNull();
      expect(wire.coverage.gammaFlip.status).toBe('complete');
      expect(wire.levelStatus.gammaFlip).toBe(rawFlip === null ? 'complete' : 'unavailable');
      expect(wire.guide.levelStatus).toMatch(/missing or invalid.*level.*unavailable/i);
      expect(wire.guide.levelStatus).toMatch(/reported null.*coverage status/i);
    }
  });

  it('defines usable IV beside a fully repriced flip too', async () => {
    const wire = await wireFor(live({ coverage: { ...coverage(), gammaFlipMethod: 'repriced' } }));
    expect(wire.coverage.gammaFlipMethod).toBe('repriced');
    expect(wire.guide.flipMethod).toMatch(/finite, above 0 and at most 5/);
    expect(wire.guide.flipMethod).not.toMatch(/held gamma is an approximation/);
  });

  it('retains a partial side netGex while withholding its call and put GEX', async () => {
    const side = {
      strikes: 1, netGamma: 5, callGamma: 5, putGamma: 0, gammaCoverage: { total: 2, included: 1 },
      callOpenInterest: 10, putOpenInterest: 20,
      callOpenInterestCoverage: { total: 1, included: 1 }, putOpenInterestCoverage: { total: 1, included: 1 },
    };
    const wire = await wireFor(live({ spotSides: { above: side, below: side, atSpotStrike: 120, callOpenInterestShareAbove: 0.4 } }));
    expect(wire.spotSides.above).toMatchObject({ netGex: 5, callGex: null, putGex: null, status: { netGex: 'partial' } });
    expect(wire.guide.spotSides).toMatch(/netGex[^.;]*partial sums/);
    expect(wire.guide.spotSides).toMatch(/callGex and putGex.*only under complete or empty gamma coverage/);
  });

  it('coverage still explains eligible legs when a partial metric value is missing', async () => {
    for (const [metric, field] of [['gamma', 'netGamma'], ['delta', 'netDelta'], ['vega', 'netVega'], ['vanna', 'netVanna'], ['charm', 'netCharm'], ['vomma', 'netVomma']]) {
      const wire = await wireFor(live({
        coverage: { ...coverage(), [metric!]: { total: 2, included: 1 } },
        snapshot: { ...live().snapshot, [field!]: null },
      }));
      expect(wire.coverage[metric!].status).toBe('partial');
      expect(wire.guide.legEligibility).toMatch(/which legs were summed/);
    }
    expect((await wireFor(live())).guide.legEligibility).toBeUndefined();
    expect((await wireFor(live({ coverage: {} }))).guide.legEligibility).toBeUndefined();
  });

  it('successful batch-broker answers explain a call larger than the whole budget', async () => {
    for (const provider of ['tastytrade', 'moomoo', null]) {
      const wire = await wireFor(live({ provider }));
      expect(wire.guide.rateLimit).toMatch(/bigger than the whole budget.*runs alone on an empty window/);
      expect(wire.guide.rateLimit).toMatch(/charged in full.*reset only while something else is in it/);
    }
  });

  it('hourly broker Greeks do not freeze the engine-computed charm between refreshes', async () => {
    for (const provider of ['tradier', null]) {
      const wire = await wireFor(live({ provider }));
      expect(wire.guide.tradierGreeks).toMatch(/refreshes its Greeks about hourly/);
      expect(wire.guide.tradierGreeks).toMatch(/engine computes vanna, charm and vomma from IV and time to expiry/);
      expect(wire.guide.tradierGreeks).toMatch(/those totals can change with spot and the clock between refreshes/);
    }
    expect((await wireFor(live({ provider: 'tastytrade' }))).guide.tradierGreeks).toBeUndefined();
  });

  it('a single requested same-day expiration does not make its own reported charm share unknown', async () => {
    const wire = await wireFor(live({
      asOf: '2026-09-18T19:00:00.000Z',
      expirations: ['2026-09-18'], expirationSelection: 'requested',
      byExpiration: [{ expiration: '2026-09-18', daysToExpiration: 0, netGamma: 140_000, netDelta: -3_400_000, coverage: coverage() }],
    }), { expiration: '2026-09-18' });
    expect(wire.window.expirations).toEqual(['2026-09-18']);
    expect(wire.exposure.netCharm).toBe(-450);
    expect(wire.exposureStatus.netCharm).toBe('complete');
    expect(wire.guide.sameDay).not.toMatch(/how much of it is same-day is unknown/);
    expect(wire.guide.sameDay).toMatch(/over several expirations this answer does not show its same-day share/);
  });

  it('the 4:15 cutoff preserves a named expiration and the default window with no later listing', async () => {
    for (const selection of ['requested', 'nearest']) {
      const wire = await wireFor(live({
        asOf: '2026-09-18T20:16:00.000Z',
        expirations: ['2026-09-18'], expirationsAvailable: 1, expirationSelection: selection,
        snapshot: { ...live().snapshot, netVanna: 0, netCharm: 0, netVomma: 0 },
        coverage: { ...coverage(), vanna: { total: 824, included: 0 }, charm: { total: 824, included: 0 }, vomma: { total: 824, included: 0 } },
        byExpiration: [{ expiration: '2026-09-18', daysToExpiration: 0, netGamma: 140_000, netDelta: -3_400_000, coverage: coverage() }],
      }), selection === 'requested' ? { expiration: '2026-09-18' } : {});
      expect(wire.window.expirations).toEqual(['2026-09-18']);
      expect(wire.guide.sameDay).not.toMatch(/4:15 PM only drops the expiration/);
      expect(wire.guide.sameDay).toMatch(/4:15 PM is the default-window cutoff, not a repricing boundary/);
      expect(wire.guide.sameDay).toMatch(/named expirations and those with no later listing are kept/);
    }
  });

  it('the engine clock can reach the one-minute floor at 12:59 on an early-close date', async () => {
    // The shared engine's current clock: 2026-11-27 closes at 13:00 New York. A usable IV leg is counted for
    // charm at 12:58 and excluded at 12:59; the flip remains repriced at the one-minute floor. The default
    // window's separate selection cutoff stays at 16:15. These are received engine results, not a local clock.
    for (const [asOf, included, netCharm] of [
      ['2026-11-27T17:58:00.000Z', 1, -79_405],
      ['2026-11-27T17:59:00.000Z', 0, 0],
    ] as const) {
      const wire = await wireFor(live({
        asOf, expirations: ['2026-11-27'], expirationSelection: 'requested',
        snapshot: { ...live().snapshot, netCharm },
        coverage: { ...coverage(1), charm: { total: 1, included }, gammaFlipMethod: 'repriced' },
        byExpiration: [{ expiration: '2026-11-27', daysToExpiration: 0, coverage: coverage(1), expectedMove: null }],
      }), { expiration: '2026-11-27' });
      expect(wire.exposure.netCharm).toBe(included === 1 ? -79_405 : null);
      expect(wire.coverage.charm.status).toBe(included === 1 ? 'complete' : 'unmeasured');
      expect(wire.coverage.gammaFlipMethod).toBe('repriced');
      expect(wire.guide.roots).toMatch(/timed to the engine's close for that date \(4:00 PM New York on a regular day\)/);
      expect(wire.guide.sameDay).toMatch(/one minute before the engine's close for that date \(4:00 PM New York on a regular day\)/);
      expect(wire.guide.sameDay).toMatch(/repriced gamma narrows onto their strikes until one minute before that close and holds that shape after it/);
      for (const line of [wire.guide.roots, wire.guide.sameDay, wire.guide.legEligibility ?? '']) expect(line).not.toMatch(/1:00 PM|early close/);
      expect(wire.guide.sameDay).toMatch(/4:15 PM is the default-window cutoff, not a repricing boundary/);
      if (included === 0) {
        expect(wire.guide.legEligibility).toMatch(/more than a minute remains before the engine's close for its expiration day \(4:00 PM New York on a regular day\)/);
      }
    }
  });

  it('fits simultaneous guide rules and partial rows together without losing level rows or either channel', async () => {
    const rows = Array.from({ length: 1_600 }, (_, i) => ({
      ...strikeRow(40 + i * 0.5, 1 + Math.sqrt(i + 2) / 7),
      callOpenInterest: 123456, putOpenInterest: 654321,
      coverage: { ...coverage(2), vega: { total: 2, included: 1 } },
    }));
    const expiration = {
      expiration: '2026-09-18', daysToExpiration: 0,
      netGamma: 100, netDelta: 10, callGamma: 120, putGamma: -20, grossGamma: 140, shareOfGrossGamma: 0.5,
      coverage: { gamma: { total: 2, included: 2 }, delta: { total: 2, included: 2 } },
      expectedMove: { strike: 120, callMid: 2, putMid: 2.1, straddle: 4.1, pctOfSpot: 0.034, lower: 115.9, upper: 124.1, atmIv: 0.3, ivOneSigma: 5.1, root: 'SPXW' },
      expectedMoveUnavailable: null, events: { earningsOnOrBefore: null, exDividendOnOrBefore: null },
    };
    const response = live({
      provider: null, expirationSelection: 'nearest', expirations: ['2026-09-18', '2026-09-25'],
      byStrike: rows,
      snapshot: { ...live().snapshot, gammaFlip: null, regime: 'neutral', callWall: 250, putWall: 50, absGamma: 260 },
      coverage: { ...coverage(3200), vega: { total: 3200, included: 1600 }, gammaFlipMethod: 'mixed', gammaFlipSearchStatus: null },
      byExpiration: [expiration, { ...expiration, expiration: '2026-09-25', daysToExpiration: null, expectedMove: null, events: null }],
      events: { from: '2026-09-18', through: '2026-09-25', earnings: [], exDividends: [] },
      resolved: { S: { value: 120, asOf: null, stale: null }, r: { value: 0.04, source: 'fred-DGS3MO', asOf: null }, q: { value: 0.01, source: 'profile_yield', asOf: '2026-09-17' } },
      warnings: ['A stored yield could not be used; the profile fallback was used.'],
    });
    const wire = await wireFor(response, { strikeWindowPct: 50 });
    expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(49_152);
    expect(wire.responseBudget).toBeUndefined();
    expect(wire.rateLimit).toEqual(budget);
    expect(wire.warnings).toEqual(['A stored yield could not be used; the profile fallback was used.']);
    expect(wire.strikes.limitedBySize).toBe(true);
    expect(wire.strikes.returned).toBeGreaterThan(1);
    expect(wire.strikes.returned).toBeLessThan(150);
    expect(wire.strikes.atLevels.map((r: { strike: number }) => r.strike)).toEqual([50, 250, 260]);
    for (const key of ['exposure', 'walls', 'levelStatus', 'dealerRegime', 'magnet', 'concentration', 'flipMethod', 'flipSearch', 'rows', 'spotSides', 'rowsAtLevels', 'rowsLimited', 'inWindow', 'byExpiration', 'expectedMove', 'events', 'eventsUnread', 'roots', 'strikeCounts', 'windowRoll', 'windowMoves', 'clock', 'tradierGreeks', 'cache', 'moomooDelay', 'sameDay', 'legEligibility', 'inputs', 'rateSource', 'profileYield', 'spotClock', 'rateLimit']) {
      expect(wire.guide[key], key).toBeString();
    }
    expect(wire.guide.levelStatus).toMatch(/null over complete coverage/);
    expect(wire.guide.dealerRegime).toMatch(/"neutral"/);
    const kept = wire.strikes.nearSpot.map((r: { strike: number }) => r.strike);
    const distance = Math.max(...kept.map((strike: number) => Math.abs(strike - 120)));
    expect(rows.filter((r) => r.strike >= 60 && r.strike <= 180 && Math.abs(r.strike - 120) < distance && !kept.includes(r.strike))).toEqual([]);
  });
});
