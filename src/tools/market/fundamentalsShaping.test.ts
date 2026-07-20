import { describe, expect, test } from 'bun:test';
import { summarizeFundamentals } from './fundamentalsShaping.js';

describe('summarizeFundamentals', () => {
  test('returns compact company metadata, curated ratios, and summarized latest statements', () => {
    const fundamentals = {
      symbol: 'AAPL',
      ratios_ttm: {
        priceToEarningsRatioTTM: 31.053564808,
        priceToSalesRatioTTM: 8.367301507,
        priceToBookRatioTTM: 41.471773471,
        priceToFreeCashFlowRatioTTM: 29.555794335,
        priceToEarningsGrowthRatioTTM: 5.279106017,
        grossProfitMarginTTM: 0.4732528804,
        operatingProfitMarginTTM: 0.3238395196,
        netProfitMarginTTM: 0.2703682363,
        currentRatioTTM: 0.9737446648,
        quickRatioTTM: 0.9375612039,
        cashRatioTTM: 0.2791022806,
        debtToEquityRatioTTM: 1.0262954983,
        debtToAssetsRatioTTM: 0.2386230315,
        debtToCapitalRatioTTM: 0.5064885645,
        dividendYieldTTM: 0.00419372,
        cashPerShareTTM: 4.5366343376,
        operatingCashFlowPerShareTTM: 9.1856894942,
        freeCashFlowPerShareTTM: 8.3619934096,
        ignoredField: 123,
      },
      key_metrics_ttm: {
        marketCap: 3644938780583.0005,
        enterpriseValueTTM: 3690130780583.0005,
        evToSalesTTM: 8.4710440147,
        evToEBITDATTM: 24.1218126709,
        earningsYieldTTM: 0.032202422,
        freeCashFlowYieldTTM: 0.0338343131,
        returnOnAssetsTTM: 0.3105139244,
        returnOnEquityTTM: 1.5994214884,
        returnOnInvestedCapitalTTM: 0.5101222472,
        netDebtToEBITDATTM: 0.2954130959,
        workingCapitalTTM: -4263000000,
        cashConversionCycleTTM: -44.0162426156,
        daysOfSalesOutstandingTTM: 58.9205655426,
        daysOfInventoryOutstandingTTM: 9.3453107295,
        daysOfPayablesOutstandingTTM: 112.2821188878,
        ignoredField: 456,
      },
      income_stmt: [
        { date: '2024-09-27', revenue: 400000000000 },
        {
          date: '2025-09-27',
          period: 'FY',
          fiscalYear: '2025',
          revenue: 416161000000,
          grossProfit: 195201000000,
          operatingIncome: 133050000000,
          ebitda: 144427000000,
          incomeBeforeTax: 132729000000,
          netIncome: 112010000000,
          eps: 7.49,
          epsDiluted: 7.46,
          reportedCurrency: 'USD',
          ignoredField: 'x',
        },
      ],
      balance_sheet: [
        {
          date: '2025-09-27',
          period: 'FY',
          fiscalYear: '2025',
          totalAssets: 359241000000,
          totalLiabilities: 285508000000,
          totalStockholdersEquity: 73733000000,
          cashAndCashEquivalents: 35934000000,
          cashAndShortTermInvestments: 54697000000,
          totalDebt: 112377000000,
          longTermDebt: 78328000000,
          shortTermDebt: 20329000000,
          netDebt: 76443000000,
          inventory: 5718000000,
          reportedCurrency: 'USD',
        },
      ],
      cash_flow: [
        {
          date: '2025-09-27',
          period: 'FY',
          fiscalYear: '2025',
          operatingCashFlow: 111482000000,
          freeCashFlow: 98767000000,
          capitalExpenditure: -12715000000,
          netCashProvidedByOperatingActivities: 111482000000,
          netCashProvidedByInvestingActivities: 15195000000,
          netCashProvidedByFinancingActivities: -120686000000,
          netDividendsPaid: -15421000000,
          netStockIssuance: -90711000000,
          cashAtEndOfPeriod: 35934000000,
          reportedCurrency: 'USD',
        },
      ],
      fetched_at: '2026-03-23T05:15:59.575+00:00',
    };

    const profile = {
      symbol: 'AAPL',
      company_name: 'Apple Inc.',
      exchange_short: 'NASDAQ',
      sector: 'Technology',
      industry: 'Consumer Electronics',
      ceo: 'Tim Cook',
      mkt_cap: 3644938780583.0005,
      beta: 1.23456,
      pe_ratio_ttm: 31.053564808,
      last_div: 1.04,
      shares_outstanding: 15000000000,
      free_float_shares: 14800000000,
      free_float_pct: 98.67,
      full_time_employees: 164000,
      ignoredField: 'x',
    };

    const summary = summarizeFundamentals(fundamentals, profile) as any;

    expect(summary.company_profile).toEqual({
      symbol: 'AAPL',
      company_name: 'Apple Inc.',
      exchange_short: 'NASDAQ',
      sector: 'Technology',
      industry: 'Consumer Electronics',
      ceo: 'Tim Cook',
      market_cap: 3644938780583,
      beta: 1.235,
      pe_ratio_ttm: 31.05,
      last_dividend: 1.04,
      shares_outstanding: 15000000000,
      free_float_shares: 14800000000,
      free_float_pct: 98.67,
      full_time_employees: 164000,
    });
    expect(summary.ratios_ttm).toEqual({
      priceToEarningsRatioTTM: 31.05,
      priceToSalesRatioTTM: 8.37,
      priceToBookRatioTTM: 41.47,
      priceToFreeCashFlowRatioTTM: 29.56,
      priceToEarningsGrowthRatioTTM: 5.28,
      grossProfitMarginTTM: 0.4733,
      operatingProfitMarginTTM: 0.3238,
      netProfitMarginTTM: 0.2704,
      currentRatioTTM: 0.974,
      quickRatioTTM: 0.938,
      cashRatioTTM: 0.279,
      debtToEquityRatioTTM: 1.026,
      debtToAssetsRatioTTM: 0.239,
      debtToCapitalRatioTTM: 0.506,
      dividendYieldTTM: 0.0042,
      cashPerShareTTM: 4.54,
      operatingCashFlowPerShareTTM: 9.19,
      freeCashFlowPerShareTTM: 8.36,
    });
    expect(summary.key_metrics_ttm.marketCap).toBe(3644938780583);
    expect(summary.key_metrics_ttm.returnOnEquityTTM).toBe(1.5994);
    expect(summary.income_stmt).toEqual([
      {
        date: '2025-09-27',
        period: 'FY',
        fiscalYear: '2025',
        revenue: 416161000000,
        grossProfit: 195201000000,
        operatingIncome: 133050000000,
        ebitda: 144427000000,
        incomeBeforeTax: 132729000000,
        netIncome: 112010000000,
        eps: 7.49,
        epsDiluted: 7.46,
        reportedCurrency: 'USD',
      },
    ]);
    expect(summary.balance_sheet?.[0].totalDebt).toBe(112377000000);
    expect(summary.cash_flow?.[0].freeCashFlow).toBe(98767000000);
    expect(summary._summary_meta).toEqual({ compact_view: true, has_coverage: true });
  });

  test('handles missing company profile and non-object payloads safely', () => {
    const summary = summarizeFundamentals({ symbol: 'AAPL' }) as any;
    expect(summary.symbol).toBe('AAPL');
    expect(summary.company_profile).toBeUndefined();
    expect(summarizeFundamentals(null)).toBeNull();
  });

  test('returns an explanatory empty-state note for ETF-like symbols without company-style fundamentals', () => {
    const summary = summarizeFundamentals(
      {
        symbol: 'SPY',
        ratios_ttm: {},
        key_metrics_ttm: {},
        fetched_at: '2026-03-23T07:47:06.96+00:00',
      },
      {
        company_name: 'State Street SPDR S&P 500 ETF Trust',
        industry: 'Asset Management',
      },
    ) as any;

    expect(summary.company_profile.company_name).toBe('State Street SPDR S&P 500 ETF Trust');
    expect(summary._note).toContain('No meaningful company-style TTM ratios or financial statements');
  });

  test('fills dividendYieldTTM from the shared /dividend-yield endpoint for an ETF (empty ratios-ttm)', () => {
    const summary = summarizeFundamentals(
      { symbol: 'SPY', ratios_ttm: {}, key_metrics_ttm: {}, fetched_at: '2026-06-29T00:00:00Z' },
      { company_name: 'State Street SPDR S&P 500 ETF Trust' },
      { symbol: 'SPY', dividendYield: 0.010155, source: 'profile_yield', asOf: '2026-06-29T06:00:00Z' },
    ) as any;
    expect(summary.ratios_ttm.dividendYieldTTM).toBe(0.0102);
  });

  test('does NOT override a real ratios-ttm dividend yield with the endpoint value', () => {
    const summary = summarizeFundamentals(
      { symbol: 'AAPL', ratios_ttm: { dividendYieldTTM: 0.00419372 }, key_metrics_ttm: {}, fetched_at: '2026-06-29T00:00:00Z' },
      { company_name: 'Apple Inc.' },
      { symbol: 'AAPL', dividendYield: 0.0037, source: 'ratios_ttm', asOf: '2026-06-29T05:00:00Z' },
    ) as any;
    expect(summary.ratios_ttm.dividendYieldTTM).toBe(0.0042);
  });

  test('withholds dividendYieldTTM (undefined) when the endpoint also has no yield', () => {
    const summary = summarizeFundamentals(
      { symbol: 'NODIV', ratios_ttm: {}, key_metrics_ttm: {}, fetched_at: '2026-06-29T00:00:00Z' },
      { company_name: 'No Dividend Co' },
      { symbol: 'NODIV', dividendYield: null, source: 'default', asOf: null },
    ) as any;
    expect(summary.ratios_ttm.dividendYieldTTM).toBeUndefined();
  });
});
