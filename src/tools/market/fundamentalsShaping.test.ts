import { describe, expect, test } from 'bun:test';
import { currencyContext, shapeFundamentalsFull, summarizeFundamentals } from './fundamentalsShaping.js';
import { applyResponseSizeGuard, MAX_RESPONSE_BYTES, sanitizeMcpWireOutput, utf8ByteLength } from '../helpers.js';
import { RESPONSE_MARGIN_BYTES } from './dealerPositioningShaping.js';

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


describe('reported dividend yield is independent of pricing eligibility', () => {
  test.each([
    [{ dividendYield: null, observedYield: 1.853678 }, 1.8537],
    [{ dividendYield: null, observedYield: 0 }, 0],
    [{ dividendYield: 0.04, observedYield: null }, undefined],
    [{ dividendYield: 0.04 }, 0.04],
  ])('preserves endpoint observation %j', (info, expected) => {
    const out = summarizeFundamentals({ symbol: 'FUND', ratios_ttm: {}, key_metrics_ttm: {} }, null, info) as any;
    expect(out.ratios_ttm.dividendYieldTTM).toBe(expected);
  });
});

describe('the currencies beside the figures', () => {
  // Live test 2026-10-04: TSM's key-metrics market cap read 64.8T (TWD) beside a 2.45T (USD) profile, unlabeled.
  const TSM = {
    symbol: 'TSM',
    ratios_ttm: { priceToEarningsRatioTTM: 28.98, cashPerShareTTM: 678.37 },
    key_metrics_ttm: { marketCap: 64831000000000 },
    income_stmt: [{ date: '2024-12-31', reportedCurrency: 'TWD', revenue: 1 }, { date: '2025-12-31', reportedCurrency: 'TWD', revenue: 2 }],
    income_stmt_quarterly: [{ date: '2026-06-30', reportedCurrency: 'TWD', revenue: 3 }],
  };
  const TSM_PROFILE = { symbol: 'TSM', mkt_cap: 2452064014400, last_div: 3.49569, currency: 'USD' };

  test('a company reporting in another currency than it trades in: both named, and a note', () => {
    const summary = summarizeFundamentals(TSM, TSM_PROFILE) as any;
    expect(summary.company_profile.currency).toBe('USD');
    expect(summary.currencies).toEqual({ reported: 'TWD', reportedAsOf: '2026-06-30', trading: 'USD' });
    // Live test #5: the summary shows FY 2025-12-31 only, so the quarter it dates the currency from is said to be in full.
    expect(summary.currencyNote).toBe('The newest statement on file (2026-06-30, a quarter: `full: true` lists the quarterly statements) reports in TWD; the listing trades here in USD. Each statement names its own currency in `reportedCurrency`. '
      + 'The money amounts and per-share figures in `ratiosTtm` and `keyMetricsTtm` (marketCap, enterpriseValueTTM, workingCapitalTTM, cashPerShareTTM and the like) '
      + 'carry no currency of their own: they are normally in the company\'s reporting currency, TWD by that statement, but they are refreshed apart from the statements, '
      + 'so around a change of reporting currency the two can disagree. '
      + '`companyProfile` (marketCap, lastDividend) and `valuation.marketCap` are in USD. The ratios, margins, returns and yields are the same in either currency.');
    // The full payload carries no companyProfile: its note names only what it holds.
    const full = currencyContext(TSM, TSM_PROFILE, 'full') as any;
    expect(full.currencyNote).toContain('the two can disagree. `valuation.marketCap` is in USD. The ratios');
    // The full payload lists the quarters: no pointer to them.
    expect(full.currencyNote).toStartWith('The newest statement on file (2026-06-30) reports in TWD; ');
  });

  test('after a change of reporting currency, an older statement keeps its own and the note does not claim it', () => {
    // Review: a 2026 quarter in EUR, the 2025 annual (the one the summary returns) in USD.
    const moved = {
      symbol: 'X', key_metrics_ttm: { marketCap: 1 },
      income_stmt: [{ date: '2025-12-31', period: 'FY', reportedCurrency: 'USD', revenue: 100 }],
      income_stmt_quarterly: [{ date: '2026-03-31', period: 'Q1', reportedCurrency: 'EUR', revenue: 30 }],
    };
    const summary = summarizeFundamentals(moved, { currency: 'USD' }) as any;
    expect(summary.income_stmt[0]).toMatchObject({ date: '2025-12-31', reportedCurrency: 'USD' });
    expect(summary.currencies).toEqual({ reported: 'EUR', reportedAsOf: '2026-03-31', trading: 'USD' });
    expect(summary.currencyNote).toStartWith('The newest statement on file (2026-03-31, a quarter: `full: true` lists the quarterly statements) reports in EUR; ');
    expect(summary.currencyNote).toContain('Each statement names its own currency in `reportedCurrency`.');
    expect(summary.currencyNote).not.toContain('The statements and');
  });

  test('the TTM is put in the statement\'s currency only as its usual one, whichever side is newer', () => {
    // Review: the TTM objects come from a daily file with no currency, refreshed apart from the
    // statements. After a change of reporting currency the TTM can be ahead of the statements (CAD statements,
    // USD TTM) or behind them (an EUR statement stored, then an older file's CAD TTM): the note may not say
    // flatly that they are the statement's, nor limit the exception to a change after the statement.
    const stale = { symbol: 'X', ttm_bulk_as_of: '2026-10-03T14:36:54+00:00', key_metrics_ttm: { marketCap: 5 }, income_stmt: [{ date: '2025-12-31', reportedCurrency: 'CAD' }] };
    const note = (summarizeFundamentals(stale, { currency: 'USD' }) as any).currencyNote as string;
    expect(note).toContain('carry no currency of their own: they are normally in the company\'s reporting currency, CAD by that statement, but they are refreshed apart from the statements, so around a change of reporting currency the two can disagree.');
    expect(note).not.toMatch(/keyMetricsTtm[^.]*\) are in CAD/);
    expect(note).not.toContain('after that statement');
    // A statement with no date: the note names none, and the date is null.
    const undated = currencyContext({ symbol: 'X', income_stmt: [{ reportedCurrency: 'CAD' }] }, { currency: 'USD' }, 'summary') as any;
    expect(undated.currencies).toEqual({ reported: 'CAD', reportedAsOf: null, trading: 'USD' });
    expect(undated.currencyNote).toStartWith('The newest statement on file reports in CAD; ');
  });

  test('a quarter sharing its date with the latest annual period is shown in the summary: no pointer', () => {
    // MSFT-like: the fiscal year ends 2026-06-30, so the newest quarter and the annual period share the date.
    const fy = { symbol: 'X', income_stmt: [{ date: '2026-06-30', reportedCurrency: 'EUR' }], income_stmt_quarterly: [{ date: '2026-06-30', reportedCurrency: 'EUR' }] };
    const note = (currencyContext(fy, { currency: 'USD' }, 'summary') as any).currencyNote as string;
    expect(note).toStartWith('The newest statement on file (2026-06-30) reports in EUR; ');
    // An annual period on any of the three statements counts: a cash flow annual sharing the date is shown too.
    const cf = { symbol: 'X', income_stmt: [{ date: '2025-06-30', reportedCurrency: 'EUR' }], cash_flow: [{ date: '2026-06-30', reportedCurrency: 'EUR' }], balance_sheet_quarterly: [{ date: '2026-06-30', reportedCurrency: 'EUR' }] };
    expect((currencyContext(cf, { currency: 'USD' }, 'summary') as any).currencyNote).toStartWith('The newest statement on file (2026-06-30) reports in EUR; ');
  });

  test('an annual row the summary does not show is never called a quarter (review)', () => {
    // FY 2025 names no currency, so FY 2024's CAD is the newest named; there are no quarters at all.
    const annualOnly = {
      symbol: 'X',
      income_stmt: [{ date: '2025-12-31', reportedCurrency: null }, { date: '2024-12-31', reportedCurrency: 'CAD' }],
      income_stmt_quarterly: [], balance_sheet_quarterly: [], cash_flow_quarterly: [],
    };
    const out = currencyContext(annualOnly, { currency: 'USD' }, 'summary') as any;
    expect(out.currencies).toEqual({ reported: 'CAD', reportedAsOf: '2024-12-31', trading: 'USD' });
    expect(out.currencyNote).toStartWith('The newest statement on file (2024-12-31) reports in CAD; ');
    expect(out.currencyNote).not.toContain('a quarter');
  });

  test('the newest statement across the lists names the reported currency', () => {
    // A company that moved its reporting to EUR in 2026: the newest line is a quarter.
    const moved = { symbol: 'X', income_stmt: [{ date: '2025-12-31', reportedCurrency: 'USD' }], cash_flow_quarterly: [{ date: '2026-03-31', reportedCurrency: ' eur ' }] };
    expect(currencyContext(moved, { currency: 'USD' }, 'summary').currencies).toEqual({ reported: 'EUR', reportedAsOf: '2026-03-31', trading: 'USD' });
    // A row without a usable code is passed over, not read as a currency.
    const blank = { symbol: 'X', income_stmt: [{ date: '2025-12-31', reportedCurrency: 'JPY' }], balance_sheet: [{ date: '2026-03-31', reportedCurrency: 'N/A' }, { date: '2026-06-30' }] };
    expect(currencyContext(blank, { currency: 'USD' }, 'summary').currencies).toEqual({ reported: 'JPY', reportedAsOf: '2025-12-31', trading: 'USD' });
  });

  test('the same currency on both sides is named without a note; an unknown side is null; neither known is nothing', () => {
    const same = summarizeFundamentals({ symbol: 'AAPL', income_stmt: [{ date: '2025-09-27', reportedCurrency: 'USD' }] }, { currency: 'USD' }) as any;
    expect(same.currencies).toEqual({ reported: 'USD', reportedAsOf: '2025-09-27', trading: 'USD' });
    expect('currencyNote' in same).toBe(false);
    // No profile: the trading currency is unknown, so nothing is compared.
    const noProfile = summarizeFundamentals(TSM) as any;
    expect(noProfile.currencies).toEqual({ reported: 'TWD', reportedAsOf: '2026-06-30', trading: null });
    expect('currencyNote' in noProfile).toBe(false);
    expect(currencyContext({ symbol: 'X' }, { currency: 'USD' }, 'summary')).toEqual({ currencies: { reported: null, reportedAsOf: null, trading: 'USD' } });
    expect(currencyContext({ symbol: 'X' }, null, 'summary')).toEqual({});
    expect(currencyContext(null, Symbol('failed'), 'full')).toEqual({});
  });
});

