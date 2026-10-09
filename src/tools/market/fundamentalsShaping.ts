import { MAX_RESPONSE_BYTES, sanitizeMcpWireOutput, utf8ByteLength } from '../helpers.js';
import { RESPONSE_MARGIN_BYTES } from './dealerPositioningShaping.js';

type FundamentalsPayload = {
  [key: string]: unknown;
  symbol?: string;
  ratios_ttm?: unknown;
  key_metrics_ttm?: unknown;
  income_stmt?: unknown;
  balance_sheet?: unknown;
  cash_flow?: unknown;
  fetched_at?: unknown;
};

type CompanyProfilePayload = {
  [key: string]: unknown;
  symbol?: string;
  company_name?: string;
  exchange_short?: string;
  sector?: string;
  industry?: string;
  ceo?: string;
  mkt_cap?: number;
  beta?: number;
  pe_ratio_ttm?: number;
  last_div?: number;
  shares_outstanding?: number;
  free_float_pct?: number;
  free_float_shares?: number;
  full_time_employees?: number;
  currency?: string;
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

type StatementRow = {
  [key: string]: unknown;
  date?: string;
  period?: string;
  fiscalYear?: string;
};

function round(value: unknown, decimals = 2): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Number(value.toFixed(decimals));
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

function pickNumeric(source: Record<string, unknown> | null, key: string, decimals = 2): number | undefined {
  if (!source) return undefined;
  return round(source[key], decimals);
}

function pickLatestStatement(rows: unknown): StatementRow | null {
  if (!Array.isArray(rows)) return null;
  const sorted = rows
    .filter((row): row is StatementRow => row != null && typeof row === 'object')
    .slice()
    .sort((left, right) => (right.date ?? '').localeCompare(left.date ?? ''));
  return sorted[0] ?? null;
}

function summarizeIncomeStatement(row: StatementRow | null): Record<string, unknown>[] | undefined {
  if (!row) return undefined;
  return [{
    date: row.date,
    period: row.period,
    fiscalYear: row.fiscalYear,
    revenue: round(row.revenue, 0),
    grossProfit: round(row.grossProfit, 0),
    operatingIncome: round(row.operatingIncome, 0),
    ebitda: round(row.ebitda, 0),
    incomeBeforeTax: round(row.incomeBeforeTax, 0),
    netIncome: round(row.netIncome, 0),
    eps: round(row.eps, 3),
    epsDiluted: round(row.epsDiluted, 3),
    reportedCurrency: row.reportedCurrency,
  }];
}

function summarizeBalanceSheet(row: StatementRow | null): Record<string, unknown>[] | undefined {
  if (!row) return undefined;
  return [{
    date: row.date,
    period: row.period,
    fiscalYear: row.fiscalYear,
    totalAssets: round(row.totalAssets, 0),
    totalLiabilities: round(row.totalLiabilities, 0),
    totalStockholdersEquity: round(row.totalStockholdersEquity ?? row.totalEquity, 0),
    cashAndCashEquivalents: round(row.cashAndCashEquivalents, 0),
    cashAndShortTermInvestments: round(row.cashAndShortTermInvestments, 0),
    totalDebt: round(row.totalDebt, 0),
    longTermDebt: round(row.longTermDebt, 0),
    shortTermDebt: round(row.shortTermDebt, 0),
    netDebt: round(row.netDebt, 0),
    inventory: round(row.inventory, 0),
    sharesOutstanding: round(row.sharesOutstanding, 0),
    reportedCurrency: row.reportedCurrency,
  }];
}

function summarizeCashFlow(row: StatementRow | null): Record<string, unknown>[] | undefined {
  if (!row) return undefined;
  return [{
    date: row.date,
    period: row.period,
    fiscalYear: row.fiscalYear,
    operatingCashFlow: round(row.operatingCashFlow, 0),
    freeCashFlow: round(row.freeCashFlow, 0),
    capitalExpenditure: round(row.capitalExpenditure, 0),
    netCashProvidedByOperatingActivities: round(row.netCashProvidedByOperatingActivities, 0),
    netCashProvidedByInvestingActivities: round(row.netCashProvidedByInvestingActivities, 0),
    netCashProvidedByFinancingActivities: round(row.netCashProvidedByFinancingActivities, 0),
    netDividendsPaid: round(row.netDividendsPaid, 0),
    netStockIssuance: round(row.netStockIssuance, 0),
    cashAtEndOfPeriod: round(row.cashAtEndOfPeriod, 0),
    reportedCurrency: row.reportedCurrency,
  }];
}

const currencyCode = (value: unknown): string | null => {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : null;
};

const STATEMENT_KEYS = ['income_stmt_quarterly', 'income_stmt', 'balance_sheet_quarterly', 'balance_sheet', 'cash_flow_quarterly', 'cash_flow'];

/**
 * The currency the newest statement on file reports in, and that statement's
 * date. The TTM amounts are in the company's reporting currency too (TSM's
 * key-metrics market cap is 64.8T, TWD, beside a 2.45T USD profile; across
 * ~500 companies reporting in another currency the TTM-to-profile market cap
 * ratio sits at the exchange rate, JPY 158, TWD 30, while the weekly
 * market-cap history matches the profile, 1.000). But the TTM objects come
 * from a daily file carrying no currency, refreshed apart from the
 * statements, so around a change of reporting currency either can be the
 * newer: the statement's currency is the TTM's usual one, never a certain one.
 */
function reportedCurrencyOf(data: FundamentalsPayload): { code: string; asOf: string | null; quarterOnly: boolean } | null {
  const rows = STATEMENT_KEYS
    .flatMap(key => (Array.isArray(data[key]) ? (data[key] as unknown[]).map(row => ({ key, row: getObject(row) })) : []))
    .filter((entry): entry is { key: string; row: Record<string, unknown> } => entry.row !== null && currencyCode(entry.row.reportedCurrency) !== null)
    .sort((left, right) => String(right.row.date ?? '').localeCompare(String(left.row.date ?? '')));
  if (rows.length === 0) return null;
  const { key, row } = rows[0];
  const date = typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(row.date) ? row.date.slice(0, 10) : null;
  // The summary shows each statement's latest annual period only: a newest
  // statement from a quarterly list that no shown annual period shares the
  // date of is a quarter it does not show (TSM: the 2026-06-30 quarter beside
  // FY 2025-12-31). An annual row it passes over (an older year, the newest
  // naming no currency) is no quarter (review).
  const annualDays = new Set(['income_stmt', 'balance_sheet', 'cash_flow']
    .map(list => pickLatestStatement(data[list])?.date)
    .filter((d): d is string => typeof d === 'string')
    .map(d => d.slice(0, 10)));
  const quarterOnly = key.endsWith('_quarterly') && date !== null && !annualDays.has(date);
  return { code: currencyCode(row.reportedCurrency) as string, asOf: date, quarterOnly };
}

/**
 * The currencies beside the figures: the one the newest statement on file
 * reports in, with its date, and the one the listing trades in (the profile
 * and the market-cap history), with a note when they differ. Each statement
 * names its own currency, and the TTM amounts are put in the statement's only
 * as their usual one (see reportedCurrencyOf). `view` is the response the note
 * sits in: the summary carries a `companyProfile` and each statement's latest
 * annual period only, the full payload no profile and the quarters.
 */
export function currencyContext(payload: unknown, companyProfile: unknown, view: 'summary' | 'full'): Record<string, unknown> {
  const data = getObject(payload) as FundamentalsPayload | null;
  const newest = data ? reportedCurrencyOf(data) : null;
  const reported = newest?.code ?? null;
  const trading = currencyCode(getObject(companyProfile)?.currency);
  if (!reported && !trading) return {};
  const differ = reported !== null && trading !== null && reported !== trading;
  const tradingFigures = view === 'summary' ? '`companyProfile` (marketCap, lastDividend) and `valuation.marketCap` are' : '`valuation.marketCap` is';
  const statement = !newest?.asOf ? 'The newest statement on file'
    : view === 'summary' && newest.quarterOnly ? `The newest statement on file (${newest.asOf}, a quarter: \`full: true\` lists the quarterly statements)`
    : `The newest statement on file (${newest.asOf})`;
  return {
    currencies: { reported, reportedAsOf: newest?.asOf ?? null, trading },
    ...(differ ? {
      currencyNote: `${statement} reports in ${reported}; the listing trades here in ${trading}. Each statement names its own currency in \`reportedCurrency\`. `
        + `The money amounts and per-share figures in \`ratiosTtm\` and \`keyMetricsTtm\` (marketCap, enterpriseValueTTM, workingCapitalTTM, cashPerShareTTM and the like) carry no currency of their own: they are normally in the company's reporting currency, ${reported} by that statement, but they are refreshed apart from the statements, so around a change of reporting currency the two can disagree. `
        + `${tradingFigures} in ${trading}. The ratios, margins, returns and yields are the same in either currency.`,
    } : {}),
  };
}

/**
 * full=true: the raw payload with as many of each statement's newest periods
 * as fit the response budget. The raw statements (six lists, some 40 fields a
 * period) sit at the 50 KB budget for most companies even after the size
 * guard's array trimming, and past it once `valuation` and the currencies sit
 * beside them (live 2026-10-04: TSM, MSFT and BABA over with `valuation`, TM
 * over without it), and the guard then answered "Response too large" in place
 * of the payload. Every list keeps its newest periods up to one shared count
 * (a shorter list keeps all of its own), the most that fits beside the TTM
 * figures and the extras; `fullMeta` gives the count, and each list's periods
 * on file, when some are left. The fit assumes the rest is small (the TTM
 * objects and extras run to a few KB); should it not be, the count reaches 0
 * and the size guard has the last word.
 */
export function shapeFundamentalsFull(payload: unknown, extras: Record<string, unknown>): Record<string, unknown> {
  const data = { ...(getObject(payload) ?? {}) } as Record<string, unknown>;
  const lists: Array<[string, unknown[]]> = STATEMENT_KEYS
    .filter(key => Array.isArray(data[key]))
    .map(key => [key, [...(data[key] as unknown[])].sort((left, right) =>
      String(getObject(right)?.date ?? '').localeCompare(String(getObject(left)?.date ?? '')))]);
  const longest = lists.reduce((max, [, rows]) => Math.max(max, rows.length), 0);
  const build = (periods: number): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...data };
    for (const [key, rows] of lists) out[key] = rows.slice(0, periods);
    const trimmed = lists.some(([, rows]) => rows.length > periods);
    return {
      ...out,
      ...extras,
      ...(trimmed ? { fullMeta: { periodsPerStatement: periods, periodsOnFile: Object.fromEntries(lists.map(([key, rows]) => [key, rows.length])), trimmedForSize: true } } : {}),
    };
  };
  const fits = (out: unknown) => utf8ByteLength(JSON.stringify(sanitizeMcpWireOutput(out))) <= MAX_RESPONSE_BYTES - RESPONSE_MARGIN_BYTES;
  const whole = build(longest);
  if (fits(whole)) return whole;
  // The most periods that fit: the size grows with the count.
  let lo = 0;
  let hi = longest - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(build(mid))) lo = mid; else hi = mid - 1;
  }
  return build(lo);
}

