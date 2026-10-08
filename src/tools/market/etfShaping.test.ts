// The etf block of get_company_profile and its holdings paging (phase C).
import { describe, expect, it } from 'bun:test';
import { ETF_READ_FAILED, fitHoldingsPage, shapeEtfBlock } from './etfShaping.js';
import { MAX_RESPONSE_BYTES, sanitizeMcpWireOutput, utf8ByteLength } from '../helpers.js';
import { register } from './companyProfile.js';

const H = { status: 'ok', total: 506, kept: 101, weightSum: 100, basis: 'count_mismatch', basisInherited: false, basisCount: 7, basisCountReadOn: '2026-10-05', basisAnchorLines: 33881, updatedOn: '2026-10-04', fetchedAt: '2026-10-05T07:00:00Z', checkedAt: null, lastAttempt: 'ok', overdue: false, sourceStale: false };
const NOTES = { basis: 'The fund reports 7 holdings, but this file lists 506 lines - likely its underlying exposure through those holdings (look-through) rather than its own holdings.', overdue: null, sourceStale: null, fileWithheld: null, factsWithheld: null, countryWithheld: null, asReported: 'as reported', weights: 'w' };
const line = (rank: number, o: any = {}) => ({ rank, name: `Holding ${rank}`, reportedTicker: null, symbol: null, assetType: null, linkBasis: null, matchKind: null, unconfirmedNote: null, linkWithheld: false, withheldNote: null, isin: null, cusip: null, shares: 1, weightPct: 1, marketValue: 1, splitWarnings: [], ...o });
const VIEW = (o: any = {}) => ({ symbol: 'AOR', name: 'iShares Core Moderate Allocation ETF', facts: { expenseRatioPct: 0.15, aum: 1, nav: 2, navCurrency: 'USD', inceptionDate: '2008-11-04', issuer: 'iShares', assetClass: 'Asset Allocation', domicile: 'US' }, factsSourceUpdatedAt: '2026-10-04T23:00:00Z', sectorWeights: [], countryWeights: [], holdings: H, notes: NOTES, offset: 0, limit: 25,
  lines: [line(1, { symbol: 'NVDA', reportedTicker: 'NVDA', linkBasis: 'name', matchKind: 'security', splitWarnings: [{ date: '2026-10-12', ratio: '2-for-1', note: 'n' }] }), line(2, { linkWithheld: true, withheldNote: 'This line was linked to OLD when the file was read; ...' }), ...Array.from({ length: 23 }, (_, i) => line(i + 3))], ...o });

describe('the etf block', () => {
  it('facts with the source refresh time, basis in camelCase with its evidence, top 10 as reported, notes', () => {
    const { etf } = shapeEtfBlock(VIEW()) as any;
    expect(etf.facts).toMatchObject({ expenseRatioPct: 0.15, factsSourceUpdatedAt: '2026-10-04T23:00:00Z', issuer: 'iShares' });
    expect(etf).toMatchObject({ holdingsInFile: 506, holdingsBasis: 'countMismatch', basisEvidence: { fundReportedHoldings: 7, countReadOn: '2026-10-05', inherited: false, anchorLines: 33881 }, holdingsUpdated: '2026-10-04', holdingsReadAt: '2026-10-05T07:00:00Z', quantitiesNote: 'as reported' });
    expect(etf.basisNote).toContain('look-through');
    expect(etf.topHoldings).toHaveLength(10);
    expect(etf.topHoldings[0]).toMatchObject({ rank: 1, symbol: 'NVDA', matchKind: 'security', splitWarnings: [{ date: '2026-10-12', ratio: '2-for-1' }] });
    expect(etf.topHoldings[1]).toMatchObject({ symbol: null, linkWithheld: true });
    expect('splitWarnings' in etf.topHoldings[1]).toBe(false); // only where a split was found
    expect(JSON.stringify(etf)).not.toMatch(/count_mismatch|_/);
  });
  it('a share count the file does not give is null, and the note says why (the zero-share rule)', () => {
    const { etf } = shapeEtfBlock(VIEW({ lines: [line(1, { shares: null, marketValue: 484300000 })] })) as any;
    expect(etf.topHoldings[0]).toMatchObject({ shares: null, marketValue: 484300000 });
    expect(etf.etfNote).toContain('shares is null where the file gives no count');
  });
  it('withheld groups omit their fields; a failed read is etfStatus; not a fund is no block', () => {
    const w = (shapeEtfBlock(VIEW({ facts: null, sectorWeights: null, holdings: { ...H, status: 'withheld', total: null, basis: null, basisCount: null }, lines: [], notes: { ...NOTES, basis: null, fileWithheld: 'file note', factsWithheld: 'facts note' } })) as any).etf;
    expect(w).toMatchObject({ factsStatus: 'withheld', factsNote: 'facts note', holdingsStatus: 'withheld', holdingsNote: 'file note' });
    for (const k of ['facts', 'holdingsInFile', 'holdingsBasis', 'basisEvidence', 'topHoldings', 'sectorWeights']) expect(k in w).toBe(false);
    expect(shapeEtfBlock(ETF_READ_FAILED)).toEqual({ etf: null, etfStatus: 'Fund data could not be read right now.' });
    expect(shapeEtfBlock(null)).toEqual({});
  });
});

