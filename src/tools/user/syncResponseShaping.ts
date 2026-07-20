/**
 * Shared response shaping helpers for synced user-data tools.
 *
 * These tools read rows that were pushed from the browser into JSONB columns.
 * Some payloads duplicate large nested objects both inside `record.data` and in
 * top-level companion columns such as `details`, `facts`, and `artifacts`.
 * The default (non-full) view should keep the useful summary fields while
 * removing those duplicated heavy payloads.
 */
import { modelDisplayName } from '../modelLabels.js';

const MAX_SUMMARY_DEPTH = 3;
const MAX_INLINE_SCALAR_ARRAY_ITEMS = 5;
export const RESPONSE_COMPACTION_THRESHOLD = 40 * 1024;
const DEFAULT_RECORD_KEYS_TO_STRIP = ['id', 'user_id', 'created_at', 'key'];
const DEFAULT_DATA_KEYS_TO_STRIP = ['id', 'user_id', 'key'];
const DEFAULT_FULL_INTERNAL_KEYS_TO_STRIP = ['resultId', 'key'];
const PORTFOLIO_TOP_HOLDINGS_LATEST = 5;
const PORTFOLIO_TOP_HOLDINGS_HISTORY = 3;
const ANALYSIS_NUMBER_DECIMALS = 6;
const ANALYSIS_DEDUPE_WINDOW_MS = 30 * 60 * 1000;
const ANALYSIS_DEDUPE_OPTION_PRICE_ABS = 0.15;
const ANALYSIS_DEDUPE_OPTION_PRICE_REL = 0.01;
const ANALYSIS_DEDUPE_DELTA = 0.02;
const ANALYSIS_DEDUPE_VOL = 1e-6;
const SNAPSHOT_SIGNATURE_DECIMALS = 4;
const ANALYSIS_MODEL_KEYS = new Set(['model', 'bestModel', 'worstModel']);
const VARIANCE_GAMMA_PARAM_LABELS: Record<string, string> = {
  vgNu: 'nu',
  vgSigma: 'sigma',
  vgTheta: 'theta',
};

function roundNumber(value: number, decimals = ANALYSIS_NUMBER_DECIMALS): number {
  const abs = Math.abs(value);
  if (abs === 0) return 0;
  if (abs >= 1e-4) return Number(value.toFixed(decimals));
  return Number(value.toPrecision(decimals));
}

function roundNestedNumbers(value: unknown, decimals = ANALYSIS_NUMBER_DECIMALS, depth = 0): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) return roundNumber(value, decimals);
  if (value == null || depth > 4 || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => roundNestedNumbers(item, decimals, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, roundNestedNumbers(nested, decimals, depth + 1)])
  );
}

function findMatchingGreekValue(greeks: unknown, key: string): unknown {
  if (greeks == null || typeof greeks !== 'object' || Array.isArray(greeks)) return undefined;
  const normalized = key.toLowerCase();
  for (const [greekKey, greekValue] of Object.entries(greeks)) {
    if (greekKey.toLowerCase() === normalized) return greekValue;
  }
  return undefined;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' && typeof right === 'number') {
    return Object.is(roundNumber(left), roundNumber(right));
  }
  return left === right;
}

function compactAnalysisGreeks(greeks: unknown): unknown {
  if (greeks == null || typeof greeks !== 'object' || Array.isArray(greeks)) return greeks;
  const original = roundNestedNumbers(greeks) as Record<string, unknown>;
  const compacted: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(original)) {
    const normalized = key.toLowerCase();
    if (normalized === 'price') continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    compacted[key] = value;
  }
  return compacted;
}

function stripKeys(target: unknown, keys: string[]): void {
  if (target == null || typeof target !== 'object' || Array.isArray(target)) return;
  for (const key of keys) delete (target as Record<string, unknown>)[key];
}