/**
 * No fundamentals on record (the route 404s): a status, never a bare no-data
 * answer. The ETF class has no company statements (their rows were removed
 * with the phase A universe), so SPY answered "No data available" with no
 * reason; the profile's is_etf (set on ETFs, and on some ETNs and trusts)
 * names an exchange-traded product as one, as get_insider_trading does. A
 * failed profile read says only "this symbol".
 */
export function noFundamentalsRecord(symbol: string, companyProfile: unknown): Record<string, unknown> {
  const isEtf = getObject(companyProfile)?.is_etf === true;
  return { symbol, fundamentalsStatus: `No company financial statements on record for this ${isEtf ? 'exchange-traded product' : 'symbol'}.` };
}

function summarizeCompanyProfile(profile: unknown): Record<string, unknown> | undefined {
  const data = getObject(profile) as CompanyProfilePayload | null;
  if (!data) return undefined;

  return {
    symbol: data.symbol,
    company_name: data.company_name,
    exchange_short: data.exchange_short,
    sector: data.sector,
    industry: data.industry,
    ceo: data.ceo,
    market_cap: round(data.mkt_cap, 0),
    beta: round(data.beta, 3),
    pe_ratio_ttm: round(data.pe_ratio_ttm, 2),
    last_dividend: round(data.last_div, 3),
    shares_outstanding: round(data.shares_outstanding, 0),
    free_float_shares: round(data.free_float_shares, 0),
    free_float_pct: round(data.free_float_pct, 2),
    full_time_employees: round(data.full_time_employees, 0),
    currency: currencyCode(data.currency) ?? undefined,
  };
}

