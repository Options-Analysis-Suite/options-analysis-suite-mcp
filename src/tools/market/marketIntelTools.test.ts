import { describe, expect, test } from 'bun:test';
import { register as registerInsider, INSIDER_TRADING_DESCRIPTION } from './insiderTrading.js';
import { register as registerRegime } from './regime.js';
import { register as registerFundamentals, FUNDAMENTALS_DESCRIPTION } from './fundamentals.js';
import { register as registerProfile, COMPANY_PROFILE_DESCRIPTION } from './companyProfile.js';
import { MAX_RESPONSE_BYTES } from '../helpers.js';

/**
 * The phase E reads on four existing tools: get_insider_trading scope market,
 * get_regime scopes volatility and sectors, get_fundamentals' valuation and
 * get_company_profile's esg. A read beside the tool's own must not take the
 * tool's answer with it when it fails.
 */

type Route = unknown | Error | ((params?: Record<string, string>) => unknown);

function tool(register: Function, routes: Record<string, Route>, defaults: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  let handler!: Function;
  let config!: Record<string, any>;
  register({ registerTool: (_n: string, c: Record<string, any>, h: Function) => { config = c; handler = h; } } as any, {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ path, params });
      const key = params?.kind && `${path}?kind=${params.kind}` in routes ? `${path}?kind=${params.kind}` : path;
      const r = routes[key];
      if (r instanceof Error) throw r;
      if (typeof r === 'function') return (r as Function)(params);
      return r === undefined ? null : r;
    },
  } as any);
  const run = async (args: Record<string, unknown>) => (await handler({ ...defaults, ...args })) as any;
  return { calls, run, config };
}

const INSIDER_DEFAULTS = { scope: 'symbol', days: 7, kind: 'purchases', limit: 25 };
const MARKET_FEED = {
  days: 7, kind: 'purchases', from: '2026-09-26', asOf: '2026-10-02', total: 1,
  summary: { purchases: { trades: 1, shares: 10, value: 100 }, sales: { trades: 0, shares: 0, value: null }, topPurchases: [], topSales: [] },
  trades: [{ symbol: 'PAM', transactionType: 'P-Purchase', formType: '4', shares: 10, price: 10, value: 100, attribution: 'issuer' }],
};

