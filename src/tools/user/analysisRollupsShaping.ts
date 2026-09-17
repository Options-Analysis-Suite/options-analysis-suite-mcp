import { modelDisplayNames } from '../modelLabels.js';

type RawRollupRow = {
  [key: string]: unknown;
  symbol?: unknown;
  period?: unknown;
  period_start?: unknown;
  data?: unknown;
};

type CompactRollupRow = {
  symbol?: string;
  period?: string;
  periodStart?: string;
  periodStartTimestamp?: number;
  count?: number;
  avgDelta?: number;
  avgGamma?: number;
  avgVega?: number;
  avgVegaUnit?: 'per_unit_vol';
  avgVegaWithheld?: string;
  avgTheta?: number;
  avgVol?: number;
  minVol?: number;
  maxVol?: number;
  avgSpot?: number;
  models?: string[];
  modelCount?: number;
};

function round(value: unknown, decimals = 4): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Number(value.toFixed(decimals));
}

function toDateString(timestamp: unknown): string | undefined {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function getObject(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getUniqueModels(value: unknown): string[] | undefined {
  const models = modelDisplayNames(value);
  if (models.length === 0) return undefined;
  return Array.from(new Set(models));
}

function numericValue(value: unknown, decimals = 4): number | undefined {
  return round(value, decimals);
}

/**
 * avgVega's unit, and whether the row can state one.
 *
 * The web app's applyGreekScaling leaves the Digital model's vega per unit of
 * volatility and scales every other model's per percentage point. The rollup
 * producer (apps/web analysisRollupsService) now normalizes Digital before
 * averaging and stamps `avgVegaUnit: 'per_vol_point'`. A row without the
 * stamp was computed before that: if it mixes Digital with any other model
 * its avgVega averaged two units (a Black-Scholes 0.2765 and a Digital
 * -27.0979 gave -13.41), and no caveat repairs an aggregate that is already
 * mixed, so it is withheld; a Digital-only legacy row is per unit and says so.
 *
 * The legacy rows are replaced, not kept: the web app recomputes every rollup
 * from its facts and re-queues them when it ACTIVATES SYNC (sign-in with Data
 * Sync enabled; syncClient's lifecycle work). Not merely "the next time the
 * app runs": a startup whose storage initialization precedes sign-in
 * recomputes the rows before any owner can accept them, and nothing else
 * re-queued them, so that wording promised a recovery that could not happen.
 */
const DIGITAL_MODEL = 'Digital';
const LEGACY_MIXED_VEGA =
  'computed before the Digital model\'s per-unit vega was normalized, so it averaged two units; '
  + 'the web app re-queues normalized rollups when it next activates sync';

export const ROLLUP_VEGA_UNITS =
  'per 1 percentage point of volatility. A rollup computed before the Digital model\'s vega was normalized '
  + 'withholds avgVega when it mixed Digital with other models (avgVegaWithheld says so) and carries it per unit '
  + 'of volatility when it was Digital-only (avgVegaUnit: "per_unit_vol").';

function describeRollupVega(data: Record<string, unknown> | null): { withheld?: string; unit?: 'per_unit_vol' } {
  if (!data || data.avgVegaUnit === 'per_vol_point') return {};
  const models = Array.isArray(data.models) ? data.models.filter((m): m is string => typeof m === 'string') : [];
  if (!models.includes(DIGITAL_MODEL)) return {};
  return models.some((m) => m !== DIGITAL_MODEL) ? { withheld: LEGACY_MIXED_VEGA } : { unit: 'per_unit_vol' };
}

/** The same verdict, applied in place to a raw synced row's `data` for the `full` path. */
export function withholdLegacyMixedVega(data: Record<string, unknown>): void {
  const verdict = describeRollupVega(data);
  if (verdict.withheld) {
    delete data.avgVega;
    data.avgVegaWithheld = verdict.withheld;
  } else if (verdict.unit) {
    data.avgVegaUnit = verdict.unit;
  }
}

export function shapeAnalysisRollupRecord(record: unknown): CompactRollupRow | unknown {
  const raw = getObject(record);
  if (!raw) return record;

  const nested = getObject(raw.data);
  const periodStartTimestamp = typeof raw.period_start === 'number' && Number.isFinite(raw.period_start)
    ? raw.period_start
    : typeof nested?.periodStart === 'number' && Number.isFinite(nested.periodStart)
      ? nested.periodStart
      : undefined;
  const models = getUniqueModels(nested?.models);
  const vega = describeRollupVega(nested);

  return {
    symbol: typeof raw.symbol === 'string' ? raw.symbol : typeof nested?.symbol === 'string' ? nested.symbol : undefined,
    period: typeof raw.period === 'string' ? raw.period : typeof nested?.period === 'string' ? nested.period : undefined,
    periodStart: toDateString(periodStartTimestamp),
    periodStartTimestamp,
    count: typeof nested?.count === 'number' ? nested.count : undefined,
    avgDelta: numericValue(nested?.avgDelta),
    avgGamma: numericValue(nested?.avgGamma, 6),
    avgVega: vega.withheld ? undefined : numericValue(nested?.avgVega),
    ...(vega.unit ? { avgVegaUnit: vega.unit } : {}),
    ...(vega.withheld ? { avgVegaWithheld: vega.withheld } : {}),
    avgTheta: numericValue(nested?.avgTheta),
    avgVol: numericValue(nested?.avgVol),
    minVol: numericValue(nested?.minVol),
    maxVol: numericValue(nested?.maxVol),
    avgSpot: numericValue(nested?.avgSpot, 2),
    models,
    modelCount: models?.length,
  };
}

export function summarizeAnalysisRollupsResponse(payload: unknown): unknown {
  const response = getObject(payload);
  if (!response || !Array.isArray(response.data)) return payload;

  const shapedRows = response.data
    .map((row) => shapeAnalysisRollupRecord(row))
    .filter((row): row is CompactRollupRow => row != null && typeof row === 'object' && !Array.isArray(row));

  if (shapedRows.length === 0) {
    return { ...response, data: shapedRows };
  }

  const counts = shapedRows
    .map((row) => row.count)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const minVols = shapedRows
    .map((row) => row.minVol)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const maxVols = shapedRows
    .map((row) => row.maxVol)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const allModels = Array.from(new Set(
    shapedRows.flatMap((row) => Array.isArray(row.models) ? row.models : [])
  ));

  const latest = shapedRows[0];
  const earliest = shapedRows[shapedRows.length - 1];
  const latestSpot = latest.avgSpot;
  const earliestSpot = earliest.avgSpot;
  const latestDelta = latest.avgDelta;
  const earliestDelta = earliest.avgDelta;

  return {
    ...response,
    data: shapedRows,
    units: { avgVega: ROLLUP_VEGA_UNITS },
    summary: {
      periodsReturned: shapedRows.length,
      totalAnalyses: counts.reduce((sum, value) => sum + value, 0),
      latestPeriod: latest.periodStart,
      earliestPeriod: earliest.periodStart,
      modelsUsed: allModels,
      minObservedVol: minVols.length ? round(Math.min(...minVols)) : undefined,
      maxObservedVol: maxVols.length ? round(Math.max(...maxVols)) : undefined,
      avgSpotChangePct: typeof latestSpot === 'number' && typeof earliestSpot === 'number' && earliestSpot !== 0
        ? round(((latestSpot - earliestSpot) / earliestSpot) * 100, 2)
        : undefined,
      avgDeltaChange: typeof latestDelta === 'number' && typeof earliestDelta === 'number'
        ? round(latestDelta - earliestDelta)
        : undefined,
    },
  };
}
