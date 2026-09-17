import { describe, expect, it } from 'bun:test';
import { EOD_GAMMA_FLIP_NOTE, summarizeEodDealerPositioning } from './eodDealerPositioningShaping.js';
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
});
