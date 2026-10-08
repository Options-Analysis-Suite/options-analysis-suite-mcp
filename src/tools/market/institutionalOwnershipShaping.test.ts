import { describe, expect, test } from 'bun:test';
import { MAX_RESPONSE_BYTES, sanitizeMcpWireOutput } from '../helpers.js';
import { ETF_HOLDERS_BASIS, INSTITUTIONAL_NOTE, noInstitutionalRecord, quarterLabel, shapeInstitutionalOwnership } from './institutionalOwnershipShaping.js';
import { INSTITUTIONAL_OWNERSHIP_DESCRIPTION, register } from './institutionalOwnership.js';

const ROUTE = {
  symbol: 'AAPL',
  source: 'SEC Form 13F data sets',
  quarters: [
    { symbol: 'AAPL', period: '2026-06-30', holders: 6111, shares: 9695713598, value: 2802.3e9, call_holders: 146, call_shares: 50e6, put_holders: 196, put_shares: 60e6,
      prev_holders: 6112, prev_shares: 9488085727, new_holders: 100, closed_holders: 87, increased_holders: 2565, decreased_holders: 2925,
      market_cap: 4.17e12, market_cap_date: '2026-06-26', pct_of_market_cap: 67.1284, filed_through: '2026-08-31' },
    { symbol: 'AAPL', period: '2026-03-31', holders: 6112, shares: 9488085727, value: 2377.6e9, call_holders: 140, call_shares: 1, put_holders: 190, put_shares: 1,
      prev_holders: null, prev_shares: null, new_holders: null, closed_holders: null, increased_holders: null, decreased_holders: null,
      market_cap: null, market_cap_date: null, pct_of_market_cap: null, filed_through: '2026-08-31' },
  ],
  holders: { period: '2026-06-30', rows: [
    { rank: 1, manager_cik: '2012383', manager_name: 'BlackRock, Inc.', shares: 1162996939, value: 337e9, prev_shares: 1144695425 },
    { rank: 10, manager_cik: '1374170', manager_name: 'NORGES BANK', shares: 190726866, value: 55e9, prev_shares: null },
    { rank: 11, manager_cik: '9', manager_name: null, shares: 100, value: 1, prev_shares: 0 },
  ] },
  periods: [{ period: '2026-06-30', publishedAt: '2026-09-20T07:00:00Z', filedThrough: '2026-08-31', windows: ['01jun2026-31aug2026_form13f.zip'], filers: 8857 }],
};

