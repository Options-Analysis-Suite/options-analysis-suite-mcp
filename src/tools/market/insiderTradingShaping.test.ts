import { describe, expect, test } from 'bun:test';
import { applyResponseSizeGuard, MAX_RESPONSE_BYTES, utf8ByteLength } from '../helpers.js';
import { sanitizeMcpWireOutput } from '../helpers.js';
import { categorizeInsiderTrade, groupInsiderTrades, MARKET_INSIDER_NOTE, noInsiderRecord, shapeInsiderTradingResponse, shapeMarketInsiderTrades } from './insiderTradingShaping.js';

describe('categorizeInsiderTrade', () => {
  test('classifies common transaction-code patterns', () => {
    expect(categorizeInsiderTrade({ formType: '4', transactionType: 'P-Purchase' })).toBe('purchase');
    expect(categorizeInsiderTrade({ formType: '4', transactionType: 'S-Sale' })).toBe('sale');
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
      category: 'sale',
      sharesTransacted: 4857,
      rawCount: 2,
      reportingName: 'Wilson-Thompson Kathleen',
      securityName: 'Common Stock',
    });
    expect(grouped[0]?.totalValue).toBeCloseTo((80 * 412.46) + (4777 * 413.952), 6);
  });
});

describe('shapeInsiderTradingResponse', () => {
  test('prefers purchases and sales over awards and exercises in the default view', () => {
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
        categoryLabel: 'Sale',
        formType: '4',
        transactionDate: '2026-03-06',
        filingDate: '2026-03-09',
        securityName: 'Common Stock',
        sharesTransacted: 2264.5,
        price: 397.031,
        // To the cent: 2264.5 x 397.031 = 899,076.6995.
        totalValue: 899076.7,
        directOrIndirect: null,
        acquisitionOrDisposition: null,
        sharesOwned: null,
        rawTradeCount: 1,
        url: 'https://example.com/filing-2',
      },
    ]);
    // Codes P and S are purchases and sales, open market or private alike: nothing here says which.
    expect(response.summary.sales).toBe(1);
    expect(response.summary.purchases).toBe(0);
    expect(response.summary.activityBreakdown).toEqual({
      'Exercise or conversion': 1,
      'Sale': 1,
    });
    expect((response as any).insiderTradesMeta?.kind).toBe('Purchases and sales');
    expect((response as any).purchaseSaleNote).toContain('open market or privately');
  });

  test('falls back to administrative activity when no purchases or sales exist', () => {
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
      insiderTradesMeta?: Record<string, unknown>;
      insiderTradesStatus?: string;
    };

    expect(response.insider_trades).toHaveLength(1);
    expect(response.insider_trades[0]?.categoryLabel).toBe('Grant or award');
    expect(response.summary.activityBreakdown).toEqual({
      'Grant or award': 1,
      'Initial holding': 1,
    });
    expect(response.insiderTradesMeta?.noRecentPurchasesOrSales).toBe(true);
    expect('purchaseSaleNote' in response).toBe(false);
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
      categoryLabel: 'Sale',
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
      is_etf: true,
    }) as {
      insider_trades: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
      insiderTradesMeta?: Record<string, unknown>;
      insiderTradesStatus?: string;
    };

    expect(response.insider_trades).toEqual([]);
    expect(response.summary.groupedEvents).toBe(0);
    expect(response.insiderTradesStatus).toBe('No insider filings on record for this exchange-traded product.');
  });

  test('the status says only what is on record, and names an ETF by its stored flag, never by its name', () => {
    // review: "No corporate insider filings" read a missing record as an impossibility,
    // and the name heuristic called an asset manager (BX) and closed-end funds (ADX, PDI: they file Form 4s) "likely ETF".
    for (const profile of [
      { company_name: 'Blackstone Inc.', industry: 'Asset Management', is_etf: false },
      { company_name: 'Adams Diversified Equity Fund, Inc.', industry: 'Asset Management', is_etf: false },
      { company_name: 'SPDR S&P 500 ETF Trust' },
      null,
    ]) {
      expect((shapeInsiderTradingResponse({ symbol: 'X', insider_trades: [] }, profile) as any).insiderTradesStatus, JSON.stringify(profile))
        .toBe('No insider filings on record for this symbol.');
      expect(noInsiderRecord('X', profile).insiderTradesStatus).toBe('No insider filings on record for this symbol.');
    }
  });

  test('the meta counts purchases and sales apart from every grouped event; values are to the cent; the period spans the lines on file', () => {
    // Live run 2026-10-04: AAPL's meta read kind "Purchases and sales" beside
    // totalGrouped 372, every category's count (73 were sales), and saleValue
    // came back 832762246.6704.
    const r = shapeInsiderTradingResponse({
      symbol: 'X',
      insider_trades: [
        { reportingName: 'A', formType: '4', transactionType: 'P-Purchase', filingDate: '2026-01-07', transactionDate: '2026-01-05', securitiesTransacted: 10, price: 5.333 },
        { reportingName: 'B', formType: '4', transactionType: 'S-Sale', filingDate: '2026-02-11', transactionDate: '2026-02-10', securitiesTransacted: 3, price: 7.1111 },
        { reportingName: 'C', formType: '4', transactionType: 'A-Award', filingDate: '2025-12-02', transactionDate: '2025-12-01', securitiesTransacted: 100, price: 0 },
        { reportingName: 'D', formType: '3', filingDate: '2025-11-02', securitiesTransacted: 0, securitiesOwned: 500 },
      ],
    }) as any;
    expect(r.insiderTradesMeta).toMatchObject({ kind: 'Purchases and sales', showing: 2, totalPurchasesAndSales: 2, totalGrouped: 4 });
    expect(r.summary).toMatchObject({ purchases: 1, sales: 1, purchaseValue: 53.33, saleValue: 21.33, netValue: 32 });
    expect(r.insider_trades.map((t: any) => t.totalValue)).toEqual([21.33, 53.33]);
    expect(r.summary.period).toEqual({ from: '2025-11-02', through: '2026-02-10' });
  });

  test('no insider record on file says so, naming an exchange-traded product', () => {
    // Live run 2026-10-04: SPY answered "No data available" (the route 404s), not a status.
    expect(noInsiderRecord('SPY', { company_name: 'SPDR S&P 500 ETF Trust', is_etf: true }))
      .toEqual({ symbol: 'SPY', insider_trades: [], insiderTradesStatus: 'No insider filings on record for this exchange-traded product.' });
    expect(noInsiderRecord('ZZZZ', null)).toEqual({ symbol: 'ZZZZ', insider_trades: [], insiderTradesStatus: 'No insider filings on record for this symbol.' });
  });

  test('lines filed under another CIK are left out of the list and the summary, counted and said', () => {
    // Live run 2026-10-04: BX listed Blackstone Holdings IV's purchases of another Blackstone vehicle's
    // "Common Shares of Beneficial Interest" at 26.17 (issuer CIK 2049733) as BX purchases, 48% of purchaseValue.
    const own = { reportingName: 'Gray Jonathan', formType: '4', transactionType: 'S-Sale', filingDate: '2026-09-02', transactionDate: '2026-09-01', securitiesTransacted: 1000, price: 140, companyCik: '0001393818' };
    const other = { reportingName: 'Blackstone Holdings IV L.P.', formType: '4', transactionType: 'P-Purchase', filingDate: '2026-09-04', transactionDate: '2026-09-03', securitiesTransacted: 769892.884, price: 26.14, companyCik: '0002049733' };
    const r = shapeInsiderTradingResponse({ symbol: 'BX', insider_trades: [own, other] }, { symbol: 'BX', cik: '0001393818' }) as any;
    expect(r.insider_trades.map((t: any) => t.reportingName)).toEqual(['Gray Jonathan']);
    expect(r.summary).toMatchObject({ purchases: 0, sales: 1, purchaseValue: 0, saleValue: 140000, rawRows: 2, otherIssuerLines: 1 });
    expect(r.summary.period).toEqual({ from: '2026-09-01', through: '2026-09-01' });
    // The CIK alone does not say whose the lines are (review): the note claims none of the three.
    expect(r.otherIssuerNote).toBe('1 line on file was filed under an issuer CIK other than the company profile\'s (1393818): '
      + 'a predecessor\'s (a company that reorganizes, redomiciles or converts can file under a new CIK), a former holder of this ticker\'s, '
      + 'or another issuer whose securities this company or its insiders report holding; the CIK alone does not say which. '
      + 'It is left out of the list and the summary: `otherIssuers` gives each CIK\'s lines, dates, security names and purchases and sales, and `full` returns the raw lines with each one\'s `companyCik`.');
    expect(r.otherIssuers).toEqual([{ companyCik: '2049733', lines: 1, period: { from: '2026-09-03', through: '2026-09-03' }, securityNames: [], purchases: 1, sales: 0, purchaseValue: 20124999.99, saleValue: 0 }]);
    expect('otherIssuersMeta' in r).toBe(false);
    // Only another CIK's lines: nothing on record under the profile's CIK, and the status says where they are.
    const onlyOther = shapeInsiderTradingResponse({ symbol: 'BX', insider_trades: [other, other] }, { symbol: 'BX', cik: '1393818' }) as any;
    expect(onlyOther.insider_trades).toEqual([]);
    expect(onlyOther.insiderTradesStatus).toBe('No insider filings on record under the company profile\'s CIK (1393818); the lines on file were filed under another (`otherIssuers`).');
    expect(onlyOther.otherIssuerNote).toContain('2 lines on file were filed under an issuer CIK other than the company profile\'s (1393818): ');
    expect(onlyOther.otherIssuerNote).toContain('They are left out of the list and the summary: ');
    // No CIK on record for the company: nothing can be told apart, so nothing is left out; two issuers on file are said.
    const noCik = shapeInsiderTradingResponse({ symbol: 'BX', insider_trades: [own, other] }, { symbol: 'BX' }) as any;
    expect(noCik.insider_trades).toHaveLength(2);
    expect(noCik.summary.otherIssuerLines).toBeUndefined();
    expect('otherIssuers' in noCik).toBe(false);
    expect(noCik.otherIssuerNote).toBe('The lines on file name more than one issuer, and the company\'s own CIK is not on record to tell them apart.');
    // A line naming no issuer cannot be told apart and is kept; a CIK is compared without its leading zeros.
    const { companyCik: _drop, ...unnamed } = own;
    const kept = shapeInsiderTradingResponse({ symbol: 'BX', insider_trades: [own, unnamed, other] }, { symbol: 'BX', cik: '1393818' }) as any;
    expect(kept.summary).toMatchObject({ sales: 1, rawRows: 3, otherIssuerLines: 1 });
    expect(kept.insider_trades[0].rawTradeCount).toBe(2);
    // One issuer throughout, the company's or not: no note.
    expect('otherIssuerNote' in (shapeInsiderTradingResponse({ symbol: 'BX', insider_trades: [own] }, { symbol: 'BX' }) as any)).toBe(false);
  });

  test('a predecessor\'s lines under its old CIK stay on the record, apart from the confirmed totals', () => {
    // Review: a company that redomiciled files under a new CIK (prod: XPRO, CAAS, UNIT hold only
    // their predecessor's lines). Dropping them read "no filings for this company's own securities".
    const old = (day: string, type: string, shares: number, price: number, security = 'Common Stock') =>
      ({ reportingName: 'Insider ' + day, formType: '4', transactionType: type, filingDate: day, transactionDate: day, securitiesTransacted: shares, price, securityName: security, companyCik: '0000000100', url: 'u' + day });
    const r = shapeInsiderTradingResponse({ symbol: 'XPRO', insider_trades: [
      // One purchase filed as two lines: one event, two lines.
      old('2026-06-30', 'P-Purchase', 100, 10), old('2026-06-30', 'P-Purchase', 100, 10), old('2026-05-01', 'S-Sale', 50, 12.345), old('2025-01-02', 'A-Award', 10, 0, 'Restricted Stock Units'),
    ] }, { symbol: 'XPRO', cik: '200' }) as any;
    expect(r.summary).toMatchObject({ purchases: 0, sales: 0, purchaseValue: 0, saleValue: 0, rawRows: 4, otherIssuerLines: 4 });
    expect(r.insiderTradesStatus).toBe('No insider filings on record under the company profile\'s CIK (200); the lines on file were filed under another (`otherIssuers`).');
    expect(r.otherIssuers).toEqual([{
      companyCik: '100', lines: 4, period: { from: '2025-01-02', through: '2026-06-30' },
      securityNames: ['Common Stock', 'Restricted Stock Units'], purchases: 1, sales: 1, purchaseValue: 2000, saleValue: 617.25,
    }]);
  });

  test('other CIKs are listed newest lines first, ten at most, with a meta for the rest', () => {
    const line = (cik: number, day: string, security: string) =>
      ({ reportingName: 'R' + cik, formType: '4', transactionType: 'P-Purchase', filingDate: day, transactionDate: day, securitiesTransacted: 1, price: 1, securityName: security, companyCik: String(cik), url: `u${cik}${day}${security}` });
    // CIKs 7 and 8 both run through 2026-02-01; 8 ends with four lines to 7's two, and more lines go first on a tie.
    const lines = [line(7, '2026-01-01', 'A'), line(7, '2026-02-01', 'B'), line(8, '2026-02-01', 'A')];
    for (let cik = 10; cik < 20; cik += 1) lines.push(line(cik, `2025-0${cik - 9 > 9 ? 9 : 1}-${String(cik).padStart(2, '0')}`, 'A'));
    // Four security names under one CIK: three kept.
    lines.push(line(8, '2025-12-01', 'B'), line(8, '2025-12-01', 'C'), line(8, '2025-12-01', 'D'));
    const r = shapeInsiderTradingResponse({ symbol: 'X', insider_trades: lines }, { symbol: 'X', cik: '1' }) as any;
    expect(r.otherIssuers).toHaveLength(10);
    expect(r.otherIssuers.slice(0, 2).map((o: any) => [o.companyCik, o.lines])).toEqual([['8', 4], ['7', 2]]);
    expect(r.otherIssuers[0].securityNames).toEqual(['A', 'B', 'C']);
    // The rest newest first: CIK 19 (2025-09-19), then 18 down to 12; 11 and 10, the oldest, are cut.
    expect(r.otherIssuers.slice(2).map((o: any) => o.companyCik)).toEqual(['19', '18', '17', '16', '15', '14', '13', '12']);
    expect(r.otherIssuersMeta).toEqual({ showing: 10, total: 12, truncated: true });
    expect(r.summary.otherIssuerLines).toBe(16);
  });

  test('an event\'s average price is rounded to 4 decimals', () => {
    // Live run: BX read 147.113575111111.
    const r = shapeInsiderTradingResponse({ symbol: 'X', insider_trades: [
      { reportingName: 'A', formType: '4', transactionType: 'S-Sale', transactionDate: '2026-09-01', securitiesTransacted: 3, price: 147.1, url: 'u' },
      { reportingName: 'A', formType: '4', transactionType: 'S-Sale', transactionDate: '2026-09-01', securitiesTransacted: 6, price: 147.12036267, url: 'u' },
    ] }) as any;
    expect(r.insider_trades[0].price).toBe(147.1136);
  });

  test('the meta and the status reach the wire', () => {
    // They were _insiderTradesMeta / _insiderTradesStatus, and the wire drops
    // a leading-underscore key it has no rename for: an empty record's status
    // never reached the model.
    const empty = sanitizeMcpWireOutput(shapeInsiderTradingResponse({ symbol: 'SPY', insider_trades: [] }, { company_name: 'SPDR S&P 500 ETF Trust', is_etf: true })) as Record<string, unknown>;
    expect(empty.insiderTradesStatus).toBe('No insider filings on record for this exchange-traded product.');
    const listed = sanitizeMcpWireOutput(shapeInsiderTradingResponse({
      symbol: 'AAPL',
      insider_trades: [{ reportingName: 'A', formType: '4', transactionType: 'P-Purchase', transactionDate: '2026-09-01', securitiesTransacted: 10, price: 5 }],
    })) as Record<string, any>;
    expect(listed.insiderTradesMeta).toMatchObject({ kind: 'Purchases and sales', showing: 1 });
    expect(listed.summary).toMatchObject({ purchases: 1, sales: 0, purchaseValue: 50, saleValue: 0, netValue: 50 });
    // The lines under another CIK, by CIK, and their note.
    const other = sanitizeMcpWireOutput(shapeInsiderTradingResponse({
      symbol: 'XPRO',
      insider_trades: [{ reportingName: 'A', formType: '4', transactionType: 'P-Purchase', transactionDate: '2026-06-30', securitiesTransacted: 10, price: 5, companyCik: '0000000100' }],
    }, { symbol: 'XPRO', cik: '200' })) as Record<string, any>;
    expect(other.otherIssuers).toEqual([{ companyCik: '100', lines: 1, period: { from: '2026-06-30', through: '2026-06-30' }, securityNames: [], purchases: 1, sales: 0, purchaseValue: 50, saleValue: 0 }]);
    expect(other.otherIssuerNote).toContain('filed under an issuer CIK other than the company profile\'s (200)');
  });
});

