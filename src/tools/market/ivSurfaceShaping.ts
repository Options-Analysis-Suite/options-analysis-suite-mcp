import { compareByDte, isSameDayExpiry, sampleExpirationsAcrossCurve } from './expirationSampling.js';

type IvSurfaceRow = {
  strike: number;
  expiration: string;
  yte?: number;
  iv?: number;
  callIV?: number;
  putIV?: number;
  smv?: number;
};

type IvSurfacePayload = {
  ticker?: string;
  date?: string;
  spotPrice?: number;
  expirations?: string[];
  rowCount?: number;
  data?: unknown;
};

const MAX_EXPIRATIONS = 6;

/**
 * Calendar days to expiry for a group of rows, from the smallest `yte` in it
 * (the data vendor writes yte as days / 365). Unknown when no row carries one: such a
 * group ranks last and is never treated as same-day.
 */
function groupDte(rows: IvSurfaceRow[]): number {
  const known = rows.map((row) => row.yte).filter((yte): yte is number => typeof yte === 'number' && Number.isFinite(yte));
  return known.length > 0 ? Math.round(Math.min(...known) * 365) : Number.MAX_SAFE_INTEGER;
}

function round(value: unknown, decimals = 4): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Number(value.toFixed(decimals));
}

/**
 * An IV field is published as null, never omitted, when the proxy banded the
 * stored value out (capIv: finite, above 0, at most 5): the description says
 * "null where the stored value is outside the usable band", and an absent
 * key reads as "not reported" rather than "not usable".
 */
function ivOrNull(value: unknown): number | null {
  return round(value) ?? null;
}

/**
 * Where a node's blended `iv` came from. The proxy publishes
 * capIv(smooth_smv_vol) ?? capIv(c_mid_iv) ?? capIv(p_mid_iv) as `iv`
 * (SupabaseService.getIVSurface) and carries the raw smv beside it, so the
 * source is the first of the three that is usable: the smoothed surface
 * value, the call mid, the put mid. Null is no usable IV, or a row without
 * the raw smv beside it, where the fallback cannot be placed. A node read
 * iv 0.394 between putIV 0.414 and callIV 0.2475 with nothing saying which
 * of the three it was.
 */
type SurfaceIvSource = 'smoothed' | 'call-mid' | 'put-mid' | null;

const usableIv = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 5;

function surfaceIvSource(row: IvSurfaceRow): SurfaceIvSource {
  if (!usableIv(row.iv)) return null;
  if (!('smv' in row)) return null;
  if (usableIv(row.smv)) return 'smoothed';
  if (usableIv(row.callIV)) return 'call-mid';
  return usableIv(row.putIV) ? 'put-mid' : null;
}

export const SURFACE_SKEW_BASIS =
  'put-wing mid IV at the strike nearest 95% of spot among strikes below the ATM strike, minus call-wing mid IV at the strike nearest 105% of spot among strikes above it (the ATM strike is the one nearest spot and is never a wing; ties go to the lower strike); null when either wing\'s mid IV is unusable, and no skew row at all when a side has no strike beyond the ATM';

function pickNearestRow(rows: IvSurfaceRow[], targetStrike: number, used = new Set<number>()): IvSurfaceRow | undefined {
  return [...rows]
    .filter((row) => !used.has(row.strike))
    .sort((left, right) => {
      const leftDistance = Math.abs(left.strike - targetStrike);
      const rightDistance = Math.abs(right.strike - targetStrike);
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return left.strike - right.strike;
    })[0];
}

