type TradingHalt = {
  [key: string]: unknown;
  symbol?: string;
  name?: string;
  market?: string;
  haltTime?: string;
  haltCode?: string;
  haltDescription?: string;
  resumptionTime?: string | null;
  status?: string;
  source?: string;
};

type TradingHaltsPayload = {
  [key: string]: unknown;
  halts?: unknown;
  summary?: unknown;
};

type SymbolTradingHaltPayload = {
  [key: string]: unknown;
  symbol?: unknown;
  history?: unknown;
  summary?: unknown;
};

const VOLATILITY_CODES = new Set(['LUDP', 'LUDS', 'M', 'T5']);
const MATERIAL_CODES = new Set(['T1', 'T2', 'T3', 'T6', 'T8', 'T12', 'H4', 'H9', 'H10', 'H11', 'O1', 'M1', 'M2', 'M3', 'IPO1', 'D', 'MWC1', 'MWC2', 'MWC3', 'MWCQ']);
const MAX_RECENT_MATERIAL = 12;
const MAX_RECENT_VOLATILITY = 8;

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function normalizeTimestamp(value: unknown): string {
  const parsed = parseTimestamp(value);
  if (!Number.isFinite(parsed)) return '';
  return new Date(Math.floor(parsed / 1000) * 1000).toISOString();
}

function normalizeCode(value: unknown): string {
  return typeof value === 'string' ? value.toUpperCase() : '';
}

function isActiveHalt(halt: TradingHalt): boolean {
  return typeof halt.status === 'string' && halt.status.toLowerCase() === 'halted';
}

function isVolatilityHalt(halt: TradingHalt): boolean {
  return VOLATILITY_CODES.has(normalizeCode(halt.haltCode));
}

function isMaterialHalt(halt: TradingHalt): boolean {
  return MATERIAL_CODES.has(normalizeCode(halt.haltCode));
}

function haltEventKey(halt: TradingHalt): string {
  return [
    typeof halt.symbol === 'string' ? halt.symbol.toUpperCase() : '',
    normalizeTimestamp(halt.haltTime),
    normalizeTimestamp(halt.resumptionTime),
    isActiveHalt(halt) ? 'active' : 'resumed',
  ].join('::');
}

function haltPriorityScore(halt: TradingHalt): number {
  let score = 0;
  if (isMaterialHalt(halt)) score += 100;
  if (isVolatilityHalt(halt)) score += 40;
  if (normalizeCode(halt.haltCode) === 'LUDP') score += 5;
  if (isActiveHalt(halt)) score += 10;
  score += (typeof halt.name === 'string' ? halt.name.length : 0)
    + (typeof halt.haltDescription === 'string' ? halt.haltDescription.length : 0)
    + (halt.resumptionTime ? 10 : 0)
    + (typeof halt.market === 'string' ? halt.market.length : 0);
  return score;
}

export function dedupeTradingHalts(halts: TradingHalt[]): TradingHalt[] {
  const byKey = new Map<string, TradingHalt>();

  for (const halt of halts) {
    const key = haltEventKey(halt);
    const existing = byKey.get(key);
    if (!existing || haltPriorityScore(halt) > haltPriorityScore(existing)) {
      byKey.set(key, halt);
    }
  }

  return Array.from(byKey.values());
}

function compareByRecency(left: TradingHalt, right: TradingHalt): number {
  return parseTimestamp(right.haltTime) - parseTimestamp(left.haltTime);
}

function trimHalt(halt: TradingHalt): Record<string, unknown> {
  return {
    symbol: halt.symbol,
    name: halt.name,
    market: halt.market,
    haltTime: halt.haltTime,
    haltCode: halt.haltCode,
    haltDescription: halt.haltDescription,
    resumptionTime: halt.resumptionTime ?? null,
    status: halt.status,
  };
}

function uniqueLatestActiveHalts(halts: TradingHalt[]): TradingHalt[] {
  const bySymbol = new Map<string, TradingHalt>();

  for (const halt of halts.sort(compareByRecency)) {
    const key = typeof halt.symbol === 'string' ? halt.symbol.toUpperCase() : '';
    if (!key || bySymbol.has(key)) continue;
    bySymbol.set(key, halt);
  }

  return Array.from(bySymbol.values());
}

