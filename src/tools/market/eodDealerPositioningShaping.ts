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

import { exposuresChange, exposuresFromDaily } from '../exposureMethodology.js';

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

// ---------------------------------------------------------------------------------------------------------------
// Greek exposure methodology v2: under methodology 2 the route's opt-in (`exposure=v2`) adds the session's methodology-2 day and its
// own prior. The answer carries the book in `exposures` (every expiration after the session) and the stored
// summary's 0-60 day levels in `levels`, labeled methodology 1; no methodology-1 total (netGex, netDex) is sent.

export const EOD_V2_NOTE = 'Here `exposures` cover the scope `exposures.scope` states, from the stored end-of-day chain - every expiration '
  + 'after the session where the expiry rule is proven; an older row\'s own expiring contracts may be included, as its scope and '
  + 'exposureStatus.expiryQualifier say; `levels` are '
  + 'methodology 1\'s over the 0-60 day window (their own rate and dividend inputs: the snapshot\'s median rate and yield), so the two '
  + 'differ in scope and neither is wrong. sincePriorSession compares each with its own prior: `levels` with the stored summary\'s '
  + 'previous session, `exposures` with the newest earlier methodology-2 row (its own priorDate and sessionsSkipped, which can '
  + 'differ); a change is null where either side has no number, and charmFlow\'s across a change of charm basis (charmBasisChanged).';

const PRIOR_V2_STATUSES = new Set(['found', 'none-on-file', 'unavailable']);

function priorExposuresV2(raw: unknown, current: Record<string, unknown> | null) {
  const p = raw as { status?: unknown; priorDate?: unknown; sessionsSkipped?: unknown; prior?: unknown } | null;
  if (!p || typeof p !== 'object' || typeof p.status !== 'string' || !PRIOR_V2_STATUSES.has(p.status)) return { status: 'unavailable' as const };
  if (p.status !== 'found') return { status: p.status as 'none-on-file' | 'unavailable' };
  const prior = exposuresFromDaily(p.prior);
  const skipped = p.sessionsSkipped;
  return {
    status: 'found' as const,
    priorDate: sessionDate(p.priorDate),
    sessionsSkipped: typeof skipped === 'number' && Number.isSafeInteger(skipped) && skipped >= 0 ? skipped : null,
    prior: prior.exposures,
    ...(prior.exposuresUnavailable ? { priorUnavailable: prior.exposuresUnavailable } : {}),
    change: current && prior.exposures ? exposuresChange(current, prior.exposures) : null,
  };
}

export function summarizeEodDealerPositioningV2(response: EodExposureResponse, options: ShapeEodDealerPositioningOptions = {}) {
  const legacy = summarizeEodDealerPositioning(response, options);
  const session = exposuresFromDaily(response?.exposureV2);
  const since = legacy.sincePriorSession;
  const rawSince = response?.sincePriorSession as Record<string, unknown> | undefined;
  return {
    symbol: legacy.symbol,
    date: legacy.date,
    asOf: legacy.asOf,
    dataSource: legacy.dataSource,
    exposures: session.exposures,
    ...(session.exposuresUnavailable ? { exposuresUnavailable: session.exposuresUnavailable } : {}),
    levels: {
      methodology: 1,
      window: legacy.dteWindow,
      spotPrice: legacy.spotPrice,
      dealerRegime: legacy.dealerRegime,
      gammaFlip: legacy.gammaFlip,
      gammaFlipNote: legacy.gammaFlipNote,
      callWall: legacy.callWall,
      putWall: legacy.putWall,
      gammaMagnet: legacy.gammaMagnet,
      topContributingStrikes: legacy.topContributingStrikes,
      topContributingStrikesAvailable: legacy.topContributingStrikesAvailable,
      // the strikes' netGex and netDex are methodology 1's per-strike values, in the stored summary's own units
      topContributingStrikesUnits: { netGex: legacy.units.netGex, netDex: legacy.units.netDex },
    },
    expectedMove30d: legacy.expectedMove30d,
    sincePriorSession: {
      // the stored summary's previous session, its levels only (its net GEX and DEX are methodology 1's)
      levels: since === null ? null : {
        status: since.status,
        priorDate: since.priorDate,
        sessionsSkipped: since.sessionsSkipped,
        prior: since.prior === null ? null : (({ netGex: _g, netDex: _d, ...rest }) => rest)(since.prior),
        change: since.change === null ? null : (({ netGex: _g, netDex: _d, ...rest }) => rest)(since.change),
        dealerRegimeChanged: since.dealerRegimeChanged,
      },
      exposures: priorExposuresV2(rawSince?.exposureV2, session.exposures),
    },
    units: {
      // the methodology-2 numbers' units are methodologyNote's
      expectedMove30d: legacy.units.expectedMove30d,
    },
  };
}
