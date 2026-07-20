import { describe, expect, test } from 'bun:test';
import { categorizeInsiderTrade, groupInsiderTrades, shapeInsiderTradingResponse } from './insiderTradingShaping.js';

describe('categorizeInsiderTrade', () => {
  test('classifies common transaction-code patterns', () => {
    expect(categorizeInsiderTrade({ formType: '4', transactionType: 'P-Purchase' })).toBe('open_market_buy');
    expect(categorizeInsiderTrade({ formType: '4', transactionType: 'S-Sale' })).toBe('open_market_sell');
    expect(categorizeInsiderTrade({ formType: '4', transactionType: 'F-InKind' })).toBe('tax_withholding');
    expect(categorizeInsiderTrade({ formType: '4', transactionType: 'M-Exempt' })).toBe('exercise_or_conversion');
    expect(categorizeInsiderTrade({ formType: '4', transactionType: 'A-Award' })).toBe('grant_or_award');
    expect(categorizeInsiderTrade({ formType: '3', transactionType: '' })).toBe('initial_holding');
  });
});

describe('groupInsiderTrades', () => {
  test('collapses repeated sale rows from the same filing into one event', () => {
    const grouped = groupInsiderTrades([
      {
        reportingName: 'Wilson-Thompson Kathleen',
        filingDate: '2026-02-27',
        transactionDate: '2026-02-25',
        transactionType: 'S-Sale',
        securityName: 'Common Stock',
        securitiesTransacted: 80,
        price: 412.46,
        url: 'https://example.com/filing-1',
      },
      {
        reportingName: 'Wilson-Thompson Kathleen',
        filingDate: '2026-02-27',
        transactionDate: '2026-02-25',
        transactionType: 'S-Sale',
        securityName: 'Common Stock',
        securitiesTransacted: 4777,
        price: 413.952,
        url: 'https://example.com/filing-1',
      },
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      category: 'open_market_sell',
      sharesTransacted: 4857,
      rawCount: 2,
      reportingName: 'Wilson-Thompson Kathleen',
      securityName: 'Common Stock',
    });
    expect(grouped[0]?.totalValue).toBeCloseTo((80 * 412.46) + (4777 * 413.952), 6);
  });
});

