import { describe, expect, test } from 'bun:test';
import { estimatesCurrencyContext, summarizeAnalystData } from './analystDataShaping.js';
import { sanitizeMcpWireOutput } from '../helpers.js';
import { register as registerAnalyst } from './analystData.js';

describe('summarizeAnalystData', () => {
  test('compacts estimates, parses publishers, and collapses daily rating history into streaks', () => {
    const payload = {
      symbol: 'AAPL',
      estimates: [
        { date: '2029-09-27', epsAvg: 10.5, epsLow: 9.8, epsHigh: 11.3, revenueAvg: 520_000_000_000, revenueLow: 510_000_000_000, revenueHigh: 530_000_000_000, numAnalystsEps: 20, numAnalystsRevenue: 15, ebitAvg: 1 },
        { date: '2028-09-27', epsAvg: 9.2, epsLow: 8.7, epsHigh: 10.0, revenueAvg: 490_000_000_000, revenueLow: 480_000_000_000, revenueHigh: 500_000_000_000, numAnalystsEps: 18, numAnalystsRevenue: 14 },
        { date: '2027-09-27', epsAvg: 8.1, epsLow: 7.9, epsHigh: 8.7, revenueAvg: 460_000_000_000, revenueLow: 455_000_000_000, revenueHigh: 470_000_000_000, numAnalystsEps: 17, numAnalystsRevenue: 13 },
      ],
      price_target_summary: {
        symbol: 'AAPL',
        publishers: '["StreetInsider","Barrons"]',
        allTimeCount: 200,
      },
      price_target_consensus: {
        targetLow: 200,
        targetHigh: 300,
      },
      rating_snapshot: {
        rating: 'B',
        overallScore: 3,
      },
      historical_rating: [
        { date: '2026-03-26', rating: 'B', overallScore: 3, priceToBookScore: 1, debtToEquityScore: 1, returnOnAssetsScore: 5, returnOnEquityScore: 5, priceToEarningsScore: 2, discountedCashFlowScore: 3 },
        { date: '2026-03-25', rating: 'B', overallScore: 3, priceToBookScore: 1, debtToEquityScore: 1, returnOnAssetsScore: 5, returnOnEquityScore: 5, priceToEarningsScore: 2, discountedCashFlowScore: 3 },
        { date: '2026-03-24', rating: 'C', overallScore: 2, priceToBookScore: 1, debtToEquityScore: 2, returnOnAssetsScore: 4, returnOnEquityScore: 4, priceToEarningsScore: 2, discountedCashFlowScore: 2 },
      ],
      upgrades_downgrades: [
        { date: '2026-03-24', action: 'upgrade', newGrade: 'Buy', previousGrade: 'Hold', gradingCompany: 'Firm A', ignored: 'x' },
        { date: '2026-03-23', action: 'maintain', newGrade: 'Buy', previousGrade: 'Buy', gradingCompany: 'Firm B' },
      ],
      fetched_at: '2026-03-27T00:00:00Z',
    };

    const summary = summarizeAnalystData(payload, 2, 10, 1, '2026-03-27T00:00:00Z') as any;

    expect(summary.estimates).toEqual([
      {
        date: '2027-09-27',
        epsAvg: 8.1,
        epsLow: 7.9,
        epsHigh: 8.7,
        revenueAvg: 460000000000,
        revenueLow: 455000000000,
        revenueHigh: 470000000000,
        numAnalystsEps: 17,
        numAnalystsRevenue: 13,
      },
      {
        date: '2028-09-27',
        epsAvg: 9.2,
        epsLow: 8.7,
        epsHigh: 10,
        revenueAvg: 490000000000,
        revenueLow: 480000000000,
        revenueHigh: 500000000000,
        numAnalystsEps: 18,
        numAnalystsRevenue: 14,
      },
    ]);
    expect(summary._estimates_meta).toEqual({ showing: 2, total: 3, truncated: true });
    expect(summary.price_target_summary.publishers).toEqual(['StreetInsider', 'Barrons']);
    expect(summary.historical_rating).toEqual([
      {
        rating: 'B',
        overallScore: 3,
        priceToBookScore: 1,
        debtToEquityScore: 1,
        returnOnAssetsScore: 5,
        returnOnEquityScore: 5,
        priceToEarningsScore: 2,
        discountedCashFlowScore: 3,
        // A streak runs from its oldest observation through its newest (it
        // read fromDate 03-26 through 03-25, backwards, in the thirty-third run).
        fromDate: '2026-03-25',
        throughDate: '2026-03-26',
        observationCount: 2,
      },
      {
        rating: 'C',
        overallScore: 2,
        priceToBookScore: 1,
        debtToEquityScore: 2,
        returnOnAssetsScore: 4,
        returnOnEquityScore: 4,
        priceToEarningsScore: 2,
        discountedCashFlowScore: 2,
        fromDate: '2026-03-24',
        throughDate: '2026-03-24',
        observationCount: 1,
      },
    ]);
    expect(summary._historical_rating_meta).toEqual({ collapsed: true, raw_observations: 3, streaks: 2 });
    expect(summary.upgrades_downgrades).toEqual([
      {
        date: '2026-03-24',
        action: 'upgrade',
        newGrade: 'Buy',
        previousGrade: 'Hold',
        gradingCompany: 'Firm A',
      },
    ]);
    expect(summary._upgrades_downgrades_meta).toEqual({ showing: 1, total: 2, truncated: true });
  });

  test('prefers nearest future estimate periods, then the most recent past periods', () => {
    const payload = {
      symbol: 'AAPL',
      estimates: [
        { date: '2028-09-27', epsAvg: 9.2 },
        { date: '2025-09-27', epsAvg: 7.4 },
        { date: '2027-09-27', epsAvg: 8.1 },
        { date: '2024-09-27', epsAvg: 6.7 },
      ],
    };

    const summary = summarizeAnalystData(payload, 4, 10, 20, '2026-03-27T00:00:00Z') as any;

    expect(summary.estimates.map((entry: { date: string }) => entry.date)).toEqual([
      '2027-09-27',
      '2028-09-27',
      '2025-09-27',
      '2024-09-27',
    ]);
  });

  test('passes through non-object payloads unchanged', () => {
    expect(summarizeAnalystData(null)).toBeNull();
    expect(summarizeAnalystData('raw')).toBe('raw');
  });

  test('returns an explanatory empty state for ETF-like symbols without analyst coverage', () => {
    const summary = summarizeAnalystData({
      symbol: 'SPY',
      estimates: [],
      price_target_summary: null,
      price_target_consensus: null,
      rating_snapshot: null,
      historical_rating: [],
      upgrades_downgrades: [],
      // Fetched, and the vendor has none (sql/182 columns).
      grades_historical: [],
      price_target_news: [],
      fetched_at: '2026-03-27T00:00:00Z',
    }, 8, 10, 20, '2026-03-27T00:00:00Z', {
      company_name: 'State Street SPDR S&P 500 ETF Trust',
      industry: 'Asset Management',
    }) as any;

    expect(summary.estimates).toEqual([]);
    expect(summary.price_target_summary).toBeNull();
    expect(summary.historical_rating).toEqual([]);
    expect(summary._analyst_note).toContain('No meaningful sell-side analyst coverage');
    // The same row before its rating counts and targets were ever fetched: coverage not known.
    const before = summarizeAnalystData({ symbol: 'SPY', estimates: [], historical_rating: [], upgrades_downgrades: [] }, 8, 10, 20, '2026-03-27T00:00:00Z', { company_name: 'State Street SPDR S&P 500 ETF Trust' }) as any;
    expect(before._analyst_note).toContain('so its analyst coverage is not known');
  });
});

