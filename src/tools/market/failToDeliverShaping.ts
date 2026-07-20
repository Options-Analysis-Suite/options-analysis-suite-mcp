type FtdRow = {
  date?: string;
  quantity?: number | string | null;
  price?: number | string | null;
  value?: number | string | null;
  onThresholdList?: boolean | null;
  thresholdSource?: string | null;
  [key: string]: unknown;
};

type FtdResponse = {
  symbol?: string;
  data?: FtdRow[];
  summary?: Record<string, unknown>;
  [key: string]: unknown;
};

const DEFAULT_RECENT_CAP = 8;
const DEFAULT_SPIKE_CAP = 5;
const DEFAULT_TREND_CAP = 4;

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function pickEvenlySpaced<T>(rows: T[], count: number): T[] {
  if (count <= 0 || rows.length <= count) {
    return rows.slice();
  }

  const picks: T[] = [];
  const step = (rows.length - 1) / (count - 1);
  const used = new Set<number>();

  for (let i = 0; i < count; i++) {
    const index = Math.round(i * step);
    if (!used.has(index)) {
      picks.push(rows[index]);
      used.add(index);
    }
  }

  return picks;
}

function describeTrend(trendPct: number): string {
  if (trendPct >= 50) return 'surging';
  if (trendPct >= 10) return 'rising';
  if (trendPct <= -50) return 'collapsing';
  if (trendPct <= -10) return 'falling';
  return 'stable';
}

function normalizeRow(row: FtdRow): Record<string, unknown> {
  const quantity = toNumber(row.quantity) ?? 0;
  const price = toNumber(row.price);
  const value = toNumber(row.value) ?? (price != null ? quantity * price : null);

  return {
    date: row.date ?? null,
    quantity,
    price,
    value: value != null ? round(value, 2) : null,
    onThresholdList: Boolean(row.onThresholdList),
    thresholdSource: row.thresholdSource ?? 'none',
  };
}

export function summarizeFailToDeliver(
  payload: FtdResponse,
  recentCap = DEFAULT_RECENT_CAP,
  spikeCap = DEFAULT_SPIKE_CAP,
  trendCap = DEFAULT_TREND_CAP,
): Record<string, unknown> {
  const rows = Array.isArray(payload.data)
    ? payload.data.map(normalizeRow)
    : [];

  if (rows.length === 0) {
    return {
      symbol: payload.symbol ?? null,
      summary: {
        totalDataPoints: 0,
        totalFTDShares: 0,
        totalFTDValue: 0,
        avgFTDShares: 0,
        maxFTDShares: 0,
        maxFTDDate: null,
        recentTrendPct: 0,
        recentTrend: 'stable',
        latestFTD: null,
        dateRange: { start: null, end: null },
        daysOnThreshold: 0,
      },
      recentHistory: [],
      notableSpikes: [],
      thresholdEvents: [],
      trendSample: [],
    };
  }

  const recentHistory = rows.slice(0, recentCap);
  const trendSample = rows.length > recentCap
    ? pickEvenlySpaced(rows, Math.min(trendCap, rows.length))
    : [];
  const notableSpikes = rows
    .slice()
    .sort((a, b) => (Number(b.quantity) || 0) - (Number(a.quantity) || 0))
    .slice(0, spikeCap)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const thresholdEvents = rows.filter((row) => row.onThresholdList).slice(0, spikeCap);

  const totalFTDShares = rows.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
  const totalFTDValue = rows.reduce((sum, row) => sum + (Number(row.value) || 0), 0);
  const avgFTDShares = rows.length > 0 ? totalFTDShares / rows.length : 0;
  const latestQuantity = Number(rows[0]?.quantity) || 0;
  const latestVsAveragePct = avgFTDShares > 0
    ? ((latestQuantity - avgFTDShares) / avgFTDShares) * 100
    : 0;
  const summary = (payload.summary ?? {}) as Record<string, unknown>;
  const trendPct = toNumber(summary.trend) ?? 0;

  return {
    symbol: payload.symbol ?? null,
    latestFTD: rows[0],
    summary: {
      totalDataPoints: rows.length,
      totalFTDShares,
      totalFTDValue: round(totalFTDValue, 2),
      avgFTDShares: Math.round(avgFTDShares),
      latestVsAveragePct: round(latestVsAveragePct),
      maxFTDShares: toNumber(summary.maxFTDShares) ?? Math.max(...rows.map((row) => Number(row.quantity) || 0)),
      maxFTDDate: summary.maxFTDDate ?? rows[0]?.date ?? null,
      recentTrendPct: round(trendPct),
      recentTrend: describeTrend(trendPct),
      daysOnThreshold: toNumber(summary.daysOnThreshold) ?? thresholdEvents.length,
      latestFTD: rows[0],
      dateRange: summary.dateRange ?? {
        start: rows[rows.length - 1]?.date ?? null,
        end: rows[0]?.date ?? null,
      },
    },
    recentHistory,
    notableSpikes,
    thresholdEvents,
    trendSample,
    _recent_history_meta: { showing: recentHistory.length, total: rows.length, truncated: rows.length > recentHistory.length },
    _spikes_meta: { showing: notableSpikes.length, scope: 'requested_window', kind: 'highest_quantity' },
    ...(trendSample.length > 0
      ? {
          _trend_sample_meta: { samples: trendSample.length, total_rows: rows.length, evenly_spaced: true },
        }
      : {}),
    ...(thresholdEvents.length === 0
      ? { _threshold_note: 'No threshold-list overlap in the requested window.' }
      : {}),
  };
}