function isScalar(value: unknown): boolean {
  return value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeVarianceGammaParams(value: unknown): void {
  const obj = asRecord(value);
  if (!obj) return;
  for (const [rawKey, humanKey] of Object.entries(VARIANCE_GAMMA_PARAM_LABELS)) {
    if (rawKey in obj) {
      obj[humanKey] = obj[rawKey];
      delete obj[rawKey];
    }
  }
}

export function humanizeAnalysisWireOutput(value: unknown, depth = 0): unknown {
  if (depth > 20 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) humanizeAnalysisWireOutput(item, depth + 1);
    return value;
  }

  const obj = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(obj)) {
    if (ANALYSIS_MODEL_KEYS.has(key) && typeof child === 'string') {
      obj[key] = modelDisplayName(child);
      continue;
    }
    if (key === 'models' && Array.isArray(child)) {
      obj[key] = child.map((item) => {
        if (typeof item === 'string') return modelDisplayName(item);
        humanizeAnalysisWireOutput(item, depth + 1);
        return item;
      });
      continue;
    }
    if (key === 'params') {
      humanizeVarianceGammaParams(child);
    }
    humanizeAnalysisWireOutput(obj[key], depth + 1);
  }

  return value;
}

function getAnalysisDelta(record: any): number | undefined {
  const data = asRecord(record?.data);
  const greeks = asRecord(data?.greeks);
  const facts = asRecord(record?.facts);

  const factDelta = facts?.delta;
  if (typeof factDelta === 'number' && Number.isFinite(factDelta)) return factDelta;

  for (const [key, value] of Object.entries(greeks ?? {})) {
    if (key.toLowerCase() === 'delta' && typeof value === 'number' && Number.isFinite(value)) return value;
  }

  const dataDelta = data?.delta;
  if (typeof dataDelta === 'number' && Number.isFinite(dataDelta)) return dataDelta;
  return undefined;
}

function getAnalysisSignature(record: any): {
  symbol?: string;
  model?: string;
  isCall?: boolean;
  strike?: number;
  daysToMaturity?: number;
  volatility?: number;
  optionPrice?: number;
  delta?: number;
  timestamp?: number;
} {
  const data = asRecord(record?.data);
  const symbol = typeof record?.symbol === 'string'
    ? record.symbol
    : typeof data?.symbol === 'string'
      ? data.symbol
      : undefined;
  const model = typeof record?.model === 'string'
    ? record.model
    : typeof data?.model === 'string'
      ? data.model
      : undefined;
  const strike = typeof data?.strike === 'number' && Number.isFinite(data.strike) ? data.strike : undefined;
  const daysToMaturity = typeof data?.daysToMaturity === 'number' && Number.isFinite(data.daysToMaturity)
    ? data.daysToMaturity
    : undefined;
  const volatility = typeof data?.volatility === 'number' && Number.isFinite(data.volatility) ? data.volatility : undefined;
  const optionPrice = typeof data?.optionPrice === 'number' && Number.isFinite(data.optionPrice) ? data.optionPrice : undefined;
  const timestamp = typeof record?.timestamp === 'number' && Number.isFinite(record.timestamp) ? record.timestamp : undefined;
  const isCall = typeof data?.isCall === 'boolean' ? data.isCall : undefined;

  return {
    symbol,
    model,
    isCall,
    strike,
    daysToMaturity,
    volatility,
    optionPrice,
    delta: getAnalysisDelta(record),
    timestamp,
  };
}

function isNearDuplicateAnalysisRecord(left: any, right: any): boolean {
  const current = getAnalysisSignature(left);
  const existing = getAnalysisSignature(right);

  if (
    !current.symbol || !existing.symbol || current.symbol !== existing.symbol ||
    !current.model || !existing.model || current.model !== existing.model ||
    current.isCall == null || existing.isCall == null || current.isCall !== existing.isCall ||
    current.strike == null || existing.strike == null || current.strike !== existing.strike ||
    current.daysToMaturity == null || existing.daysToMaturity == null || current.daysToMaturity !== existing.daysToMaturity ||
    current.volatility == null || existing.volatility == null ||
    Math.abs(current.volatility - existing.volatility) > ANALYSIS_DEDUPE_VOL ||
    current.optionPrice == null || existing.optionPrice == null ||
    current.delta == null || existing.delta == null ||
    current.timestamp == null || existing.timestamp == null ||
    Math.abs(current.timestamp - existing.timestamp) > ANALYSIS_DEDUPE_WINDOW_MS
  ) {
    return false;
  }

  const optionPriceTolerance = Math.max(
    ANALYSIS_DEDUPE_OPTION_PRICE_ABS,
    Math.max(Math.abs(current.optionPrice), Math.abs(existing.optionPrice)) * ANALYSIS_DEDUPE_OPTION_PRICE_REL,
  );
  return (
    Math.abs(current.optionPrice - existing.optionPrice) <= optionPriceTolerance &&
    Math.abs(current.delta - existing.delta) <= ANALYSIS_DEDUPE_DELTA
  );
}

