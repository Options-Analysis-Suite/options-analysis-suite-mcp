type EstimateEntry = {
  date?: string;
  epsAvg?: number;
  epsLow?: number;
  epsHigh?: number;
  revenueAvg?: number;
  revenueLow?: number;
  revenueHigh?: number;
  numAnalystsEps?: number;
  numAnalystsRevenue?: number;
};

type HistoricalRatingEntry = {
  date?: string;
  rating?: string;
  overallScore?: number;
  priceToBookScore?: number;
  debtToEquityScore?: number;
  returnOnAssetsScore?: number;
  returnOnEquityScore?: number;
  priceToEarningsScore?: number;
  discountedCashFlowScore?: number;
};

type UpgradeDowngradeEntry = {
  date?: string;
  action?: string;
  newGrade?: string;
  previousGrade?: string;
  gradingCompany?: string;
};

type AnalystDataPayload = {
  [key: string]: unknown;
  symbol?: string;
  estimates?: unknown;
  price_target_summary?: unknown;
  price_target_consensus?: unknown;
  rating_snapshot?: unknown;
  historical_rating?: unknown;
  upgrades_downgrades?: unknown;
  fetched_at?: unknown;
};

type AnalystCompanyProfile = {
  [key: string]: unknown;
  company_name?: string;
  companyName?: string;
  is_etf?: boolean;
  isEtf?: boolean;
  description?: string;
  sector?: string;
  industry?: string;
};

const DEFAULT_ESTIMATE_CAP = 8;
const DEFAULT_RATING_STREAK_CAP = 10;
const DEFAULT_UPGRADE_CAP = 20;

function round(value: unknown, decimals = 2): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Number(value.toFixed(decimals));
}

function sortNewestFirst<T extends { date?: string }>(entries: unknown): T[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry): entry is T => entry != null && typeof entry === 'object')
    .slice()
    .sort((left, right) => (right.date ?? '').localeCompare(left.date ?? ''));
}

function sortRelevantEstimates(entries: unknown, now: Date | string = new Date()): EstimateEntry[] {
  if (!Array.isArray(entries)) return [];
  const today = typeof now === 'string'
    ? now.slice(0, 10)
    : now.toISOString().slice(0, 10);

  return entries
    .filter((entry): entry is EstimateEntry => entry != null && typeof entry === 'object')
    .slice()
    .sort((left, right) => {
      const leftDate = typeof left.date === 'string' ? left.date : '';
      const rightDate = typeof right.date === 'string' ? right.date : '';
      const leftFuture = leftDate >= today;
      const rightFuture = rightDate >= today;

      if (leftFuture !== rightFuture) return leftFuture ? -1 : 1;
      if (leftFuture) return leftDate.localeCompare(rightDate);
      return rightDate.localeCompare(leftDate);
    });
}

function compactEstimate(entry: EstimateEntry): Record<string, unknown> {
  return {
    date: entry.date,
    epsAvg: round(entry.epsAvg, 3),
    epsLow: round(entry.epsLow, 3),
    epsHigh: round(entry.epsHigh, 3),
    revenueAvg: round(entry.revenueAvg, 0),
    revenueLow: round(entry.revenueLow, 0),
    revenueHigh: round(entry.revenueHigh, 0),
    numAnalystsEps: entry.numAnalystsEps,
    numAnalystsRevenue: entry.numAnalystsRevenue,
  };
}

function compactUpgrade(entry: UpgradeDowngradeEntry): Record<string, unknown> {
  return {
    date: entry.date,
    action: entry.action,
    newGrade: entry.newGrade,
    previousGrade: entry.previousGrade,
    gradingCompany: entry.gradingCompany,
  };
}

function getRatingSignature(entry: HistoricalRatingEntry): string {
  return JSON.stringify({
    rating: entry.rating,
    overallScore: entry.overallScore,
    priceToBookScore: entry.priceToBookScore,
    debtToEquityScore: entry.debtToEquityScore,
    returnOnAssetsScore: entry.returnOnAssetsScore,
    returnOnEquityScore: entry.returnOnEquityScore,
    priceToEarningsScore: entry.priceToEarningsScore,
    discountedCashFlowScore: entry.discountedCashFlowScore,
  });
}

