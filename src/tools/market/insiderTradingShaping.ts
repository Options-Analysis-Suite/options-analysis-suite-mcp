type RawInsiderTrade = {
  [key: string]: unknown;
  acquisitionOrDisposition?: string;
  directOrIndirect?: string;
  filingDate?: string;
  formType?: string;
  price?: number;
  reportingCik?: string;
  reportingName?: string;
  securitiesOwned?: number;
  securitiesTransacted?: number;
  securityName?: string;
  symbol?: string;
  transactionDate?: string;
  transactionType?: string;
  typeOfOwner?: string;
  url?: string;
};

type InsiderResponse = {
  [key: string]: unknown;
  fetched_at?: string;
  insider_trades?: unknown;
  symbol?: string;
};

type InstrumentProfile = {
  [key: string]: unknown;
  company_name?: string;
  companyName?: string;
  description?: string;
  sector?: string;
  industry?: string;
  is_etf?: boolean;
  isEtf?: boolean;
};

type TradeCategory =
  | 'open_market_buy'
  | 'open_market_sell'
  | 'tax_withholding'
  | 'exercise_or_conversion'
  | 'grant_or_award'
  | 'gift'
  | 'initial_holding'
  | 'other_acquisition'
  | 'other_disposition'
  | 'other';

type GroupedInsiderTrade = {
  acquisitionOrDisposition: string | null;
  category: TradeCategory;
  categoryLabel: string;
  directOrIndirect: string | null;
  filingDate: string | null;
  formType: string | null;
  price: number | null;
  rawCount: number;
  reportingName: string;
  sharesOwned: number | null;
  sharesTransacted: number;
  signalPriority: number;
  securityName: string | null;
  totalValue: number | null;
  transactionDate: string | null;
  typeOfOwner: string | null;
  url: string | null;
};

const MAX_DEFAULT_EVENTS = 10;
const COMMON_STOCK_HINTS = ['common stock', 'class a common stock', 'class b common stock'];

function normalizeText(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/\s+/g, ' ').trim()
    : '';
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseTradeCode(trade: RawInsiderTrade): string {
  const rawType = typeof trade.transactionType === 'string' ? trade.transactionType.trim() : '';
  if (!rawType) return '';
  return rawType.split('-')[0]!.toUpperCase();
}

