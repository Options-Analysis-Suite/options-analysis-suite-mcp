type EarningsRow = {
  [key: string]: unknown;
  date?: string;
  epsActual?: number | null;
  epsEstimated?: number | null;
  revenueActual?: number | null;
  revenueEstimated?: number | null;
};

type EarningsPayload = {
  [key: string]: unknown;
  symbol?: string;
  earnings_history?: unknown;
  fetched_at?: string;
};

const RECENT_EARNINGS_WINDOW_DAYS = 550;

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseDate(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecentlyRelevant(date: unknown, nowMs: number): boolean {
  const parsed = parseDate(date);
  if (parsed == null || !Number.isFinite(nowMs)) return false;
  return Math.abs(parsed - nowMs) <= RECENT_EARNINGS_WINDOW_DAYS * 86400000;
}

function isMeaningfulRow(row: EarningsRow, nowMs: number): boolean {
  const epsActual = asFiniteNumber(row.epsActual);
  const epsEstimated = asFiniteNumber(row.epsEstimated);
  const revenueActual = asFiniteNumber(row.revenueActual);
  const revenueEstimated = asFiniteNumber(row.revenueEstimated);

  const hasPairedEps = epsActual != null && epsEstimated != null;
  const hasPairedRevenue = revenueActual != null && revenueEstimated != null;
  const hasAnyRevenue = revenueActual != null || revenueEstimated != null;
  const hasAnyEps = epsActual != null || epsEstimated != null;

  if (hasPairedEps || hasPairedRevenue) return true;
  if ((hasAnyRevenue || hasAnyEps) && isRecentlyRelevant(row.date, nowMs)) return true;
  return false;
}

function surprisePercent(actual: number | null, estimate: number | null): number | null {
  if (actual == null || estimate == null || estimate === 0) return null;
  return ((actual - estimate) / Math.abs(estimate)) * 100;
}

export function summarizeEarnings(payload: unknown, historyLimit = 8, now: Date | string = new Date()): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const typed = payload as EarningsPayload;
  const rows = Array.isArray(typed.earnings_history)
    ? typed.earnings_history.filter((row): row is EarningsRow => row != null && typeof row === 'object')
    : [];

  const nowMs = typeof now === 'string' ? (parseDate(now) ?? Date.now()) : now.getTime();
  const meaningfulRows = rows.filter((row) => isMeaningfulRow(row, nowMs));
  if (meaningfulRows.length === 0) {
    return {
      symbol: typed.symbol,
      earnings_history: [],
      fetched_at: typed.fetched_at,
      _earnings_note: 'No meaningful corporate earnings records were available for this symbol. It may be an ETF, fund, index, or another instrument without company earnings data.',
    };
  }

  const cappedRows = meaningfulRows.slice(0, historyLimit);
  const upcoming = meaningfulRows.find((row) =>
    asFiniteNumber(row.epsActual) == null
      && asFiniteNumber(row.revenueActual) == null
      && (asFiniteNumber(row.epsEstimated) != null || asFiniteNumber(row.revenueEstimated) != null));
  const recent = meaningfulRows.find((row) =>
    asFiniteNumber(row.epsActual) != null || asFiniteNumber(row.revenueActual) != null);
  const completedRows = meaningfulRows.filter((row) =>
    asFiniteNumber(row.epsActual) != null && asFiniteNumber(row.epsEstimated) != null);
  const avgEpsSurprisePct = completedRows.length > 0
    ? completedRows
      .map((row) => surprisePercent(asFiniteNumber(row.epsActual), asFiniteNumber(row.epsEstimated)))
      .filter((value): value is number => value != null)
      .reduce((sum, value) => sum + value, 0) / completedRows.length
    : null;

  return {
    ...typed,
    earnings_history: cappedRows,
    summary: {
      totalMeaningfulQuarters: meaningfulRows.length,
      upcoming: upcoming ? {
        date: upcoming.date,
        epsEstimated: upcoming.epsEstimated ?? null,
        revenueEstimated: upcoming.revenueEstimated ?? null,
      } : null,
      latestReported: recent ? {
        date: recent.date,
        epsActual: recent.epsActual ?? null,
        epsEstimated: recent.epsEstimated ?? null,
        epsSurprisePct: surprisePercent(asFiniteNumber(recent.epsActual), asFiniteNumber(recent.epsEstimated)),
        revenueActual: recent.revenueActual ?? null,
        revenueEstimated: recent.revenueEstimated ?? null,
        revenueSurprisePct: surprisePercent(asFiniteNumber(recent.revenueActual), asFiniteNumber(recent.revenueEstimated)),
      } : null,
      averageEpsSurprisePct: avgEpsSurprisePct,
    },
    _earnings_history_meta: meaningfulRows.length > historyLimit
      ? { showing: historyLimit, total: meaningfulRows.length, truncated: true }
      : undefined,
  };
}
