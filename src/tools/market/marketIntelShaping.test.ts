import { describe, expect, test } from 'bun:test';
import {
  capChangeOver,
  esgWithheldNotes,
  groupSectorRows,
  READ_FAILED,
  shapeEsg,
  shapeSectorHistory,
  shapeSectorMetrics,
  shapeValuation,
  shapeVixTermStructure,
} from './marketIntelShaping.js';

// The proxy's /market/vix-term-structure on 2026-10-02 (local proxy), VIX6M
// moved a day back to stand for a tenor that did not close on asOf.
const VIX = {
  asOf: '2026-10-02',
  shape: 'contango',
  shapeTenors: ['VIX9D', 'VIX', 'VIX3M'],
  curve: [
    { symbol: 'VIX1D', horizon: '1 day', days: 1, close: 10.76, date: '2026-10-02', previousClose: 13.85, change: -3.09, changePct: -22.31 },
    { symbol: 'VIX9D', horizon: '9 days', days: 9, close: 12.06, date: '2026-10-02', previousClose: 14, change: -1.94, changePct: -13.86 },
    { symbol: 'VIX', horizon: '30 days', days: 30, close: 15.31, date: '2026-10-02', previousClose: 16.39, change: -1.08, changePct: -6.59 },
    { symbol: 'VIX3M', horizon: '3 months', days: 93, close: 18.01, date: '2026-10-02', previousClose: 18.58, change: -0.57, changePct: -3.07 },
    { symbol: 'VIX6M', horizon: '6 months', days: 183, close: 20.52, date: '2026-10-01', previousClose: 20.4, change: 0.12, changePct: 0.59 },
  ],
  vvix: { close: 87.02, date: '2026-10-02', previousClose: 92.01, change: -4.99, changePct: -5.42 },
};

describe('shapeVixTermStructure', () => {
  test('the curve by index, the shape as the proxy read it, and the ratios on asOf', () => {
    const out = shapeVixTermStructure(VIX) as any;
    expect(out.view).toBe('volatility');
    expect(out.asOf).toBe('2026-10-02');
    expect(out.shape).toBe('contango');
    expect(out.shapeTenors).toEqual(['VIX9D', 'VIX', 'VIX3M']);
    expect(out.curve.map((c: any) => c.index)).toEqual(['VIX1D', 'VIX9D', 'VIX', 'VIX3M', 'VIX6M']);
    expect(out.curve[2]).toEqual({ index: 'VIX', horizon: '30 days', horizonDays: 30, close: 15.31, date: '2026-10-02', previousClose: 16.39, change: -1.08, changePct: -6.59 });
    expect(out.ratios).toEqual({ vixToVix3m: 0.8501, vix9dToVix: 0.7877 });
    expect(out.vvix).toEqual({ close: 87.02, date: '2026-10-02', previousClose: 92.01, change: -4.99, changePct: -5.42 });
    expect(out.volatilityNote).toContain('VIX1D moves with each day');
  });

  test('a tenor whose newest close is older than asOf is stale and gives no ratio', () => {
    const out = shapeVixTermStructure(VIX) as any;
    expect(out.curve[4].stale).toBe(true);
    expect(out.curve.slice(0, 4).every((c: any) => !('stale' in c))).toBe(true);
    const stale3m = shapeVixTermStructure({ ...VIX, curve: VIX.curve.map(c => (c.symbol === 'VIX3M' ? { ...c, date: '2026-09-30' } : c)) }) as any;
    expect(stale3m.ratios).toEqual({ vixToVix3m: null, vix9dToVix: 0.7877 });
    const staleVvix = shapeVixTermStructure({ ...VIX, vvix: { ...VIX.vvix, date: '2026-10-01' } }) as any;
    expect(staleVvix.vvix.stale).toBe(true);
  });

  test('an index with no close and a missing VVIX are nulls, never numbers', () => {
    const out = shapeVixTermStructure({
      ...VIX,
      curve: VIX.curve.map(c => (c.symbol === 'VIX' ? { ...c, close: null, date: null, previousClose: null, change: null, changePct: null } : c)),
      vvix: null,
    }) as any;
    expect(out.curve[2]).toEqual({ index: 'VIX', horizon: '30 days', horizonDays: 30, close: null, date: null, previousClose: null, change: null, changePct: null });
    expect(out.ratios).toEqual({ vixToVix3m: null, vix9dToVix: null });
    expect(out.vvix).toBeNull();
  });

  test('nothing on record (a 404) says so', () => {
    expect(shapeVixTermStructure(null)).toEqual({ view: 'volatility', dataAvailable: false, message: 'No VIX term structure on record.' });
  });
});

