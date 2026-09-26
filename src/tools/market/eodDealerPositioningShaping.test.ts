import { describe, expect, it } from 'bun:test';
import { EOD_GAMMA_FLIP_NOTE, EOD_GAMMA_FLIP_NULL_NOTE, summarizeEodDealerPositioning } from './eodDealerPositioningShaping.js';
import { sanitizeMcpWireOutput } from '../helpers.js';

/** The proxy's /eod/exposure shape, as packages/shared's buildEodExposureResponse emits it. */
const response = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  symbol: 'SPY',
  date: '2026-09-15',
  asOf: '2026-09-15T21:40:00Z',
  source: 'eod_options_snapshot',
  dteWindow: { minDte: 0, maxDte: 60, unit: 'calendar_days' },
  spotPrice: 650.12,
  netGex: 1.2e9,
  netDex: -3.4e9,
  gammaMagnet: 650,
  gammaFlip: 641.5,
  callWall: 660,
  putWall: 640,
  dealerRegime: 'positive_gamma',
  expectedMovePct30d: 0.018,
  expectedMove30d: 11.70216,
  topContributingStrikes: [
    { strike: 650, netGex: 4e8, netDex: -1e8 },
    { strike: 655, netGex: 3e8, netDex: -0.5e8 },
    { strike: 645, netGex: 2e8, netDex: -0.2e8 },
  ],
  topContributingStrikesLimit: 10,
  units: {
    netGex: 'dealer-perspective dollar delta change for a 1% spot move',
    netDex: 'dealer-perspective dollar delta exposure',
    expectedMovePct30d: 'decimal fraction',
  },
  ...over,
});