describe('full=true fits the response budget', () => {
  // Live test 2026-10-04: get_fundamentals full=true for TSM answered "Response too large" (52 KB): the raw
  // statements sit at the budget, and `valuation` beside them pushed TSM, MSFT and BABA over (TM was over without it).
  const row = (date: string) => Object.fromEntries([['date', date], ['reportedCurrency', 'USD'],
    ...Array.from({ length: 40 }, (_, i) => [`field${i}`, 123456789.123 + i])]);
  const periods = (n: number, quarterly: boolean) => Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, quarterly ? 5 - 3 * i : 11 - 12 * i, 30));
    return row(d.toISOString().slice(0, 10));
  });
  const big = {
    symbol: 'BIG', ratios_ttm: { priceToEarningsRatioTTM: 28.98 }, key_metrics_ttm: { marketCap: 1 },
    income_stmt: periods(30, false), income_stmt_quarterly: periods(120, true).reverse(), // stored oldest first here
    balance_sheet: periods(30, false), balance_sheet_quarterly: periods(100, true),
    cash_flow: periods(29, false), cash_flow_quarterly: periods(94, true),
  };
  const extras = { valuation: { peTtm: 28.98 }, currencies: { reported: 'USD', reportedAsOf: '2026-06-30', trading: 'USD' } };
  const bytes = (out: unknown) => utf8ByteLength(JSON.stringify(sanitizeMcpWireOutput(out)));

  test('the most newest periods that fit, the same number in every list, and fullMeta says so', () => {
    const out = shapeFundamentalsFull(big, extras) as any;
    const n = out.fullMeta.periodsPerStatement;
    expect(n).toBeGreaterThan(0);
    for (const key of ['income_stmt', 'income_stmt_quarterly', 'balance_sheet', 'balance_sheet_quarterly', 'cash_flow', 'cash_flow_quarterly']) {
      expect(out[key], key).toHaveLength(n);
    }
    // Newest first, whatever order the list arrived in.
    expect(out.income_stmt_quarterly[0].date).toBe('2026-06-30');
    expect(out.income_stmt_quarterly.map((r: any) => r.date)).toEqual([...out.income_stmt_quarterly.map((r: any) => r.date)].sort().reverse());
    expect(out.fullMeta).toEqual({ periodsPerStatement: n, periodsOnFile: { income_stmt_quarterly: 120, income_stmt: 30, balance_sheet_quarterly: 100, balance_sheet: 30, cash_flow_quarterly: 94, cash_flow: 29 }, trimmedForSize: true });
    expect(out.valuation).toEqual(extras.valuation);
    expect(out.currencies).toEqual(extras.currencies);
    expect(out.ratios_ttm).toEqual(big.ratios_ttm);
    // Within the budget less the margin, and one more period would not be.
    expect(bytes(out)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES - RESPONSE_MARGIN_BYTES);
    const onePlus = { ...out };
    for (const key of ['income_stmt_quarterly', 'balance_sheet_quarterly', 'cash_flow_quarterly']) {
      onePlus[key] = [...(big as any)[key]].sort((a: any, b: any) => b.date.localeCompare(a.date)).slice(0, n + 1);
    }
    expect(bytes(onePlus)).toBeGreaterThan(MAX_RESPONSE_BYTES - RESPONSE_MARGIN_BYTES);
    // The guard passes it through: no "Response too large", no meta of its own.
    const wire = JSON.parse(applyResponseSizeGuard(out));
    expect(wire.error).toBeUndefined();
    expect(wire.fullMeta.periodsPerStatement).toBe(n);
  });

  test('the margin holds even where one more period adds only a few hundred bytes', () => {
    // Small rows: the 2 KB margin spans several periods, so the count is the margin's to decide.
    const small = (i: number) => ({ date: new Date(Date.UTC(2026, 5 - 3 * i, 30)).toISOString().slice(0, 10), reportedCurrency: 'USD', revenue: 1000000 + i, netIncome: 2000 + i, eps: 1.25 });
    const out = shapeFundamentalsFull({ symbol: 'SMALL', income_stmt_quarterly: Array.from({ length: 1000 }, (_, i) => small(i)) }, {}) as any;
    const n = out.fullMeta.periodsPerStatement;
    expect(bytes(out)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES - RESPONSE_MARGIN_BYTES);
    expect(bytes({ ...out, income_stmt_quarterly: Array.from({ length: n + 1 }, (_, i) => small(i)) })).toBeGreaterThan(MAX_RESPONSE_BYTES - RESPONSE_MARGIN_BYTES);
  });

  test('a payload that fits is returned whole, with no fullMeta', () => {
    const small = { symbol: 'S', income_stmt: periods(3, false), cash_flow_quarterly: periods(5, true), ratios_ttm: {} };
    const out = shapeFundamentalsFull(small, extras) as any;
    expect(out.income_stmt).toHaveLength(3);
    expect(out.cash_flow_quarterly).toHaveLength(5);
    expect('fullMeta' in out).toBe(false);
    expect(out.valuation).toEqual(extras.valuation);
  });
});