const SECTORS = {
  kind: 'sector',
  date: '2026-10-02',
  rows: [
    { name: 'Basic Materials', exchange: 'AMEX', pe: 15.9652382772302, changePct: 0.0154735804877681 },
    { name: 'Basic Materials', exchange: 'NASDAQ', pe: 23.7689040184272, changePct: 1.20573996682507 },
    { name: 'Technology', exchange: 'NASDAQ', pe: 48.8012, changePct: -0.3961 },
    { name: 'Technology', exchange: 'NYSE', pe: 42.4977, changePct: 0.8549 },
    { name: 'Utilities', exchange: 'NYSE', pe: null, changePct: 0.1 },
  ],
};

describe('sector metrics', () => {
  test('rows group by name with one entry per exchange, rounded', () => {
    expect(groupSectorRows(SECTORS.rows)).toEqual([
      { name: 'Basic Materials', byExchange: { AMEX: { pe: 15.97, changePct: 0.015 }, NASDAQ: { pe: 23.77, changePct: 1.206 } } },
      { name: 'Technology', byExchange: { NASDAQ: { pe: 48.8, changePct: -0.396 }, NYSE: { pe: 42.5, changePct: 0.855 } } },
      { name: 'Utilities', byExchange: { NYSE: { pe: null, changePct: 0.1 } } },
    ]);
  });

  test('a P/E under 1 keeps three significant digits, never rounding to 0', () => {
    // Live run 2026-10-04: NASDAQ Agricultural Inputs is stored at 0.00049483 and read 0.
    expect(groupSectorRows([{ name: 'Agricultural Inputs', exchange: 'NASDAQ', pe: 0.00049482863310975, changePct: 0.375 }, { name: 'Real Estate - Development', exchange: 'NASDAQ', pe: 0.1534, changePct: 0 }]))
      .toEqual([
        { name: 'Agricultural Inputs', byExchange: { NASDAQ: { pe: 0.000495, changePct: 0.375 } } },
        { name: 'Real Estate - Development', byExchange: { NASDAQ: { pe: 0.153, changePct: 0 } } },
      ]);
    expect(shapeSectorHistory({ series: [{ date: '2026-10-02', pe: 0.00049482863310975, changePct: 0 }] })).toEqual([{ date: '2026-10-02', pe: 0.000495, changePct: 0 }]);
  });

  test('an exchange filter keeps that exchange alone and drops groups not on it', () => {
    expect(groupSectorRows(SECTORS.rows, 'NYSE').map(g => [g.name, Object.keys(g.byExchange)])).toEqual([
      ['Technology', ['NYSE']],
      ['Utilities', ['NYSE']],
    ]);
  });

  test('the whole day, with its date and kind', () => {
    const { shaped, group } = shapeSectorMetrics(SECTORS, { kind: 'sector' });
    expect(group).toBeNull();
    expect(shaped).toMatchObject({ view: 'sectors', kind: 'sector', date: '2026-10-02' });
    expect((shaped.groups as unknown[]).length).toBe(3);
    expect(shaped.sectorsNote).toContain('NYSE, NASDAQ and AMEX only');
    expect('exchange' in shaped).toBe(false);
    expect(shapeSectorMetrics(SECTORS, { kind: 'sector', exchange: 'NASDAQ' }).shaped.exchange).toBe('NASDAQ');
  });

  test('a group by name in any case returns that group and the exchanges to read its history on', () => {
    const { shaped, group } = shapeSectorMetrics(SECTORS, { kind: 'sector', group: ' technology ' });
    expect(group).toEqual({ name: 'Technology', exchanges: ['NASDAQ', 'NYSE'] });
    expect(shaped.group).toEqual({ name: 'Technology', byExchange: { NASDAQ: { pe: 48.8, changePct: -0.396 }, NYSE: { pe: 42.5, changePct: 0.855 } } });
    expect('groups' in shaped).toBe(false);
    // With an exchange, only that exchange's history is read.
    expect(shapeSectorMetrics(SECTORS, { kind: 'sector', group: 'Technology', exchange: 'NYSE' }).group).toEqual({ name: 'Technology', exchanges: ['NYSE'] });
  });

  test('a name not on record returns the day\'s groups and says so', () => {
    const { shaped, group } = shapeSectorMetrics(SECTORS, { kind: 'industry', group: 'Tech' });
    expect(group).toBeNull();
    expect((shaped.groups as unknown[]).length).toBe(3);
    expect(shaped.groupNote).toBe('No industry named "Tech" on record for 2026-10-02; `groups` lists the industries on record that day.');
    // A group on another exchange than the one asked is not on record there.
    const off = shapeSectorMetrics(SECTORS, { kind: 'sector', group: 'Basic Materials', exchange: 'NYSE' });
    expect(off.group).toBeNull();
    expect(off.shaped.groupNote).toBe('No sector named "Basic Materials" on the NYSE on record for 2026-10-02; `groups` lists the sectors on record that day.');
  });

  test('nothing on record (a 404) says so', () => {
    expect(shapeSectorMetrics(null, { kind: 'industry' }).shaped).toEqual({ view: 'sectors', kind: 'industry', dataAvailable: false, message: 'No industry metrics on record.' });
  });

  test('a history series is rounded, oldest first as read; none on record or a failed read is null', () => {
    expect(shapeSectorHistory({ series: [{ date: '2026-10-01', pe: 41.8912, changePct: 0.53312 }, { date: '2026-10-02', pe: 42.4977, changePct: null }] }))
      .toEqual([{ date: '2026-10-01', pe: 41.89, changePct: 0.533 }, { date: '2026-10-02', pe: 42.5, changePct: null }]);
    expect(shapeSectorHistory(null)).toBeNull();
    expect(shapeSectorHistory(READ_FAILED)).toBeNull();
  });
});