function buildExpirationSummary(expiration: string, rows: IvSurfaceRow[], spotPrice: number) {
  const used = new Set<number>();
  const atmNode = pickNearestRow(rows, spotPrice);
  if (atmNode) used.add(atmNode.strike);
  const putRows = atmNode ? rows.filter((row) => row.strike <= atmNode.strike) : rows;
  const callRows = atmNode ? rows.filter((row) => row.strike >= atmNode.strike) : rows;
  const putNode = pickNearestRow(putRows, spotPrice * 0.95, used);
  if (putNode) used.add(putNode.strike);
  const callNode = pickNearestRow(callRows, spotPrice * 1.05, used);

  const preview = [
    putNode && {
      expiration,
      bucket: 'put wing',
      strike: putNode.strike,
      relativeStrike: round(putNode.strike / spotPrice, 3),
      yte: round(putNode.yte, 5),
      iv: ivOrNull(putNode.iv),
      ivSource: surfaceIvSource(putNode),
      putIV: ivOrNull(putNode.putIV),
      callIV: ivOrNull(putNode.callIV),
    },
    atmNode && {
      expiration,
      bucket: 'atm',
      strike: atmNode.strike,
      relativeStrike: round(atmNode.strike / spotPrice, 3),
      yte: round(atmNode.yte, 5),
      iv: ivOrNull(atmNode.iv),
      ivSource: surfaceIvSource(atmNode),
      putIV: ivOrNull(atmNode.putIV),
      callIV: ivOrNull(atmNode.callIV),
    },
    callNode && {
      expiration,
      bucket: 'call wing',
      strike: callNode.strike,
      relativeStrike: round(callNode.strike / spotPrice, 3),
      yte: round(callNode.yte, 5),
      iv: ivOrNull(callNode.iv),
      ivSource: surfaceIvSource(callNode),
      putIV: ivOrNull(callNode.putIV),
      callIV: ivOrNull(callNode.callIV),
    },
  ].filter((x): x is NonNullable<typeof x> => Boolean(x));

  // The side IVs are the side IVs. A missing one used to be replaced by the
  // smoothed value, so stored (smv 0.3, call 0, put 0) reported both wings
  // at 0.3 and a skew of 0, and a strike with no usable IV at all reported a
  // skew of 0 as well. The skew is put mid minus call mid when both are
  // usable, and null otherwise; nothing stands in for an absent side.
  const usable = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const putWingMid = putNode ? usable(putNode.putIV) : null;
  const callWingMid = callNode ? usable(callNode.callIV) : null;
  const putWingIv = ivOrNull(putWingMid);
  const callWingIv = ivOrNull(callWingMid);
  const skewSummary = atmNode && putNode && callNode
    ? {
        expiration,
        yte: round(atmNode.yte, 5),
        atmStrike: atmNode.strike,
        atmIV: ivOrNull(atmNode.iv),
        atmIvSource: surfaceIvSource(atmNode),
        // How far from spot each wing actually sits: the basis says "nearest
        // 95% and 105%", and on a dollar grid at spot 5.27 that is 4 and 6,
        // 76% and 114%. The preview carried relativeStrike; the row, read
        // alone, did not.
        putStrike: putNode.strike,
        putRelativeStrike: round(putNode.strike / spotPrice, 3),
        putIV: putWingIv,
        callStrike: callNode.strike,
        callRelativeStrike: round(callNode.strike / spotPrice, 3),
        callIV: callWingIv,
        // The unrounded mids, rounded once: 0.300049 - 0.299951 is 0.0001,
        // not 0.3 - 0.3.
        putCallSkew: putWingMid !== null && callWingMid !== null ? round(putWingMid - callWingMid) ?? null : null,
      }
    : undefined;

  const atmTerm = atmNode
    ? {
        expiration,
        yte: round(atmNode.yte, 5),
        atmStrike: atmNode.strike,
        atmIV: ivOrNull(atmNode.iv),
        atmIvSource: surfaceIvSource(atmNode),
        callIV: ivOrNull(atmNode.callIV),
        putIV: ivOrNull(atmNode.putIV),
      }
    : undefined;

  return { preview, skewSummary, atmTerm };
}

export function summarizeIvSurface(payload: unknown): unknown {
  if (payload == null || typeof payload !== 'object') return payload;
  const data = payload as IvSurfacePayload;
  if (!Array.isArray(data.data) || typeof data.spotPrice !== 'number' || !Number.isFinite(data.spotPrice)) {
    return payload;
  }

  const rows = data.data.filter((row): row is IvSurfaceRow => {
    return row != null
      && typeof row === 'object'
      && typeof (row as IvSurfaceRow).strike === 'number'
      && typeof (row as IvSurfaceRow).expiration === 'string';
  });
  if (rows.length === 0) return payload;

  const grouped = new Map<string, IvSurfaceRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.expiration);
    if (group) group.push(row);
    else grouped.set(row.expiration, [row]);
  }

  // Sampled across the curve with the chain's rule (expirationSampling.ts):
  // the first six by date gave a 0-to-12-day "term structure" out of a
  // 25-expiration file, led by the expiry that ended that session.
  const groups = [...grouped.entries()]
    .map(([expiration, group]) => ({ expiration, dte: groupDte(group), rows: group }))
    .sort(compareByDte);
  const sameDayOnFile = groups.some((group) => isSameDayExpiry(group.dte));
  const sampled = sampleExpirationsAcrossCurve(groups, MAX_EXPIRATIONS);
  const expirations = sampled.map((group) => group.expiration);
  const sameDaySkipped = sameDayOnFile && !sampled.some((group) => isSameDayExpiry(group.dte));

  const atmTermStructure: Array<Record<string, unknown>> = [];
  const skewSummary: Array<Record<string, unknown>> = [];
  const surfacePreview: Array<Record<string, unknown>> = [];

  for (const group of sampled) {
    const summary = buildExpirationSummary(group.expiration, group.rows, data.spotPrice);
    if (summary.atmTerm) atmTermStructure.push(summary.atmTerm);
    if (summary.skewSummary) skewSummary.push(summary.skewSummary);
    surfacePreview.push(...summary.preview);
  }

  return {
    ticker: data.ticker,
    date: data.date,
    spotPrice: round(data.spotPrice, 2),
    expirationCount: grouped.size,
    expirations,
    rowCount: data.rowCount ?? rows.length,
    atmTermStructure,
    skewSummary,
    putCallSkewBasis: SURFACE_SKEW_BASIS,
    surfacePreview,
    _surface_meta: {
      preview: true,
      smiles_per_expiration: 3,
      preview_nodes: surfacePreview.length,
      expirations: expirations.length,
      sampled_across_curve: true,
      same_day_skipped: sameDaySkipped,
    },
  };
}