describe('shapeInsiderTradingResponse', () => {
  test('prefers open-market trades over awards and exercises in the default view', () => {
    const response = shapeInsiderTradingResponse({
      symbol: 'TSLA',
      insider_trades: [
        {
          reportingName: 'Taneja Vaibhav',
          typeOfOwner: 'officer: Chief Financial Officer',
          formType: '4',
          filingDate: '2026-03-09',
          transactionDate: '2026-03-05',
          transactionType: 'M-Exempt',
          securityName: 'Restricted Stock Unit',
          securitiesTransacted: 6538,
          price: 0,
          url: 'https://example.com/filing-2',
        },
        {
          reportingName: 'Taneja Vaibhav',
          typeOfOwner: 'officer: Chief Financial Officer',
          formType: '4',
          filingDate: '2026-03-09',
          transactionDate: '2026-03-06',
          transactionType: 'S-Sale',
          securityName: 'Common Stock',
          securitiesTransacted: 2264.5,
          price: 397.031,
          url: 'https://example.com/filing-2',
        },
      ],
    }) as {
      insider_trades: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
      _insider_trades_meta?: Record<string, unknown>;
      _insider_trades_status?: string;
    };

    expect(response.insider_trades).toEqual([
      {
        reportingName: 'Taneja Vaibhav',
        typeOfOwner: 'officer: Chief Financial Officer',
        categoryLabel: 'Open-market sell',
        formType: '4',
        transactionDate: '2026-03-06',
        filingDate: '2026-03-09',
        securityName: 'Common Stock',
        sharesTransacted: 2264.5,
        price: 397.031,
        totalValue: 2264.5 * 397.031,
        directOrIndirect: null,
        acquisitionOrDisposition: null,
        sharesOwned: null,
        rawTradeCount: 1,
        url: 'https://example.com/filing-2',
      },
    ]);
    expect(response.summary.openMarketSells).toBe(1);
    expect(response.summary.openMarketBuys).toBe(0);
    expect(response.summary.activityBreakdown).toEqual({
      'Exercise or conversion': 1,
      'Open-market sell': 1,
    });
    expect((response as any)._insiderTradesMeta?.kind).toBe('Open-market events');
  });

  test('falls back to administrative activity when no open-market buys or sells exist', () => {
    const response = shapeInsiderTradingResponse({
      symbol: 'AAPL',
      insider_trades: [
        {
          reportingName: 'WAGNER SUSAN',
          typeOfOwner: 'director',
          formType: '4',
          filingDate: '2026-02-26',
          transactionDate: '2026-02-24',
          transactionType: 'A-Award',
          securityName: 'Restricted Stock Unit',
          securitiesTransacted: 1139,
          price: 0,
          url: 'https://example.com/filing-3',
        },
        {
          reportingName: 'Newstead Jennifer',
          typeOfOwner: 'officer: SVP, GC and Secretary',
          formType: '3',
          filingDate: '2026-03-06',
          transactionDate: '2026-03-01',
          transactionType: '',
          securityName: 'Restricted Stock Unit',
          securitiesTransacted: 48871,
          price: 0,
          url: 'https://example.com/filing-4',
        },
      ],
    }) as {
      insider_trades: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
      _insiderTradesMeta?: Record<string, unknown>;
      _insiderTradesStatus?: string;
    };

    expect(response.insider_trades).toHaveLength(1);
    expect(response.insider_trades[0]?.categoryLabel).toBe('Grant or award');
    expect(response.summary.activityBreakdown).toEqual({
      'Grant or award': 1,
      'Initial holding': 1,
    });
    expect(response._insiderTradesMeta?.noRecentOpenMarketBuysOrSells).toBe(true);
  });

  test('returns a grouped event-level summary for repeated sale rows', () => {
    const response = shapeInsiderTradingResponse({
      symbol: 'META',
      insider_trades: [
        {
          reportingName: 'Olivan Javier',
          typeOfOwner: 'officer: Chief Operating Officer',
          formType: '4',
          filingDate: '2026-03-25',
          transactionDate: '2026-03-23',
          transactionType: 'S-Sale',
          securityName: 'Class A Common Stock',
          securitiesTransacted: 408,
          price: 605.38,
          directOrIndirect: 'I',
          acquisitionOrDisposition: 'D',
          url: 'https://example.com/filing-5',
        },
        {
          reportingName: 'Olivan Javier',
          typeOfOwner: 'officer: Chief Operating Officer',
          formType: '4',
          filingDate: '2026-03-25',
          transactionDate: '2026-03-23',
          transactionType: 'S-Sale',
          securityName: 'Class A Common Stock',
          securitiesTransacted: 926,
          price: 605.38,
          directOrIndirect: 'D',
          acquisitionOrDisposition: 'D',
          url: 'https://example.com/filing-5',
        },
      ],
    }) as {
      insider_trades: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    };

    expect(response.insider_trades).toHaveLength(1);
    expect(response.insider_trades[0]).toMatchObject({
      reportingName: 'Olivan Javier',
      categoryLabel: 'Open-market sell',
      sharesTransacted: 1334,
      directOrIndirect: 'mixed',
      acquisitionOrDisposition: 'D',
      rawTradeCount: 2,
    });
    expect(response.summary.rawRows).toBe(2);
    expect(response.summary.groupedEvents).toBe(1);
  });

  test('returns an explanatory empty-state note for ETF-like symbols without insider activity', () => {
    const response = shapeInsiderTradingResponse({
      symbol: 'SPY',
      insider_trades: [],
      fetched_at: '2026-03-26T06:07:41.358+00:00',
    }, {
      company_name: 'State Street SPDR S&P 500 ETF Trust',
      industry: 'Asset Management',
    }) as {
      insider_trades: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
      _insiderTradesMeta?: Record<string, unknown>;
      _insiderTradesStatus?: string;
    };

    expect(response.insider_trades).toEqual([]);
    expect(response.summary.groupedEvents).toBe(0);
    expect(response._insiderTradesStatus).toBe('No corporate insider filings (likely ETF)');
  });
});