// The proxy's /market/insider-trades (sql/181 valued lines), 2026-10-02 shapes.
const MARKET = {
  days: 7,
  kind: 'purchases',
  from: '2026-09-26',
  asOf: '2026-10-02',
  total: 457,
  summary: {
    purchases: { trades: 457, shares: 54044854.0732, value: 466207927.224234 },
    sales: { trades: 1250, shares: 90971425.638, value: 1274814283.21004 },
    topPurchases: [{ symbol: 'KOD', trades: 82, shares: 1941755, value: 156986393.7365 }, { symbol: 'XYZ', trades: 3, shares: 10, value: null }],
    topSales: [{ symbol: 'INNV', trades: 4, shares: 30023814, value: 185207181.8 }],
  },
  trades: [
    {
      symbol: 'PAM', filingDate: '2026-10-02', transactionDate: '2026-09-28', insider: 'Mindlin Damian Miguel', role: 'officer: Vicepresident',
      transactionType: 'P-Purchase', acquiredOrDisposed: 'A', directOrIndirect: 'D', shares: 15000, price: 77.628, value: 1164420.236,
      sharesOwnedAfter: 690893, security: 'American Depositary shares', formType: '4', url: 'https://www.sec.gov/a', attribution: 'issuer',
    },
    {
      symbol: 'UUU', filingDate: '2026-10-01', transactionDate: '2026-09-30', insider: 'Doe Jane', role: 'director',
      transactionType: 'P-Purchase', acquiredOrDisposed: 'A', directOrIndirect: 'D', shares: 18000, price: 5134, value: null,
      sharesOwnedAfter: 20000, security: 'Common Stock', formType: '4', url: 'https://www.sec.gov/b', attribution: 'issuer',
    },
    {
      symbol: 'BX', filingDate: '2026-10-01', transactionDate: '2026-09-29', insider: 'Fund Vehicle LP', role: '10 percent owner',
      transactionType: 'P-Purchase', acquiredOrDisposed: 'A', directOrIndirect: 'I', shares: 100, price: 12, value: null,
      sharesOwnedAfter: 1000, security: 'Common Units', formType: '4', url: 'https://www.sec.gov/c', attribution: 'unverified',
    },
    {
      symbol: 'PYXS', filingDate: '2026-10-01', transactionDate: '2026-10-01', insider: 'GordonMD Global Investments LP', role: '10 percent owner',
      transactionType: 'P-Purchase', acquiredOrDisposed: 'A', directOrIndirect: 'I', shares: 5517000, price: 0, value: null,
      sharesOwnedAfter: 15541909, security: 'Common Stock', formType: '4', url: 'https://www.sec.gov/d', attribution: 'issuer',
    },
  ],
};

