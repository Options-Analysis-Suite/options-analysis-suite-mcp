import { describe, expect, test } from 'bun:test';
import { MAX_RESPONSE_BYTES, applyResponseSizeGuard, sanitizeMcpWireOutput } from '../helpers.js';
import { CONGRESS_NOTE, noCongressRecord, shapeCongressTrades, shapeMarketCongressTrades } from './congressTradesShaping.js';
import { CONGRESS_TRADES_DESCRIPTION, register } from './congressTrades.js';

const COVERAGE = [
  { chamber: 'house', firstDisclosure: '2023-04-10', newestDisclosure: '2026-10-02', lastReadAt: '2026-10-04T10:20:00Z', lastFullReadAt: null, tickersDatedFrom: '2021-02-01' },
  { chamber: 'senate', firstDisclosure: '2014-01-30', newestDisclosure: '2026-09-30', lastReadAt: '2026-10-04T10:19:00Z', lastFullReadAt: null, tickersDatedFrom: '2021-02-01' },
];
const trade = (over: Record<string, any> = {}) => ({
  chamber: 'house', member: { id: 'C001123', name: 'Gilbert Ray Cisneros, Jr.', party: 'Democrat', caucus: null, state: 'CA', district: '31' },
  symbol: 'NVDA', symbolFiled: 'NVDA', symbolBasis: 'dated', asset: 'NVIDIA Corporation', assetType: 'Stock', type: 'Sale', owner: null,
  amount: { text: '$1,001 - $15,000', min: 1001, max: 15000 }, transactionDate: '2026-08-18', disclosedDate: '2026-09-11', lagDays: 24, listed: 1,
  filings: [{ url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035390.pdf', disclosed: '2026-09-11' }], comment: null, ...over,
});
const ROUTE = {
  symbol: 'NVDA', source: 'Senate and House periodic transaction reports', limit: 100, coverage: COVERAGE,
  summary: { transactions: 323, purchases: 199, sales: 124, other: 0, members: 56, senate: 93, house: 230, firstTrade: '2016-01-05', lastTrade: '2026-08-18', lastDisclosed: '2026-09-11' },
  trades: [
    trade(),
    trade({ chamber: 'senate', member: { id: 'S000033', name: 'Bernard Sanders', party: 'Independent', caucus: 'Democrat', state: 'VT', district: null }, symbol: 'META', symbolFiled: 'FB', type: 'Purchase', owner: 'Spouse',
      amount: { text: 'Over $50,000,000', min: 50000001, max: null }, lagDays: -1,
      filings: [{ url: 'https://efd/1', disclosed: '2021-07-01' }, { url: 'https://efd/2', disclosed: '2022-01-10' }] }),
    trade({ member: { id: 'X000001', name: 'New Member', party: null, caucus: null, state: 'TX', district: '9' }, symbol: null, symbolFiled: null, asset: 'Ohio St 4% 2030', assetType: 'Municipal Security', type: 'receive' }),
  ],
};

describe('get_congress_trades', () => {
  test('a company: totals over every transaction, the newest trades with party, seat, ranges, dates, the report and later re-listings', () => {
    const out = sanitizeMcpWireOutput(shapeCongressTrades(ROUTE)) as any;
    expect(out.summary).toEqual({ transactions: 323, purchases: 199, sales: 124, other: 0, members: 56, senate: 93, house: 230, firstTrade: '2016-01-05', lastTrade: '2026-08-18', lastDisclosed: '2026-09-11' });
    expect(out.trades[0]).toEqual({
      member: 'Gilbert Ray Cisneros, Jr.', memberId: 'C001123', party: 'Democrat', chamber: 'House', seat: 'CA-31', label: 'D-CA-31', symbol: 'NVDA', asset: 'NVIDIA Corporation',
      assetType: 'Stock', type: 'Sale', owner: null, amountRange: { text: '$1,001 - $15,000', min: 1001, max: 15000 }, tradeDate: '2026-08-18', disclosedDate: '2026-09-11',
      disclosureLagDays: 24, report: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035390.pdf',
    });
    expect(out.trades[1]).toMatchObject({ party: 'Independent', caucus: 'Democrat', chamber: 'Senate', seat: 'VT', label: 'I-VT', symbol: 'META', symbolFiled: 'FB', owner: 'Spouse',
      amountRange: { text: 'Over $50,000,000', min: 50000001, max: null }, disclosureLagDays: -1, report: 'https://efd/1', alsoInLaterReports: 1 });
    expect(out.trades[2]).toMatchObject({ party: null, label: 'TX-9', symbol: null, asset: 'Ohio St 4% 2030', assetType: 'Municipal Security', type: 'Received' });
    expect(out.trades[2].caucus).toBeUndefined();
    expect(out.trades[0].alsoInLaterReports).toBeUndefined();
    expect(out.tradesMeta).toEqual({ returned: 3, onFile: 323, order: 'newest trade first', note: 'The totals in `summary` count every transaction on file; ask for more with `limit` (up to 50).' });
    expect(out.coverage).toEqual([
      { chamber: 'House', disclosuresFrom: '2023-04-10', disclosuresThrough: '2026-10-02', lastRead: '2026-10-04T10:20:00Z' },
      { chamber: 'Senate', disclosuresFrom: '2014-01-30', disclosuresThrough: '2026-09-30', lastRead: '2026-10-04T10:19:00Z' },
    ]);
    expect(out.tickersDatedFrom).toBe('2021-02-01');
    expect(out.congressNote).toBe(CONGRESS_NOTE);
  });

  test('the limit caps the trades listed, never the totals; every trade shown when all fit', () => {
    const out = shapeCongressTrades(ROUTE, { limit: 1 }) as any;
    expect(out.trades).toHaveLength(1);
    expect(out.summary.transactions).toBe(323);
    const all = shapeCongressTrades({ ...ROUTE, summary: { ...ROUTE.summary, transactions: 3 } }) as any;
    expect(all.tradesMeta.note).toBeUndefined();
    expect((shapeCongressTrades(ROUTE, { limit: 500 }) as any).trades).toHaveLength(3);
  });

  test('nothing on record is a status, never zeros; a malformed answer is the same', () => {
    expect(noCongressRecord('ZZZ')).toEqual({ symbol: 'ZZZ', congressStatus: 'No Congress trades on record for this symbol.' });
    expect((shapeCongressTrades({ symbol: 'X', trades: [{ chamber: 'house' }] }) as any).congressStatus).toBe('No Congress trades on record for this symbol.');
    expect((shapeMarketCongressTrades(null) as any).congressStatus).toBe('No Congress trade data on record yet.');
  });

  test('the market: the window read, totals, the companies traded most, the newest disclosures', () => {
    const market = {
      days: 30, chamber: 'all', kind: 'all', from: '2026-09-03', asOf: '2026-10-02', limit: 25, source: 'x', coverage: COVERAGE,
      summary: { transactions: 455, purchases: 188, sales: 261, other: 6, members: 32, senate: 45, house: 410, matched: 421 },
      topSymbols: [{ symbol: 'MSFT', transactions: 10, purchases: 6, sales: 4, members: 6 }],
      trades: [trade()],
    };
    const out = sanitizeMcpWireOutput(shapeMarketCongressTrades(market)) as any;
    expect(out).toMatchObject({
      scope: 'market', window: { days: 30, from: '2026-09-03', through: '2026-10-02', firstDisclosedOnly: true }, chamber: 'both', kind: 'all',
      summary: { transactions: 455, purchases: 188, sales: 261, members: 32, senate: 45, house: 410, matchedToCompanies: 421 },
      topCompanies: [{ symbol: 'MSFT', transactions: 10, purchases: 6, sales: 4, members: 6 }],
      tradesMeta: { returned: 1, inWindow: 455, order: 'newest disclosure first' },
    });
    expect(out.trades[0].label).toBe('D-CA-31');
    expect((shapeMarketCongressTrades({ ...market, chamber: 'senate' }) as any).chamber).toBe('Senate');
  });

  test('the tool: symbol and market read their routes with the limit; a 404 is a status; symbol scope needs a symbol', async () => {
    let config: any; let handler: any;
    const server = { registerTool: (_n: string, c: unknown, h: unknown) => { config = c; handler = h; } };
    const calls: Array<[string, unknown]> = [];
    register(server as any, { get: async (p: string, q?: unknown) => { calls.push([p, q]); return p.endsWith('/ZZZ') ? null : p.startsWith('/market') ? { ...ROUTE, days: 30 } : ROUTE; } } as any);
    const none = await handler({ symbol: 'zzz', scope: 'symbol', days: 30, chamber: 'all', kind: 'all', limit: 25 });
    expect(none.structuredContent.congressStatus).toBe('No Congress trades on record for this symbol.');
    const res = await handler({ symbol: 'nvda', scope: 'symbol', days: 30, chamber: 'all', kind: 'all', limit: 2 });
    expect(res.structuredContent.trades).toHaveLength(2);
    await handler({ scope: 'market', days: 90, chamber: 'senate', kind: 'purchases', limit: 10 });
    expect(calls).toEqual([
      ['/congress-trades/ZZZ', { limit: '25' }],
      ['/congress-trades/NVDA', { limit: '2' }],
      ['/market/congress-trades', { days: '90', chamber: 'senate', kind: 'purchases', limit: '10' }],
    ]);
    const missing = await handler({ scope: 'symbol', days: 30, chamber: 'all', kind: 'all', limit: 25 });
    expect(missing.isError).toBe(true);
    expect(config.description).toBe(CONGRESS_TRADES_DESCRIPTION);
    expect(config.title).toBe('Congress Trades');
  });

  test('fifty trades with the longest comments and names fit the response budget: those fields are cut', () => {
    const many = { ...ROUTE, trades: Array.from({ length: 50 }, (_, i) => trade({ asset: `A security with a long description ${i} `.repeat(10), comment: 'x'.repeat(400) })) };
    const out = sanitizeMcpWireOutput(shapeCongressTrades(many, { limit: 50 })) as any;
    expect(out.trades[0].comment).toHaveLength(200);
    expect(out.trades[0].comment.endsWith('…')).toBe(true);
    expect(out.trades[0].asset.length).toBeLessThanOrEqual(140);
    expect(JSON.stringify(out).length).toBeLessThan(MAX_RESPONSE_BYTES * 0.9);
    // A short one is left whole.
    expect((shapeCongressTrades({ ...ROUTE, trades: [trade({ comment: 'Sold to rebalance.' })] }) as any).trades[0].comment).toBe('Sold to rebalance.');
  });

  test('fifty trades that outgrow the budget anyway lose their last trades here, keeping the totals, order and window', () => {
    const long = (i: number) => trade({
      member: { id: `M${i}`, name: `A Member With An Unusually Long Name ${i} `.repeat(6), party: 'Democrat', caucus: null, state: 'CA', district: '31' },
      asset: 'x'.repeat(400), comment: 'y'.repeat(400), owner: 'Dependent Child '.repeat(8), amount: { text: 'Spouse/DC Over $1,000,000 '.repeat(6), min: 1000001, max: null },
      filings: [{ url: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/${'9'.repeat(200)}${i}.pdf`, disclosed: '2026-09-11' }],
    });
    const many = Array.from({ length: 50 }, (_, i) => long(i));
    const symbol = shapeCongressTrades({ ...ROUTE, trades: many }, { limit: 50 }) as any;
    expect(symbol.trades.length).toBeGreaterThan(5);
    expect(symbol.trades.length).toBeLessThan(50);
    expect(symbol.trades[0].memberId).toBe('M0');
    expect(symbol.tradesMeta).toMatchObject({ returned: symbol.trades.length, onFile: 323, order: 'newest trade first', trimmedForSize: true });
    expect(symbol.tradesMeta.note).toBe('The trades asked for did not all fit the response size: these are the newest `returned` of them (a smaller `limit` gives fewer of the same; there is no paging), and the totals in `summary` count every transaction.');
    expect(symbol.summary.transactions).toBe(323);
    // The shared guard has nothing left to cut.
    expect(JSON.parse(applyResponseSizeGuard(symbol))).toEqual(sanitizeMcpWireOutput(symbol));
    const market = shapeMarketCongressTrades({ days: 30, chamber: 'all', kind: 'all', from: '2026-09-03', asOf: '2026-10-02', coverage: COVERAGE,
      summary: { transactions: 455, purchases: 188, sales: 261, other: 6, members: 32, senate: 45, house: 410, matched: 421 }, topSymbols: [], trades: many }, { limit: 50 }) as any;
    expect(market.tradesMeta).toMatchObject({ returned: market.trades.length, inWindow: 455, order: 'newest disclosure first', trimmedForSize: true });
    expect(market.window).toEqual({ days: 30, from: '2026-09-03', through: '2026-10-02', firstDisclosedOnly: true });
    expect(JSON.parse(applyResponseSizeGuard(market))).toEqual(sanitizeMcpWireOutput(market));
    // An answer that fits is not marked.
    expect((shapeCongressTrades(ROUTE, { limit: 50 }) as any).tradesMeta.trimmedForSize).toBeUndefined();
  });
});