export function dedupeAnalysisHistoryRecords(records: any[], limit = records.length): { records: any[]; omittedCount: number } {
  if (!Array.isArray(records) || records.length === 0) {
    return { records: Array.isArray(records) ? records : [], omittedCount: 0 };
  }

  const kept: any[] = [];
  let omittedCount = 0;

  for (const record of records) {
    if (kept.some((existing) => isNearDuplicateAnalysisRecord(record, existing))) {
      omittedCount += 1;
      continue;
    }
    if (kept.length < limit) {
      kept.push(record);
    }
  }

  return { records: kept, omittedCount };
}

function serializeSnapshotSignature(value: unknown): string {
  return JSON.stringify(roundNestedNumbers(value, SNAPSHOT_SIGNATURE_DECIMALS));
}

function getPortfolioSnapshotSignature(record: any): unknown {
  const data = asRecord(record?.data);
  const details = asRecord(record?.details);
  const detailGreeks = asRecord(details?.greeks);
  const topHoldings = Array.isArray(data?.topHoldings)
    ? data.topHoldings
        .filter((holding): holding is Record<string, unknown> => holding != null && typeof holding === 'object' && !Array.isArray(holding))
        .map((holding) => ({
          symbol: holding.symbol,
          value: holding.value,
          pnl: holding.pnl,
          weight: holding.weight,
        }))
    : [];

  return {
    positionCount: data?.positionCount,
    totalValue: data?.totalValue,
    totalPnL: data?.totalPnL,
    totalPnLPercent: data?.totalPnLPercent,
    cashBalance: data?.cashBalance,
    // First-order Greeks (market-scaled raw units, no $): delta in shares,
    // gamma, theta/day, vega/1% IV, rho/1% rate.
    delta: data?.delta,
    gamma: data?.gamma,
    theta: data?.theta,
    vega: data?.vega,
    rho: data?.rho,
    // Second-order Greeks (market-scaled): vanna/1% IV, charm/day,
    // vomma/1% IV², veta/day.
    vanna: data?.vanna,
    charm: data?.charm,
    vomma: data?.vomma,
    veta: data?.veta,
    topHoldings,
    greeks: detailGreeks
      ? {
          totalRho: detailGreeks.totalRho,
          dollarDelta: detailGreeks.dollarDelta,
          dollarGamma: detailGreeks.dollarGamma,
        }
      : undefined,
  };
}

