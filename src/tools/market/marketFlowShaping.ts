type ShortVolumeRow = {
  [key: string]: unknown;
  date?: string;
  shortVolume?: number;
  shortInterest?: number;
  totalVolume?: number;
  shortPercent?: number | string | null;
  shortPercentage?: number | string | null;
  shortInterestPercentFloat?: number | string | null;
  shortExemptVolume?: number;
  markets?: string | string[];
};

type ShortVolumePayload = {
  [key: string]: unknown;
  symbol?: string;
  lastUpdate?: string;
  latest?: unknown;
  history?: unknown;
  averages?: unknown;
  yearStats?: unknown;
};

type ShortInterestRow = {
  [key: string]: unknown;
  settlementDate?: string;
  shortInterest?: number;
  previousShortInterest?: number;
  changeNumber?: number;
  changePercent?: number;
  avgDailyVolume?: number;
  daysToCover?: number;
  shortPercentOfFloat?: number | null;
};

type ShortInterestPayload = {
  [key: string]: unknown;
  symbol?: string;
  lastUpdate?: string;
  freeFloat?: number | null;
  sharesOutstanding?: number | null;
  latest?: unknown;
  history?: unknown;
  stats?: unknown;
};

type ShareFloatFallback = {
  freeFloat: number | null;
  sharesOutstanding: number | null;
};

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asPercentNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseFloat(trimmed.replace(/%/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function roundTo(value: number | null, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeMarkets(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim());
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function asArrayOfObjects<T extends Record<string, unknown>>(value: unknown): T[] {
  return Array.isArray(value)
    ? value.filter((item): item is T => item != null && typeof item === 'object')
    : [];
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function summarizeShortVolumeRow(row: ShortVolumeRow): Record<string, unknown> {
  const shortPercent = asPercentNumber(row.shortPercent)
    ?? asPercentNumber(row.shortPercentage)
    ?? asPercentNumber(row.shortInterestPercentFloat);
  return {
    date: typeof row.date === 'string' ? row.date : null,
    shortVolume: asFiniteNumber(row.shortVolume) ?? asFiniteNumber(row.shortInterest),
    totalVolume: asFiniteNumber(row.totalVolume),
    shortPercent: roundTo(shortPercent, 2),
    shortExemptVolume: asFiniteNumber(row.shortExemptVolume),
    markets: normalizeMarkets(row.markets),
  };
}

export function summarizeShortVolume(payload: unknown, historyLimit = 10): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const typed = payload as ShortVolumePayload;
  const history = asArrayOfObjects<ShortVolumeRow>(typed.history);
  const latestSource = typed.latest != null && typeof typed.latest === 'object'
    ? (typed.latest as ShortVolumeRow)
    : history[0];
  const latest = latestSource ? summarizeShortVolumeRow(latestSource) : null;
  const recentHistory = history.slice(0, historyLimit).map(summarizeShortVolumeRow);
  const shortPercents = recentHistory
    .map((row) => asPercentNumber(row.shortPercent))
    .filter((value): value is number => value != null);
  const trailingAverageShortPercent = asPercentNumber((typed.averages as Record<string, unknown> | undefined)?.avgShortPercentage)
    ?? (shortPercents.length > 0 ? shortPercents.reduce((sum, value) => sum + value, 0) / shortPercents.length : null);
  const latestShortPercent = latest ? asPercentNumber(latest.shortPercent) : null;
  const diffPctPoints = latestShortPercent != null && trailingAverageShortPercent != null
    ? latestShortPercent - trailingAverageShortPercent
    : null;
  const highestRecent = recentHistory.reduce<Record<string, unknown> | null>((best, row) => {
    const shortPercent = asPercentNumber(row.shortPercent);
    if (shortPercent == null) return best;
    if (!best || shortPercent > (asPercentNumber(best.shortPercent) ?? -Infinity)) return row;
    return best;
  }, null);
  const lowestRecent = recentHistory.reduce<Record<string, unknown> | null>((best, row) => {
    const shortPercent = asPercentNumber(row.shortPercent);
    if (shortPercent == null) return best;
    if (!best || shortPercent < (asPercentNumber(best.shortPercent) ?? Infinity)) return row;
    return best;
  }, null);

  return {
    symbol: typed.symbol,
    lastUpdate: typed.lastUpdate,
    latest,
    summary: {
      trailingAverageShortPercent: roundTo(trailingAverageShortPercent, 2),
      latestVsTrailingAveragePctPoints: roundTo(diffPctPoints, 2),
      recentTrend: diffPctPoints == null
        ? null
        : diffPctPoints >= 5
          ? 'elevated'
          : diffPctPoints <= -5
            ? 'below_average'
            : 'near_average',
      highestRecentShortPercent: highestRecent,
      lowestRecentShortPercent: lowestRecent,
    },
    recentHistory,
    trailingAverages: typed.averages ?? null,
    yearStats: typed.yearStats ?? null,
    _recent_history_meta: history.length > historyLimit
      ? { showing: historyLimit, total: history.length, truncated: true }
      : undefined,
  };
}

function summarizeShortInterestRow(row: ShortInterestRow): Record<string, unknown> {
  return {
    settlementDate: typeof row.settlementDate === 'string' ? row.settlementDate : null,
    shortInterest: asFiniteNumber(row.shortInterest),
    previousShortInterest: asFiniteNumber(row.previousShortInterest),
    changeNumber: asFiniteNumber(row.changeNumber),
    changePercent: roundTo(asFiniteNumber(row.changePercent), 2),
    avgDailyVolume: asFiniteNumber(row.avgDailyVolume),
    daysToCover: roundTo(asFiniteNumber(row.daysToCover), 2),
    shortPercentOfFloat: roundTo(asPercentNumber(row.shortPercentOfFloat), 2),
  };
}

function pickShareFloatFallback(payload: ShortInterestPayload, companyProfile?: unknown): ShareFloatFallback {
  const profile = getRecord(companyProfile);
  return {
    freeFloat: asFiniteNumber(payload.freeFloat)
      ?? asFiniteNumber(profile?.free_float_shares)
      ?? asFiniteNumber(profile?.freeFloat),
    sharesOutstanding: asFiniteNumber(payload.sharesOutstanding)
      ?? asFiniteNumber(profile?.shares_outstanding)
      ?? asFiniteNumber(profile?.sharesOutstanding),
  };
}

function enrichShortInterestRow(row: Record<string, unknown>, freeFloat: number | null): Record<string, unknown> {
  if (freeFloat == null || freeFloat <= 0 || row.shortPercentOfFloat != null) return row;
  const shortInterest = asFiniteNumber(row.shortInterest);
  if (shortInterest == null) return row;

  return {
    ...row,
    shortPercentOfFloat: roundTo((shortInterest / freeFloat) * 100, 2),
  };
}

export function summarizeShortInterest(payload: unknown, historyLimit = 8, companyProfile?: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const typed = payload as ShortInterestPayload;
  const shareFloat = pickShareFloatFallback(typed, companyProfile);
  const history = asArrayOfObjects<ShortInterestRow>(typed.history);
  const latestSource = typed.latest != null && typeof typed.latest === 'object'
    ? (typed.latest as ShortInterestRow)
    : history[0];
  const latest = latestSource
    ? enrichShortInterestRow(summarizeShortInterestRow(latestSource), shareFloat.freeFloat)
    : null;
  const recentHistory = history
    .slice(0, historyLimit)
    .map((row) => enrichShortInterestRow(summarizeShortInterestRow(row), shareFloat.freeFloat));
  const latestShortInterest = latest ? asFiniteNumber(latest.shortInterest) : null;
  const stats = typed.stats != null && typeof typed.stats === 'object'
    ? typed.stats as Record<string, unknown>
    : {};
  const avgShortInterest = asFiniteNumber(stats.avgShortInterest)
    ?? (() => {
      const values = history
        .map((row) => asFiniteNumber(row.shortInterest))
        .filter((value): value is number => value != null);
      return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    })();
  const latestVsAveragePct = latestShortInterest != null && avgShortInterest != null && avgShortInterest !== 0
    ? ((latestShortInterest - avgShortInterest) / avgShortInterest) * 100
    : null;
  const referenceRow = history[3] ?? history[history.length - 1];
  const referenceShortInterest = referenceRow ? asFiniteNumber(referenceRow.shortInterest) : null;
  const recentTrend = latestShortInterest != null && referenceShortInterest != null && referenceShortInterest !== 0
    ? ((latestShortInterest - referenceShortInterest) / referenceShortInterest) * 100
    : null;

  return {
    symbol: typed.symbol,
    lastUpdate: typed.lastUpdate,
    freeFloat: shareFloat.freeFloat,
    sharesOutstanding: shareFloat.sharesOutstanding,
    latest,
    summary: {
      periodsAvailable: asFiniteNumber(stats.periodsAvailable) ?? history.length,
      averageShortInterest: roundTo(avgShortInterest, 0),
      latestVsAveragePct: roundTo(latestVsAveragePct, 2),
      recentTrend: recentTrend == null
        ? null
        : recentTrend >= 5
          ? 'rising'
          : recentTrend <= -5
            ? 'falling'
            : 'stable',
      averageDaysToCover: roundTo(asFiniteNumber(stats.avgDaysToCover), 2),
      maxShortInterest: asFiniteNumber(stats.maxShortInterest),
      maxDate: typeof stats.maxDate === 'string' ? stats.maxDate : null,
      minShortInterest: asFiniteNumber(stats.minShortInterest),
      minDate: typeof stats.minDate === 'string' ? stats.minDate : null,
    },
    recentHistory,
    _recent_history_meta: history.length > historyLimit
      ? { showing: historyLimit, total: history.length, truncated: true }
      : undefined,
  };
}