function securityBucketName(securityName: string | undefined): string {
  const normalized = normalizeText(securityName);
  if (!normalized) return 'unknown_security';
  if (COMMON_STOCK_HINTS.some((hint) => normalized.includes(hint))) return 'common_stock';
  if (normalized.includes('restricted stock unit') || normalized.includes('rsu')) return 'rsu';
  if (normalized.includes('option')) return 'option';
  if (normalized.includes('preferred')) return 'preferred';
  return normalized.replace(/[^a-z0-9]+/g, '_').slice(0, 40);
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isLikelyEtfProfile(profile: unknown): boolean {
  const data = getObject(profile) as InstrumentProfile | null;
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

export function categorizeInsiderTrade(trade: RawInsiderTrade): TradeCategory {
  const formType = String(trade.formType ?? '').trim();
  if (formType === '3') return 'initial_holding';

  const code = parseTradeCode(trade);
  const acquisitionDisposition = String(trade.acquisitionOrDisposition ?? '').toUpperCase();

  switch (code) {
    case 'P':
      return 'open_market_buy';
    case 'S':
      return 'open_market_sell';
    case 'F':
      return 'tax_withholding';
    case 'M':
      return 'exercise_or_conversion';
    case 'A':
      return 'grant_or_award';
    case 'G':
      return 'gift';
    default:
      if (acquisitionDisposition === 'A') return 'other_acquisition';
      if (acquisitionDisposition === 'D') return 'other_disposition';
      return 'other';
  }
}

function categoryLabel(category: TradeCategory): string {
  switch (category) {
    case 'open_market_buy':
      return 'Open-market buy';
    case 'open_market_sell':
      return 'Open-market sell';
    case 'tax_withholding':
      return 'Tax withholding';
    case 'exercise_or_conversion':
      return 'Exercise or conversion';
    case 'grant_or_award':
      return 'Grant or award';
    case 'gift':
      return 'Gift';
    case 'initial_holding':
      return 'Initial holding';
    case 'other_acquisition':
      return 'Other acquisition';
    case 'other_disposition':
      return 'Other disposition';
    default:
      return 'Other activity';
  }
}

function signalPriority(category: TradeCategory): number {
  switch (category) {
    case 'open_market_buy':
      return 100;
    case 'open_market_sell':
      return 90;
    case 'tax_withholding':
      return 40;
    case 'exercise_or_conversion':
      return 35;
    case 'gift':
      return 25;
    case 'grant_or_award':
      return 20;
    case 'other_acquisition':
      return 15;
    case 'other_disposition':
      return 10;
    case 'initial_holding':
      return 5;
    default:
      return 0;
  }
}

function isSignalCategory(category: TradeCategory): boolean {
  return category === 'open_market_buy' || category === 'open_market_sell';
}

function pickRepresentativeSecurity(securityNames: Set<string>): string | null {
  if (securityNames.size === 0) return null;
  for (const candidate of securityNames) {
    if (securityBucketName(candidate) === 'common_stock') return candidate;
  }
  return Array.from(securityNames)[0] ?? null;
}

export function groupInsiderTrades(rawTrades: unknown): GroupedInsiderTrade[] {
  if (!Array.isArray(rawTrades)) return [];

  const groups = new Map<string, {
    acquisitionOrDisposition: Set<string>;
    category: TradeCategory;
    directOrIndirect: Set<string>;
    filingDate: string | null;
    formType: string | null;
    latestSharesOwned: number | null;
    pricedShares: number;
    rawCount: number;
    reportingName: string;
    securityNames: Set<string>;
    sharesTransacted: number;
    totalValue: number;
    transactionDate: string | null;
    typeOfOwner: string | null;
    url: string | null;
  }>();

  for (const item of rawTrades) {
    if (item == null || typeof item !== 'object') continue;
    const trade = item as RawInsiderTrade;
    const category = categorizeInsiderTrade(trade);
    const reportingName = typeof trade.reportingName === 'string' && trade.reportingName.trim()
      ? trade.reportingName.trim()
      : 'Unknown insider';
    const transactionDate = typeof trade.transactionDate === 'string' ? trade.transactionDate : null;
    const filingDate = typeof trade.filingDate === 'string' ? trade.filingDate : null;
    const securityName = typeof trade.securityName === 'string' ? trade.securityName : null;
    const key = [
      trade.reportingCik ?? reportingName,
      transactionDate ?? filingDate ?? 'unknown-date',
      category,
      securityBucketName(securityName ?? undefined),
      trade.url ?? '',
    ].join('|');

    const sharesTransacted = toFiniteNumber(trade.securitiesTransacted) ?? 0;
    const price = toFiniteNumber(trade.price);
    const totalValueContribution = price != null && sharesTransacted > 0 ? price * sharesTransacted : 0;
    const sharesOwned = toFiniteNumber(trade.securitiesOwned);
    const directOrIndirect = typeof trade.directOrIndirect === 'string' ? trade.directOrIndirect : null;
    const acquisitionOrDisposition = typeof trade.acquisitionOrDisposition === 'string'
      ? trade.acquisitionOrDisposition
      : null;

    const existing = groups.get(key) ?? {
      acquisitionOrDisposition: new Set<string>(),
      category,
      directOrIndirect: new Set<string>(),
      filingDate,
      formType: typeof trade.formType === 'string' ? trade.formType : null,
      latestSharesOwned: sharesOwned,
      pricedShares: 0,
      rawCount: 0,
      reportingName,
      securityNames: new Set<string>(),
      sharesTransacted: 0,
      totalValue: 0,
      transactionDate,
      typeOfOwner: typeof trade.typeOfOwner === 'string' ? trade.typeOfOwner : null,
      url: typeof trade.url === 'string' ? trade.url : null,
    };

    existing.rawCount += 1;
    existing.sharesTransacted += sharesTransacted;
    existing.totalValue += totalValueContribution;
    if (price != null && sharesTransacted > 0) {
      existing.pricedShares += sharesTransacted;
    }
    if (securityName) existing.securityNames.add(securityName);
    if (directOrIndirect) existing.directOrIndirect.add(directOrIndirect);
    if (acquisitionOrDisposition) existing.acquisitionOrDisposition.add(acquisitionOrDisposition);
    if (sharesOwned != null) existing.latestSharesOwned = sharesOwned;
    groups.set(key, existing);
  }

  const grouped = Array.from(groups.values()).map((group) => ({
    acquisitionOrDisposition: group.acquisitionOrDisposition.size === 1
      ? Array.from(group.acquisitionOrDisposition)[0] ?? null
      : null,
    category: group.category,
    categoryLabel: categoryLabel(group.category),
    directOrIndirect: group.directOrIndirect.size === 1
      ? Array.from(group.directOrIndirect)[0] ?? null
      : group.directOrIndirect.size > 1
        ? 'mixed'
        : null,
    filingDate: group.filingDate,
    formType: group.formType,
    price: group.pricedShares > 0 ? group.totalValue / group.pricedShares : null,
    rawCount: group.rawCount,
    reportingName: group.reportingName,
    sharesOwned: group.latestSharesOwned,
    sharesTransacted: group.sharesTransacted,
    signalPriority: signalPriority(group.category),
    securityName: pickRepresentativeSecurity(group.securityNames),
    totalValue: group.totalValue > 0 ? group.totalValue : null,
    transactionDate: group.transactionDate,
    typeOfOwner: group.typeOfOwner,
    url: group.url,
  }));

  grouped.sort((left, right) => {
    const rightDate = Date.parse(right.transactionDate ?? right.filingDate ?? '') || 0;
    const leftDate = Date.parse(left.transactionDate ?? left.filingDate ?? '') || 0;
    if (rightDate !== leftDate) return rightDate - leftDate;
    if (right.signalPriority !== left.signalPriority) return right.signalPriority - left.signalPriority;
    const rightValue = right.totalValue ?? 0;
    const leftValue = left.totalValue ?? 0;
    if (rightValue !== leftValue) return rightValue - leftValue;
    return (right.sharesTransacted ?? 0) - (left.sharesTransacted ?? 0);
  });

  return grouped;
}

function summarizeActivityCounts(groupedTrades: GroupedInsiderTrade[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const trade of groupedTrades) {
    const label = trade.categoryLabel ?? categoryLabel(trade.category);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

export function shapeInsiderTradingResponse(payload: unknown, companyProfile?: unknown): unknown {
  if (payload == null || typeof payload !== 'object') return payload;

  const response = { ...(payload as InsiderResponse) };
  const groupedTrades = groupInsiderTrades(response.insider_trades);
  const signalTrades = groupedTrades.filter((trade) => isSignalCategory(trade.category));
  const nonInitialTrades = groupedTrades.filter((trade) => trade.category !== 'initial_holding');

  const defaultTrades = signalTrades.length > 0
    ? signalTrades.slice(0, MAX_DEFAULT_EVENTS)
    : nonInitialTrades.slice(0, MAX_DEFAULT_EVENTS);

  const openMarketBuyValue = signalTrades
    .filter((trade) => trade.category === 'open_market_buy')
    .reduce((sum, trade) => sum + (trade.totalValue ?? 0), 0);
  const openMarketSellValue = signalTrades
    .filter((trade) => trade.category === 'open_market_sell')
    .reduce((sum, trade) => sum + (trade.totalValue ?? 0), 0);

  response.insider_trades = defaultTrades.map((trade) => ({
    reportingName: trade.reportingName,
    typeOfOwner: trade.typeOfOwner,
    categoryLabel: trade.categoryLabel,
    formType: trade.formType,
    transactionDate: trade.transactionDate,
    filingDate: trade.filingDate,
    securityName: trade.securityName,
    sharesTransacted: trade.sharesTransacted,
    price: trade.price,
    totalValue: trade.totalValue,
    directOrIndirect: trade.directOrIndirect,
    acquisitionOrDisposition: trade.acquisitionOrDisposition,
    sharesOwned: trade.sharesOwned,
    rawTradeCount: trade.rawCount,
    url: trade.url,
  }));

  response.summary = {
    openMarketBuys: signalTrades.filter((trade) => trade.category === 'open_market_buy').length,
    openMarketSells: signalTrades.filter((trade) => trade.category === 'open_market_sell').length,
    openMarketBuyValue,
    openMarketSellValue,
    netOpenMarketValue: openMarketBuyValue - openMarketSellValue,
    groupedEvents: groupedTrades.length,
    rawRows: Array.isArray((payload as InsiderResponse).insider_trades)
      ? ((payload as InsiderResponse).insider_trades as unknown[]).length
      : 0,
    activityBreakdown: summarizeActivityCounts(groupedTrades),
    dataSource: 'insider-trading',
  };

  if (signalTrades.length > 0) {
    response._insiderTradesMeta = {
      kind: 'Open-market events',
      showing: defaultTrades.length,
      totalGrouped: groupedTrades.length,
      administrativeSummarizedIn: 'summary.activityBreakdown',
    };
  } else if (nonInitialTrades.length > 0) {
    response._insiderTradesMeta = {
      kind: 'Administrative events',
      showing: defaultTrades.length,
      totalGrouped: groupedTrades.length,
      noRecentOpenMarketBuysOrSells: true,
    };
  } else if (groupedTrades.length > 0) {
    response._insiderTradesStatus = 'No Form 4 transactions beyond initial holdings';
  } else {
    response._insiderTradesStatus = isLikelyEtfProfile(companyProfile)
      ? 'No corporate insider filings (likely ETF)'
      : 'No recent insider activity';
  }

  return response;
}
