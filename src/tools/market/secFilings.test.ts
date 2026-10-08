import { describe, expect, test } from 'bun:test';
import { register, SEC_FILINGS_DESCRIPTION } from './secFilings.js';

/**
 * get_sec_filings reads the filing list and the merger / offering flags as two
 * requests; a flags failure must not take the list with it. scope market
 * reads the market-wide merger filings instead.
 */

function tool(routes: Record<string, unknown | Error>) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  let handler!: Function;
  let config!: Record<string, any>;
  register({ registerTool: (_n: string, c: Record<string, any>, h: Function) => { config = c; handler = h; } } as any, {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ path, params });
      const r = routes[path];
      if (r instanceof Error) throw r;
      return r === undefined ? null : r;
    },
  } as any);
  const run = async (args: Record<string, unknown>) => (await handler({ scope: 'symbol', limit: 10, type: 'all', days: 30, ...args })) as any;
  return { calls, run, config };
}

const FILINGS = { symbol: 'BRBS', companyName: 'Blue Ridge Bankshares', cik: '0000842717', filings: [
  { formType: 'DEFA14A', description: 'DEFA14A', filingDate: '2026-08-17', accessionNumber: '0001-26-1', url: 'https://www.sec.gov/x' },
] };
const FLAGS = { asOf: '2026-10-02', flags: { offering: null, merger: {
  form: 'S-4', label: 'Merger filing', dateFiled: '2026-10-02', accession: '0001104659-26-113346', url: 'https://www.sec.gov/s4',
  counterparties: [{ cik: 1538263, name: 'HomeTrust Bancshares, Inc.', tickers: ['HTB'] }], expiresOn: '2027-01-30',
} } };

describe('get_sec_filings', () => {
  test('a symbol: the filing list and its flags, read side by side', async () => {
    const t = tool({ '/sec-filings/BRBS': FILINGS, '/sec-corporate-filings/BRBS': FLAGS });
    const out = (await t.run({ symbol: 'brbs' })).structuredContent;
    expect(t.calls.map(c => c.path).sort()).toEqual(['/sec-corporate-filings/BRBS', '/sec-filings/BRBS']);
    expect(out.recentFilings).toHaveLength(1);
    expect(out.dealFlags.merger).toMatchObject({ label: 'Merger filing', formType: 'S-4', counterparties: [{ name: 'HomeTrust Bancshares, Inc.', tickers: ['HTB'] }], flagUntil: '2027-01-30' });
    expect(out.dealFlags.indexThrough).toBe('2026-10-02');
  });

  test('a flags read that fails leaves the filing list and says the flags were unavailable', async () => {
    const t = tool({ '/sec-filings/BRBS': FILINGS, '/sec-corporate-filings/BRBS': new Error('HTTP 503') });
    const out = (await t.run({ symbol: 'BRBS' })).structuredContent;
    expect(out.recentFilings).toHaveLength(1);
    expect(out.dealFlags).toBeNull();
    expect(out.dealFlagsNote).toContain('unavailable');
    expect(out.dealFlagsNote).not.toContain('funds');
  });

  test('a fund (no filer on record, a 404) carries no flags and says why', async () => {
    const t = tool({ '/sec-filings/SPY': { ...FILINGS, symbol: 'SPY' } });
    const out = (await t.run({ symbol: 'SPY' })).structuredContent;
    expect(out.dealFlags).toBeNull();
    // SPY has a CIK (the trust files with the SEC); funds are left out of the filer map, not filer-less.
    expect(out.dealFlagsNote).toContain('funds and ETFs are left out of it');
    // Not the outage note: a fund has no flags, which is an answer, not a failure.
    expect(out.dealFlagsNote).not.toContain('unavailable');
  });

  test('full=true keeps the raw list and adds the flags', async () => {
    const t = tool({ '/sec-filings/BRBS': FILINGS, '/sec-corporate-filings/BRBS': FLAGS });
    const out = (await t.run({ symbol: 'BRBS', full: true })).structuredContent;
    expect(out.filings).toHaveLength(1);
    expect(out.dealFlags.merger.formType).toBe('S-4');
  });

  test('scope market reads the merger filings of `days` and keeps `limit`; it needs no symbol', async () => {
    const deals = Array.from({ length: 12 }, (_, i) => ({ label: 'Merger filing', form: '425', dateFiled: '2026-10-02', accession: `a${i}`, url: `u${i}`, parties: [] }));
    const t = tool({ '/market/mna-filings': { days: 7, asOf: '2026-10-02', total: 12, deals } });
    const out = (await t.run({ scope: 'market', days: 7, limit: 5 })).structuredContent;
    expect(t.calls).toEqual([{ path: '/market/mna-filings', params: { days: '7' } }]);
    expect(out).toMatchObject({ scope: 'market', days: 7, totalFilings: 12, filingsMeta: { showing: 5, total: 12, truncated: true } });
    expect(out.filings).toHaveLength(5);
  });

  test('scope symbol without a symbol is an error, and reads nothing', async () => {
    const t = tool({});
    const out = await t.run({});
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.content)).toContain("scope='symbol' requires `symbol`");
    expect(t.calls).toEqual([]);
  });

  test('the description says what the flags are and names no vendor', () => {
    const t = tool({});
    expect(t.config.description).toBe(SEC_FILINGS_DESCRIPTION);
    expect(SEC_FILINGS_DESCRIPTION).toContain('dealFlags');
    // Live run 2026-10-04: BRBS's S-4 behind its flag was filed under HomeTrust's CIK, so the BRBS filing list never showed it.
    expect(SEC_FILINGS_DESCRIPTION).toContain('need not appear in `recentFilings`');
    expect(SEC_FILINGS_DESCRIPTION).toContain('scope="market"');
    expect(SEC_FILINGS_DESCRIPTION).not.toMatch(/dilution/i);
  });
});