function getRiskSnapshotSignature(record: any): unknown {
  const data = asRecord(record?.data);
  const details = asRecord(record?.details);
  const fullMargin = asRecord(details?.fullMargin);

  return {
    portfolioValue: data?.portfolioValue,
    var95: data?.var95,
    var99: data?.var99,
    cvar95: data?.cvar95,
    beta: data?.beta,
    volatility: data?.volatility,
    correlation: data?.correlation,
    maxDrawdown: data?.maxDrawdown,
    sharpeRatio: data?.sharpeRatio,
    marginUsagePercent: data?.marginUsagePercent,
    // Aggregate Greek $-impact (Risk-page convention). First-order:
    // dollarDelta exposure, dollarGamma per 1% move, dollarTheta/day,
    // dollarVega/1% IV, dollarRho/1% rate. Second-order: dollarVanna/1% IV,
    // dollarCharm/day, dollarVomma/1% IV, dollarVeta/day.
    dollarDelta: data?.dollarDelta,
    dollarGamma: data?.dollarGamma,
    dollarTheta: data?.dollarTheta,
    dollarVega: data?.dollarVega,
    dollarRho: data?.dollarRho,
    dollarVanna: data?.dollarVanna,
    dollarCharm: data?.dollarCharm,
    dollarVomma: data?.dollarVomma,
    dollarVeta: data?.dollarVeta,
    fullMargin: fullMargin
      ? {
          usagePercent: fullMargin.usagePercent,
          marginUsed: fullMargin.marginUsed,
          maintenanceReq: fullMargin.maintenanceReq,
          marginAvailable: fullMargin.marginAvailable,
          buyingPower: fullMargin.buyingPower,
          cashBalance: fullMargin.cashBalance,
          buffer: fullMargin.buffer,
          bufferPercent: fullMargin.bufferPercent,
          isHighUsage: fullMargin.isHighUsage,
          isCritical: fullMargin.isCritical,
        }
      : undefined,
  };
}

function dedupeSnapshotRecords(
  records: any[],
  limit: number,
  getSignature: (record: any) => unknown,
): { records: any[]; omittedCount: number } {
  if (!Array.isArray(records) || records.length === 0) {
    return { records: Array.isArray(records) ? records : [], omittedCount: 0 };
  }

  const kept: any[] = [];
  let omittedCount = 0;
  const seenSignatures = new Set<string>();

  for (const record of records) {
    const signature = serializeSnapshotSignature(getSignature(record));
    if (seenSignatures.has(signature)) {
      omittedCount += 1;
      continue;
    }

    seenSignatures.add(signature);
    if (kept.length < limit) kept.push(record);
  }

  return { records: kept, omittedCount };
}

export function dedupePortfolioSnapshotRecords(records: any[], limit = records.length): { records: any[]; omittedCount: number } {
  return dedupeSnapshotRecords(records, limit, getPortfolioSnapshotSignature);
}

export function dedupeRiskSnapshotRecords(records: any[], limit = records.length): { records: any[]; omittedCount: number } {
  return dedupeSnapshotRecords(records, limit, getRiskSnapshotSignature);
}

function formatPortfolioSnapshotLabel(entry: Record<string, unknown>, quantity?: number | null): string {
  const symbol = typeof entry.symbol === 'string' ? entry.symbol.trim() : '';
  if (symbol) return symbol;

  const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
  if (type === 'call' || type === 'put') {
    const base = type === 'call' ? 'Call' : 'Put';
    if (quantity != null && Number.isFinite(quantity) && quantity !== 0) {
      const side = quantity < 0 ? 'Short ' : '';
      return `${side}${base} x${Math.abs(quantity)}`;
    }
    return `${base} position`;
  }

  if (type) return `${type.charAt(0).toUpperCase()}${type.slice(1)} position`;
  return 'Unnamed position';
}

/**
 * Backfill readable labels for legacy portfolio snapshots where option symbols
 * were stored as empty strings. Newer web snapshots should already carry
 * display labels, but existing synced rows still benefit from a fallback.
 */
