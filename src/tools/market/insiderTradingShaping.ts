import { MAX_RESPONSE_BYTES, sanitizeMcpWireOutput, utf8ByteLength } from '../helpers.js';
import { RESPONSE_MARGIN_BYTES } from './dealerPositioningShaping.js';

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

// Form 4 codes P and S are purchases and sales on the open market or private
// alike: the code alone does not say which (a filing's footnotes sometimes
// do), so nothing here calls them open-market.
type TradeCategory =
  | 'purchase'
  | 'sale'
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

/**
 * What an empty insider record says: only that nothing is on record, naming
 * an exchange-traded product by the profile's stored is_etf flag (set on ETFs,
 * and on some ETNs and trusts). A name or industry is no guide (an
 * asset manager such as BX, and closed-end funds such as ADX and PDI, whose
 * insiders file Form 4s, all read as funds by name).
 */
function noFilingsStatus(profile: unknown): string {
  const data = getObject(profile) as InstrumentProfile | null;
  // The raw profile row's flag: the tool passes the proxy's row, never the shaped profile.
  return data?.is_etf === true
    ? 'No insider filings on record for this exchange-traded product.'
    : 'No insider filings on record for this symbol.';
}

export function categorizeInsiderTrade(trade: RawInsiderTrade): TradeCategory {
  const formType = String(trade.formType ?? '').trim();
  if (formType === '3') return 'initial_holding';

  const code = parseTradeCode(trade);
  const acquisitionDisposition = String(trade.acquisitionOrDisposition ?? '').toUpperCase();

  switch (code) {
    case 'P':
      return 'purchase';
    case 'S':
      return 'sale';
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

export function categoryLabel(category: TradeCategory): string {
  switch (category) {
    case 'purchase':
      return 'Purchase';
    case 'sale':
      return 'Sale';
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
    case 'purchase':
      return 100;
    case 'sale':
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
  return category === 'purchase' || category === 'sale';
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

/** The oldest and newest transaction day (the filing day where a line has none) of the lines on file. */
function periodOf(groupedTrades: GroupedInsiderTrade[]): { from: string | null; through: string | null } {
  const days = groupedTrades
    .map(trade => (trade.transactionDate ?? trade.filingDate ?? '').slice(0, 10))
    .filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day))
    .sort();
  return { from: days[0] ?? null, through: days[days.length - 1] ?? null };
}

function summarizeActivityCounts(groupedTrades: GroupedInsiderTrade[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const trade of groupedTrades) {
    const label = trade.categoryLabel ?? categoryLabel(trade.category);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

const cents = (value: number): number => Math.round(value * 100) / 100;

/** A symbol the insider route has no record for (a 404): a status, not "no data". */
export function noInsiderRecord(symbol: string, companyProfile?: unknown): Record<string, unknown> {
  return {
    symbol,
    insider_trades: [],
    insiderTradesStatus: noFilingsStatus(companyProfile),
  };
}

export const PURCHASE_SALE_NOTE = 'Purchases and sales are the filings\' codes P and S, made on the open market or privately: the code alone does not say which, though a filing\'s footnotes sometimes do (the `url` links each filing).';

/** A CIK as digits without leading zeros, or null. */
const cikKey = (value: unknown): string | null => {
  const digits = typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\D/g, '').replace(/^0+/, '') : '';
  return digits || null;
};

/**
 * The lines filed under the company profile's CIK and the ones filed under
 * another. Each line's companyCik is its issuer, and about 4% of all stored
 * lines name one other than the profile's: a predecessor's (XPRO, CAAS and
 * UNIT reorganized or redomiciled under a new CIK, and their history sits
 * under the old one), a former holder of the ticker's (B's lines are Barnes
 * Group's), or another issuer the company or its insiders report holding (BX:
 * Blackstone Holdings IV buying another Blackstone vehicle's shares at 26.17).
 * The CIK alone does not say which, so those lines are kept apart rather than
 * counted or dropped; with the company's own CIK unknown nothing can be told
 * apart.
 */
function splitByIssuer(trades: unknown, companyProfile: unknown): { own: unknown[]; other: unknown[]; ownCik: string | null; ambiguous: boolean } {
  const lines = Array.isArray(trades) ? trades : [];
  const ownCik = cikKey(getObject(companyProfile)?.cik);
  const issuerOf = (line: unknown) => cikKey(getObject(line)?.companyCik);
  if (!ownCik) {
    const issuers = new Set(lines.map(issuerOf).filter((cik): cik is string => cik !== null));
    return { own: lines, other: [], ownCik, ambiguous: issuers.size > 1 };
  }
  const own: unknown[] = [];
  const other: unknown[] = [];
  for (const line of lines) {
    const issuer = issuerOf(line);
    (issuer === null || issuer === ownCik ? own : other).push(line);
  }
  return { own, other, ownCik, ambiguous: false };
}

const MAX_OTHER_ISSUERS = 10;

/** The lines filed under another CIK, one entry per CIK, the newest lines first. */
function summarizeOtherIssuers(lines: unknown[]): Array<Record<string, unknown>> {
  const byCik = new Map<string, unknown[]>();
  for (const line of lines) {
    const cik = cikKey(getObject(line)?.companyCik) as string;
    const list = byCik.get(cik);
    if (list) list.push(line);
    else byCik.set(cik, [line]);
  }
  return Array.from(byCik, ([cik, cikLines]) => {
    const grouped = groupInsiderTrades(cikLines);
    const of = (category: TradeCategory) => grouped.filter(trade => trade.category === category);
    const value = (category: TradeCategory) => cents(of(category).reduce((sum, trade) => sum + (trade.totalValue ?? 0), 0));
    return {
      companyCik: cik,
      lines: cikLines.length,
      period: periodOf(grouped),
      securityNames: Array.from(new Set(grouped.map(trade => trade.securityName).filter((name): name is string => !!name))).slice(0, 3),
      purchases: of('purchase').length,
      sales: of('sale').length,
      purchaseValue: value('purchase'),
      saleValue: value('sale'),
    };
  }).sort((a, b) => (b.period.through ?? '').localeCompare(a.period.through ?? '') || b.lines - a.lines);
}

const STATS_SIDE_KEYS = ['lines', 'filings', 'reporters', 'shares', 'value', 'pricedLines'] as const;
const STATS_OTHER_KEYS = ['otherSecurityPurchases', 'otherSecuritySales', 'otherAcquired', 'otherDisposed'] as const;

/**
 * The quarterly statistics the insider sync stores (insider_statistics: the
 * company's own lines by transaction-date quarter, computed from every page
 * it read, deeper than the 500 lines listed). Never read as zeros when absent
 * or unreadable, and none when the issuers cannot be told apart.
 */
export function shapeInsiderStatistics(raw: unknown): Record<string, unknown> {
  if (raw == null) return { quarterlyStatisticsNote: 'Quarterly statistics have not been computed for this symbol yet.' };
  const s = getObject(raw) as Record<string, any> | null;
  const sideOk = (x: any) => x && STATS_SIDE_KEYS.every(k => Number.isFinite(x[k]));
  const countsOk = (q: any) => STATS_OTHER_KEYS.every(k => Number.isFinite(q[k]));
  if (!s || s.version !== 1 || !Array.isArray(s.quarters) || !getObject(s.coverage)
    || !s.quarters.every((q: any) => typeof q?.quarter === 'string' && sideOk(q.purchases) && sideOk(q.sales) && countsOk(q))) {
    return { quarterlyStatisticsNote: 'The stored quarterly statistics are not in a form this tool reads, so none are given.' };
  }
  if (s.issuer === 'ambiguous') {
    return { quarterlyStatistics: [], quarterlyStatisticsNote: 'The lines on file name more than one issuer and the company\'s own CIK is not on record, so no quarterly statistics are given.' };
  }
  const side = (x: any) => Object.fromEntries(STATS_SIDE_KEYS.map(k => [k, x[k]]));
  return {
    quarterlyStatistics: s.quarters.map((q: any) => ({
      quarter: q.quarter,
      from: q.from,
      through: q.through,
      provisional: q.provisional === true,
      purchases: side(q.purchases),
      sales: side(q.sales),
      otherSecurityPurchases: q.otherSecurityPurchases,
      otherSecuritySales: q.otherSecuritySales,
      otherAcquired: q.otherAcquired,
      otherDisposed: q.otherDisposed,
    })),
    quarterlyStatisticsMeta: {
      issuer: s.issuer,
      computedAt: s.computedAt,
      pagesRead: s.coverage.pagesRead,
      linesRead: s.coverage.linesRead,
      readToEnd: s.coverage.exhausted === true,
      oldestFilingRead: s.coverage.oldestFilingRead ?? null,
      completeFrom: s.coverage.completeFrom ?? null,
      otherIssuerLines: s.otherIssuerLines,
      linesWithoutCik: s.linesWithoutCik,
      undatedLines: s.undatedLines,
      formThreeLines: s.formThreeLines,
    },
  };
}

export function shapeInsiderTradingResponse(payload: unknown, companyProfile?: unknown): unknown {
  if (payload == null || typeof payload !== 'object') return payload;

  const response = { ...(payload as InsiderResponse) } as InsiderResponse & Record<string, unknown>;
  // The stored statistics object is shaped below, never passed through raw.
  const statistics = shapeInsiderStatistics(response.insider_statistics);
  delete response.insider_statistics;
  const issuers = splitByIssuer(response.insider_trades, companyProfile);
  const groupedTrades = groupInsiderTrades(issuers.own);
  const signalTrades = groupedTrades.filter((trade) => isSignalCategory(trade.category));
  const nonInitialTrades = groupedTrades.filter((trade) => trade.category !== 'initial_holding');

  const defaultTrades = signalTrades.length > 0
    ? signalTrades.slice(0, MAX_DEFAULT_EVENTS)
    : nonInitialTrades.slice(0, MAX_DEFAULT_EVENTS);

  const purchaseValue = signalTrades
    .filter((trade) => trade.category === 'purchase')
    .reduce((sum, trade) => sum + (trade.totalValue ?? 0), 0);
  const saleValue = signalTrades
    .filter((trade) => trade.category === 'sale')
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
    price: trade.price === null ? null : Number(trade.price.toFixed(4)),
    totalValue: trade.totalValue === null ? null : cents(trade.totalValue),
    directOrIndirect: trade.directOrIndirect,
    acquisitionOrDisposition: trade.acquisitionOrDisposition,
    sharesOwned: trade.sharesOwned,
    rawTradeCount: trade.rawCount,
    url: trade.url,
  }));

  response.summary = {
    purchases: signalTrades.filter((trade) => trade.category === 'purchase').length,
    sales: signalTrades.filter((trade) => trade.category === 'sale').length,
    purchaseValue: cents(purchaseValue),
    saleValue: cents(saleValue),
    netValue: cents(purchaseValue - saleValue),
    groupedEvents: groupedTrades.length,
    rawRows: Array.isArray((payload as InsiderResponse).insider_trades)
      ? ((payload as InsiderResponse).insider_trades as unknown[]).length
      : 0,
    ...(issuers.other.length > 0 ? { otherIssuerLines: issuers.other.length } : {}),
    activityBreakdown: summarizeActivityCounts(groupedTrades),
    // The lines on file are the company's newest (up to 500 filing lines): the dates they span.
    period: periodOf(groupedTrades),
    dataSource: 'insider-trading',
  };

  // No leading underscore on the meta and the status: the wire drops a key it
  // has no rename for, and a fund's "No corporate insider filings" never
  // reached the model.
  if (signalTrades.length > 0) {
    response.purchaseSaleNote = PURCHASE_SALE_NOTE;
    response.insiderTradesMeta = {
      kind: 'Purchases and sales',
      showing: defaultTrades.length,
      totalPurchasesAndSales: signalTrades.length,
      totalGrouped: groupedTrades.length,
      administrativeSummarizedIn: 'summary.activityBreakdown',
    };
  } else if (nonInitialTrades.length > 0) {
    response.insiderTradesMeta = {
      kind: 'Administrative events',
      showing: defaultTrades.length,
      totalGrouped: groupedTrades.length,
      noRecentPurchasesOrSales: true,
    };
  } else if (groupedTrades.length > 0) {
    response.insiderTradesStatus = 'No Form 4 transactions beyond initial holdings';
  } else if (issuers.other.length > 0) {
    response.insiderTradesStatus = `No insider filings on record under the company profile's CIK (${issuers.ownCik}); the lines on file were filed under another (\`otherIssuers\`).`;
  } else {
    response.insiderTradesStatus = noFilingsStatus(companyProfile);
  }
  if (issuers.other.length > 0) {
    const n = issuers.other.length;
    const otherIssuers = summarizeOtherIssuers(issuers.other);
    response.otherIssuers = otherIssuers.slice(0, MAX_OTHER_ISSUERS);
    if (otherIssuers.length > MAX_OTHER_ISSUERS) response.otherIssuersMeta = { showing: MAX_OTHER_ISSUERS, total: otherIssuers.length, truncated: true };
    response.otherIssuerNote = `${n} line${n === 1 ? ' on file was' : 's on file were'} filed under an issuer CIK other than the company profile's (${issuers.ownCik}): `
      + 'a predecessor\'s (a company that reorganizes, redomiciles or converts can file under a new CIK), a former holder of this ticker\'s, '
      + 'or another issuer whose securities this company or its insiders report holding; the CIK alone does not say which. '
      + `${n === 1 ? 'It is' : 'They are'} left out of the list and the summary: \`otherIssuers\` gives each CIK's lines, dates, security names and purchases and sales, and \`full\` returns the raw lines with each one's \`companyCik\`.`;
  } else if (issuers.ambiguous) {
    response.otherIssuerNote = 'The lines on file name more than one issuer, and the company\'s own CIK is not on record to tell them apart.';
  }
  Object.assign(response, statistics);

  return response;
}