function uniqueRecentVolatilityHalts(halts: TradingHalt[], cap: number): TradingHalt[] {
  const bySymbol = new Map<string, TradingHalt>();

  for (const halt of halts.sort(compareByRecency)) {
    const key = typeof halt.symbol === 'string' ? halt.symbol.toUpperCase() : '';
    if (!key || bySymbol.has(key)) continue;
    bySymbol.set(key, halt);
    if (bySymbol.size >= cap) break;
  }

  return Array.from(bySymbol.values());
}

function sameUtcDay(timestamp: number, nowMs: number): boolean {
  if (!Number.isFinite(timestamp) || !Number.isFinite(nowMs)) return false;
  const left = new Date(timestamp);
  const right = new Date(nowMs);
  return left.getUTCFullYear() === right.getUTCFullYear()
    && left.getUTCMonth() === right.getUTCMonth()
    && left.getUTCDate() === right.getUTCDate();
}

function inferDurationMinutes(halt: TradingHalt): number | null {
  const haltMs = parseTimestamp(halt.haltTime);
  const resumeMs = parseTimestamp(halt.resumptionTime);
  if (!Number.isFinite(haltMs) || !Number.isFinite(resumeMs)) return null;
  return Math.round((resumeMs - haltMs) / 60000);
}

function trimSymbolHistoryEntry(halt: TradingHalt): Record<string, unknown> {
  const haltTime = typeof halt.haltTime === 'string' ? halt.haltTime : '';
  return {
    date: haltTime.includes('T') ? haltTime.split('T')[0] : haltTime || null,
    haltTime: halt.haltTime,
    resumptionTime: halt.resumptionTime ?? null,
    duration: inferDurationMinutes(halt),
    code: halt.haltCode,
    description: halt.haltDescription,
    market: halt.market,
    source: halt.source,
    status: halt.status,
  };
}

export function summarizeTradingHalts(
  payload: unknown,
  now: Date | string = new Date(),
): unknown {
  const halts = payload && typeof payload === 'object' && Array.isArray((payload as TradingHaltsPayload).halts)
    ? ((payload as TradingHaltsPayload).halts as unknown[]).filter((halt): halt is TradingHalt => halt != null && typeof halt === 'object')
    : [];

  if (halts.length === 0) return payload;

  const nowMs = typeof now === 'string' ? parseTimestamp(now) : now.getTime();
  const deduped = dedupeTradingHalts(halts).sort(compareByRecency);
  const duplicateRowsRemoved = halts.length - deduped.length;
  const activeHalts = uniqueLatestActiveHalts(deduped.filter(isActiveHalt));
  const olderActiveRowsCollapsed = deduped.filter(isActiveHalt).length - activeHalts.length;
  const todayHalts = deduped.filter((halt) => sameUtcDay(parseTimestamp(halt.haltTime), nowMs));
  const recentMaterialHalts = deduped
    .filter((halt) => !isActiveHalt(halt) && isMaterialHalt(halt))
    .slice(0, MAX_RECENT_MATERIAL);
  const recentVolatilityHalts = uniqueRecentVolatilityHalts(
    deduped.filter((halt) => !isActiveHalt(halt) && isVolatilityHalt(halt)),
    MAX_RECENT_VOLATILITY,
  );
  const summary = payload && typeof payload === 'object' && (payload as TradingHaltsPayload).summary && typeof (payload as TradingHaltsPayload).summary === 'object'
    ? { ...((payload as TradingHaltsPayload).summary as Record<string, unknown>) }
    : {};

  const omittedVolatilityCount = deduped.filter((halt) => !isActiveHalt(halt) && isVolatilityHalt(halt)).length - recentVolatilityHalts.length;
  const haltsMeta: Record<string, number | boolean> = {};
  if (duplicateRowsRemoved > 0) haltsMeta.duplicateRowsRemoved = duplicateRowsRemoved;
  if (activeHalts.length > 0) haltsMeta.activeHaltsPrioritized = activeHalts.length;
  if (olderActiveRowsCollapsed > 0) haltsMeta.olderActiveRowsCollapsed = olderActiveRowsCollapsed;
  if (omittedVolatilityCount > 0) haltsMeta.condensedResumedVolatility = omittedVolatilityCount;

  return {
    summary: {
      ...summary,
      activeHalts: activeHalts.length,
      todayHalts: todayHalts.length,
      totalHalts: deduped.length,
      duplicateRowsRemoved,
      olderActiveRowsCollapsed,
    },
    activeHalts: activeHalts.map(trimHalt),
    recentMaterialHalts: recentMaterialHalts.map(trimHalt),
    recentVolatilityHalts: recentVolatilityHalts.map(trimHalt),
    ...(Object.keys(haltsMeta).length > 0 ? { _halts_meta: haltsMeta } : {}),
  };
}