describe('get_insider_trading', () => {
  test('scope market reads the market feed with its window, kind and limit', async () => {
    const t = tool(registerInsider, { '/market/insider-trades': MARKET_FEED }, INSIDER_DEFAULTS);
    const out = (await t.run({ scope: 'market', days: 14, kind: 'sales', limit: 10 })).structuredContent;
    expect(t.calls).toEqual([{ path: '/market/insider-trades', params: { days: '14', kind: 'sales', limit: '10' } }]);
    expect(out.scope).toBe('market');
    expect(out.trades[0]).toMatchObject({ symbol: 'PAM', value: 100 });
  });

  test('scope market with no feed on record (a 404) answers with a note, not an error', async () => {
    const t = tool(registerInsider, {}, INSIDER_DEFAULTS);
    const res = await t.run({ scope: 'market' });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.tradesNote).toBe('No market-wide insider filings on record.');
  });

  test('scope symbol still needs a symbol and reads the company as before', async () => {
    const none = tool(registerInsider, {}, INSIDER_DEFAULTS);
    const res = await none.run({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("scope='symbol' requires `symbol`");
    expect(none.calls).toEqual([]);
    const t = tool(registerInsider, { '/insider-trading/AAPL': { symbol: 'AAPL', insider_trades: [] }, '/company-profile/AAPL': { symbol: 'AAPL' } }, INSIDER_DEFAULTS);
    await t.run({ symbol: 'aapl' });
    expect(t.calls.map(c => c.path).sort()).toEqual(['/company-profile/AAPL', '/insider-trading/AAPL']);
  });

  test('a company with no insider record on file answers its status, not "no data"', async () => {
    const etf = await tool(registerInsider, { '/company-profile/SPY': { symbol: 'SPY', company_name: 'SPDR S&P 500 ETF Trust', is_etf: true } }, INSIDER_DEFAULTS).run({ symbol: 'spy' });
    expect(etf.structuredContent).toEqual({ symbol: 'SPY', insiderTrades: [], insiderTradesStatus: 'No insider filings on record for this exchange-traded product.' });
    const none = await tool(registerInsider, {}, INSIDER_DEFAULTS).run({ symbol: 'ZZZZ' });
    expect(none.structuredContent.insiderTradesStatus).toBe('No insider filings on record for this symbol.');
  });

  test('the description names the market scope and its markers', () => {
    expect(INSIDER_TRADING_DESCRIPTION).toContain('scope="market"');
    expect(INSIDER_TRADING_DESCRIPTION).toContain('`valueWithheld`');
    expect(INSIDER_TRADING_DESCRIPTION).toContain('`issuerUnconfirmed`');
    expect(INSIDER_TRADING_DESCRIPTION).toContain('(1-50, default 25)');
    // Lines under another CIK are kept apart, not called another company's (review).
    expect(INSIDER_TRADING_DESCRIPTION).toContain('the CIK alone does not say which');
    expect(INSIDER_TRADING_DESCRIPTION).toContain('`otherIssuers` gives each CIK\'s lines, dates, security names and purchases and sales');
  });
});

const SECTORS = {
  kind: 'sector', date: '2026-10-02',
  rows: [
    { name: 'Technology', exchange: 'NASDAQ', pe: 48.8, changePct: -0.4 },
    { name: 'Technology', exchange: 'NYSE', pe: 42.5, changePct: 0.86 },
    { name: 'Energy', exchange: 'NYSE', pe: 16.4, changePct: 1.2 },
  ],
};

describe('get_regime volatility and sectors', () => {
  test('a date on a latest-only scope is answered with a note, not silently', async () => {
    const vix = { asOf: '2026-10-02', shape: 'contango', shapeTenors: [], curve: [], vvix: null };
    const t = tool(registerRegime, { '/market/vix-term-structure': vix, '/market/sector-metrics': SECTORS });
    const withDate = (await t.run({ scope: 'volatility', date: '2025-01-02' })).structuredContent;
    // review: each scope's note names the day it does answer (sectors can answer an older shared day).
    expect(withDate.dateNote).toBe('This scope answers the newest closes on file (`asOf`), not a day asked for: the date 2025-01-02 is not supported here.');
    expect('dateNote' in (await t.run({ scope: 'volatility' })).structuredContent).toBe(false);
    expect((await t.run({ scope: 'sectors', date: '2025-01-02' })).structuredContent.dateNote).toBe('This scope answers the day it reports as `date`, chosen as `sectorsNote` says, not a day asked for: the date 2025-01-02 is not supported here.');
    // With a group, its history answer carries the note too.
    const g = tool(registerRegime, { '/market/sector-metrics': SECTORS, '/market/sector-metrics/history': { series: [] } });
    expect((await g.run({ scope: 'sectors', group: 'Energy', date: '2025-01-02' })).structuredContent).toMatchObject({ group: { name: 'Energy' }, dateNote: expect.stringContaining('not supported here') });
    // The history's window is `days`, from the current date, on the exchanges the group is listed on.
    expect(t.config.description).toContain('on each exchange the group is listed on');
  });

  test('volatility reads the VIX term structure and nothing else', async () => {
    const t = tool(registerRegime, { '/market/vix-term-structure': { asOf: '2026-10-02', shape: 'contango', shapeTenors: [], curve: [], vvix: null } });
    const out = (await t.run({ scope: 'volatility', symbol: 'SPY', date: '2026-01-02' })).structuredContent;
    expect(t.calls).toEqual([{ path: '/market/vix-term-structure', params: undefined }]);
    expect(out).toMatchObject({ view: 'volatility', asOf: '2026-10-02', shape: 'contango' });
  });

  test('sectors reads the kind asked (sector by default) and no history without a group', async () => {
    const t = tool(registerRegime, { '/market/sector-metrics': SECTORS });
    const out = (await t.run({ scope: 'sectors' })).structuredContent;
    expect(t.calls).toEqual([{ path: '/market/sector-metrics', params: { kind: 'sector' } }]);
    expect(out.groups.map((g: any) => g.name)).toEqual(['Technology', 'Energy']);
    await t.run({ scope: 'sectors', kind: 'industry' });
    expect(t.calls[1].params).toEqual({ kind: 'industry' });
  });

  test('a group reads its history on each exchange it is on, over `days` (30 by default)', async () => {
    const t = tool(registerRegime, {
      '/market/sector-metrics': SECTORS,
      '/market/sector-metrics/history': (p?: Record<string, string>) => ({ series: [{ date: '2026-10-02', pe: p?.exchange === 'NYSE' ? 42.5 : 48.8, changePct: 0 }] }),
    });
    const out = (await t.run({ scope: 'sectors', group: 'technology' })).structuredContent;
    expect(t.calls.slice(1)).toEqual([
      { path: '/market/sector-metrics/history', params: { kind: 'sector', name: 'Technology', exchange: 'NASDAQ', days: '30' } },
      { path: '/market/sector-metrics/history', params: { kind: 'sector', name: 'Technology', exchange: 'NYSE', days: '30' } },
    ]);
    expect(out.group.name).toBe('Technology');
    expect(out.history).toEqual({ NASDAQ: [{ date: '2026-10-02', pe: 48.8, changePct: 0 }], NYSE: [{ date: '2026-10-02', pe: 42.5, changePct: 0 }] });
    expect(out.historyMeta).toEqual({ days: 30, order: 'oldest first' });
    expect('historyNote' in out).toBe(false);
    await t.run({ scope: 'sectors', group: 'Technology', exchange: 'NYSE', days: 60 });
    expect(t.calls.slice(4)).toEqual([{ path: '/market/sector-metrics/history', params: { kind: 'sector', name: 'Technology', exchange: 'NYSE', days: '60' } }]);
  });

  test('a failed history read leaves the group and the other exchange standing, and says which', async () => {
    const t = tool(registerRegime, {
      '/market/sector-metrics': SECTORS,
      '/market/sector-metrics/history': (p?: Record<string, string>) => {
        if (p?.exchange === 'NYSE') throw new Error('HTTP 503');
        return { series: [] };
      },
    });
    const res = await t.run({ scope: 'sectors', group: 'Technology' });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.history).toEqual({ NASDAQ: [], NYSE: null });
    expect(res.structuredContent.historyNote).toBe('The history on NYSE was unavailable on this call.');
  });

  test('a group not on record reads no history', async () => {
    const t = tool(registerRegime, { '/market/sector-metrics': SECTORS });
    const out = (await t.run({ scope: 'sectors', group: 'Tech' })).structuredContent;
    expect(t.calls).toHaveLength(1);
    expect(out.groupNote).toContain('No sector named "Tech"');
  });
});