// ---------------------------------------------------------------------------
// scope "market": the proxy's /market/insider-trades, the insider filings of
// every covered company over a window of filing days.

type MarketInsiderLine = {
  symbol?: string | null;
  filingDate?: string | null;
  transactionDate?: string | null;
  insider?: string | null;
  role?: string | null;
  transactionType?: string | null;
  acquiredOrDisposed?: string | null;
  directOrIndirect?: string | null;
  shares?: number | null;
  price?: number | null;
  value?: number | null;
  sharesOwnedAfter?: number | null;
  security?: string | null;
  formType?: string | null;
  url?: string | null;
  attribution?: string | null;
};

type MarketInsiderTotal = { trades?: number | null; shares?: number | null; value?: number | null };
type MarketInsiderTop = { symbol?: string | null; trades?: number | null; shares?: number | null; value?: number | null };

export type MarketInsiderResponse = {
  days?: number;
  kind?: string;
  from?: string;
  asOf?: string;
  total?: number;
  summary?: {
    purchases?: MarketInsiderTotal;
    sales?: MarketInsiderTotal;
    topPurchases?: MarketInsiderTop[];
    topSales?: MarketInsiderTop[];
  };
  trades?: MarketInsiderLine[];
};

/** Why a priced line of a confirmed issuer carries no value (the proxy's sql/181 insider_line_value). */
export const MARKET_INSIDER_VALUE_WITHHELD = 'another security, or priced more than 1.5 times from the stock\'s close';