export function normalizePortfolioSnapshotSymbols(record: any): void {
  const data = record?.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data : null;
  const detailsSource = record?.details && typeof record.details === 'object' && !Array.isArray(record.details)
    ? record.details
    : data?.details && typeof data.details === 'object' && !Array.isArray(data.details)
      ? data.details
      : null;
  if (!detailsSource) return;

  const positionGreeks = Array.isArray(detailsSource.positionGreeks)
    ? detailsSource.positionGreeks.filter((item: unknown): item is Record<string, unknown> => item != null && typeof item === 'object')
    : [];
  if (positionGreeks.length > 0) {
    detailsSource.positionGreeks = positionGreeks.map((entry: Record<string, unknown>) => {
      const quantity = typeof entry.quantity === 'number' && Number.isFinite(entry.quantity) ? entry.quantity : null;
      return {
        ...entry,
        symbol: formatPortfolioSnapshotLabel(entry, quantity),
      };
    });
  }

  const fullAllocation = Array.isArray(detailsSource.fullAllocation)
    ? detailsSource.fullAllocation.filter((item: unknown): item is Record<string, unknown> => item != null && typeof item === 'object')
    : [];
  const normalizedAllocation = fullAllocation.map((entry: Record<string, unknown>, index: number) => {
    const greekEntry = positionGreeks[index];
    const quantity = greekEntry && typeof greekEntry.quantity === 'number' && Number.isFinite(greekEntry.quantity)
      ? greekEntry.quantity
      : null;
    return {
      ...entry,
      symbol: formatPortfolioSnapshotLabel(entry, quantity),
    };
  });
  if (normalizedAllocation.length > 0) detailsSource.fullAllocation = normalizedAllocation;

  if (data && Array.isArray(data.topHoldings) && normalizedAllocation.length > 0) {
    const used = new Set<number>();
    data.topHoldings = data.topHoldings.map((holding: unknown) => {
      if (!holding || typeof holding !== 'object' || Array.isArray(holding)) return holding;
      const holdingObj = holding as Record<string, unknown>;
      const symbol = typeof holdingObj.symbol === 'string' ? holdingObj.symbol.trim() : '';
      if (symbol) return holding;

      const matchIndex = normalizedAllocation.findIndex((allocation: Record<string, unknown>, index: number) => {
        if (used.has(index)) return false;
        return sameValue(allocation.value, holdingObj.value) && sameValue(allocation.pnl, holdingObj.pnl);
      });
      if (matchIndex === -1) {
        return {
          ...holdingObj,
          symbol: 'Unnamed position',
        };
      }
      used.add(matchIndex);
      return {
        ...holdingObj,
        symbol: normalizedAllocation[matchIndex].symbol,
      };
    });
  }
}

/**
 * Recursively summarize nested values while avoiding large arrays of objects.
 * Keeps small scalar arrays inline, but replaces heavier arrays with a compact note.
 */
export function summarizeNestedValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    if (value.length <= MAX_INLINE_SCALAR_ARRAY_ITEMS && value.every(isScalar)) return value;
    return {
      _count: value.length,
      _omitted: true,
    };
  }
  if (depth >= MAX_SUMMARY_DEPTH) return '[nested object]';
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, summarizeNestedValue(nested, depth + 1)])
  );
}

/**
 * Remove database/internal sync metadata that is not useful to the AI assistant.
 */
export function stripSyncRecordMetadata(
  record: any,
  opts?: { topLevelKeys?: string[]; dataKeys?: string[] },
): void {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return;
  stripKeys(record, opts?.topLevelKeys ?? DEFAULT_RECORD_KEYS_TO_STRIP);
  if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
    stripKeys(record.data, opts?.dataKeys ?? DEFAULT_DATA_KEYS_TO_STRIP);
  }
}

