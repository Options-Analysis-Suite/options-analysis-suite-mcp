type WeeklyPoint = {
  weekEnding?: string;
  totalShares?: number;
  totalTrades?: number;
  averageSharesPerTrade?: number;
  marketMakers?: string;
};

type VenuePayload = {
  [key: string]: unknown;
  symbol?: string;
  weeklyData?: unknown;
  summary?: unknown;
};

type DarkPoolResponse = {
  [key: string]: unknown;
  otcTrading?: unknown;
  atsData?: unknown;
};

const DEFAULT_RECENT_CAP = 12;
const DEFAULT_TREND_CAP = 8;

function round(value: unknown, decimals = 2): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Number(value.toFixed(decimals));
}

function sortNewestFirst(points: unknown): WeeklyPoint[] {
  if (!Array.isArray(points)) return [];
  return points
    .filter((point): point is WeeklyPoint => point != null && typeof point === 'object')
    .slice()
    .sort((left, right) => (right.weekEnding ?? '').localeCompare(left.weekEnding ?? ''));
}

function pickEvenlySpaced<T>(items: T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return [];
  if (count === 1) return [items[0]];
  if (items.length <= count) return items;
  const chosen: T[] = [];
  const used = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    const position = Math.round((index * (items.length - 1)) / (count - 1));
    if (used.has(position)) continue;
    used.add(position);
    chosen.push(items[position]);
  }
  return chosen;
}

function avg(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function compactWeeklyPoint(point: WeeklyPoint): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    weekEnding: point.weekEnding,
    totalShares: round(point.totalShares, 0),
    totalTrades: round(point.totalTrades, 0),
    averageSharesPerTrade: round(point.averageSharesPerTrade, 0),
  };
  if (point.marketMakers && point.marketMakers !== 'N/A') {
    compact.marketMakers = point.marketMakers;
  }
  return compact;
}

function deriveSummary(points: WeeklyPoint[], existingSummary: unknown): Record<string, unknown> | undefined {
  if (points.length === 0 && (existingSummary == null || typeof existingSummary !== 'object')) return undefined;

  const recentWindow = points.slice(0, 4);
  const priorWindow = points.slice(4, 8);
  const shareSeries = points
    .map((point) => point.totalShares)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const tradeSeries = points
    .map((point) => point.totalTrades)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const avgTradeSeries = points
    .map((point) => point.averageSharesPerTrade)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  const recentShareAvg = avg(recentWindow.map((point) => point.totalShares).filter((value): value is number => typeof value === 'number'));
  const priorShareAvg = avg(priorWindow.map((point) => point.totalShares).filter((value): value is number => typeof value === 'number'));
  const recentTradeAvg = avg(recentWindow.map((point) => point.totalTrades).filter((value): value is number => typeof value === 'number'));
  const priorTradeAvg = avg(priorWindow.map((point) => point.totalTrades).filter((value): value is number => typeof value === 'number'));

  return {
    ...(existingSummary && typeof existingSummary === 'object' ? existingSummary as Record<string, unknown> : {}),
    latestWeek: points[0]?.weekEnding,
    avgWeeklyShares: round(avg(shareSeries), 0),
    avgWeeklyTrades: round(avg(tradeSeries), 0),
    avgSharesPerTrade: round(avg(avgTradeSeries), 0),
    shareTrendPct: round(
      typeof recentShareAvg === 'number' && typeof priorShareAvg === 'number' && priorShareAvg !== 0
        ? ((recentShareAvg - priorShareAvg) / priorShareAvg) * 100
        : undefined,
    ),
    tradeTrendPct: round(
      typeof recentTradeAvg === 'number' && typeof priorTradeAvg === 'number' && priorTradeAvg !== 0
        ? ((recentTradeAvg - priorTradeAvg) / priorTradeAvg) * 100
        : undefined,
    ),
  };
}

export function summarizeDarkPoolVenue(
  payload: unknown,
  recentCap = DEFAULT_RECENT_CAP,
  trendCap = DEFAULT_TREND_CAP,
): unknown {
  if (payload == null || typeof payload !== 'object') return payload;
  const venue = payload as VenuePayload;
  const sorted = sortNewestFirst(venue.weeklyData);
  if (sorted.length === 0) return payload;

  const recent = sorted.slice(0, recentCap);
  const recentDates = new Set(recent.map((point) => point.weekEnding));
  const trendSample = pickEvenlySpaced(sorted, trendCap)
    .filter((point) => !recentDates.has(point.weekEnding))
    .map(compactWeeklyPoint);

  return {
    symbol: venue.symbol,
    summary: deriveSummary(sorted, venue.summary),
    weeklyData: recent.map(compactWeeklyPoint),
    trendSample,
    _weeklyData_meta: sorted.length > recent.length
      ? {
          summarized: true,
          recent_weeks: recent.length,
          trend_samples: trendSample.length,
          total_weeks: sorted.length,
        }
      : undefined,
  };
}

export function summarizeDarkPoolResponse(payload: unknown): unknown {
  if (payload == null || typeof payload !== 'object') return payload;
  const response = payload as DarkPoolResponse;
  return {
    ...response,
    otcTrading: summarizeDarkPoolVenue(response.otcTrading),
    atsData: summarizeDarkPoolVenue(response.atsData),
  };
}