describe('summarizeEodDealerPositioning', () => {
  it('keeps every level, labels the gamma flip as coarse-grid, and survives the sanitizer intact', () => {
    const shaped = summarizeEodDealerPositioning(response());
    expect(shaped).toMatchObject({
      symbol: 'SPY', date: '2026-09-15', dataSource: 'eod',
      dteWindow: { minDte: 0, maxDte: 60, unit: 'calendar_days' },
      spotPrice: 650.12, dealerRegime: 'positive_gamma',
      netGex: 1.2e9, netDex: -3.4e9, gammaFlip: 641.5, callWall: 660, putWall: 640, gammaMagnet: 650,
      expectedMove30d: { fraction: 0.018, absolute: 11.70216 },
      topContributingStrikesAvailable: 3,
    });
    // The one thing the row cannot say for itself: this flip carries no
    // search status, and the live tool is a different claim.
    expect(shaped.gammaFlipNote).toBe(EOD_GAMMA_FLIP_NOTE);
    expect(shaped.gammaFlipNote).toContain('get_live_dealer_positioning');
    // The stored expected move is a decimal FRACTION of spot (0.018 = 1.8%),
    // which is what the shared shape's units block says of it. It is published
    // under the name of its unit, never as `percent`, and the units block
    // describes the keys THIS summary emits rather than the row's.
    expect(shaped.expectedMove30d).not.toHaveProperty('percent');
    expect(shaped.units.expectedMove30d.fraction).toContain('decimal fraction');
    expect(shaped.units.netGex).toBe('dealer-perspective dollar delta change for a 1% spot move');
    expect(shaped.units).not.toHaveProperty('expectedMovePct30d');
    expect(shaped.topContributingStrikes).toHaveLength(3);
    const expected = structuredClone(shaped);
    expect(sanitizeMcpWireOutput(shaped as Record<string, unknown>)).toEqual(expected as Record<string, unknown>);
  });

  it('says what a null gamma flip means instead of describing a level that is not there', () => {
    // Eighth run, APT 2026-09-17: gammaFlip null beside the same "Coarse-grid
    // level from the stored end-of-day snapshot" note a real level carries.
    // The producer (proxy/lib/exposure-compute.ts computeRepricedGammaFlip)
    // stores null when its sweep within 20% of spot finds no zero crossing,
    // or had no near-term open interest to sweep; that is not a level of
    // zero and says nothing about a crossing beyond the range.
    // Ninth run: the note named both causes and the row could not say
    // which. On any row the route serves, "no near-term open interest" is
    // impossible: serving needs dealer_regime, which the producer sets only
    // when the near-term universe had a strike with open interest and a
    // valid gamma (SnapshotComputeService hasNearExposure), and that row
    // enters the sweep held or repriced. What remains is no crossing, or a
    // profile that is zero at every sampled price (validGamma accepts 0;
    // calls at one strike and puts at another under one held gamma cancel
    // at every price; a far strike with a tiny T reprices to 0 everywhere).
    // review refuted a pick from the listed strikes: +10,000 at
    // 95 and -10,000 at 105 are two non-zero listed strikes whose sweep is
    // zero at every price, and the producer stores no search status, so the
    // note keeps both causes and says the row cannot tell them apart.
    const shaped = summarizeEodDealerPositioning(response({ gammaFlip: null }));
    expect(shaped.gammaFlip).toBeNull();
    expect(shaped.gammaFlipNote).toBe(EOD_GAMMA_FLIP_NULL_NOTE);
    expect(shaped.gammaFlipNote).toMatch(/^No level is stored for this session: the coarse-grid sweep within 20% of spot found no zero crossing, or its net gamma profile was zero at every price it sampled; the stored row does not say which\. A session with no near-term open interest at all is not served\. That is not a level of zero and says nothing about a crossing beyond that range\./);
    expect(shaped.gammaFlipNote).not.toMatch(/^Coarse-grid level|no near-term open interest to sweep|found no zero crossing in its net gamma profile\./);
    // A missing field reads the same as a stored null, and the listed
    // strikes, zero, non-zero or absent, change nothing.
    for (const over of [
      { gammaFlip: undefined },
      { gammaFlip: null, topContributingStrikes: [] },
      { gammaFlip: null, topContributingStrikes: [{ strike: 5, netGex: 0, netDex: 12 }] },
      { gammaFlip: null, topContributingStrikes: [{ strike: 95, netGex: 10000 }, { strike: 105, netGex: -10000 }] },
      { gammaFlip: null, topContributingStrikes: undefined },
    ]) {
      expect(summarizeEodDealerPositioning(response(over)).gammaFlipNote).toBe(EOD_GAMMA_FLIP_NULL_NOTE);
    }
    // And a real level keeps the level note, whatever the strikes say.
    expect(summarizeEodDealerPositioning(response()).gammaFlipNote).toBe(EOD_GAMMA_FLIP_NOTE);
    expect(summarizeEodDealerPositioning(response({ topContributingStrikes: [] })).gammaFlipNote).toBe(EOD_GAMMA_FLIP_NOTE);
  });

  it('caps the contributing strikes in stored order and says how many there were', () => {
    const shaped = summarizeEodDealerPositioning(response(), { strikeLimit: 2 });
    expect(shaped.topContributingStrikes.map((s) => s.strike)).toEqual([650, 655]);
    expect(shaped.topContributingStrikesAvailable).toBe(3);
  });

  it('reads a missing or malformed field as null, never as a number', () => {
    const shaped = summarizeEodDealerPositioning(response({
      gammaFlip: 'n/a', callWall: undefined, expectedMove30d: NaN,
      topContributingStrikes: [{ strike: 'x' }, { strike: 650 }], units: 'nope', dteWindow: null,
    }) as any);
    expect(shaped.gammaFlip).toBeNull();
    expect(shaped.callWall).toBeNull();
    expect(shaped.expectedMove30d.absolute).toBeNull();
    expect(shaped.topContributingStrikes).toEqual([{ strike: 650, netGex: null, netDex: null }]);
    // A malformed row block loses the row's unit text, not this summary's own.
    expect(shaped.units.netGex).toBeNull();
    expect(shaped.units.expectedMove30d.fraction).toContain('decimal fraction');
    expect(shaped.dteWindow).toEqual({ minDte: null, maxDte: null, unit: null });
    expect(() => summarizeEodDealerPositioning({} as any)).not.toThrow();
  });

  it('carries the session before it on file, and keeps a missing block distinct from none on file', () => {
    const since = {
      status: 'found' as const, priorDate: '2026-09-11', sessionsSkipped: 1,
      prior: { spotPrice: 640.12, netGex: 0.8e9, netDex: -3e9, gammaFlip: 638.25, callWall: 655, putWall: 640, gammaMagnet: 645, dealerRegime: 'negative_gamma' },
      change: { spotPrice: 10, netGex: 0.4e9, netDex: -0.4e9, gammaFlip: 3.25, callWall: 5, putWall: 0, gammaMagnet: 5 },
      dealerRegimeChanged: true,
    };
    expect(summarizeEodDealerPositioning(response({ sincePriorSession: since }) as any).sincePriorSession).toEqual(since);
    // Absent (data-api's shape) or an unknown status: unknown, not "none on file".
    expect(summarizeEodDealerPositioning(response() as any).sincePriorSession).toBeNull();
    expect(summarizeEodDealerPositioning(response({ sincePriorSession: { ...since, status: 'maybe' } }) as any).sincePriorSession).toBeNull();
    const odd = summarizeEodDealerPositioning(response({
      sincePriorSession: { ...since, priorDate: 'yesterday', sessionsSkipped: -1, dealerRegimeChanged: 'yes', change: { ...since.change, netGex: 'lots' } },
    }) as any).sincePriorSession!;
    expect(odd).toMatchObject({ priorDate: null, sessionsSkipped: null, dealerRegimeChanged: null });
    expect(odd.change!.netGex).toBeNull();
    const none = { status: 'none-on-file' as const, priorDate: null, sessionsSkipped: null, prior: null, change: null, dealerRegimeChanged: null };
    expect(summarizeEodDealerPositioning(response({ sincePriorSession: none }) as any).sincePriorSession).toEqual(none);
  });
});