export const MARKET_INSIDER_NOTE = 'Insider transactions reported to the SEC on Forms 3, 4 and 5 by the officers, directors and 10% owners of covered companies, '
  + 'filed from `window.from` through `window.through`, the newest filing day on file. '
  + '`totals`, `topPurchases` and `topSales` count purchases (code P) and sales (code S) only, which a filing codes the same whether made on the open market or privately; awards, option exercises, gifts, shares withheld for taxes and initial holdings (Form 3) are listed under kind "all" but not counted there. '
  + 'Nothing is traded on a Form 3: its lines report holdings. A Form 3 line with `sharesTransacted` above 0 and `sharesOwned` 0 is nearly always a derivative holding (options, restricted stock units, warrants), and the number is the shares underlying it. '
  + 'A line\'s `value` is shares times price for the company\'s listed stock: priced within 1.5 times of the stock\'s close on or before the trade date (checked on each split basis that close may carry), or as filed when no close is on file within 10 days. '
  + 'A line with a price and shares above zero that is for another security (preferred shares, warrants, options, notes, units, rights) or priced further from the close carries `value` null and `valueWithheld`; a line without a price or shares carries `value` null and, unless its issuer is unconfirmed (below), no marker. '
  + 'The totals and rankings sum values only, so `lines` can count lines that carry none, and a company whose lines all lack a value ranks last. '
  + 'A line whose filing names an issuer that could not be confirmed as the listed company carries `issuerUnconfirmed`, has no value and is left out of the totals and the top lists. '
  + '`tradesMeta` appears when the window holds more lines than are listed, by `limit` or, with `trimmedForSize`, by the response size budget (the oldest listed lines dropped first).';


const finiteOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const roundTo = (value: number | null, decimals: number): number | null => (value === null ? null : Number(value.toFixed(decimals)));
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

function shapeMarketTotal(total: MarketInsiderTotal | undefined): { lines: number; value: number | null } {
  return { lines: finiteOrNull(total?.trades) ?? 0, value: roundTo(finiteOrNull(total?.value), 0) };
}

function shapeMarketTop(rows: unknown): Array<{ symbol: string | null; lines: number; value: number | null }> {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is MarketInsiderTop => r != null && typeof r === 'object')
    .map(r => ({ symbol: stringOrNull(r.symbol), lines: finiteOrNull(r.trades) ?? 0, value: roundTo(finiteOrNull(r.value), 0) }));
}

function shapeMarketLine(line: MarketInsiderLine): Record<string, unknown> {
  const unconfirmed = line.attribution === 'unverified';
  const shares = finiteOrNull(line.shares);
  const price = finiteOrNull(line.price);
  // The proxy never values an unconfirmed line (sql/181).
  const value = roundTo(finiteOrNull(line.value), 2);
  const priced = price !== null && price > 0 && shares !== null && shares > 0;
  const category = categorizeInsiderTrade({
    formType: line.formType ?? undefined,
    transactionType: line.transactionType ?? undefined,
    acquisitionOrDisposition: line.acquiredOrDisposed ?? undefined,
  });
  return {
    symbol: stringOrNull(line.symbol),
    reportingName: stringOrNull(line.insider),
    typeOfOwner: stringOrNull(line.role),
    categoryLabel: categoryLabel(category),
    transactionType: stringOrNull(line.transactionType),
    formType: stringOrNull(line.formType),
    transactionDate: stringOrNull(line.transactionDate),
    filingDate: stringOrNull(line.filingDate),
    securityName: stringOrNull(line.security),
    sharesTransacted: shares,
    price,
    value,
    directOrIndirect: stringOrNull(line.directOrIndirect),
    acquisitionOrDisposition: stringOrNull(line.acquiredOrDisposed),
    sharesOwned: finiteOrNull(line.sharesOwnedAfter),
    url: stringOrNull(line.url),
    ...(unconfirmed ? { issuerUnconfirmed: true, valueWithheld: 'issuer unconfirmed' } : {}),
    ...(!unconfirmed && priced && value === null ? { valueWithheld: MARKET_INSIDER_VALUE_WITHHELD } : {}),
  };
}