/**
 * Pull the resolved trailing dividend yield (a decimal fraction) out of the shared
 * /dividend-yield endpoint payload. Withheld/invalid -> undefined (never fabricated).
 */
function extractEndpointDividendYield(info: unknown): number | undefined {
  if (info == null || typeof info !== 'object') return undefined;
  // New responses separate the observation from permission to price with it.
  // Presence matters: an explicit null observation must not resurrect an older
  // pricing field. Retain compatibility with endpoints predating the split.
  const data = info as Record<string, unknown>;
  const raw = Object.prototype.hasOwnProperty.call(data, 'observedYield')
    ? data.observedYield : data.dividendYield;
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * The /dividend-yield endpoint says when it could not read the yield (reason 'read_failed'; the
 * tool passes the same reason when the call itself failed): with no ratios yield either, the yield is unknown, not
 * withheld - said in the summary and in the full view alike (review).
 */
export function dividendYieldUnreadFields(payload: unknown, dividendYieldInfo: unknown): Record<string, unknown> {
  const ratios = getObject(getObject(payload)?.ratios_ttm);
  const ratiosHasYield = pickNumeric(ratios, 'dividendYieldTTM', 4) != null;
  const unread = !ratiosHasYield && dividendYieldInfo != null && typeof dividendYieldInfo === 'object'
    && (dividendYieldInfo as Record<string, unknown>).reason === 'read_failed';
  return unread ? { dividendYieldNote: 'The dividend yield could not be read; it is unknown here, not zero.' } : {};
}

export function summarizeFundamentals(payload: unknown, companyProfile?: unknown, dividendYieldInfo?: unknown): unknown {
  if (payload == null || typeof payload !== 'object') return payload;
  const data = payload as FundamentalsPayload;
  const ratios = getObject(data.ratios_ttm);
  // Funds (ETFs) carry no ratios-ttm dividendYieldTTM, so fall back to the shared endpoint's
  // resolved trailing yield (profile last_div / close). For companies the endpoint returns the
  // same ratios value, so this only ever fills a gap - never overrides a real ratios yield.
  const endpointDividendYield = extractEndpointDividendYield(dividendYieldInfo);
  const metrics = getObject(data.key_metrics_ttm);
  const companyProfileSummary = summarizeCompanyProfile(companyProfile);
  const incomeSummary = summarizeIncomeStatement(pickLatestStatement(data.income_stmt));
  const balanceSummary = summarizeBalanceSheet(pickLatestStatement(data.balance_sheet));
  const cashFlowSummary = summarizeCashFlow(pickLatestStatement(data.cash_flow));

  const hasRatios = ratios != null && Object.values(ratios).some((value) => typeof value === 'number' && Number.isFinite(value));
  const hasMetrics = metrics != null && Object.values(metrics).some((value) => typeof value === 'number' && Number.isFinite(value));
  const hasStatements = Boolean(incomeSummary || balanceSummary || cashFlowSummary);

  const hasNoCoverage = !hasRatios && !hasMetrics && !hasStatements;
  const note = hasNoCoverage
    ? isLikelyEtfProfile(companyProfile)
      ? 'No meaningful company-style TTM ratios or financial statements were available for this symbol. It may be an ETF, fund, index, or another instrument without corporate financial statement coverage.'
      : 'No meaningful TTM ratios or financial statement coverage were available for this symbol.'
    : undefined;

  return {
    symbol: data.symbol,
    company_profile: companyProfileSummary,
    ratios_ttm: {
      priceToEarningsRatioTTM: pickNumeric(ratios, 'priceToEarningsRatioTTM', 2),
      priceToSalesRatioTTM: pickNumeric(ratios, 'priceToSalesRatioTTM', 2),
      priceToBookRatioTTM: pickNumeric(ratios, 'priceToBookRatioTTM', 2),
      priceToFreeCashFlowRatioTTM: pickNumeric(ratios, 'priceToFreeCashFlowRatioTTM', 2),
      priceToEarningsGrowthRatioTTM: pickNumeric(ratios, 'priceToEarningsGrowthRatioTTM', 2),
      grossProfitMarginTTM: pickNumeric(ratios, 'grossProfitMarginTTM', 4),
      operatingProfitMarginTTM: pickNumeric(ratios, 'operatingProfitMarginTTM', 4),
      netProfitMarginTTM: pickNumeric(ratios, 'netProfitMarginTTM', 4),
      currentRatioTTM: pickNumeric(ratios, 'currentRatioTTM', 3),
      quickRatioTTM: pickNumeric(ratios, 'quickRatioTTM', 3),
      cashRatioTTM: pickNumeric(ratios, 'cashRatioTTM', 3),
      debtToEquityRatioTTM: pickNumeric(ratios, 'debtToEquityRatioTTM', 3),
      debtToAssetsRatioTTM: pickNumeric(ratios, 'debtToAssetsRatioTTM', 3),
      debtToCapitalRatioTTM: pickNumeric(ratios, 'debtToCapitalRatioTTM', 3),
      dividendYieldTTM: pickNumeric(ratios, 'dividendYieldTTM', 4) ?? round(endpointDividendYield, 4),
      cashPerShareTTM: pickNumeric(ratios, 'cashPerShareTTM', 2),
      operatingCashFlowPerShareTTM: pickNumeric(ratios, 'operatingCashFlowPerShareTTM', 2),
      freeCashFlowPerShareTTM: pickNumeric(ratios, 'freeCashFlowPerShareTTM', 2),
    },
    key_metrics_ttm: {
      marketCap: pickNumeric(metrics, 'marketCap', 0),
      enterpriseValueTTM: pickNumeric(metrics, 'enterpriseValueTTM', 0),
      evToSalesTTM: pickNumeric(metrics, 'evToSalesTTM', 2),
      evToEBITDATTM: pickNumeric(metrics, 'evToEBITDATTM', 2),
      earningsYieldTTM: pickNumeric(metrics, 'earningsYieldTTM', 4),
      freeCashFlowYieldTTM: pickNumeric(metrics, 'freeCashFlowYieldTTM', 4),
      returnOnAssetsTTM: pickNumeric(metrics, 'returnOnAssetsTTM', 4),
      returnOnEquityTTM: pickNumeric(metrics, 'returnOnEquityTTM', 4),
      returnOnInvestedCapitalTTM: pickNumeric(metrics, 'returnOnInvestedCapitalTTM', 4),
      netDebtToEBITDATTM: pickNumeric(metrics, 'netDebtToEBITDATTM', 3),
      workingCapitalTTM: pickNumeric(metrics, 'workingCapitalTTM', 0),
      cashConversionCycleTTM: pickNumeric(metrics, 'cashConversionCycleTTM', 2),
      daysOfSalesOutstandingTTM: pickNumeric(metrics, 'daysOfSalesOutstandingTTM', 2),
      daysOfInventoryOutstandingTTM: pickNumeric(metrics, 'daysOfInventoryOutstandingTTM', 2),
      daysOfPayablesOutstandingTTM: pickNumeric(metrics, 'daysOfPayablesOutstandingTTM', 2),
    },
    income_stmt: incomeSummary,
    balance_sheet: balanceSummary,
    cash_flow: cashFlowSummary,
    fetched_at: data.fetched_at,
    // The daily TTM files' own date, as the full payload carries it: the TTM
    // figures are refreshed both with the statements (fetched_at) and from
    // those files, and neither stamp says which refresh wrote the figures
    // shown (the files' date is their publication date, and a partial refresh
    // leaves it as it was), so both are given, nothing derived from them.
    ...(typeof data.ttm_bulk_as_of === 'string' ? { ttm_bulk_as_of: data.ttm_bulk_as_of } : {}),
    ...currencyContext(payload, companyProfile, 'summary'),
    ...dividendYieldUnreadFields(payload, dividendYieldInfo),
    ...(note ? { _note: note } : {}),
    _summary_meta: { compact_view: true, has_coverage: !hasNoCoverage },
  };
}
