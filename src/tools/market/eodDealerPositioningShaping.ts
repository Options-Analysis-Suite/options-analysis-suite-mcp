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

/**
 * Beside a null flip the level note described a level that is not there
 * (APT 2026-09-17). The producer (proxy/lib/exposure-compute.ts
 * computeRepricedGammaFlip) returns null for no zero crossing, for a
 * profile that is zero at every sampled price, or for nothing to sweep.
 * On a row this tool can show, the last is ruled out: the route serves a
 * session only with dealer_regime set, which the producer sets only when
 * the near-term universe had a strike with open interest and a valid gamma
 * (SnapshotComputeService hasNearExposure), and that strike enters the
 * sweep held or repriced. The other two the row cannot tell apart, and no
 * pick from the listed strikes can: calls at 95 and puts at 105 under one
 * held gamma list as +10,000 and -10,000 and sweep to zero at every price,
 * and a far strike with a minute left reprices to zero everywhere. The
 * producer stores no search status, so the note says both.
 */
export const EOD_GAMMA_FLIP_NULL_NOTE =
  'No level is stored for this session: the coarse-grid sweep within 20% of spot found no zero crossing, '
  + 'or its net gamma profile was zero at every price it sampled; the stored row does not say which. '
  + 'A session with no near-term open interest at all is not served. '
  + 'That is not a level of zero and says nothing about a crossing beyond that range. '
  + 'For a repriced flip as of now, with its search status, use get_live_dealer_positioning.';

const PRIOR_STATUSES = new Set(['found', 'none-on-file', 'unavailable']);
const sessionDate = (v: unknown): string | null =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

/**
 * Null when the route sent none or an unknown status, so a missing block is
 * never read as "no earlier session". Changes are passed through, not
 * recomputed: they are this session minus the prior, null where either
 * side is missing.
 */
function sincePriorSession(value: unknown) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.status !== 'string' || !PRIOR_STATUSES.has(raw.status)) return null;
  const record = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  const prior = record(raw.prior);
  const change = record(raw.change);
  const skipped = raw.sessionsSkipped;
  return {
    status: raw.status as 'found' | 'none-on-file' | 'unavailable',
    priorDate: sessionDate(raw.priorDate),
    sessionsSkipped: typeof skipped === 'number' && Number.isSafeInteger(skipped) && skipped >= 0 ? skipped : null,
    prior: prior === null ? null : {
      spotPrice: num(prior.spotPrice),
      netGex: num(prior.netGex),
      netDex: num(prior.netDex),
      gammaFlip: num(prior.gammaFlip),
      callWall: num(prior.callWall),
      putWall: num(prior.putWall),
      gammaMagnet: num(prior.gammaMagnet),
      dealerRegime: str(prior.dealerRegime),
    },
    change: change === null ? null : {
      spotPrice: num(change.spotPrice),
      netGex: num(change.netGex),
      netDex: num(change.netDex),
      gammaFlip: num(change.gammaFlip),
      callWall: num(change.callWall),
      putWall: num(change.putWall),
      gammaMagnet: num(change.gammaMagnet),
    },
    dealerRegimeChanged: typeof raw.dealerRegimeChanged === 'boolean' ? raw.dealerRegimeChanged : null,
  };
}

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
    gammaFlipNote: num(row.gammaFlip) === null ? EOD_GAMMA_FLIP_NULL_NOTE : EOD_GAMMA_FLIP_NOTE,
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
    // The session before this one on file, same computation and window.
    sincePriorSession: sincePriorSession(row.sincePriorSession),
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