describe('the currency of the estimates', () => {
  // TSM, prod 2026-10-04: revenue estimates in TWD (391B for 2010) beside a listing trading in USD, unlabeled.
  const TSM = {
    symbol: 'TSM',
    estimates: [{ date: '2027-12-31', revenueAvg: 4.6e12, epsAvg: 420.5 }],
    price_target_consensus: { targetConsensus: 578.43 },
    reported_currency: 'TWD',
    reported_currency_as_of: '2026-06-30',
  };
  const NOTE = 'The estimates carry no currency of their own: they are normally in the company\'s reporting currency, TWD by its newest statement on file (2026-06-30), '
    + 'but they are refreshed apart from the statements, so around a change of reporting currency the two can disagree. The price targets are in the listing\'s currency, USD.';

  test('a company reporting in another currency than its listing: both named, and a note', () => {
    const out = sanitizeMcpWireOutput(summarizeAnalystData(TSM, undefined, undefined, undefined, '2026-10-04', { currency: 'USD' })) as any;
    expect(out.estimatesCurrency).toEqual({ reported: 'TWD', reportedAsOf: '2026-06-30', trading: 'USD' });
    expect(out.estimatesCurrencyNote).toBe(NOTE);
  });

  test('the same currency is named without a note; unknown sides are null; no estimates, nothing', () => {
    const same = summarizeAnalystData({ ...TSM, reported_currency: 'usd' }, undefined, undefined, undefined, '2026-10-04', { currency: 'USD' }) as any;
    expect(same.estimates_currency).toEqual({ reported: 'USD', reportedAsOf: '2026-06-30', trading: 'USD' });
    expect('estimates_currency_note' in same).toBe(false);
    // No statement currency (a failed read, or no statements): the date goes with it, and nothing is compared.
    expect(estimatesCurrencyContext({ reported_currency: null, reported_currency_as_of: '2026-06-30' }, { currency: 'USD' }))
      .toEqual({ estimates_currency: { reported: null, reportedAsOf: null, trading: 'USD' } });
    expect(estimatesCurrencyContext({ reported_currency: 'TWD' }, null)).toEqual({ estimates_currency: { reported: 'TWD', reportedAsOf: null, trading: null } });
    expect(estimatesCurrencyContext({}, null)).toEqual({});
    // An undated statement: the note names no date.
    expect((estimatesCurrencyContext({ reported_currency: 'JPY', reported_currency_as_of: 'n/a' }, { currency: 'USD' }) as any).estimates_currency_note)
      .toStartWith('The estimates carry no currency of their own: they are normally in the company\'s reporting currency, JPY by its newest statement on file, but');
    // Price targets alone: no estimates to label.
    const targetsOnly = summarizeAnalystData({ ...TSM, estimates: [] }, undefined, undefined, undefined, '2026-10-04', { currency: 'USD' }) as any;
    expect('estimates_currency' in targetsOnly).toBe(false);
  });

  test('both tool paths carry it, and the description says what it is', async () => {
    let config: any; let handler: any;
    const server = { registerTool: (_n: string, c: unknown, h: unknown) => { config = c; handler = h; } };
    const client = { get: async (path: string) => (path.startsWith('/analyst-data/') ? TSM : { symbol: 'TSM', currency: 'USD' }) };
    registerAnalyst(server as any, client as any);
    for (const full of [false, true]) {
      const res = await handler({ symbol: 'tsm', full });
      const out = full ? res.structuredContent.data ?? res.structuredContent : res.structuredContent;
      expect(out.estimatesCurrency, String(full)).toEqual({ reported: 'TWD', reportedAsOf: '2026-06-30', trading: 'USD' });
      expect(out.estimatesCurrencyNote, String(full)).toBe(NOTE);
    }
    expect(config.description).toContain('`estimatesCurrency` gives the currency the company\'s newest statement reports in, with that statement\'s date, and the one the listing trades in');
    expect(config.description).toContain('so around a change of reporting currency the two can disagree; `estimatesCurrencyNote` says so');
  });
});