describe('the TTM figures\' refresh stamps', () => {
  // Live test #6: the compact view showed fetchedAt (2026-10-01) but not the TTM files' 2026-10-03.
  // Review: neither stamp says which refresh wrote the figures shown (the files' date is their
  // publication date, and a partial refresh leaves it as it was), so both are given and nothing is derived.
  test('the summary carries the daily files\' stamp beside fetchedAt, as the full payload does', () => {
    const out = summarizeFundamentals({ symbol: 'TSM', ratios_ttm: { priceToEarningsRatioTTM: 29 }, fetched_at: '2026-10-01T05:23:28.651+00:00', ttm_bulk_as_of: '2026-10-03T14:36:54+00:00' }) as any;
    expect(out.ttm_bulk_as_of).toBe('2026-10-03T14:36:54+00:00');
    expect(out.fetched_at).toBe('2026-10-01T05:23:28.651+00:00');
    expect('ttm_as_of' in out).toBe(false);
    expect('ttm_bulk_as_of' in (summarizeFundamentals({ symbol: 'X', ratios_ttm: { priceToEarningsRatioTTM: 29 } }) as any)).toBe(false);
  });
});

describe('a dividend yield that could not be read', () => {
  const payload = { symbol: 'SPY', ratios_ttm: {}, key_metrics_ttm: {}, fetched_at: '2026-10-07T06:00:00Z' };

  test('no ratios yield and the endpoint unread: null with a note, never left as plain absence', () => {
    const out = summarizeFundamentals(payload, null, { symbol: 'SPY', dividendYield: null, observedYield: null, reason: 'read_failed' }) as any;
    expect(out.ratios_ttm?.dividendYieldTTM ?? out.ratios?.dividendYieldTTM ?? null).toBeNull();
    expect(out.dividendYieldNote).toMatch(/could not be read/);
    expect(sanitizeMcpWireOutput(out) as any).toHaveProperty('dividendYieldNote');
  });

  test('a yield in the ratios beside an unread endpoint: the yield is known, no unread note (the control)', () => {
    const out = summarizeFundamentals({ ...payload, ratios_ttm: { dividendYieldTTM: 0.0123 } }, null, { symbol: 'SPY', dividendYield: null, observedYield: null, reason: 'read_failed' }) as any;
    expect('dividendYieldNote' in out).toBe(false);
  });

  test('a yield the endpoint withheld on purpose: no unread note (the control)', () => {
    const out = summarizeFundamentals(payload, null, { symbol: 'SPY', dividendYield: null, observedYield: null, source: 'default', note: null }) as any;
    expect('dividendYieldNote' in out).toBe(false);
  });
});