/**
 * The market-wide insider feed for the model: the window, each kind's totals
 * and top companies by value, and the lines the proxy returned (newest filing
 * day first), with `tradesMeta` when the window holds more.
 */
export function shapeMarketInsiderTrades(payload: MarketInsiderResponse | null, kind: string): Record<string, unknown> {
  if (payload == null || typeof payload !== 'object') {
    return { scope: 'market', kind, trades: [], tradesNote: 'No market-wide insider filings on record.' };
  }
  const purchases = shapeMarketTotal(payload.summary?.purchases);
  const sales = shapeMarketTotal(payload.summary?.sales);
  // A kind with no lines sums to zero; one whose lines all lack a value has no total to net.
  const netOf = (t: { lines: number; value: number | null }) => (t.value ?? (t.lines === 0 ? 0 : null));
  const buy = netOf(purchases);
  const sell = netOf(sales);
  const lines = Array.isArray(payload.trades) ? payload.trades.filter((l): l is MarketInsiderLine => l != null && typeof l === 'object') : [];
  const all = lines.map(shapeMarketLine);
  const total = finiteOrNull(payload.total) ?? all.length;
  const shape = (trades: Array<Record<string, unknown>>, trimmedForSize: boolean) => ({
    scope: 'market',
    kind: payload.kind ?? kind,
    window: { days: finiteOrNull(payload.days), from: stringOrNull(payload.from), through: stringOrNull(payload.asOf) },
    totals: {
      purchases,
      sales,
      netValue: buy !== null && sell !== null ? Math.round(buy - sell) : null,
    },
    topPurchases: shapeMarketTop(payload.summary?.topPurchases),
    topSales: shapeMarketTop(payload.summary?.topSales),
    trades,
    ...(total > trades.length ? { tradesMeta: { showing: trades.length, total, truncated: true, ...(trimmedForSize ? { trimmedForSize: true } : {}) } } : {}),
    ...(all.length === 0 ? { tradesNote: `No ${kind === 'all' ? 'insider transactions' : kind} filed in this window.` } : {}),
    note: MARKET_INSIDER_NOTE,
  });
  // The shared size guard trims a long list to five and replaces tradesMeta
  // with its own, losing the window's total: the oldest listed lines go here
  // instead, until the published answer fits.
  const fits = (out: unknown) => utf8ByteLength(JSON.stringify(sanitizeMcpWireOutput(out))) <= MAX_RESPONSE_BYTES - RESPONSE_MARGIN_BYTES;
  let kept = all;
  let out = shape(kept, false);
  while (kept.length > 0 && !fits(out)) {
    kept = kept.slice(0, -1);
    out = shape(kept, true);
  }
  return out;
}
