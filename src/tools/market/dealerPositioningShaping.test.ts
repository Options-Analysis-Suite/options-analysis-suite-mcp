import { describe, expect, it } from 'bun:test';
import { summarizeDealerPositioning, withinPercent } from './dealerPositioningShaping.js';
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

describe('summarizeDealerPositioning', () => {
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
    // Partial coverage keeps every row's counts, and long decimals: the
    // largest rows this shaper emits. 5,000 asks past the cap.
    const byStrike = Array.from({ length: 1_600 }, (_, i) => ({
      ...strikeRow(50 + i * 0.5, i * Math.PI * 1e10),
      netDelta: -i * Math.PI * 1e11, netVega: i * Math.PI * 1e8,
      callOpenInterest: 123_456, putOpenInterest: 654_321,
      coverage: coverage(824, 823),
    }));
    const shaped = summarizeDealerPositioning(live({ byStrike }), { strikeRange: 5_000 });
    expect(shaped.strikes.limitedBySize).toBe(true);
    expect(shaped.strikes.nearSpot.length).toBeLessThan(150);
    expect(new TextEncoder().encode(JSON.stringify(shaped)).byteLength).toBeLessThanOrEqual(50 * 1024 - 2 * 1024);
    // What is kept is the nearest to spot (120): a contiguous run around it.
    const kept = shaped.strikes.nearSpot.map((r) => r.strike as number);
    const farthestKept = Math.max(...kept.map((k) => Math.abs(k - 120)));
    const nearerDropped = byStrike.filter((r) => Math.abs(r.strike - 120) < farthestKept && !kept.includes(r.strike));
    expect(nearerDropped).toEqual([]);
    const result = await toolHandler(async () => shaped)({});
    expect((result.structuredContent as any).responseBudget).toBeUndefined();
    expect((result.structuredContent as any).strikes.nearSpot).toHaveLength(shaped.strikes.nearSpot.length);

    // Complete rows drop their counts, so the full 150 fit.
    const complete = byStrike.map((r) => ({ ...r, strike: r.strike, netGamma: 1234.5, netDelta: -2345.6, netVega: 34.5, coverage: coverage(4, 4) }));
    const wide = summarizeDealerPositioning(live({ byStrike: complete }), { strikeRange: 5_000 });
    expect(wide.strikes.nearSpot).toHaveLength(150);
    expect(wide.strikes.limitedBySize).toBe(false);
    expect(wide.strikes.nearSpot[0]).not.toHaveProperty('coverage');
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
