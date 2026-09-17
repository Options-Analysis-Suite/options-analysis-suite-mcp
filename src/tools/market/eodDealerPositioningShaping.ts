/**
 * Shape END-OF-DAY dealer positioning, from the stored options snapshot.
 *
 * The proxy's /eod/exposure/:symbol publishes packages/shared's
 * buildEodExposureResponse shape: one row per symbol per session, already
 * small. This keeps it flat, coerces every number, caps the contributing
 * strikes, names the expected move by its unit, and adds the one thing the row
 * cannot say for itself: that its gamma flip is a coarse-grid level with no
 * search status or resolution, so a model does not present it with the live
 * tool's confidence.
 */

export interface EodExposureResponse { [key: string]: unknown }

export interface ShapeEodDealerPositioningOptions {
  /** Contributing strikes kept, in the stored order. */
  strikeLimit?: number;
}

const DEFAULT_STRIKE_LIMIT = 10;

const num = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null =>
  (typeof v === 'string' && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const EOD_GAMMA_FLIP_NOTE =
  'Coarse-grid level from the stored end-of-day snapshot, with no search status or resolution. '
  + 'For a repriced flip as of now, with how it was found, use get_live_dealer_positioning.';

export function summarizeEodDealerPositioning(
  response: EodExposureResponse,
  options: ShapeEodDealerPositioningOptions = {},
) {
  const limit = Math.max(1, Math.trunc(options.strikeLimit ?? DEFAULT_STRIKE_LIMIT));
  const row = response ?? {};
  const window = (row.dteWindow && typeof row.dteWindow === 'object') ? row.dteWindow as Record<string, unknown> : {};
  const rowUnits = (row.units && typeof row.units === 'object') ? row.units as Record<string, unknown> : {};

  const strikes = arr(row.topContributingStrikes)
    .map((entry: any) => ({ strike: num(entry?.strike), netGex: num(entry?.netGex), netDex: num(entry?.netDex) }))
    .filter((entry) => entry.strike !== null);

  return {
    symbol: str(row.symbol),
    date: str(row.date),
    asOf: str(row.asOf),
    dataSource: 'eod' as const,
    dteWindow: {
      minDte: num(window.minDte),
      maxDte: num(window.maxDte),
      unit: str(window.unit),
    },
    spotPrice: num(row.spotPrice),
    dealerRegime: str(row.dealerRegime),
    netGex: num(row.netGex),
    netDex: num(row.netDex),
    gammaFlip: num(row.gammaFlip),
    gammaFlipNote: EOD_GAMMA_FLIP_NOTE,
    callWall: num(row.callWall),
    putWall: num(row.putWall),
    gammaMagnet: num(row.gammaMagnet),
    // The stored expected move is a decimal FRACTION of spot (0.018 = 1.8%),
    // which is what the shared shape's units block says of expectedMovePct30d.
    // Published under the name of its unit: under `percent` a model reads
    // 0.018 as 0.018%, and no note beside it survives a relay.
    expectedMove30d: {
      fraction: num(row.expectedMovePct30d),
      absolute: num(row.expectedMove30d),
    },
    topContributingStrikes: strikes.slice(0, limit),
    topContributingStrikesAvailable: strikes.length,
    // The units describe THIS summary's keys. The row's block names
    // expectedMovePct30d, a key this summary does not emit, so passing it
    // through whole labelled a field the reader could not find.
    units: {
      netGex: str(rowUnits.netGex),
      netDex: str(rowUnits.netDex),
      expectedMove30d: {
        fraction: 'decimal fraction of spotPrice over the next 30 calendar days (0.018 = 1.8%)',
        absolute: 'spotPrice times the fraction, in the currency of spotPrice',
      },
    },
  };
}