describe('holdings paging under the byte budget', () => {
  it('meta from what it keeps; nextOffset from the kept rows; trimmed by the shaper, never by the guard', () => {
    const wide = (rank: number) => line(rank, { name: 'N'.repeat(400), symbol: 'X', reportedTicker: 'X', linkBasis: 'name', matchKind: 'unconfirmed', withheldNote: 'W'.repeat(300), splitWarnings: Array.from({ length: 3 }, (_, i) => ({ date: `2026-10-1${i}`, ratio: '2-for-1', note: 'x' })) });
    const page = { holdings: H, holdingsFetchedAt: H.fetchedAt, lines: Array.from({ length: 100 }, (_, i) => wide(i + 1)), offset: 0, limit: 100, notes: NOTES };
    const out = fitHoldingsPage({ symbol: 'AOR' }, page, { offset: 0, limit: 100 }) as any;
    expect(utf8ByteLength(JSON.stringify(sanitizeMcpWireOutput(out)))).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(out.holdingsMeta.returned).toBe(out.holdings.length);
    expect(out.holdingsMeta.returned).toBeLessThan(100);
    expect(out.holdingsMeta).toMatchObject({ offset: 0, limit: 100, kept: 101, totalInFile: 506, holdingsReadAt: H.fetchedAt, order: 'by weight', nextOffset: out.holdings.length });
    expect(out.holdingsMeta.budgetNote).toContain('to fit'); // any trim says so
    expect('budgetNote' in (fitHoldingsPage({ symbol: 'AOR' }, { ...page, lines: [line(1)] }, { offset: 0, limit: 100 }) as any).holdingsMeta).toBe(false);
    const small = fitHoldingsPage({ symbol: 'AOR' }, { ...page, lines: page.lines.slice(90).map((l, i) => line(91 + i)), offset: 90, limit: 10 }, { offset: 90, limit: 10 }) as any;
    expect(small.holdingsMeta).toMatchObject({ returned: 10, nextOffset: null });
  });
  it('no row fitting beside the base keeps nextOffset where it was and says why', () => {
    const page = { holdings: H, holdingsFetchedAt: H.fetchedAt, lines: [line(1), line(2)], offset: 40, limit: 2, notes: NOTES };
    const out = fitHoldingsPage({ symbol: 'AOR', description: 'D'.repeat(60000) }, page, { offset: 40, limit: 2 }) as any;
    expect(out.holdingsMeta).toMatchObject({ returned: 0, nextOffset: 40 });
    expect(out.holdingsMeta.budgetNote).toContain('without full=true');
  });
  it('a page read from another file than the etf block says so in its meta (review on the web: never one file\'s rows under another\'s summary)', () => {
    const page = { holdings: { ...H, total: 1, kept: 1 }, holdingsFetchedAt: '2026-10-12T07:00:00Z', lines: [line(1)], offset: 0, limit: 50, notes: NOTES };
    const out = fitHoldingsPage({ symbol: 'AOR' }, page, { offset: 0, limit: 50 }, H.fetchedAt) as any;
    expect(out.holdingsMeta).toMatchObject({ totalInFile: 1, holdingsReadAt: '2026-10-12T07:00:00Z' });
    expect(out.holdingsMeta.fileNote).toContain('a newer holdings file');
    // An older page (a cached read) beside a newer etf block says older, never newer.
    const older = fitHoldingsPage({ symbol: 'AOR' }, { ...page, holdingsFetchedAt: '2026-10-01T07:00:00Z' }, { offset: 0, limit: 50 }, H.fetchedAt) as any;
    expect(older.holdingsMeta.fileNote).toContain('an older holdings file');
    expect('fileNote' in (fitHoldingsPage({ symbol: 'AOR' }, { ...page, holdingsFetchedAt: H.fetchedAt }, { offset: 0, limit: 50 }, H.fetchedAt) as any).holdingsMeta).toBe(false);
  });
});

