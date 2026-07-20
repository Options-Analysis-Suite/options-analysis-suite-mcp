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

  return {
    symbol: typeof raw.symbol === 'string' ? raw.symbol : typeof nested?.symbol === 'string' ? nested.symbol : undefined,
    period: typeof raw.period === 'string' ? raw.period : typeof nested?.period === 'string' ? nested.period : undefined,
    periodStart: toDateString(periodStartTimestamp),
    periodStartTimestamp,
    count: typeof nested?.count === 'number' ? nested.count : undefined,
    avgDelta: numericValue(nested?.avgDelta),
    avgGamma: numericValue(nested?.avgGamma, 6),
    avgVega: numericValue(nested?.avgVega),
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
