import { describe, expect, it } from 'bun:test';
import { shapeCotMarket, shapeCotSymbol } from './cotShaping.js';

// Vendor names in base64: the public mirror ships this file.
const VENDOR = new RegExp(Buffer.from('Zm1wfG9yYXRzfHN1cGFiYXNl', 'base64').toString('utf8'), 'i');

const sym = (n: number) => ({
  root: 'ES', market: { code: '13874+', kind: 'tff', label: 'S&P 500 Consolidated', sector: 'equity-index', name: 'S&P 500 Consolidated - CHICAGO MERCANTILE EXCHANGE', units: '(S&P 500 INDEX X $50.00)' },
  note: 'n', reportDate: '2026-09-29', firstSeenAt: '2026-10-03T10:20:00Z', openInterest: 2000, changeOpenInterest: 10,
  speculative: { group: 'leveragedFunds', label: 'Leveraged funds', long: 1, short: 3, spread: null, net: -2, side: 'short', netChange: null, percentOfOi: -0.1 },
  groups: [{ key: 'leveragedFunds', label: 'Leveraged funds', long: 1, short: 3, spread: null, net: -2, netChange: null, percentOfOi: -0.1 }],
  range: { reading: null, low: -2, high: -2, windowStart: '2026-08-11', windowEnd: '2026-09-29', observations: n },
  history: Array.from({ length: n }, (_, i) => ({ reportDate: `2026-08-${String(11 + i).padStart(2, '0')}`, speculativeNet: -i, openInterest: 2000 })),
  source: 'CFTC Commitments of Traders (futures only)', releaseNote: 'r', groupNote: 'g', spreadNote: 's', rangeNote: 'x',
});

describe('the COT shaping', () => {
  it('a first sync holds 8 reports: returned is the actual length, limit 13', () => {
    const out = shapeCotSymbol(sym(8)) as any;
    expect(out.historyMeta).toMatchObject({ limit: 13, returned: 8, reportsInWindow: 8, window: { start: '2026-08-11', end: '2026-09-29' } });
    expect(out.history).toHaveLength(8);
    expect(out.reportDate).toBe('2026-09-29');
    expect(out.familyNote).toBe('n');
    expect(out.cotNote).toContain('as of');
    expect(JSON.stringify(out)).not.toMatch(VENDOR);
  });

  it('a long history is cut to the 13 newest', () => {
    const out = shapeCotSymbol(sym(30)) as any;
    expect(out.historyMeta).toMatchObject({ limit: 13, returned: 13, reportsInWindow: 30 });
    expect(out.history[12].reportDate).toBe(sym(30).history[29].reportDate);
    expect(out.history[0].reportDate).toBe(sym(30).history[17].reportDate);
  });

  it('no data answers with a status, not an error', () => {
    expect(shapeCotSymbol(null)).toEqual({ cotStatus: 'No CFTC positioning on record for this contract.' });
    expect(shapeCotMarket(null)).toEqual({ cotStatus: 'No CFTC positioning on record yet.' });
  });

  it('the market list keeps each row`s report date, filters by sector, keeps the route`s order', () => {
    const res = { asOf: '2026-10-06', source: 'CFTC', releaseNote: 'r', groupNote: 'g', rangeNote: 'x', markets: [
      { code: 'a', kind: 'tff', label: 'Euro FX', sector: 'fx', roots: ['6E'], reportDate: '2026-09-29', units: 'u', speculativeNet: -1, side: 'short', netChange: 1, percentOfOi: 1, range: { reading: 95, low: 0, high: 1, windowStart: null, windowEnd: null, observations: 60 } },
      { code: 'b', kind: 'disaggregated', label: 'Gold', sector: 'metals', roots: ['GC'], reportDate: '2026-10-06', units: 'u', speculativeNet: 1, side: 'long', netChange: 1, percentOfOi: 1, range: { reading: 5, low: 0, high: 1, windowStart: null, windowEnd: null, observations: 60 } },
    ] };
    const all = shapeCotMarket(res) as any;
    expect(all.markets.map((m: any) => [m.label, m.reportDate])).toEqual([['Euro FX', '2026-09-29'], ['Gold', '2026-10-06']]);
    expect(all.asOfNote).toContain('newest report on file');
    expect((shapeCotMarket(res, { sector: 'metals' }) as any).markets.map((m: any) => m.label)).toEqual(['Gold']);
  });
});
