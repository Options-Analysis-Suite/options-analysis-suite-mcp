import { describe, expect, it } from 'bun:test';
import { shapeSecFilingsResponse } from './secFilingsShaping.js';

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