describe('the analysts\' rating counts and individual price targets (phase D1)', () => {
  const m = (date: string, strongBuy: number, buy: number, hold: number, sell: number, strongSell: number) => ({ date, strongBuy, buy, hold, sell, strongSell });
  // AAPL 2026-10-04, stored shape (proxy/lib/analystExtras.ts); no row for 2026-03.
  const MONTHS = [
    m('2026-10-01', 6, 19, 13, 3, 3), m('2026-09-01', 6, 19, 14, 3, 3), m('2026-08-01', 6, 22, 14, 3, 2),
    m('2026-07-01', 6, 23, 17, 2, 2), m('2026-06-01', 7, 23, 16, 2, 2), m('2026-05-01', 7, 25, 16, 1, 2),
    m('2026-04-01', 7, 25, 15, 1, 1), m('2026-02-01', 6, 25, 16, 1, 2), m('2026-01-01', 6, 24, 17, 1, 3),
    m('2025-12-01', 5, 24, 15, 1, 3), m('2025-11-01', 5, 24, 15, 1, 3), m('2025-10-01', 6, 24, 15, 2, 3),
  ];
  const ev = (day: string, priceTarget: number, extra: Record<string, unknown> = {}) => ({
    publishedDate: `${day}T12:00:00.000Z`, analystCompany: 'Morgan Stanley', analystName: null, priceTarget, adjPriceTarget: priceTarget, priceWhenPosted: 330.26, ...extra,
  });
  const NOW = '2026-10-04T12:00:00Z';
  const wire = (payload: unknown, now = NOW) => sanitizeMcpWireOutput(summarizeAnalystData(payload, undefined, undefined, undefined, now)) as any;

  test('the newest monthly count with its month and total; the 12 months to it, newest first, a missing month named', () => {
    const out = wire({ symbol: 'AAPL', grades_historical: MONTHS, grades_historical_fetched_at: '2026-10-04T06:00:00Z' });
    expect(out.ratingCounts).toEqual({ month: '2026-10', strongBuy: 6, buy: 19, hold: 13, sell: 3, strongSell: 3, total: 44 });
    expect(out.ratingCountsNote).toBeUndefined();
    expect(out.ratingHistory.map((r: any) => r.month)).toEqual(['2026-10', '2026-09', '2026-08', '2026-07', '2026-06', '2026-05', '2026-04', '2026-02', '2026-01', '2025-12', '2025-11']);
    expect(out.ratingHistoryMeta).toEqual({ months: 12, through: '2026-10', missingMonths: ['2026-03'] });
    expect(out.ratingHistoryFetchedAt).toBe('2026-10-04T06:00:00Z');
  });

  test('an old newest count is named, never given as current (UUU stopped at 2024-11)', () => {
    const out = wire({ symbol: 'UUU', grades_historical: [m('2024-11-01', 0, 1, 0, 0, 0), m('2024-10-01', 0, 1, 0, 0, 0)] });
    expect(out.ratingCounts).toBeNull();
    expect(out.ratingCountsNote).toBe('The newest monthly count of analyst ratings on file is for 2024-11; there is none since, so no current count is given.');
    expect(out.ratingHistory).toHaveLength(2);
    // Two months back still stands; three does not.
    expect(wire({ grades_historical: [m('2026-08-01', 1, 1, 1, 1, 1)] }).ratingCounts).toMatchObject({ month: '2026-08' });
    expect(wire({ grades_historical: [m('2026-07-01', 1, 1, 1, 1, 1)] }).ratingCounts).toBeNull();
  });

  test('a malformed stored month is left out, never read as zeros', () => {
    const out = wire({ grades_historical: [{ date: '2026-10-01', strongBuy: 1, buy: null, hold: 1, sell: 1, strongSell: 1 }, m('2026-09-01', 1, 2, 3, 4, 5)] });
    expect(out.ratingCounts).toMatchObject({ month: '2026-09', total: 15 });
    expect(out.ratingHistoryMeta.missingMonths).not.toContain('2026-10');
  });

  test('price targets of the year, newest first: unnamed analyst null, the split-adjusted target only when it differs', () => {
    const out = wire({ price_target_news: [ev('2025-09-01', 100), ev('2026-10-01', 355, { analystName: 'Erik Woodring' }), ev('2026-09-02', 1000, { adjPriceTarget: 250, analystCompany: 'Wedbush' })] });
    expect(out.priceTargets).toEqual([
      { date: '2026-10-01', firm: 'Morgan Stanley', analyst: 'Erik Woodring', priceTarget: 355, priceWhenPosted: 330.26 },
      { date: '2026-09-02', firm: 'Wedbush', analyst: null, priceTarget: 1000, splitAdjustedPriceTarget: 250, priceWhenPosted: 330.26 },
    ]);
    expect(out.priceTargetsMeta).toEqual({ showing: 2, publishedLast12Months: 2, countComplete: true });
  });

  test('a list on file cut at its cap inside the year counts at least that many', () => {
    const capped = Array.from({ length: 100 }, (_, i) => ev(`2026-0${1 + (i % 9)}-1${i % 10}`, 300 + i));
    const out = wire({ price_target_news: capped });
    expect(out.priceTargets).toHaveLength(10);
    expect(out.priceTargetsMeta).toEqual({ showing: 10, publishedLast12Months: 100, countComplete: false });
  });

  test('either alone is coverage; none of it, and the empty state stands', () => {
    expect(wire({ symbol: 'X', grades_historical: MONTHS }).analystNote).toBeUndefined();
    expect(wire({ symbol: 'X', price_target_news: [ev('2026-10-01', 10)] }).analystNote).toBeUndefined();
    expect(wire({ symbol: 'X', grades_historical: [], price_target_news: [] }).analystNote).toBe('No analyst ratings, price targets, or forward estimate coverage were available for this symbol.');
  });

  test('a list under 100 inside the year is "at least"; nothing after today counts', () => {
    const ninetyNine = Array.from({ length: 99 }, (_, i) => ev(`2026-0${1 + (i % 9)}-1${i % 10}`, 300 + i));
    expect(wire({ price_target_news: ninetyNine }).priceTargetsMeta).toEqual({ showing: 10, publishedLast12Months: 99, countComplete: false });
    const out = wire({ grades_historical: [m('2027-01-01', 9, 9, 9, 9, 9), ...MONTHS], price_target_news: [ev('2027-01-05', 999), ev('2026-10-01', 355), ev('2025-01-01', 1)] });
    expect(out.ratingCounts.month).toBe('2026-10');
    expect(out.ratingHistory[0].month).toBe('2026-10');
    expect(out.priceTargets.map((t: any) => t.priceTarget)).toEqual([355]);
    expect(out.priceTargetsMeta).toEqual({ showing: 1, publishedLast12Months: 1, countComplete: true });
  });

  test('a section never fetched (null) is said so, never read as none; its stamp survives the empty view', () => {
    // The six empty and both extras never fetched: not "no coverage".
    const unfetched = wire({ symbol: 'X', estimates: [], upgrades_downgrades: [], historical_rating: [], grades_historical: null, price_target_news: null });
    expect(unfetched.analystNote).toBe('No forward estimates, price-target summaries, rating snapshot or rating changes are on file for this symbol, and its monthly rating counts or individual price targets have not been fetched yet, so its analyst coverage is not known.');
    expect(unfetched.ratingCounts).toBeNull();
    expect(unfetched.ratingCountsNote).toBe('The monthly analyst rating counts have not been fetched for this symbol yet.');
    expect(unfetched.priceTargets).toBeNull();
    expect(unfetched.priceTargetsNote).toBe('Individual price targets have not been fetched for this symbol yet.');
    // Fetched and empty: confirmed none, with the stamps kept.
    const empty = wire({ symbol: 'X', grades_historical: [], price_target_news: [], grades_historical_fetched_at: '2026-10-04T06:00:00Z', price_target_news_fetched_at: '2026-10-04T06:00:00Z' });
    expect(empty.analystNote).toBe('No analyst ratings, price targets, or forward estimate coverage were available for this symbol.');
    expect(empty.ratingCountsNote).toBe('No monthly analyst rating counts are on file for this symbol.');
    expect(empty.priceTargets).toEqual([]);
    expect(empty.priceTargetsNote).toBe('No individual price targets are on file for this symbol.');
    expect(empty.ratingHistoryFetchedAt).toBe('2026-10-04T06:00:00Z');
    expect(empty.priceTargetsFetchedAt).toBe('2026-10-04T06:00:00Z');
    // With other coverage, an unfetched section is still said so.
    const partial = wire({ symbol: 'X', estimates: [{ date: '2027-09-30', epsAvg: 1 }], grades_historical: null, price_target_news: [] });
    expect(partial.analystNote).toBeUndefined();
    expect(partial.ratingCountsNote).toBe('The monthly analyst rating counts have not been fetched for this symbol yet.');
    // Targets on file but none this year: the newest one's date.
    expect(wire({ price_target_news: [ev('2025-06-01', 100)] }).priceTargetsMeta).toEqual({ showing: 0, publishedLast12Months: 0, countComplete: true, newestOnFile: '2025-06-01' });
  });

  test('the compact view fits the budget with a full AAPL row (24 months, 100 targets, 1,805 rating changes)', async () => {
    const big = {
      symbol: 'AAPL',
      // Dated back from today (the handler reads the clock): this month and the 23 before, a target a week.
      grades_historical: Array.from({ length: 24 }, (_, i) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); return m(d.toISOString().slice(0, 10), 6, 19, 13, 3, 3); }),
      price_target_news: Array.from({ length: 100 }, (_, i) => ev(new Date(Date.now() - i * 7 * 86_400_000).toISOString().slice(0, 10), 300 + i, { analystName: 'Analyst Name Here', analystCompany: 'A Long Firm Name Securities' })),
      upgrades_downgrades: Array.from({ length: 1805 }, (_, i) => ({ date: '2026-01-01', action: 'maintain', newGrade: 'Buy', previousGrade: 'Buy', gradingCompany: `Firm ${i}`, symbol: 'AAPL' })),
    };
    let handler: any;
    registerAnalyst({ registerTool: (_n: string, _c: unknown, h: unknown) => { handler = h; } } as any, { get: async (p: string) => (p.startsWith('/analyst-data/') ? big : { symbol: 'AAPL', currency: 'USD' }) } as any);
    const res = await handler({ symbol: 'aapl' });
    const out = res.structuredContent;
    expect(out.priceTargets.length).toBeGreaterThan(0);
    expect(out.priceTargetsMeta.showing).toBe(out.priceTargets.length);
    expect(out.ratingHistory).toHaveLength(12);
    expect(out.ratingCounts.total).toBe(44);
    expect(Buffer.byteLength(res.content[0].text, 'utf8')).toBeLessThan(48 * 1024);
  });
});
