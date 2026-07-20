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
  };
}

/**
 * Pull the resolved trailing dividend yield (a decimal fraction) out of the shared
 * /dividend-yield endpoint payload. Withheld/invalid -> undefined (never fabricated).
 */
function extractEndpointDividendYield(info: unknown): number | undefined {
  if (info == null || typeof info !== 'object') return undefined;
  const raw = (info as { dividendYield?: unknown }).dividendYield;
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
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
    ...(note ? { _note: note } : {}),
    _summary_meta: { compact_view: true, has_coverage: !hasNoCoverage },
  };
}