describe('get_institutional_ownership', () => {
  test('the newest quarter in full, its top holders with their change, the quarters before, and what it was read from', () => {
    const out = sanitizeMcpWireOutput(shapeInstitutionalOwnership(ROUTE)) as any;
    expect(out).toMatchObject({
      symbol: 'AAPL', quarter: 'Q2 2026', asOf: '2026-06-30', institutions: 6111, shares: 9695713598, pctOfMarketCap: 67.1284, marketCapDate: '2026-06-26',
      changeFromPriorQuarter: { institutions: -1, shares: 207627871, priorInstitutions: 6112, priorShares: 9488085727 },
      positionChanges: { new: 100, closed: 87, increased: 2565, decreased: 2925 },
      calls: { institutions: 146 }, puts: { institutions: 196 }, filedThrough: '2026-08-31',
      institutionalMeta: { source: 'SEC Form 13F data sets', quartersOnFile: 2, publishedAt: '2026-09-20T07:00:00Z', dataSets: ['01jun2026-31aug2026_form13f.zip'], filers: 8857 },
    });
    expect(out.topHolders.map((h: any) => [h.rank, h.manager, h.priorShares, h.change])).toEqual([
      [1, 'BlackRock, Inc.', 1144695425, '+18301514 (1.6%)'],
      [10, 'NORGES BANK', null, 'no comparable report'],
      [11, null, 0, 'new'],
    ]);
    expect(out.history.map((h: any) => [h.quarter, h.institutions, h.pctOfMarketCap])).toEqual([['Q2 2026', 6111, 67.1284], ['Q1 2026', 6112, null]]);
    expect(out.institutionalNote).toBe(INSTITUTIONAL_NOTE);
  });

  test('the oldest quarter on file has no prior: null changes, never zeros; options apart', () => {
    const out = shapeInstitutionalOwnership({ ...ROUTE, quarters: [ROUTE.quarters[1]], holders: { period: '2026-03-31', rows: [] } }) as any;
    expect(out.changeFromPriorQuarter).toBeNull();
    expect(out.positionChanges).toBeNull();
    expect(out.pctOfMarketCap).toBeNull();
  });

  test('a newer quarter on file that holds none of the symbol is said; a quarter everyone left reads zero with its closures', () => {
    const later = shapeInstitutionalOwnership({ ...ROUTE, periods: [{ period: '2026-09-30', publishedAt: '2026-12-20T07:00:00Z', windows: [], filers: 9000 }, ...ROUTE.periods] }) as any;
    expect(later.newerQuarterNote).toBe('No 13F holdings of this symbol were found for Q3 2026, the newest quarter on file; the figures are for Q2 2026.');
    expect((shapeInstitutionalOwnership(ROUTE) as any).newerQuarterNote).toBeUndefined();
    const exit = { ...ROUTE.quarters[0], holders: 0, shares: 0, value: 0, prev_holders: 1, prev_shares: 10, new_holders: 0, closed_holders: 1, increased_holders: 0, decreased_holders: 0, pct_of_market_cap: null };
    const out = shapeInstitutionalOwnership({ ...ROUTE, quarters: [exit], holders: { period: '2026-06-30', rows: [] } }) as any;
    expect(out).toMatchObject({ institutions: 0, shares: 0, changeFromPriorQuarter: { institutions: -1, shares: -10 }, positionChanges: { new: 0, closed: 1 }, topHolders: [] });
    expect(out.institutionalStatus).toBeUndefined();
  });

  test('coverage: holders whose shares are on another basis and lines that could not be placed are said; a null prior quantity says why', () => {
    const q = { ...ROUTE.quarters[0], holders_other_basis: 2, managers_unplaced: 1 };
    // An older quarter whose lines could not be placed keeps its warning in history.
    const older = { ...ROUTE.quarters[1], holders: 0, shares: 0, value: 0, managers_unplaced: 3 };
    const rows = [{ rank: 1, manager_cik: '5', manager_name: 'M', shares: 10, value: 1, prev_shares: null, prev_status: 'quantity_unknown', other_basis: true }, ROUTE.holders.rows[1]];
    const out = shapeInstitutionalOwnership({ ...ROUTE, quarters: [q, older], holders: { period: '2026-06-30', rows } }) as any;
    expect(out.coverage).toEqual({ institutionsWithSharesOnAnotherBasis: 2, managersUnplaced: 1 });
    expect(out.history.map((h: any) => h.coverage)).toEqual([{ institutionsWithSharesOnAnotherBasis: 2, managersUnplaced: 1 }, { institutionsWithSharesOnAnotherBasis: 0, managersUnplaced: 3 }]);
    expect(out.topHolders.map((h: any) => [h.change, h.someSharesOnAnotherBasis])).toEqual([['change not known', true], ['no comparable report', undefined]]);
    expect((shapeInstitutionalOwnership(ROUTE) as any).coverage).toEqual({ institutionsWithSharesOnAnotherBasis: 0, managersUnplaced: 0 });
  });

  test('holders and quarters capped as asked; holders of another quarter are not passed off as the newest\'s', () => {
    const out = shapeInstitutionalOwnership(ROUTE, { holders: 1, quarters: 1 }) as any;
    expect(out.topHolders).toHaveLength(1);
    expect(out.history).toHaveLength(1);
    const stale = shapeInstitutionalOwnership({ ...ROUTE, holders: { period: '2026-03-31', rows: ROUTE.holders.rows } }) as any;
    expect(stale.topHolders).toEqual([]);
  });

  test('nothing on file is a status, never zeros; a malformed answer is the same', () => {
    expect(noInstitutionalRecord('ZZZ')).toEqual({ symbol: 'ZZZ', institutionalStatus: 'No institutional (13F) holdings on record for this symbol.' });
    expect((shapeInstitutionalOwnership({ symbol: 'X', quarters: [{ period: '2026-06-30', holders: 'n/a' }] }) as any).institutionalStatus).toBe('No institutional (13F) holdings on record for this symbol.');
    expect(quarterLabel('2025-12-31')).toBe('Q4 2025');
  });

  test('the tool: 404 to status, and the description says what the figures are', async () => {
    let config: any; let handler: any;
    const server = { registerTool: (_n: string, c: unknown, h: unknown) => { config = c; handler = h; } };
    const paths: string[] = [];
    register(server as any, { get: async (p: string) => { paths.push(p); return p.endsWith('/MSFT') ? null : ROUTE; } } as any);
    const none = await handler({ symbol: 'msft', holders: 10, quarters: 8 });
    expect(none.structuredContent.institutionalStatus).toBe('No institutional (13F) holdings on record for this symbol.');
    const res = await handler({ symbol: 'aapl', holders: 2, quarters: 8 });
    expect(res.structuredContent.topHolders).toHaveLength(2);
    expect(paths).toEqual(['/institutional-ownership/MSFT', '/institutional-ownership/AAPL']);
    expect(config.description).toBe(INSTITUTIONAL_OWNERSHIP_DESCRIPTION);
    expect(config.description).toContain('`priorShares` (null when the manager has no comparable report for the quarter before, or its earlier or current quantity is not known, as `change` says; 0 when its comparable report listed none)');
    expect(config.description).toContain('`history`, the newest quarters on file, newest first and the newest included (as many as `quarters` asks, 8 at most)');
  });
});