describe('capChangeOver', () => {
  const weekly = (from: string, weeks: number, cap: (i: number) => number) => Array.from({ length: weeks }, (_, i) => ({
    date: new Date(Date.parse(`${from}T00:00:00Z`) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    cap: cap(i),
  }));

  test('the change from the first point on or after the target', () => {
    const series = weekly('2025-01-03', 60, i => 100 + i);
    // Last 2026-02-20 (cap 159); a year back is 2025-02-20, the first point on or after it 2025-02-21 (cap 107).
    expect(capChangeOver(series, 365)).toBeCloseTo((159 / 107 - 1) * 100, 10);
  });

  test('null when the first point after the target is more than two weeks past it', () => {
    // A year before 2026-02-20 is 2025-02-20. History starting 15 days after
    // it would give a shorter change, not a year's; 14 days after still counts.
    expect(capChangeOver([{ date: '2025-03-07', cap: 100 }, { date: '2026-02-20', cap: 110 }], 365)).toBeNull();
    expect(capChangeOver([{ date: '2025-03-06', cap: 100 }, { date: '2026-02-20', cap: 110 }], 365)).toBeCloseTo(10, 10);
    // A point on the target itself is the base.
    expect(capChangeOver([{ date: '2025-02-20', cap: 100 }, { date: '2026-02-20', cap: 120 }], 365)).toBeCloseTo(20, 10);
  });

  test('null with fewer than two points, a target at the last point, or a zero base', () => {
    expect(capChangeOver([{ date: '2026-10-02', cap: 5 }], 365)).toBeNull();
    expect(capChangeOver([{ date: '2026-09-25', cap: 5 }, { date: '2026-10-02', cap: 6 }], 1)).toBeNull();
    expect(capChangeOver([{ date: '2025-10-03', cap: 0 }, { date: '2026-10-02', cap: 6 }], 365)).toBeNull();
  });
});

describe('shapeValuation', () => {
  const FUND = { ratios_ttm: { priceToEarningsRatioTTM: 38.0912 } };
  const PROFILE = { exchange_short: 'nasdaq', sector: 'Technology', industry: 'Consumer Electronics' };
  const SECT = { kind: 'sector', date: '2026-10-02', rows: [{ name: 'Technology', exchange: 'NASDAQ', pe: 48.8 }, { name: 'Technology', exchange: 'NYSE', pe: 42.5 }] };
  const IND = { kind: 'industry', date: '2026-10-01', rows: [{ name: 'Consumer Electronics', exchange: 'NASDAQ', pe: 38.23 }] };
  const CAP = { points: [['2021-10-08', 2.34e12], ['2025-10-03', 3.8e12], ['2026-10-02', 4.9e12]] as Array<[string, number]>, latest: null };

  test('the P/E against each group on the company\'s exchange, each with its own day', () => {
    const v = shapeValuation(FUND, PROFILE, SECT, IND, CAP) as any;
    expect(v.peTtm).toBe(38.09);
    expect(v.peers).toEqual({
      exchange: 'NASDAQ',
      sector: { name: 'Technology', pe: 48.8, premiumPct: -21.9, asOf: '2026-10-02' },
      industry: { name: 'Consumer Electronics', pe: 38.23, premiumPct: -0.4, asOf: '2026-10-01' },
    });
    expect('peersNote' in v).toBe(false);
    expect(v.note).toContain('premiumPct');
    // Live run 2026-10-04: `since` went unexplained, and companyProfile.peRatioTtm (38.03) sat beside peTtm (38.09).
    expect(v.note).toContain('`since` is the first point on file');
    expect(v.note).toContain('companyProfile.peRatioTtm');
    // Live test #4: TSM's companyProfile.marketCap (2452064014400) sat beside marketCap.latest (2452026192000), both the
    // 2026-10-02 session; the profile's figure stands in only for a newer session, and the note now says so.
    expect(v.note).toContain('The profile\'s market cap stands in as `latest` only for a newer session than the last weekly point.');
    expect(v.note).toContain(' `companyProfile.peRatioTtm` and `companyProfile.marketCap` are the profile\'s own figures, from another source and refresh, so they can differ from `peTtm` and from `marketCap.latest` on the same session, at times by a few percent.');
    // Live test #6: BABA's profile market cap sat 2.7% from `latest` on the same session; "a little" understated it.
    expect(v.note).not.toContain('a little');
    // Live test #5: full=true carries no companyProfile, so its note does not describe one.
    const full = shapeValuation(FUND, PROFILE, SECT, IND, CAP, 'full') as any;
    expect(full.note).not.toContain('companyProfile');
    expect(full.note).toContain('The profile\'s market cap stands in as `latest` only for a newer session than the last weekly point.');
    expect(full.note).toBe(v.note.slice(0, full.note.length));
  });

  test('the market cap: the latest point, and changes over one and five years', () => {
    const v = shapeValuation(FUND, PROFILE, SECT, IND, CAP) as any;
    expect(v.marketCap).toEqual({ latest: 4.9e12, date: '2026-10-02', change1yPct: 28.9, change5yPct: 109.4, since: '2021-10-08' });
    // The day's profile value, when the route has one, is the latest.
    const withLatest = shapeValuation(FUND, PROFILE, SECT, IND, { ...CAP, latest: { date: '2026-10-05', marketCap: 5e12 } }) as any;
    expect(withLatest.marketCap).toMatchObject({ latest: 5e12, date: '2026-10-05' });
  });

  test('no positive P/E, no exchange, or an exchange without groups: no comparison, and why', () => {
    // review: the note said why a P/E is missing ("no earnings, or a loss"), which the data does not say.
    expect(shapeValuation({ ratios_ttm: { priceToEarningsRatioTTM: -6.5 } }, PROFILE, SECT, IND, CAP)).toMatchObject({ peTtm: -6.5, peers: null, peersNote: 'The trailing P/E is not positive, so no peer comparison.' });
    expect(shapeValuation({ ratios_ttm: { priceToEarningsRatioTTM: 0 } }, PROFILE, SECT, IND, CAP)).toMatchObject({ peTtm: 0, peers: null, peersNote: 'The trailing P/E is not positive, so no peer comparison.' });
    expect(shapeValuation({ ratios_ttm: {} }, PROFILE, SECT, IND, CAP)).toMatchObject({ peTtm: null, peers: null, peersNote: 'No trailing P/E on record, so no peer comparison.' });
    expect(shapeValuation(FUND, { ...PROFILE, exchange_short: null }, SECT, IND, CAP)).toMatchObject({ peers: null, peersNote: 'No listing exchange on record, so no peer comparison.' });
    expect(shapeValuation(FUND, { ...PROFILE, exchange_short: 'OTC' }, SECT, IND, CAP)).toMatchObject({ peers: null, peersNote: 'Lists on OTC; group P/E is kept for the NYSE, NASDAQ and AMEX only.' });
  });

  test('a group P/E under 1 is shown as stored, not rounded to 0', () => {
    const v = shapeValuation(FUND, PROFILE, SECT, { ...IND, rows: [{ name: 'Consumer Electronics', exchange: 'NASDAQ', pe: 0.00049482863310975 }] }, CAP) as any;
    expect(v.peers.industry.pe).toBe(0.000495);
  });

  test('a group with no row or no positive P/E is null; neither is no comparison', () => {
    const v = shapeValuation(FUND, PROFILE, SECT, { ...IND, rows: [{ name: 'Consumer Electronics', exchange: 'NASDAQ', pe: -3 }] }, CAP) as any;
    expect(v.peers.industry).toBeNull();
    expect(v.peers.sector.name).toBe('Technology');
    expect(shapeValuation(FUND, { ...PROFILE, sector: 'Energy', industry: 'Oil' }, SECT, IND, CAP)).toMatchObject({ peers: null, peersNote: 'No sector or industry P/E on record for the company\'s groups on its exchange.' });
    expect(shapeValuation(FUND, PROFILE, null, null, CAP)).toMatchObject({ peers: null, peersNote: 'No sector or industry P/E on record for the company\'s groups on its exchange.' });
  });

  test('a failed group read is said, as against nothing on record', () => {
    const one = shapeValuation(FUND, PROFILE, READ_FAILED, IND, CAP) as any;
    expect(one.peers.sector).toBeNull();
    expect(one.peers.industry.name).toBe('Consumer Electronics');
    expect(one.peersNote).toBe('Part of the group P/E was unavailable on this call.');
    expect(shapeValuation(FUND, PROFILE, READ_FAILED, READ_FAILED, CAP)).toMatchObject({ peers: null, peersNote: 'Sector and industry P/E were unavailable on this call.' });
  });

  test('a failed profile read is said, not read as a company with no exchange', () => {
    // review: a profile 503 became "No listing exchange on record".
    expect(shapeValuation(FUND, READ_FAILED, SECT, IND, CAP)).toMatchObject({ peers: null, peersNote: 'The company profile was unavailable on this call, so no peer comparison.' });
  });

  test('market-cap history missing or unavailable is null with a note', () => {
    expect(shapeValuation(FUND, PROFILE, SECT, IND, null)).toMatchObject({ marketCap: null, marketCapNote: 'No market-cap history on record.' });
    expect(shapeValuation(FUND, PROFILE, SECT, IND, READ_FAILED)).toMatchObject({ marketCap: null, marketCapNote: 'Market-cap history was unavailable on this call.' });
  });
});

describe('shapeEsg', () => {
  const AAPL = {
    symbol: 'AAPL',
    disclosure: { url: 'https://www.sec.gov/x-index.htm', date: '2026-06-27', esgScore: 59.03, formType: '10-Q', socialScore: 47.36, acceptedDate: '2026-07-31', governanceScore: 61.32, environmentalScore: 68.41 },
    rating: { rating: 'B', industry: 'CONSUMER ELECTRONICS', fiscalYear: 2025, industryRank: '19 out of 21' },
    withheld: { disclosure: null, rating: null },
  };

  test('the scores with their filing, and the risk rating', () => {
    expect(shapeEsg(AAPL)).toEqual({
      esg: {
        disclosure: {
          esgScore: 59.03, environmentalScore: 68.41, socialScore: 47.36, governanceScore: 61.32, scale: '0 to 100',
          formType: '10-Q', periodEnded: '2026-06-27', filingDate: '2026-07-31', filingUrl: 'https://www.sec.gov/x-index.htm',
        },
        riskRating: { rating: 'B', fiscalYear: 2025, industry: 'CONSUMER ELECTRONICS', industryRank: '19 out of 21' },
      },
    });
  });

  test('what the route withheld is named, never shown as current', () => {
    const ltm = shapeEsg({ disclosure: null, rating: null, withheld: { disclosure: { reason: 'stale', date: '2014-06-30' }, rating: { reason: 'stale', fiscalYear: 2012 } } });
    expect(ltm.esg).toEqual({
      disclosure: null,
      riskRating: null,
      withheld: [
        'The latest ESG disclosure on file is for the period ended 2014-06-30, over two years ago, so its scores are not shown.',
        'The latest ESG risk rating on file is for fiscal 2012, more than two years back, so it is not shown.',
      ],
    });
    expect(esgWithheldNotes({ disclosure: { reason: 'placeholder', date: '2026-03-31' }, rating: null }))
      .toEqual(['The latest ESG disclosure on file (period ended 2026-03-31) carries placeholder scores, all four exactly 50, so they are not shown.']);
    expect(esgWithheldNotes(undefined)).toEqual([]);
  });

  test('nothing on record (a 404) and a failed read are told apart', () => {
    expect(shapeEsg(null)).toEqual({ esg: null, esgNote: 'No ESG data on record for this symbol.' });
    expect(shapeEsg(READ_FAILED)).toEqual({ esg: null, esgNote: 'ESG data was unavailable on this call.' });
  });
});