function stripKeysDeep(value: unknown, keys: string[], depth = 0): void {
  if (depth > 16 || value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) stripKeysDeep(item, keys, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  stripKeys(obj, keys);
  for (const child of Object.values(obj)) stripKeysDeep(child, keys, depth + 1);
}

/**
 * Full-mode sync tools still return more detail, but they must not expose
 * database row metadata or internal result identifiers to connected AI clients.
 */
export function sanitizeFullSyncResponse(
  response: any,
  opts?: { topLevelKeys?: string[]; dataKeys?: string[]; internalKeys?: string[] },
): void {
  if (response == null || typeof response !== 'object') return;
  const records = Array.isArray(response.data) ? response.data : Array.isArray(response) ? response : [];
  for (const record of records) {
    stripSyncRecordMetadata(record, opts);
    stripKeysDeep(record, opts?.internalKeys ?? DEFAULT_FULL_INTERNAL_KEYS_TO_STRIP);
  }
}

/**
 * Shape an analysis-history style record for the default summary view.
 * - Preserve scalar input/output fields in `data`
 * - Keep Greeks inline, but summarize nested arrays/objects inside them
 * - Replace duplicated `data.facts` / `data.artifacts` with pointers to the
 *   top-level columns
 * - Summarize top-level `facts` and `artifacts`
 */
export function shapeAnalysisResultRecord(record: any): void {
  stripSyncRecordMetadata(record);
  const sourceData = record?.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data : null;
  const optionPrice = typeof sourceData?.optionPrice === 'number' ? sourceData.optionPrice : undefined;

  if (sourceData) {
    record.data = Object.fromEntries(
      Object.entries(sourceData).map(([key, value]) => {
        if (key === 'facts') return [key, '[see top-level facts]'];
        if (key === 'artifacts') return [key, '[see top-level artifacts]'];
        if (key === 'greeks') {
          const compactedGreeks = compactAnalysisGreeks(summarizeNestedValue(value));
          if (
            compactedGreeks &&
            typeof compactedGreeks === 'object' &&
            !Array.isArray(compactedGreeks) &&
            optionPrice != null
          ) {
            const greekObj = compactedGreeks as Record<string, unknown>;
            if (sameValue(greekObj.Price, optionPrice)) delete greekObj.Price;
            if (sameValue(greekObj.price, optionPrice)) delete greekObj.price;
          }
          return [key, compactedGreeks];
        }
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          return [key, '[nested object]'];
        }
        return [key, value];
      })
    );
  }

  const data = record?.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data : null;
  const greeks = data?.greeks;

  if (record?.facts && typeof record.facts === 'object' && !Array.isArray(record.facts)) {
    const compactFacts = Object.fromEntries(
      Object.entries(record.facts)
        .filter(([key, value]) => {
          if (key === 'resultId') return false;
          if (data && sameValue(data[key], value)) return false;
          const greekValue = findMatchingGreekValue(greeks, key);
          if (greekValue !== undefined && sameValue(greekValue, value)) return false;
          return true;
        })
        .map(([key, value]) => [key, roundNestedNumbers(summarizeNestedValue(value))])
    );
    if (Object.keys(compactFacts).length === 0) {
      delete record.facts;
    } else {
      record.facts = compactFacts;
    }
  }

  if (record?.artifacts && typeof record.artifacts === 'object' && !Array.isArray(record.artifacts)) {
    const compactArtifacts = Object.fromEntries(
      Object.entries(record.artifacts)
        .filter(([key]) => key !== 'resultId')
        .map(([key, value]) => {
          if ((key === 'extraGreeks' || key === 'modelSensitivities') && value && typeof value === 'object' && !Array.isArray(value)) {
            const uniqueEntries = Object.entries(value).filter(([entryKey, entryValue]) => {
              if ((entryKey === 'Price' || entryKey === 'price') && optionPrice != null && sameValue(optionPrice, entryValue)) {
                return false;
              }
              const greekValue = findMatchingGreekValue(greeks, entryKey);
              return greekValue === undefined || !sameValue(greekValue, entryValue);
            });
            if (uniqueEntries.length === 0) return [key, undefined];
            return [key, roundNestedNumbers(Object.fromEntries(uniqueEntries))];
          }
          return [key, roundNestedNumbers(summarizeNestedValue(value))];
        })
        .filter(([, value]) => value !== undefined)
    );
    if (Object.keys(compactArtifacts).length === 0) {
      delete record.artifacts;
    } else {
      record.artifacts = compactArtifacts;
    }
  }

  humanizeAnalysisWireOutput(record);
}

/**
 * Shape risk-snapshot details for the default summary view.
 * Keeps summary stats such as margin usage and buying power, but removes
 * correlation matrices, Monte Carlo internals, and per-position arrays.
 */
export function shapeRiskDetails(details: unknown): unknown {
  if (details == null || typeof details !== 'object' || Array.isArray(details)) return details;
  const {
    correlationMatrix,
    mcVarDetails,
    positionContributions,
    ...summary
  } = details as Record<string, unknown>;

  const omitted: string[] = [];
  if (correlationMatrix) omitted.push('correlation matrix');
  if (mcVarDetails) omitted.push('Monte Carlo VaR details');
  if (Array.isArray(positionContributions)) {
    omitted.push(`position contributions (${positionContributions.length} items)`);
  }
  if (omitted.length) summary._omitted = omitted;
  return summary;
}