const FUNDAMENTALS = { symbol: 'AAPL', ratios_ttm: { priceToEarningsRatioTTM: 38.09 }, key_metrics_ttm: {}, fetched_at: '2026-10-03' };
const PROFILE = { symbol: 'AAPL', exchange_short: 'NASDAQ', sector: 'Technology', industry: 'Consumer Electronics' };
const CAP = { points: [['2025-10-03', 3.8e12], ['2026-10-02', 4.9e12]], latest: null };
const fundamentalsRoutes = (over: Record<string, Route> = {}) => ({
  '/fundamentals/AAPL': FUNDAMENTALS,
  '/company-profile/AAPL': PROFILE,
  '/dividend-yield/AAPL': null,
  '/market/sector-metrics?kind=sector': SECTORS,
  '/market/sector-metrics?kind=industry': { kind: 'industry', date: '2026-10-02', rows: [{ name: 'Consumer Electronics', exchange: 'NASDAQ', pe: 38.23 }] },
  '/market-cap-history/AAPL': CAP,
  ...over,
});

describe('get_fundamentals valuation', () => {
  test('the valuation reads run beside the fundamentals and land in `valuation`', async () => {
    const t = tool(registerFundamentals, fundamentalsRoutes());
    const out = (await t.run({ symbol: 'aapl' })).structuredContent;
    expect(t.calls.map(c => `${c.path}${c.params?.kind ? `?kind=${c.params.kind}` : ''}`).sort()).toEqual([
      '/company-profile/AAPL', '/dividend-yield/AAPL', '/fundamentals/AAPL', '/market-cap-history/AAPL',
      '/market/sector-metrics?kind=industry', '/market/sector-metrics?kind=sector',
    ]);
    expect(out.ratiosTtm.priceToEarningsRatioTTM).toBe(38.09);
    expect(out.valuation.peers.sector).toMatchObject({ name: 'Technology', pe: 48.8 });
    expect(out.valuation.peers.industry).toMatchObject({ name: 'Consumer Electronics', pe: 38.23 });
    expect(out.valuation.marketCap).toMatchObject({ latest: 4.9e12, date: '2026-10-02' });
  });

  test('a /dividend-yield call that fails is an unread yield, stated, never plain absence', async () => {
    const t = tool(registerFundamentals, fundamentalsRoutes({ '/dividend-yield/AAPL': new Error('HTTP 503') }));
    const out = (await t.run({ symbol: 'AAPL' })).structuredContent;
    expect(out.dividendYieldNote).toMatch(/could not be read/);
    const ok = tool(registerFundamentals, fundamentalsRoutes());
    expect('dividendYieldNote' in (await ok.run({ symbol: 'AAPL' })).structuredContent).toBe(false);
  });

  test('the full view says so too (review: the note was summary-only)', async () => {
    const t = tool(registerFundamentals, fundamentalsRoutes({ '/dividend-yield/AAPL': new Error('HTTP 503') }));
    const res = await t.run({ symbol: 'AAPL', full: true });
    expect(JSON.stringify(res.structuredContent)).toContain('The dividend yield could not be read');
    const ok = tool(registerFundamentals, fundamentalsRoutes());
    expect(JSON.stringify((await ok.run({ symbol: 'AAPL', full: true })).structuredContent)).not.toContain('dividendYieldNote');
  });

  test('valuation reads that fail leave the fundamentals standing and say so', async () => {
    const down = new Error('HTTP 503');
    const t = tool(registerFundamentals, fundamentalsRoutes({
      '/market/sector-metrics?kind=sector': down, '/market/sector-metrics?kind=industry': down, '/market-cap-history/AAPL': down,
    }));
    const res = await t.run({ symbol: 'AAPL' });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.ratiosTtm.priceToEarningsRatioTTM).toBe(38.09);
    expect(res.structuredContent.valuation).toMatchObject({
      peTtm: 38.09, peers: null, peersNote: 'Sector and industry P/E were unavailable on this call.',
      marketCap: null, marketCapNote: 'Market-cap history was unavailable on this call.',
    });
  });

  test('one group read failing keeps the other group and says part was unavailable', async () => {
    const sectorDown = tool(registerFundamentals, fundamentalsRoutes({ '/market/sector-metrics?kind=sector': new Error('HTTP 503') }));
    const v = (await sectorDown.run({ symbol: 'AAPL' })).structuredContent.valuation;
    expect(v.peers.sector).toBeNull();
    expect(v.peers.industry).toMatchObject({ name: 'Consumer Electronics', pe: 38.23 });
    expect(v.peersNote).toBe('Part of the group P/E was unavailable on this call.');
    const industryDown = tool(registerFundamentals, fundamentalsRoutes({ '/market/sector-metrics?kind=industry': new Error('HTTP 503') }));
    const w = (await industryDown.run({ symbol: 'AAPL' })).structuredContent.valuation;
    expect(w.peers.industry).toBeNull();
    expect(w.peers.sector).toMatchObject({ name: 'Technology', pe: 48.8 });
    expect(w.peersNote).toBe('Part of the group P/E was unavailable on this call.');
  });

  test('a failed profile read leaves the fundamentals and says the comparison could not be made', async () => {
    const t = tool(registerFundamentals, fundamentalsRoutes({ '/company-profile/AAPL': new Error('HTTP 503') }));
    const res = await t.run({ symbol: 'AAPL' });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.ratiosTtm.priceToEarningsRatioTTM).toBe(38.09);
    expect(res.structuredContent.valuation.peersNote).toBe('The company profile was unavailable on this call, so no peer comparison.');
  });

  test('full=true carries `valuation` beside the raw payload; no fundamentals is a status, never `valuation` alone', async () => {
    const t = tool(registerFundamentals, fundamentalsRoutes());
    const full = (await t.run({ symbol: 'AAPL', full: true })).structuredContent;
    expect(full.ratiosTtm.priceToEarningsRatioTTM).toBe(38.09);
    expect(full.valuation.peTtm).toBe(38.09);
    // The full payload carries no companyProfile, and its valuation note describes none; the summary's does.
    expect(full.valuation.note).not.toContain('companyProfile');
    // No derived TTM date in either view: only the recorded stamps (review).
    expect('ttmAsOf' in full).toBe(false);
    expect('ttmAsOf' in (await t.run({ symbol: 'AAPL' })).structuredContent).toBe(false);
    expect((await t.run({ symbol: 'AAPL' })).structuredContent.valuation.note).toContain('`companyProfile.marketCap`');
    // The currencies ride on the full payload too (the profile's, the statements' when present).
    const twd = tool(registerFundamentals, fundamentalsRoutes({
      '/fundamentals/AAPL': { ...FUNDAMENTALS, income_stmt: [{ date: '2025-12-31', reportedCurrency: 'TWD' }] },
      '/company-profile/AAPL': { ...PROFILE, currency: 'USD' },
    }));
    for (const isFull of [false, true]) {
      const out = (await twd.run({ symbol: 'AAPL', full: isFull })).structuredContent;
      expect(out.currencies, String(isFull)).toEqual({ reported: 'TWD', reportedAsOf: '2025-12-31', trading: 'USD' });
      expect(out.currencyNote, String(isFull)).toContain(isFull ? 'the two can disagree. `valuation.marketCap` is in USD.' : 'the two can disagree. `companyProfile` (marketCap, lastDividend) and `valuation.marketCap` are in USD.');
    }
    // A payload past the budget: the tool's own trim, never "Response too large" (live TSM, 2026-10-04).
    const row = (i: number) => Object.fromEntries([['date', `20${String(26 - Math.floor(i / 4)).padStart(2, '0')}-0${(3 - (i % 4)) * 3 + 1}-01`], ...Array.from({ length: 40 }, (_, k) => [`f${k}`, 1234567.891 + k])]);
    const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i));
    const huge = tool(registerFundamentals, fundamentalsRoutes({ '/fundamentals/AAPL': { ...FUNDAMENTALS, income_stmt: rows(30), income_stmt_quarterly: rows(120), balance_sheet: rows(30), balance_sheet_quarterly: rows(120), cash_flow: rows(30), cash_flow_quarterly: rows(120) } }));
    const big = (await huge.run({ symbol: 'AAPL', full: true })).structuredContent;
    expect(big.error).toBeUndefined();
    expect(big.fullMeta).toMatchObject({ trimmedForSize: true, periodsOnFile: { incomeStmtQuarterly: 120, incomeStmt: 30 } });
    expect(big.incomeStmtQuarterly).toHaveLength(big.fullMeta.periodsPerStatement);
    expect(big.valuation.peTtm).toBe(38.09);
    const none = tool(registerFundamentals, fundamentalsRoutes({ '/fundamentals/AAPL': null }));
    for (const full of [false, true]) {
      // Not a payload of `valuation` alone: no fundamentals is a status on either path.
      const res = await none.run({ symbol: 'AAPL', full });
      expect(res.structuredContent, String(full)).toEqual({ symbol: 'AAPL', fundamentalsStatus: 'No company financial statements on record for this symbol.' });
    }
    // Live 2026-10-04: SPY answered a bare "No data available for this query." A fund is named as one.
    const etf = tool(registerFundamentals, fundamentalsRoutes({ '/fundamentals/AAPL': null, '/company-profile/AAPL': { ...PROFILE, is_etf: true } }));
    expect((await etf.run({ symbol: 'aapl', full: true })).structuredContent).toEqual({ symbol: 'AAPL', fundamentalsStatus: 'No company financial statements on record for this exchange-traded product.' });
    // A failed profile read cannot name a fund.
    const down = tool(registerFundamentals, fundamentalsRoutes({ '/fundamentals/AAPL': null, '/company-profile/AAPL': new Error('HTTP 503') }));
    expect((await down.run({ symbol: 'AAPL' })).structuredContent.fundamentalsStatus).toBe('No company financial statements on record for this symbol.');
  });

  test('the description says what `valuation` holds', () => {
    expect(FUNDAMENTALS_DESCRIPTION).toContain('`valuation`');
    expect(FUNDAMENTALS_DESCRIPTION).toContain('`premiumPct`');
    expect(FUNDAMENTALS_DESCRIPTION).toContain('NYSE, NASDAQ and AMEX only');
    expect(FUNDAMENTALS_DESCRIPTION).toContain('`currencies` gives the currency the newest statement on file reports in, with that statement\'s date');
    expect(FUNDAMENTALS_DESCRIPTION).toContain('each statement names its own in `reportedCurrency`');
    expect(FUNDAMENTALS_DESCRIPTION).toContain('refreshed apart from the statements, so around a change of reporting currency the two can disagree');
    expect(FUNDAMENTALS_DESCRIPTION).toContain('When the symbol has no fundamentals record the answer is `fundamentalsStatus` (naming an exchange-traded product as one), not a payload.');
    expect(FUNDAMENTALS_DESCRIPTION).toContain("The TTM figures are refreshed both with the company's statements (`fetchedAt`) and from daily files (`ttmBulkAsOf`, the files' own date); the two stamps record those refreshes, not which one wrote the figures shown.");
    expect(FUNDAMENTALS_DESCRIPTION).not.toContain('ttmAsOf');
    expect(FUNDAMENTALS_DESCRIPTION).not.toContain('after that date');
    expect(FUNDAMENTALS_DESCRIPTION).toContain('with `currencyNote` when they differ');
  });
});