describe('get_institutional_ownership: a market cap another security of the company carries too', () => {
  test('a security whose market cap on file another security of the company carries says it is likely the company\'s whole market cap; another does not', () => {
    const brk = { ...ROUTE, symbol: 'BRK.B', quarters: [{ ...ROUTE.quarters[0], symbol: 'BRK.B', pct_of_market_cap: 43.25, market_cap_shared_with: ['BRK.A'] }] };
    const out = sanitizeMcpWireOutput(shapeInstitutionalOwnership(brk)) as any;
    expect(out.marketCapSharedWith).toEqual(['BRK.A']);
    expect(out.marketCapNote).toBe('The market cap on file for BRK.B is about the same figure as for BRK.A, another security of the same company (the same issuer number and name on file): pctOfMarketCap is likely over the company\'s whole market cap.');
    // Two of them.
    const agnc = sanitizeMcpWireOutput(shapeInstitutionalOwnership({ ...brk, symbol: 'HBAN', quarters: [{ ...brk.quarters[0], symbol: 'HBAN', market_cap_shared_with: ['HBANL', 'HBANZ'] }] })) as any;
    expect(agnc.marketCapNote).toContain('as for HBANL and HBANZ, other securities of the same company');
    const plain = sanitizeMcpWireOutput(shapeInstitutionalOwnership(ROUTE)) as any;
    expect(plain.marketCapSharedWith).toBeUndefined();
    expect(plain.marketCapNote).toBeUndefined();
  });
});


