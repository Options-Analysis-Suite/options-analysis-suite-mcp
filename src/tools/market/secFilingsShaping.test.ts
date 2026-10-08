import { describe, expect, it } from 'bun:test';
import { shapeDealFlags, shapeMnaFilings, shapeSecFilingsResponse } from './secFilingsShaping.js';

describe('shapeSecFilingsResponse', () => {
  it('builds category summaries and preserves the most recent filing list', () => {
    const shaped = shapeSecFilingsResponse({
      symbol: 'AAPL',
      companyName: 'Apple Inc.',
      cik: '0000320193',
      filings: [
        {
          formType: '8-K',
          description: 'Current report',
          filingDate: '2026-03-25',
          accessionNumber: '0000320193-26-000111',
          primaryDocument: 'a8k.htm',
          url: 'https://www.sec.gov/example/a8k.htm',
        },
        {
          formType: '10-Q',
          description: 'Quarterly report',
          filingDate: '2026-01-30',
          accessionNumber: '0000320193-26-000050',
          primaryDocument: 'a10q.htm',
          url: 'https://www.sec.gov/example/a10q.htm',
        },
        {
          formType: '4',
          description: 'Statement of changes in beneficial ownership',
          filingDate: '2026-01-15',
          accessionNumber: '0000320193-26-000020',
          primaryDocument: 'a4.xml',
          url: 'https://www.sec.gov/example/a4.xml',
        },
        {
          formType: '10-K',
          description: 'Annual report',
          filingDate: '2025-11-01',
          accessionNumber: '0000320193-25-000999',
          primaryDocument: 'a10k.htm',
          url: 'https://www.sec.gov/example/a10k.htm',
        },
      ],
    }, 3) as Record<string, any>;

    expect(shaped.symbol).toBe('AAPL');
    expect(shaped.companyName).toBe('Apple Inc.');
    expect(shaped.summary.totalFilings).toBe(4);
    expect(shaped.summary.latestFormType).toBe('8-K');
    expect(shaped.summary.formCounts['10-Q']).toBe(1);
    expect(shaped.summary.filingCategories['Current report']).toBe(1);
    expect(shaped.latestByFilingCategory['Current report'].formType).toBe('8-K');
    expect(shaped.latestByFilingCategory['Quarterly report'].formType).toBe('10-Q');
    expect(shaped.latestByFilingCategory['Annual report'].formType).toBe('10-K');
    expect(shaped.recentFilings).toHaveLength(3);
    expect(shaped._recent_filings_meta).toEqual({ showing: 3, total: 4, truncated: true });
    expect(JSON.stringify(shaped)).not.toContain('categoryCounts');
    expect(JSON.stringify(shaped)).not.toContain('currentReport');
  });

  it('returns a stable empty summary when no filings are available', () => {
    const shaped = shapeSecFilingsResponse({
      symbol: 'UNKNOWN',
      companyName: null,
      cik: null,
      filings: [],
      message: 'Could not find CIK for symbol UNKNOWN.',
    }) as Record<string, any>;

    expect(shaped.symbol).toBe('UNKNOWN');
    expect(shaped.summary.totalFilings).toBe(0);
    expect(shaped.recentFilings).toEqual([]);
    expect(shaped.latestByFilingCategory).toEqual({});
    expect(String(shaped._filings_note)).toContain('Could not find CIK');
  });
});

describe('shapeDealFlags / shapeMnaFilings', () => {
  const S4 = {
    form: 'S-4', kind: 'merger', label: 'Merger filing', dateFiled: '2026-10-02', accession: '0001104659-26-113346',
    url: 'https://www.sec.gov/Archives/edgar/data/1538263/000110465926113346/0001104659-26-113346-index.htm',
    counterparties: [{ cik: 1538263, name: 'HomeTrust Bancshares, Inc.', tickers: ['HTB'] }], expiresOn: '2027-01-30',
  };

  it('names each flag by what it is, with its link, counterparties and lapse day, and the index date', () => {
    const out = shapeDealFlags({ asOf: '2026-10-02', flags: { merger: S4, offering: null } });
    expect(out).toEqual({
      dealFlags: {
        merger: {
          label: 'Merger filing', formType: 'S-4', filingDate: '2026-10-02', accessionNumber: '0001104659-26-113346', url: S4.url,
          counterparties: [{ name: 'HomeTrust Bancshares, Inc.', tickers: ['HTB'], cik: 1538263 }], flagUntil: '2027-01-30',
        },
        offering: null,
        windows: expect.stringContaining('within 120 days'),
        indexThrough: '2026-10-02',
      },
    });
    expect(String((out.dealFlags as any).windows)).toContain('may register debt as well as stock');
  });

  it('no filer on record (a fund) and a failed read each leave a note, never a guess', () => {
    expect(shapeDealFlags(null)).toEqual({ dealFlags: null, dealFlagsNote: expect.stringContaining('not in the company filer map') });
    expect(shapeDealFlags({ asOf: 'x' }, true)).toEqual({ dealFlags: null, dealFlagsNote: expect.stringContaining('unavailable') });
  });

  it('the market list keeps `limit` filings and says when it trimmed; an empty window says so', () => {
    const deal = (i: number) => ({ label: 'Merger filing', form: '425', dateFiled: '2026-10-02', accession: `a${i}`, url: `u${i}`, parties: [{ cik: i, name: `Co ${i}`, tickers: [] }] });
    const out = shapeMnaFilings({ days: 30, asOf: '2026-10-02', total: 386, deals: Array.from({ length: 200 }, (_, i) => deal(i)) }, 10);
    expect(out).toMatchObject({ scope: 'market', days: 30, indexThrough: '2026-10-02', totalFilings: 386, filingsMeta: { showing: 10, total: 386, truncated: true } });
    expect((out.filings as any[])[0]).toEqual({ label: 'Merger filing', formType: '425', filingDate: '2026-10-02', accessionNumber: 'a0', url: 'u0', parties: [{ name: 'Co 0', tickers: [], cik: 0 }] });
    const all = shapeMnaFilings({ days: 7, asOf: '2026-10-02', total: 2, deals: [deal(1), deal(2)] }, 10);
    expect(all.filingsMeta).toBeUndefined();
    expect(shapeMnaFilings({ days: 7, asOf: null, total: 0, deals: [] }, 10)).toMatchObject({ totalFilings: 0, filings: [], filingsNote: expect.stringContaining('No merger') });
  });
});