const ESG = {
  symbol: 'AAPL',
  disclosure: { url: 'https://www.sec.gov/x', date: '2026-06-27', esgScore: 59.03, formType: '10-Q', socialScore: 47.36, acceptedDate: '2026-07-31', governanceScore: 61.32, environmentalScore: 68.41 },
  rating: { rating: 'B', industry: 'CONSUMER ELECTRONICS', fiscalYear: 2025, industryRank: '19 out of 21' },
  withheld: { disclosure: null, rating: null },
};

describe('get_company_profile esg', () => {
  test('the ESG read runs beside the profile and lands in `esg`', async () => {
    const t = tool(registerProfile, { '/company-profile/AAPL': PROFILE, '/esg/AAPL': ESG });
    const out = (await t.run({ symbol: 'aapl' })).structuredContent;
    // The fund read (phase C) runs beside them too; a stock has none on record.
    expect(t.calls.map(c => c.path).sort()).toEqual(['/company-profile/AAPL', '/esg/AAPL', '/etf-fund/AAPL']);
    expect(out.symbol).toBe('AAPL');
    expect(out.esg.disclosure).toMatchObject({ esgScore: 59.03, formType: '10-Q', periodEnded: '2026-06-27' });
    expect(out.esg.riskRating).toMatchObject({ rating: 'B', fiscalYear: 2025 });
    expect('esgNote' in out).toBe(false);
  });

  test('no ESG on record and a failed ESG read each leave the profile and say which', async () => {
    const none = (await tool(registerProfile, { '/company-profile/AAPL': PROFILE }).run({ symbol: 'AAPL' })).structuredContent;
    expect(none).toMatchObject({ symbol: 'AAPL', esg: null, esgNote: 'No ESG data on record for this symbol.' });
    const res = await tool(registerProfile, { '/company-profile/AAPL': PROFILE, '/esg/AAPL': new Error('HTTP 503') }).run({ symbol: 'AAPL' });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ symbol: 'AAPL', esg: null, esgNote: 'ESG data was unavailable on this call.' });
  });

  test('full=true carries `esg` beside the raw row; no profile is still no data', async () => {
    const full = (await tool(registerProfile, { '/company-profile/AAPL': PROFILE, '/esg/AAPL': ESG }).run({ symbol: 'AAPL', full: true })).structuredContent;
    expect(full.exchangeShort).toBe('NASDAQ');
    expect(full.esg.riskRating.rating).toBe('B');
    const res = await tool(registerProfile, { '/esg/AAPL': ESG }).run({ symbol: 'AAPL' });
    expect(res.structuredContent).toEqual({ dataAvailable: false, message: 'No data available for this query.' });
  });

  test('the description says what `esg` holds and when it is null', () => {
    expect(COMPANY_PROFILE_DESCRIPTION).toContain('`esg.withheld`');
    expect(COMPANY_PROFILE_DESCRIPTION).toContain('`esgNote`');
    expect(COMPANY_PROFILE_DESCRIPTION).toContain('0 to 100');
  });
});

