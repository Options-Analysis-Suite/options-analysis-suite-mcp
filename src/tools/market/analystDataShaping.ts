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
  grades_historical?: unknown;
  grades_historical_fetched_at?: unknown;
  price_target_news?: unknown;
  price_target_news_fetched_at?: unknown;
  fetched_at?: unknown;
};

type MonthlyRatingCounts = { date: string; strongBuy: number; buy: number; hold: number; sell: number; strongSell: number };
type PriceTargetEvent = {
  publishedDate: string;
  analystCompany: string | null;
  analystName: string | null;
  priceTarget: number;
  adjPriceTarget: number | null;
  priceWhenPosted: number | null;
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
/** The newest monthly count stands as the current one while its month is at most this many months back. */
const RATING_CURRENT_MONTHS = 2;
const RATING_HISTORY_MONTHS = 12;
const DEFAULT_PRICE_TARGET_CAP = 10;
const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
const RATINGS_NOT_FETCHED = 'The monthly analyst rating counts have not been fetched for this symbol yet.';
const TARGETS_NOT_FETCHED = 'Individual price targets have not been fetched for this symbol yet.';
const RATING_KEYS = ['strongBuy', 'buy', 'hold', 'sell', 'strongSell'] as const;

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

  // Walked newest first, so a streak starts at its newest observation
  // (throughDate) and each older match moves fromDate back.
  const streaks: Record<string, unknown>[] = [];
  let current = sorted[0];
  let throughDate = current.date;
  let fromDate = current.date;
  let count = 1;

  for (let index = 1; index < sorted.length; index += 1) {
    const next = sorted[index];
    if (getRatingSignature(next) === getRatingSignature(current)) {
      fromDate = next.date;
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
      fromDate,
      throughDate,
      observationCount: count,
    });

    if (streaks.length >= cap) return streaks;

    current = next;
    throughDate = next.date;
    fromDate = next.date;
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
    fromDate,
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

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isPositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const DAY = /^\d{4}-\d{2}-\d{2}/;

/** The stored monthly analyst rating counts (sql/182), newest first, one per month; a malformed row is left out. */
function ratingRows(raw: unknown): MonthlyRatingCounts[] {
  if (!Array.isArray(raw)) return [];
  const byMonth = new Map<string, MonthlyRatingCounts>();
  for (const r of raw) {
    if (!r || typeof r !== 'object' || typeof r.date !== 'string' || !DAY.test(r.date)) continue;
    if (!RATING_KEYS.every(k => isCount(r[k]))) continue;
    const month = r.date.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, { date: r.date.slice(0, 10), strongBuy: r.strongBuy, buy: r.buy, hold: r.hold, sell: r.sell, strongSell: r.strongSell });
  }
  return [...byMonth.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

const countsOf = (r: MonthlyRatingCounts) => ({
  month: r.date.slice(0, 7),
  strongBuy: r.strongBuy, buy: r.buy, hold: r.hold, sell: r.sell, strongSell: r.strongSell,
  total: r.strongBuy + r.buy + r.hold + r.sell + r.strongSell,
});

/**
 * How many analysts rate the stock at each level, from the monthly counts:
 * the newest month up to `now`'s as `rating_counts` while it is recent (a
 * company whose coverage stopped keeps its last rows, UUU's newest is 2024-11,
 * and that is said in `rating_counts_note`, never given as current), and the
 * 12 months to the newest one as `rating_history`, newest first, with the
 * months not on file named (a gap, never zeros). A column never fetched (null)
 * is said to be so, never read as no counts.
 */
export function summarizeRatingCounts(raw: unknown, now: Date | string = new Date()): Record<string, unknown> {
  if (!Array.isArray(raw)) return { rating_counts: null, rating_counts_note: RATINGS_NOT_FETCHED };
  const nowMonth = (typeof now === 'string' ? now : now.toISOString()).slice(0, 7);
  const rows = ratingRows(raw).filter(r => r.date.slice(0, 7) <= nowMonth);
  if (rows.length === 0) return { rating_counts: null, rating_counts_note: 'No monthly analyst rating counts are on file for this symbol.' };
  const newest = rows[0];
  const current = monthsBetween(newest.date.slice(0, 7), nowMonth) <= RATING_CURRENT_MONTHS;
  const oldestMonth = addMonths(newest.date.slice(0, 7), -(RATING_HISTORY_MONTHS - 1));
  const history = rows.filter(r => r.date.slice(0, 7) >= oldestMonth);
  const onFile = new Set(history.map(r => r.date.slice(0, 7)));
  const missingMonths = Array.from({ length: RATING_HISTORY_MONTHS }, (_, i) => addMonths(oldestMonth, i)).filter(m => !onFile.has(m));
  return {
    rating_counts: current ? countsOf(newest) : null,
    ...(current ? {} : { rating_counts_note: `The newest monthly count of analyst ratings on file is for ${newest.date.slice(0, 7)}; there is none since, so no current count is given.` }),
    rating_history: history.map(countsOf),
    _rating_history_meta: { months: RATING_HISTORY_MONTHS, through: newest.date.slice(0, 7), missingMonths },
  };
}

/** The stored price targets (sql/182), newest first; a malformed event is left out. */
function priceTargetEvents(raw: unknown): PriceTargetEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, any> => !!r && typeof r === 'object' && typeof r.publishedDate === 'string' && DAY.test(r.publishedDate) && isPositive(r.priceTarget))
    .map(r => ({
      publishedDate: r.publishedDate,
      analystCompany: typeof r.analystCompany === 'string' && r.analystCompany.trim() ? r.analystCompany.trim() : null,
      analystName: typeof r.analystName === 'string' && r.analystName.trim() ? r.analystName.trim() : null,
      priceTarget: r.priceTarget,
      adjPriceTarget: isPositive(r.adjPriceTarget) ? r.adjPriceTarget : null,
      priceWhenPosted: isPositive(r.priceWhenPosted) ? r.priceWhenPosted : null,
    }))
    .sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));
}