/**
 * Shape portfolio-snapshot details for the default summary view.
 * Removes per-position arrays and drops aggregate greek values that already
 * live on the parent record.
 */
export function shapePortfolioDetails(details: unknown): unknown {
  if (details == null || typeof details !== 'object' || Array.isArray(details)) return details;
  const summary: Record<string, unknown> = {};
  const omitted: string[] = [];

  for (const [key, value] of Object.entries(details)) {
    if (Array.isArray(value)) {
      const human = key.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
      omitted.push(`${human} (${value.length} items)`);
      continue;
    }
    if (key === 'greeks' && value && typeof value === 'object' && !Array.isArray(value)) {
      const greekSummary: Record<string, unknown> = {};
      const greekObj = value as Record<string, unknown>;
      if (greekObj.totalRho != null) greekSummary.totalRho = roundNestedNumbers(greekObj.totalRho);
      if (greekObj.dollarDelta != null) greekSummary.dollarDelta = roundNestedNumbers(greekObj.dollarDelta);
      if (greekObj.dollarGamma != null) greekSummary.dollarGamma = roundNestedNumbers(greekObj.dollarGamma);
      if (Object.keys(greekSummary).length > 0) summary.greeks = greekSummary;
      continue;
    }
    summary[key] = roundNestedNumbers(value);
  }

  if (omitted.length) summary._omitted = omitted;
  return summary;
}

/**
 * If a portfolio history response is still large after shaping, reduce
 * top-holdings arrays in older snapshots before the global size guard trims
 * the entire history down to 5 rows.
 */
export function compactPortfolioHistoryResponse(res: any, threshold = RESPONSE_COMPACTION_THRESHOLD): void {
  if (!res || !Array.isArray(res.data) || JSON.stringify(res).length <= threshold) return;

  for (const [index, record] of res.data.entries()) {
    const data = record?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const holdings = data.topHoldings;
    if (!Array.isArray(holdings)) continue;

    const keep = index === 0 ? PORTFOLIO_TOP_HOLDINGS_LATEST : PORTFOLIO_TOP_HOLDINGS_HISTORY;
    const trimmed = holdings
      .slice(0, keep)
      .map((holding) => roundNestedNumbers(holding, 4));
    data.topHoldings = trimmed;
    if (holdings.length > keep) {
      data._topHoldingsMeta = { showing: keep, total: holdings.length };
    }
  }
}

/**
 * If a large analysis-history response still exceeds the soft threshold after
 * baseline deduplication, round numeric payloads so more rows fit before the
 * shared 50 KB guard has to collapse the response.
 */
export function compactAnalysisHistoryResponse(res: any, threshold = RESPONSE_COMPACTION_THRESHOLD): void {
  if (!res || !Array.isArray(res.data) || JSON.stringify(res).length <= threshold) return;

  for (const record of res.data) {
    if (record?.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
      if (record.data.greeks) record.data.greeks = roundNestedNumbers(record.data.greeks);
    }
    if (record?.facts) record.facts = roundNestedNumbers(record.facts);
    if (record?.artifacts) record.artifacts = roundNestedNumbers(record.artifacts);
  }
}

/**
 * Some synced snapshot-style rows duplicate heavy `details` objects inside
 * `record.data.details` as well as top-level `record.details`. Replace the
 * nested copy with a compact note after the tool has summarized the top-level
 * details column.
 *
 * Only collapses when a top-level companion field exists — otherwise the note
 * "[see top-level details]" would point at nothing and the LLM would lose
 * the only copy of the data.
 */
export function replaceDuplicatedDataField(record: any, field: string, note: string): void {
  if (
    record?.[field] &&
    typeof record[field] === 'object' &&
    !Array.isArray(record[field]) &&
    record?.data &&
    typeof record.data === 'object' &&
    !Array.isArray(record.data) &&
    typeof record.data[field] === 'object' &&
    record.data[field] !== null &&
    record[field] !== undefined &&
    record[field] !== null
  ) {
    record.data[field] = note;
  }
}