describe('get_regime cot (phase H)', () => {
  test('with a symbol the contract`s family market; without, every market by sector; a date gets the note', async () => {
    const sym = { root: 'MES', market: { code: '13874+' }, reportDate: '2026-09-29', speculative: { net: -1 }, groups: [], history: [], range: { windowStart: null, windowEnd: null } };
    const list = { asOf: '2026-10-06', markets: [{ label: 'Gold', sector: 'metals', reportDate: '2026-10-06' }, { label: 'Euro FX', sector: 'fx', reportDate: '2026-09-29' }] };
    const t = tool(registerRegime, { '/cot/MESZ6': sym, '/market/cot': list });
    const one = (await t.run({ scope: 'cot', symbol: '/MESZ6' })).structuredContent;
    expect(one.market.code).toBe('13874+');
    expect(t.calls.map((c: any) => c.path)).toContain('/cot/MESZ6');
    const all = (await t.run({ scope: 'cot', sector: 'metals', date: '2025-01-02' })).structuredContent;
    expect(all.markets.map((m: any) => m.label)).toEqual(['Gold']);
    expect(all.dateNote).toContain('the date 2025-01-02 is not supported here');
  });

  test('every market at its widest stays under the real response guard, whole (no budget cut)', async () => {
    const range = { reading: -100, low: -12345678, high: -12345678, windowStart: '2023-10-03', windowEnd: '2026-09-29', observations: 157 };
    const markets = Array.from({ length: 40 }, (_, i) => ({
      code: `${String(i).padStart(5, '0')}+`, kind: 'disaggregated', label: `Ultra Treasury Bond Consolidated ${i}`, sector: 'equity-index', roots: ['MES', 'NES', 'ES'],
      reportDate: '2026-09-29', units: '(CONTRACTS OF 42,000 U.S. GALLONS AND MORE TEXT)', speculativeNet: -12345678, side: 'short', netChange: -1234567, percentOfOi: -100.0, range,
    }));
    const t = tool(registerRegime, { '/market/cot': { asOf: '2026-09-29', source: 'CFTC', releaseNote: 'r', groupNote: 'g', rangeNote: 'x', markets } });
    const out = (await t.run({ scope: 'cot', date: '2025-01-02' })).structuredContent;
    expect(out.responseBudget).toBeUndefined();
    expect(out.markets).toHaveLength(40);
    expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThan(MAX_RESPONSE_BYTES * 0.6);
  });

  test('the description names which index families CFTC consolidates, the Russell 2000 not among them', () => {
    const { config } = tool(registerRegime, {});
    expect(config.description).toContain("CFTC's consolidated market for the S&P 500, Nasdaq-100 and Dow E-mini, Micro and Nano families; for every other family, the Russell 2000 included, its standard contract's market");
    expect(config.description).not.toContain('E-mini/Micro/Nano index families');
  });

  test('a contract with no mapping or no data (a 404) answers with a status, not an error', async () => {
    const t = tool(registerRegime, {});
    const res = await t.run({ scope: 'cot', symbol: 'ZZZ' });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.cotStatus).toBe('No CFTC positioning on record for this contract.');
  });
});