/**
 * The individual price targets published in the year to `now`, newest first,
 * up to `cap`, with how many the year holds on file. That count is the year's
 * whole count only when the list on file reaches back past the year
 * (`countComplete`): a shorter list can be the whole list or a page of 100 cut
 * short by events the sync dropped, and the list does not say which. An event
 * dated more than a day after `now` counts for nothing. A column never fetched
 * (null) is said to be so, never read as no targets.
 */
export function summarizePriceTargets(raw: unknown, now: Date | string = new Date(), cap = DEFAULT_PRICE_TARGET_CAP): Record<string, unknown> {
  if (!Array.isArray(raw)) return { price_targets: null, price_targets_note: TARGETS_NOT_FETCHED };
  const nowMs = typeof now === 'string' ? Date.parse(now) : now.getTime();
  const since = nowMs - YEAR_MS;
  const events = priceTargetEvents(raw).filter(e => Date.parse(e.publishedDate) <= nowMs + DAY_MS);
  if (events.length === 0) return { price_targets: [], price_targets_note: 'No individual price targets are on file for this symbol.' };
  const inYear = events.filter(e => Date.parse(e.publishedDate) >= since);
  const countComplete = Date.parse(events[events.length - 1].publishedDate) < since;
  return {
    price_targets: inYear.slice(0, cap).map(e => ({
      date: e.publishedDate.slice(0, 10),
      firm: e.analystCompany,
      analyst: e.analystName,
      priceTarget: e.priceTarget,
      ...(e.adjPriceTarget !== null && e.adjPriceTarget !== e.priceTarget ? { splitAdjustedPriceTarget: e.adjPriceTarget } : {}),
      priceWhenPosted: e.priceWhenPosted,
    })),
    _price_targets_meta: {
      showing: Math.min(cap, inYear.length),
      publishedLast12Months: inYear.length,
      countComplete,
      ...(inYear.length === 0 ? { newestOnFile: events[0].publishedDate.slice(0, 10) } : {}),
    },
  };
}

const currencyCode = (value: unknown): string | null => {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : null;
};

/**
 * The currency of the estimates. They carry none of their own and come in the
 * company's reporting currency, which its newest statement names (the route's
 * reported_currency): TSM's revenue estimates are TWD (391B for 2010) beside
 * a listing trading in USD. Refreshed apart from the statements, so around a
 * change of reporting currency the two can disagree. The price targets are in
 * the listing's currency (across the 264 foreign reporters with a consensus
 * target, target / 52-week high has the same median as US companies, 0.90
 * against 0.97).
 */
export function estimatesCurrencyContext(payload: unknown, companyProfile: unknown): Record<string, unknown> {
  const data = payload != null && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  const profile = companyProfile != null && typeof companyProfile === 'object' ? companyProfile as Record<string, unknown> : null;
  const reported = currencyCode(data?.reported_currency);
  const asOf = typeof data?.reported_currency_as_of === 'string' && /^\d{4}-\d{2}-\d{2}/.test(data.reported_currency_as_of) ? data.reported_currency_as_of.slice(0, 10) : null;
  const trading = currencyCode(profile?.currency);
  if (!reported && !trading) return {};
  const differ = reported !== null && trading !== null && reported !== trading;
  const statement = asOf ? `its newest statement on file (${asOf})` : 'its newest statement on file';
  return {
    estimates_currency: { reported, reportedAsOf: reported ? asOf : null, trading },
    ...(differ ? {
      estimates_currency_note: `The estimates carry no currency of their own: they are normally in the company's reporting currency, ${reported} by ${statement}, `
        + `but they are refreshed apart from the statements, so around a change of reporting currency the two can disagree. The price targets are in the listing's currency, ${trading}.`,
    } : {}),
  };
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
  const ratingCounts = summarizeRatingCounts(data.grades_historical, now);
  const priceTargets = summarizePriceTargets(data.price_target_news, now);
  const extrasUnfetched = !Array.isArray(data.grades_historical) || !Array.isArray(data.price_target_news);
  // Each section's own fetch stamp (sql/182), in either view.
  const sectionStamps = {
    ...(typeof data.grades_historical_fetched_at === 'string' ? { rating_history_fetched_at: data.grades_historical_fetched_at } : {}),
    ...(typeof data.price_target_news_fetched_at === 'string' ? { price_targets_fetched_at: data.price_target_news_fetched_at } : {}),
  };
  const hasAnyCoverage = estimates.length > 0
    || Array.isArray(ratingCounts.rating_history)
    || (Array.isArray(priceTargets.price_targets) && priceTargets.price_targets.length > 0)
    || priceTargets._price_targets_meta !== undefined
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
      ...ratingCounts,
      ...priceTargets,
      fetched_at: data.fetched_at,
      ...sectionStamps,
      // Sections never fetched (their columns null) are not "no coverage":
      // the note says what is on file and what is not known yet.
      _analyst_note: extrasUnfetched
        ? 'No forward estimates, price-target summaries, rating snapshot or rating changes are on file for this symbol, and its monthly rating counts or individual price targets have not been fetched yet, so its analyst coverage is not known.'
        : isLikelyEtfProfile(companyProfile)
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
    ...ratingCounts,
    ...priceTargets,
    fetched_at: data.fetched_at,
    ...sectionStamps,
    ...(estimates.length > 0 ? estimatesCurrencyContext(data, companyProfile) : {}),
  };
}