export function summarizeSymbolTradingHalts(payload: unknown): unknown {
  const symbol = payload && typeof payload === 'object' && typeof (payload as SymbolTradingHaltPayload).symbol === 'string'
    ? ((payload as SymbolTradingHaltPayload).symbol as string).toUpperCase()
    : undefined;
  const history = payload && typeof payload === 'object' && Array.isArray((payload as SymbolTradingHaltPayload).history)
    ? ((payload as SymbolTradingHaltPayload).history as unknown[]).filter((halt): halt is Record<string, unknown> => halt != null && typeof halt === 'object')
    : [];

  if (history.length === 0) return payload;

  const normalizedHalts: TradingHalt[] = history.map((entry) => ({
    symbol,
    haltTime: typeof entry.haltTime === 'string' ? entry.haltTime : undefined,
    resumptionTime: typeof entry.resumptionTime === 'string' ? entry.resumptionTime : null,
    haltCode: typeof entry.code === 'string' ? entry.code : undefined,
    haltDescription: typeof entry.description === 'string' ? entry.description : undefined,
    market: typeof entry.market === 'string' ? entry.market : undefined,
    source: typeof entry.source === 'string' ? entry.source : undefined,
    status: typeof entry.resumptionTime === 'string' && entry.resumptionTime ? 'Resumed' : 'Halted',
  }));

  const deduped = dedupeTradingHalts(normalizedHalts).sort(compareByRecency);
  const duplicateRowsRemoved = normalizedHalts.length - deduped.length;
  const activeHalts = uniqueLatestActiveHalts(deduped.filter(isActiveHalt));
  const olderActiveRowsCollapsed = deduped.filter(isActiveHalt).length - activeHalts.length;
  const resumedHalts = deduped.filter((halt) => !isActiveHalt(halt));
  const visibleHistory = [...activeHalts, ...resumedHalts].sort(compareByRecency);
  const summary = payload && typeof payload === 'object' && (payload as SymbolTradingHaltPayload).summary && typeof (payload as SymbolTradingHaltPayload).summary === 'object'
    ? { ...((payload as SymbolTradingHaltPayload).summary as Record<string, unknown>) }
    : {};
  const durations = resumedHalts
    .map(inferDurationMinutes)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const haltsMeta: Record<string, number | boolean> = {};

  if (duplicateRowsRemoved > 0) haltsMeta.duplicateRowsRemoved = duplicateRowsRemoved;
  if (olderActiveRowsCollapsed > 0) {
    haltsMeta.showingLatestUnresolvedOnly = true;
    haltsMeta.olderActiveRowsCollapsed = olderActiveRowsCollapsed;
  }

  return {
    symbol,
    summary: {
      ...summary,
      totalHalts: visibleHistory.length,
      activeHalts: activeHalts.length,
      currentlyHalted: activeHalts.length > 0,
      latestHaltTime: visibleHistory[0]?.haltTime ?? null,
      duplicateRowsRemoved,
      olderActiveRowsCollapsed,
      avgDuration: durations.length > 0 ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
      newsHalts: visibleHistory.filter((halt) => isMaterialHalt(halt)).length,
      volatilityHalts: visibleHistory.filter((halt) => isVolatilityHalt(halt)).length,
    },
    activeHalt: activeHalts[0] ? trimSymbolHistoryEntry(activeHalts[0]) : null,
    history: visibleHistory.map(trimSymbolHistoryEntry),
    ...(Object.keys(haltsMeta).length > 0 ? { _halts_meta: haltsMeta } : {}),
  };
}