describe('get_company_profile with fund data', () => {
  const tool = (answers: Record<string, unknown>) => {
    let handler: any;
    const paths: string[] = [];
    register({ registerTool: (_n: string, _c: unknown, h: unknown) => { handler = h; } } as any, { get: async (p: string) => { paths.push(p); const a = answers[p]; if (a instanceof Error) throw a; return a ?? null; } } as any);
    return { paths, raw: async (args: Record<string, unknown>) => handler(args), call: async (args: Record<string, unknown>) => (await handler(args)).structuredContent };
  };
  it('a fund without a company profile answers with the etf block and profileStatus, full or not; both absent is no data', async () => {
    let t = tool({ '/etf-fund/AOR': VIEW() });
    const out = await t.call({ symbol: 'aor' });
    expect(out).toMatchObject({ symbol: 'AOR', profileStatus: 'No company profile on record for this symbol.' });
    expect(out.etf.holdingsBasis).toBe('countMismatch');
    expect((await t.call({ symbol: 'aor', full: true })).etf.holdingsBasis).toBe('countMismatch');
    t = tool({});
    expect((await t.call({ symbol: 'zzz' })).dataAvailable).toBe(false);
  });
  it('a failed fund read leaves the profile standing with etfStatus; a stock has no etf block', async () => {
    let t = tool({ '/company-profile/AAPL': { symbol: 'AAPL', company_name: 'Apple Inc.' }, '/etf-fund/AAPL': new Error('503') });
    let out = await t.call({ symbol: 'aapl' });
    expect(out.etfStatus).toBe('Fund data could not be read right now.');
    t = tool({ '/company-profile/AAPL': { symbol: 'AAPL', company_name: 'Apple Inc.' } });
    out = await t.call({ symbol: 'aapl' });
    expect('etf' in out).toBe(false);
    out = await t.call({ symbol: 'aapl', holdings: { offset: 0, limit: 50 } });
    expect(out.holdingsStatus).toBe('No fund holdings on record for this symbol.');
    expect(t.paths.some(p => p.startsWith('/etf-holdings/'))).toBe(false);
  });
  it('holdings {offset, limit} reads that page and answers with holdingsMeta', async () => {
    const t = tool({ '/etf-fund/AOR': VIEW(), '/etf-holdings/AOR?offset=0&limit=50': { holdings: H, holdingsFetchedAt: H.fetchedAt, lines: [line(1)], offset: 0, limit: 50, notes: NOTES } });
    const out = await t.call({ symbol: 'aor', holdings: { offset: 0, limit: 50 } });
    expect(t.paths).toContain('/etf-holdings/AOR?offset=0&limit=50');
    expect(out.holdingsMeta).toMatchObject({ offset: 0, limit: 50, returned: 1, kept: 101, nextOffset: 1 }); // more kept ranks remain
  });
  it('100 holdings at the widest values pass the real response guard untouched: the meta counts what is there', async () => {
    const wide = (rank: number) => line(rank, { name: 'N'.repeat(400), symbol: 'X', reportedTicker: 'X', linkBasis: 'name', matchKind: 'unconfirmed', linkWithheld: true, withheldNote: 'W'.repeat(300), splitWarnings: Array.from({ length: 3 }, (_, i) => ({ date: `2026-10-1${i}`, ratio: '2-for-1', note: 'x' })) });
    const t = tool({ '/etf-fund/AOR': VIEW({ lines: Array.from({ length: 25 }, (_, i) => wide(i + 1)) }), '/etf-holdings/AOR?offset=0&limit=100': { holdings: H, holdingsFetchedAt: H.fetchedAt, lines: Array.from({ length: 100 }, (_, i) => wide(i + 1)), offset: 0, limit: 100, notes: NOTES } });
    const out = await t.call({ symbol: 'aor', holdings: { offset: 0, limit: 100 } });
    expect(out.holdings.length).toBeGreaterThan(0);
    expect(out.holdings.some((r: any) => 'truncated' in r || '_truncated' in r)).toBe(false);
    expect(out.holdingsMeta.returned).toBe(out.holdings.length);
    expect(out.holdingsMeta.nextOffset).toBe(out.holdings.length);
    expect('topHoldings' in out.etf).toBe(false); // beside a page, the page is the list
  });
  it('no row fitting is said on the wire too, inside the budget: nextOffset stays, budgetNote delivered', async () => {
    const wide = (rank: number) => line(rank, { name: 'N'.repeat(400) });
    const answers = (desc: number, lines: unknown[]) => ({ '/company-profile/AOR': { symbol: 'AOR', company_name: 'X', description: 'D'.repeat(desc) }, '/etf-fund/AOR': VIEW(),
      '/etf-holdings/AOR?offset=0&limit=100': { holdings: H, holdingsFetchedAt: H.fetchedAt, lines, offset: 0, limit: 100, notes: NOTES } });
    // The answer around an empty page, then a description that leaves room for that answer and the note, not one row.
    const empty = await tool(answers(1000, [])).raw({ symbol: 'aor', full: true, holdings: { offset: 0, limit: 100 } });
    const fill = 1000 + (MAX_RESPONSE_BYTES - 2048) - Buffer.byteLength(empty.content[0].text) - 300;
    const res = await tool(answers(fill, [wide(1), wide(2)])).raw({ symbol: 'aor', full: true, holdings: { offset: 0, limit: 100 } });
    expect(Buffer.byteLength(res.content[0].text)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(res.content[0].text).not.toContain('"truncated"');
    expect(res.structuredContent.holdingsMeta).toMatchObject({ returned: 0, nextOffset: 0 });
    expect(res.structuredContent.holdingsMeta.budgetNote).toContain('without full=true');
  });
  it('a page answering a withheld or missing file takes the file group out of etf (facts stay); a failed page read says so', async () => {
    let t = tool({ '/etf-fund/AOR': VIEW(), '/etf-holdings/AOR?offset=0&limit=50': { holdings: { ...H, status: 'withheld' }, holdingsFetchedAt: null, lines: [], offset: 0, limit: 50, notes: { ...NOTES, fileWithheld: 'file note' } } });
    let out = await t.call({ symbol: 'aor', holdings: { offset: 0, limit: 50 } });
    expect(out.etf).toMatchObject({ holdingsStatus: 'withheld', holdingsNote: 'file note', facts: { issuer: 'iShares' } });
    for (const k of ['holdingsInFile', 'holdingsBasis', 'basisEvidence', 'basisNote', 'holdingsUpdated', 'holdingsReadAt', 'topHoldings', 'quantitiesNote']) expect(k in out.etf).toBe(false);
    expect('holdings' in out).toBe(false);
    t = tool({ '/etf-fund/AOR': VIEW() });
    out = await t.call({ symbol: 'aor', holdings: { offset: 0, limit: 50 } });
    expect(out.etf.holdingsStatus).toBe('No holdings file on record.');
    expect('topHoldings' in out.etf).toBe(false);
    t = tool({ '/etf-fund/AOR': VIEW(), '/etf-holdings/AOR?offset=0&limit=50': new Error('503') });
    out = await t.call({ symbol: 'aor', holdings: { offset: 0, limit: 50 } });
    expect(out.holdingsStatus).toBe('The holdings page could not be read right now.');
    expect(out.etf.holdingsInFile).toBe(506);
  });
  it('a page that withholds the facts or country weights takes them out of etf too, in both modes', async () => {
    const t = tool({ '/etf-fund/AOR': VIEW({ facts: { ...VIEW().facts, nav: 123 }, sectorWeights: [{ sector: 'Tech', weightPct: 50 }], countryWeights: [{ country: 'US', weightPct: 99 }] }),
      '/etf-holdings/AOR?offset=0&limit=50': { holdings: { ...H, status: 'withheld' }, holdingsFetchedAt: null, lines: [], offset: 0, limit: 50, notes: { ...NOTES, fileWithheld: 'file note', factsWithheld: 'facts note', countryWithheld: 'country note' } } });
    for (const full of [false, true]) {
      const out = await t.call({ symbol: 'aor', full, holdings: { offset: 0, limit: 50 } });
      expect(out.etf).toMatchObject({ factsStatus: 'withheld', factsNote: 'facts note', countryStatus: 'withheld', countryNote: 'country note', holdingsStatus: 'withheld' });
      for (const k of ['facts', 'sectorWeights', 'countryWeights', 'holdingsInFile', 'topHoldings']) expect(k in out.etf).toBe(false);
      expect(JSON.stringify(out)).not.toContain('123');
    }
    // An ok page withholding only the country weights: the file and facts stand, the country weights go.
    const t2 = tool({ '/etf-fund/AOR': VIEW({ countryWeights: [{ country: 'US', weightPct: 99 }] }), '/etf-holdings/AOR?offset=0&limit=50': { holdings: H, holdingsFetchedAt: H.fetchedAt, lines: [line(1)], offset: 0, limit: 50, notes: { ...NOTES, countryWithheld: 'country note' } } });
    const ok = await t2.call({ symbol: 'aor', holdings: { offset: 0, limit: 50 } });
    expect(ok.etf).toMatchObject({ countryStatus: 'withheld', facts: { issuer: 'iShares' }, holdingsInFile: 506 });
    expect('countryWeights' in ok.etf).toBe(false);
  });
  it('beside a page, etf.topHoldings is left out: the page lists the rows as its later read serves them', async () => {
    const t = tool({ '/etf-fund/AOR': VIEW({ lines: [line(1, { name: 'X CORP', symbol: 'X', reportedTicker: 'X', linkBasis: 'name', matchKind: 'security' })] }),
      '/etf-holdings/AOR?offset=0&limit=50': { holdings: H, holdingsFetchedAt: H.fetchedAt, lines: [line(1, { name: 'X CORP', reportedTicker: 'X', linkWithheld: true, withheldNote: 'withheld' })], offset: 0, limit: 50, notes: NOTES } });
    for (const full of [false, true]) {
      const out = await t.call({ symbol: 'aor', full, holdings: { offset: 0, limit: 50 } });
      expect('topHoldings' in out.etf).toBe(false);
      expect(out.etf.topHoldingsNote).toContain('holdings');
      expect(out.holdings[0]).toMatchObject({ symbol: null, linkWithheld: true });
      expect(JSON.stringify(out)).not.toContain('"symbol":"X"');
    }
  });
  it('each read stands apart in both directions: a profile outage keeps the fund block; a fund outage with no profile is not "no data"', async () => {
    let t = tool({ '/company-profile/AOR': new Error('HTTP 503'), '/etf-fund/AOR': VIEW() });
    for (const full of [false, true]) {
      const out = await t.call({ symbol: 'aor', full });
      expect(out).toMatchObject({ symbol: 'AOR', profileStatus: 'The company profile could not be read right now.' });
      expect(out.etf.holdingsBasis).toBe('countMismatch');
    }
    t = tool({ '/company-profile/AOR': new Error('HTTP 503') });
    expect((await t.raw({ symbol: 'aor' })).isError).toBe(true); // nothing else to show: the outage is the answer
    t = tool({ '/etf-fund/AOR': new Error('HTTP 503') });
    const out = await t.call({ symbol: 'aor' });
    expect(out).toMatchObject({ symbol: 'AOR', profileStatus: 'No company profile on record for this symbol.', etf: null, etfStatus: 'Fund data could not be read right now.' });
  });
  it('a long full=true answer still pages: the rows make room, never zero rows with nextOffset 0', async () => {
    const wide = (rank: number) => line(rank, { name: 'N'.repeat(400) });
    const t = tool({ '/company-profile/AOR': { symbol: 'AOR', company_name: 'X', description: 'D'.repeat(42000) }, '/etf-fund/AOR': VIEW({ lines: Array.from({ length: 25 }, (_, i) => wide(i + 1)) }), '/etf-holdings/AOR?offset=0&limit=100': { holdings: H, holdingsFetchedAt: H.fetchedAt, lines: Array.from({ length: 100 }, (_, i) => wide(i + 1)), offset: 0, limit: 100, notes: NOTES } });
    const res = await t.raw({ symbol: 'aor', full: true, holdings: { offset: 0, limit: 100 } });
    const out = res.structuredContent;
    expect(Buffer.byteLength(res.content[0].text)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(out.holdings.length).toBeGreaterThan(0);
    expect(out.holdingsMeta.returned).toBe(out.holdings.length);
    expect(out.holdingsMeta.nextOffset).toBe(out.holdings.length);
  });
});