describe('etfHolders (phase C)', () => {
  const HOLDERS = { symbol: 'NVDA', fundsOnFile: 2, limit: 10, note: 'n', asReported: 'Shares, value and weight are as reported in each file.',
    holders: [{ fund: 'IVV', fundName: 'iShares Core S&P 500 ETF', weightPct: 8, shares: 300, marketValue: 54000, holdingsUpdated: '2026-10-09', holdingsReadAt: '2026-10-10T07:00:00Z', basisInherited: true, basisCountReadOn: '2026-09-01', inheritedNote: 'x', splitWarnings: [{ date: '2026-10-12', ratio: '2-for-1', note: 'y' }] },
      { fund: 'SPY', fundName: 'State Street SPDR S&P 500 ETF', weightPct: 7.9, shares: null, marketValue: 27000, holdingsUpdated: '2026-10-09', holdingsReadAt: '2026-10-10T07:00:00Z', basisInherited: false, basisCountReadOn: null, inheritedNote: null, splitWarnings: [] }] };
  /** The tool over a fake proxy: path -> answer (an Error is thrown, an absent path is a 404). */
  const tool = (answers: Record<string, unknown>) => {
    let config: any; let handler: any;
    const paths: string[] = [];
    const server = { registerTool: (_n: string, c: unknown, h: unknown) => { config = c; handler = h; } };
    register(server as any, { get: async (p: string) => { paths.push(p); const a = answers[p]; if (a instanceof Error) throw a; return a ?? null; } } as any);
    return { paths, config: () => config, raw: async (args: Record<string, unknown>) => handler({ holders: 10, quarters: 8, etfHolders: 10, ...args }), call: async (args: Record<string, unknown>) => (await handler({ holders: 10, quarters: 8, etfHolders: 10, ...args })).structuredContent };
  };

  test('beside the 13F answer: rows as reported, split warnings only where present, meta with basis and exclusions', async () => {
    const t = tool({ '/institutional-ownership/NVDA': ROUTE, '/etf-holders/NVDA?limit=10': HOLDERS });
    const out = await t.call({ symbol: 'nvda' });
    expect(out.etfHolders[0]).toEqual({ fund: 'IVV', fundName: 'iShares Core S&P 500 ETF', weightPct: 8, shares: 300, marketValue: 54000, holdingsUpdated: '2026-10-09', basisInherited: true, basisCountReadOn: '2026-09-01', splitWarnings: [{ date: '2026-10-12', ratio: '2-for-1' }] });
    expect('splitWarnings' in out.etfHolders[1]).toBe(false);
    expect(out.etfHolders[1].shares).toBeNull(); // a fund line without a count: unknown, never a partial sum
    expect(out.etfHoldersMeta).toMatchObject({ limit: 10, returned: 2, fundsOnFile: 2, order: 'by value', basis: ETF_HOLDERS_BASIS, excluded: 'unconfirmed lines, count-mismatch or unknown files, and a fund with any line for the security that is not long (a negative weight, share count or value, or none above zero)' });
    // The sync's basis rule, a reported count of exactly 10 included (proxy etfBasis), and long positions only (sql/198).
    expect(ETF_HOLDERS_BASIS).toBe("long security matches in files classified as the fund's own holdings (line count at most twice the fund's reported count plus 10, or at most 1,000 for a reported count of exactly 10, which the data source gives many funds as a cap; read with the file or inherited from its last classified file within 20% and 60 days), read within 21 days");
    expect(out.etfHoldersMeta.quantitiesNote).toBe('Shares, value and weight are as reported in each file. shares or marketValue is null when one of the fund\'s lines for the security gives none (never a partial sum).');
    expect(t.paths).toEqual(['/institutional-ownership/NVDA', '/etf-holders/NVDA?limit=10']);
    expect(t.config().description).toContain('etfHolders');
  });

  test('13F 404 keeps the holders; both absent is the no-record answer with a note; a failed holders read is isolated; 0 reads nothing', async () => {
    let t = tool({ '/etf-holders/NVDA?limit=10': HOLDERS });
    let out = await t.call({ symbol: 'NVDA' });
    expect(out.institutionalStatus).toBe('No institutional (13F) holdings on record for this symbol.');
    expect(out.etfHolders).toHaveLength(2);
    t = tool({});
    out = await t.call({ symbol: 'NVDA' });
    expect(out).toMatchObject({ institutionalStatus: 'No institutional (13F) holdings on record for this symbol.', etfHolders: [], etfHoldersNote: "No qualifying ETF holder on record: a fund qualifies when its latest own-holdings file, read within 21 days, confirms a position in this security and every confirmed line for it is long." });
    t = tool({ '/institutional-ownership/NVDA': ROUTE, '/etf-holders/NVDA?limit=10': new Error('503') });
    out = await t.call({ symbol: 'NVDA' });
    expect(out.etfHoldersStatus).toBe('ETF holdings could not be read right now.');
    expect(out.institutionalStatus).toBeUndefined();
    t = tool({ '/institutional-ownership/NVDA': ROUTE });
    await t.call({ symbol: 'NVDA', etfHolders: 0 });
    expect(t.paths).toEqual(['/institutional-ownership/NVDA']);
  });

  test('a 13F outage keeps the ETF holders and says which read failed; with nothing else read it is the error', async () => {
    let t = tool({ '/institutional-ownership/NVDA': new Error('HTTP 503'), '/etf-holders/NVDA?limit=10': HOLDERS });
    const out = await t.call({ symbol: 'NVDA' });
    expect(out).toMatchObject({ symbol: 'NVDA', institutionalStatus: 'Institutional (13F) holdings could not be read right now.' });
    expect(out.etfHolders).toHaveLength(2);
    t = tool({ '/institutional-ownership/NVDA': new Error('HTTP 503') });
    expect((await t.raw({ symbol: 'NVDA', etfHolders: 0 })).isError).toBe(true);
  });

  test('the ETF holders trim themselves to the byte budget with their meta intact (review: 53,848 bytes, the guard cut them to 5 and replaced the meta)', async () => {
    const wideRoute = { ...ROUTE, holders: { ...ROUTE.holders, rows: Array.from({ length: 20 }, (_, i) => ({ rank: i + 1, manager_cik: String(1000 + i), manager_name: 'M'.repeat(400), shares: 1162996939, value: 337e9, prev_shares: 1144695425 })) } };
    const wideHolders = { ...HOLDERS, fundsOnFile: 400, holders: Array.from({ length: 50 }, (_, i) => ({ ...HOLDERS.holders[0], fund: `F${i}`, fundName: 'F'.repeat(400), splitWarnings: [1, 2, 3].map(j => ({ date: `2026-10-1${j}`, ratio: '2-for-1', note: 'y' })) })) };
    const t = tool({ '/institutional-ownership/NVDA': wideRoute, '/etf-holders/NVDA?limit=50': wideHolders });
    const res = await t.raw({ symbol: 'NVDA', holders: 20, quarters: 8, etfHolders: 50 });
    const out = res.structuredContent;
    expect(Buffer.byteLength(res.content[0].text)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(JSON.stringify(out)).not.toContain('"truncated"');
    expect(out.etfHolders.length).toBeGreaterThan(0);
    expect(out.etfHolders.length).toBeLessThan(50);
    expect(out.etfHoldersMeta).toMatchObject({ limit: 50, returned: out.etfHolders.length, fundsOnFile: 400, basis: ETF_HOLDERS_BASIS });
    expect(out.etfHoldersMeta.budgetNote).toContain('to fit');
    expect(out.topHolders).toHaveLength(20);
  });
});