describe('shapeMarketInsiderTrades', () => {
  test('the window, the purchase and sale totals with their net, and the top companies by value', () => {
    const out = shapeMarketInsiderTrades(MARKET, 'purchases') as any;
    expect(out.scope).toBe('market');
    expect(out.kind).toBe('purchases');
    expect(out.window).toEqual({ days: 7, from: '2026-09-26', through: '2026-10-02' });
    expect(out.totals).toEqual({
      purchases: { lines: 457, value: 466207927 },
      sales: { lines: 1250, value: 1274814283 },
      netValue: 466207927 - 1274814283,
    });
    expect(out.topPurchases).toEqual([{ symbol: 'KOD', lines: 82, value: 156986394 }, { symbol: 'XYZ', lines: 3, value: null }]);
    expect(out.topSales).toEqual([{ symbol: 'INNV', lines: 4, value: 185207182 }]);
    expect(out.note).toBe(MARKET_INSIDER_NOTE);
  });

  test('each line in the per-symbol field names, labelled, with its value as the proxy decided it', () => {
    const [pam] = (shapeMarketInsiderTrades(MARKET, 'purchases') as any).trades;
    expect(pam).toEqual({
      symbol: 'PAM', reportingName: 'Mindlin Damian Miguel', typeOfOwner: 'officer: Vicepresident', categoryLabel: 'Purchase',
      transactionType: 'P-Purchase', formType: '4', transactionDate: '2026-09-28', filingDate: '2026-10-02', securityName: 'American Depositary shares',
      sharesTransacted: 15000, price: 77.628, value: 1164420.24, directOrIndirect: 'D', acquisitionOrDisposition: 'A', sharesOwned: 690893, url: 'https://www.sec.gov/a',
    });
  });

  test('the note says what a Form 3 line holds', () => {
    // PJT 2026-10-02: a Form 3's RSU line carried 5,742 as shares "transacted" and 0 owned - the shares underlying the units held.
    expect(MARKET_INSIDER_NOTE).toContain('initial holdings (Form 3)');
    expect(MARKET_INSIDER_NOTE).toContain('the shares underlying');
    // Live run: the note said "no `sharesOwned`", and the lines read sharesOwned 0.
    expect(MARKET_INSIDER_NOTE).toContain('`sharesTransacted` above 0 and `sharesOwned` 0');
  });

  test('a priced line left unvalued says why, an unconfirmed issuer is marked, an unpriced line carries neither', () => {
    const [, uuu, bx, pyxs] = (shapeMarketInsiderTrades(MARKET, 'purchases') as any).trades;
    expect(uuu.value).toBeNull();
    expect(uuu.valueWithheld).toBe('another security, or priced more than 1.5 times from the stock\'s close');
    expect('issuerUnconfirmed' in uuu).toBe(false);
    expect(bx).toMatchObject({ value: null, issuerUnconfirmed: true, valueWithheld: 'issuer unconfirmed' });
    expect(pyxs.value).toBeNull();
    expect('valueWithheld' in pyxs).toBe(false);
    expect('issuerUnconfirmed' in pyxs).toBe(false);
  });

  test('the activity label follows the transaction code and form', () => {
    const line = (transactionType: string | null, formType = '4', acquiredOrDisposed = 'A') => ({ ...MARKET.trades[0], transactionType, formType, acquiredOrDisposed });
    const labels = (shapeMarketInsiderTrades({ ...MARKET, trades: [line('S-Sale', '4', 'D'), line('F-InKind', '4', 'D'), line(null, '3'), line('J-Other', '4', 'D')] }, 'all') as any)
      .trades.map((t: any) => t.categoryLabel);
    // Codes P and S say purchase or sale, open market or private alike.
    expect(labels).toEqual(['Sale', 'Tax withholding', 'Initial holding', 'Other disposition']);
  });

  test('tradesMeta only when the window holds more lines than were returned', () => {
    expect((shapeMarketInsiderTrades(MARKET, 'purchases') as any).tradesMeta).toEqual({ showing: 4, total: 457, truncated: true });
    expect('tradesMeta' in (shapeMarketInsiderTrades({ ...MARKET, total: 4 }, 'purchases') as any)).toBe(false);
  });

  test('a kind with no lines nets as zero; one whose lines all lack a value has no net', () => {
    const noSales = shapeMarketInsiderTrades({ ...MARKET, summary: { ...MARKET.summary, sales: { trades: 0, shares: 0, value: null } } }, 'purchases') as any;
    expect(noSales.totals.sales).toEqual({ lines: 0, value: null });
    expect(noSales.totals.netValue).toBe(466207927);
    const unvalued = shapeMarketInsiderTrades({ ...MARKET, summary: { ...MARKET.summary, sales: { trades: 3, shares: 10, value: null } } }, 'purchases') as any;
    expect(unvalued.totals.netValue).toBeNull();
  });

  test('lines past the response budget are dropped by the shaper, oldest first, and tradesMeta keeps the window total', () => {
    // review: 50 lines with long security names passed 50 KB, the
    // shared guard cut the list to five and replaced tradesMeta with its own
    // meta, losing the window's total.
    const long = Array.from({ length: 50 }, (_, i) => ({ ...MARKET.trades[0], symbol: `S${i}`, security: `Series ${i} ${'x'.repeat(700)}` }));
    const out = shapeMarketInsiderTrades({ ...MARKET, trades: long }, 'purchases') as any;
    expect(out.trades.length).toBeGreaterThan(5);
    expect(out.trades.length).toBeLessThan(50);
    // The newest lines are kept: the proxy lists newest filing day first.
    expect(out.trades.map((t: any) => t.symbol)).toEqual(long.slice(0, out.trades.length).map(l => l.symbol));
    expect(out.tradesMeta).toEqual({ showing: out.trades.length, total: 457, truncated: true, trimmedForSize: true });
    // What is published is the shaper's answer: the guard has nothing left to trim.
    const wire = applyResponseSizeGuard(out);
    expect(utf8ByteLength(wire)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(JSON.parse(wire).tradesMeta).toEqual(out.tradesMeta);
    expect(JSON.parse(wire).trades).toHaveLength(out.trades.length);
    // Under the budget nothing is trimmed for size.
    expect('trimmedForSize' in (shapeMarketInsiderTrades(MARKET, 'purchases') as any).tradesMeta).toBe(false);
    // A single line past the budget leaves none listed, and the window is not called empty.
    const huge = shapeMarketInsiderTrades({ ...MARKET, total: 1, trades: [{ ...MARKET.trades[0], security: 'y'.repeat(60_000) }] }, 'purchases') as any;
    expect(huge.trades).toEqual([]);
    expect(huge.tradesMeta).toEqual({ showing: 0, total: 1, truncated: true, trimmedForSize: true });
    expect('tradesNote' in huge).toBe(false);
  });

  test('an empty window and nothing on record each say so', () => {
    const empty = shapeMarketInsiderTrades({ ...MARKET, kind: 'sales', total: 0, trades: [] }, 'sales') as any;
    expect(empty.trades).toEqual([]);
    expect(empty.tradesNote).toBe('No sales filed in this window.');
    expect((shapeMarketInsiderTrades({ ...MARKET, kind: 'all', total: 0, trades: [] }, 'all') as any).tradesNote).toBe('No insider transactions filed in this window.');
    expect(shapeMarketInsiderTrades(null, 'purchases')).toEqual({ scope: 'market', kind: 'purchases', trades: [], tradesNote: 'No market-wide insider filings on record.' });
  });
});

describe('quarterly statistics (phase D2)', () => {
  const side = (lines: number, value = 0, pricedLines = lines) => ({ lines, filings: lines, reporters: lines ? 1 : 0, shares: lines * 100, value, pricedLines });
  const quarter = (q: string, provisional = false) => ({
    quarter: q, from: '2026-07-01', through: '2026-09-30', provisional,
    purchases: side(1, 1000), sales: side(2, 5000, 1), otherSecurityPurchases: 1, otherSecuritySales: 0, otherAcquired: 3, otherDisposed: 4,
  });
  const STATS = {
    version: 1, computedAt: '2026-10-03T22:00:00Z', issuer: 'confirmed', profileCik: '1393818',
    coverage: { pagesRead: 3, linesRead: 1400, exhausted: false, oldestFilingRead: '2024-08-06', completeFrom: '2024-08-07' },
    quarters: [quarter('2026-Q4', true), quarter('2026-Q3')],
    otherIssuerLines: 6, linesWithoutCik: 0, undatedLines: 1, formThreeLines: 2,
  };
  const BASE = { symbol: 'BX', insider_trades: [{ companyCik: '0001393818', transactionType: 'S-Sale', transactionDate: '2026-08-01', filingDate: '2026-08-02', securitiesTransacted: 10, price: 100, reportingName: 'A', formType: '4' }] };
  const wire = (payload: unknown) => sanitizeMcpWireOutput(shapeInsiderTradingResponse(payload, { cik: '0001393818' })) as any;

  test('the stored statistics, shaped: quarters newest first with each side, and what they cover; never the raw object', () => {
    const out = wire({ ...BASE, insider_statistics: STATS });
    expect(out.insiderStatistics).toBeUndefined();
    expect(out.quarterlyStatistics).toHaveLength(2);
    expect(out.quarterlyStatistics[0]).toEqual({
      quarter: '2026-Q4', from: '2026-07-01', through: '2026-09-30', provisional: true,
      purchases: { lines: 1, filings: 1, reporters: 1, shares: 100, value: 1000, pricedLines: 1 },
      sales: { lines: 2, filings: 2, reporters: 1, shares: 200, value: 5000, pricedLines: 1 },
      otherSecurityPurchases: 1, otherSecuritySales: 0, otherAcquired: 3, otherDisposed: 4,
    });
    expect(out.quarterlyStatisticsMeta).toEqual({
      issuer: 'confirmed', computedAt: '2026-10-03T22:00:00Z', pagesRead: 3, linesRead: 1400, readToEnd: false,
      oldestFilingRead: '2024-08-06', completeFrom: '2024-08-07', otherIssuerLines: 6, linesWithoutCik: 0, undatedLines: 1, formThreeLines: 2,
    });
    expect(out.quarterlyStatisticsNote).toBeUndefined();
    // The list and summary are unchanged beside them.
    expect(out.summary.sales).toBe(1);
  });

  test('not computed yet, not readable, or issuers not told apart: said, never zeros', () => {
    expect(wire({ ...BASE, insider_statistics: null }).quarterlyStatisticsNote).toBe('Quarterly statistics have not been computed for this symbol yet.');
    expect(wire(BASE).quarterlyStatistics).toBeUndefined();
    const bad = wire({ ...BASE, insider_statistics: { version: 2, quarters: [] } });
    expect(bad.quarterlyStatistics).toBeUndefined();
    expect(bad.quarterlyStatisticsNote).toBe('The stored quarterly statistics are not in a form this tool reads, so none are given.');
    const torn = wire({ ...BASE, insider_statistics: { ...STATS, quarters: [{ quarter: '2026-Q3', purchases: { lines: 1 } }] } });
    expect(torn.quarterlyStatistics).toBeUndefined();
    // A missing other-line count is unreadable too, never passed through as undefined.
    const { otherAcquired: _drop, ...noCount } = quarter('2026-Q3') as any;
    expect(wire({ ...BASE, insider_statistics: { ...STATS, quarters: [noCount] } }).quarterlyStatistics).toBeUndefined();
    const amb = wire({ ...BASE, insider_statistics: { ...STATS, issuer: 'ambiguous', quarters: [] } });
    expect(amb.quarterlyStatistics).toEqual([]);
    expect(amb.quarterlyStatisticsNote).toContain('more than one issuer');
  });

  test('the description says what the statistics count and cover', async () => {
    const { INSIDER_TRADING_DESCRIPTION } = await import('./insiderTrading.js');
    expect(INSIDER_TRADING_DESCRIPTION).toContain("`quarterlyStatistics` counts the company's own reported Form 4 and Form 5 lines (another issuer CIK's left out; with no profile CIK on record, `quarterlyStatisticsMeta.issuer` is \"unconfirmed\"");
    expect(INSIDER_TRADING_DESCRIPTION).toContain('a quarter is listed only when every filing for it was read');
    expect(INSIDER_TRADING_DESCRIPTION).toContain('Form 3 holdings are left out, and an amendment is not reconciled with the filing it amends.');
  });
});