function summarizeHistoricalRatings(entries: unknown, cap = DEFAULT_RATING_STREAK_CAP): Record<string, unknown>[] {
  const sorted = sortNewestFirst<HistoricalRatingEntry>(entries);
  if (sorted.length === 0) return [];

  const streaks: Record<string, unknown>[] = [];
  let current = sorted[0];
  let throughDate = current.date;
  let count = 1;

  for (let index = 1; index < sorted.length; index += 1) {
    const next = sorted[index];
    if (getRatingSignature(next) === getRatingSignature(current)) {
      throughDate = next.date;
      count += 1;
      continue;
    }

    streaks.push({
      rating: current.rating,
      overallScore: current.overallScore,
      priceToBookScore: current.priceToBookScore,
      debtToEquityScore: current.debtToEquityScore,
      returnOnAssetsScore: current.returnOnAssetsScore,
      returnOnEquityScore: current.returnOnEquityScore,
      priceToEarningsScore: current.priceToEarningsScore,
      discountedCashFlowScore: current.discountedCashFlowScore,
      fromDate: current.date,
      throughDate,
      observationCount: count,
    });

    if (streaks.length >= cap) return streaks;

    current = next;
    throughDate = next.date;
    count = 1;
  }

  streaks.push({
    rating: current.rating,
    overallScore: current.overallScore,
    priceToBookScore: current.priceToBookScore,
    debtToEquityScore: current.debtToEquityScore,
    returnOnAssetsScore: current.returnOnAssetsScore,
    returnOnEquityScore: current.returnOnEquityScore,
    priceToEarningsScore: current.priceToEarningsScore,
    discountedCashFlowScore: current.discountedCashFlowScore,
    fromDate: current.date,
    throughDate,
    observationCount: count,
  });

  return streaks;
}

function normalizePriceTargetSummary(summary: unknown): unknown {
  if (summary == null || typeof summary !== 'object') return summary;
  const result = { ...(summary as Record<string, unknown>) };
  if (typeof result.publishers === 'string') {
    try {
      const parsed = JSON.parse(result.publishers);
      if (Array.isArray(parsed)) result.publishers = parsed;
    } catch {
      // Leave the original string untouched if it is not valid JSON.
    }
  }
  return result;
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isLikelyEtfProfile(profile: unknown): boolean {
  const data = getObject(profile) as AnalystCompanyProfile | null;
  if (!data) return false;
  if (data.is_etf === true || data.isEtf === true) return true;

  const text = [
    typeof data.company_name === 'string' ? data.company_name : null,
    typeof data.companyName === 'string' ? data.companyName : null,
    typeof data.description === 'string' ? data.description : null,
    typeof data.sector === 'string' ? data.sector : null,
    typeof data.industry === 'string' ? data.industry : null,
  ]
    .filter((value): value is string => !!value)
    .join(' ')
    .toLowerCase();

  return /\b(etf|fund|trust|asset management|spdr|ishares|invesco|vanguard)\b/.test(text);
}

export function summarizeAnalystData(
  payload: unknown,
  estimateCap = DEFAULT_ESTIMATE_CAP,
  ratingCap = DEFAULT_RATING_STREAK_CAP,
  upgradeCap = DEFAULT_UPGRADE_CAP,
  now: Date | string = new Date(),
  companyProfile?: unknown,
): unknown {
  if (payload == null || typeof payload !== 'object') return payload;
  const data = payload as AnalystDataPayload;

  const estimates = sortRelevantEstimates(data.estimates, now);
  const upgrades = sortNewestFirst<UpgradeDowngradeEntry>(data.upgrades_downgrades);
  const historicalRatings = sortNewestFirst<HistoricalRatingEntry>(data.historical_rating);
  const summarizedRatings = summarizeHistoricalRatings(historicalRatings, ratingCap);
  const normalizedPriceTargetSummary = normalizePriceTargetSummary(data.price_target_summary);
  const hasAnyCoverage = estimates.length > 0
    || upgrades.length > 0
    || historicalRatings.length > 0
    || normalizedPriceTargetSummary != null
    || data.price_target_consensus != null
    || data.rating_snapshot != null;

  if (!hasAnyCoverage) {
    return {
      symbol: data.symbol,
      estimates: [],
      price_target_summary: null,
      price_target_consensus: null,
      rating_snapshot: null,
      historical_rating: [],
      upgrades_downgrades: [],
      fetched_at: data.fetched_at,
      _analyst_note: isLikelyEtfProfile(companyProfile)
        ? 'No meaningful sell-side analyst coverage was available for this symbol. It may be an ETF, fund, index, or another instrument without company analyst coverage.'
        : 'No analyst ratings, price targets, or forward estimate coverage were available for this symbol.',
    };
  }

  return {
    symbol: data.symbol,
    estimates: estimates.slice(0, estimateCap).map(compactEstimate),
    _estimates_meta: estimates.length > estimateCap
      ? { showing: estimateCap, total: estimates.length, truncated: true }
      : undefined,
    price_target_summary: normalizedPriceTargetSummary,
    price_target_consensus: data.price_target_consensus,
    rating_snapshot: data.rating_snapshot,
    historical_rating: summarizedRatings,
    _historical_rating_meta: historicalRatings.length > summarizedRatings.length
      ? { collapsed: true, raw_observations: historicalRatings.length, streaks: summarizedRatings.length }
      : undefined,
    upgrades_downgrades: upgrades.slice(0, upgradeCap).map(compactUpgrade),
    _upgrades_downgrades_meta: upgrades.length > upgradeCap
      ? { showing: upgradeCap, total: upgrades.length, truncated: true }
      : undefined,
    fetched_at: data.fetched_at,
  };
}
