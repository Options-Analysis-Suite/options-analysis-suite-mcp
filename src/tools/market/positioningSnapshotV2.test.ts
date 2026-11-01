import { describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { LiveApiClient } from '../../proxy/liveApiClient.js';
import { register as registerEod } from './eodDealerPositioning.js';
import { register as registerSnapshot } from './optionsSnapshot.js';

// Greek exposure
// methodology v2: get_dealer_positioning and get_options_snapshot answer the assumed dealer book only, through the proxy's
// opt-ins (/eod/exposure and /scanner/metrics/batch `exposure=v2`) and the single snapshot's always-present block.

type Answer = (path: string, params?: Record<string, string>) => unknown | Promise<unknown>;

async function call(tool: 'get_dealer_positioning' | 'get_options_snapshot', answer: Answer, args: Record<string, unknown>) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const server = new McpServer({ name: 'u10-g3', version: '1' });
  const client = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ path, params });
      return structuredClone(await answer(path, params));
    },
  } as unknown as LiveApiClient;
  if (tool === 'get_dealer_positioning') registerEod(server, client); else registerSnapshot(server, client);
  const reader = new Client({ name: 'u10-g3-reader', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), reader.connect(a)]);
  try {
    const result = await reader.callTool({ name: tool, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    let out: Record<string, any> = {};
    try { out = JSON.parse(text); } catch { /* an error's text */ }
    return { isError: result.isError === true, text, out, calls, routeCalls: calls };
  } finally {
    await reader.close();
    await server.close();
  }
}

const METRICS = ['gamma', 'delta', 'vega', 'vanna', 'charm', 'vomma'] as const;
const side = (gex: number, vega: number, vanna: number, charm: number, vomma: number) => ({ gex, dex: 0, vega, vanna, charmFixedRef: charm, rollBasis: 0, charm, vomma });
const coverage = (over: Partial<Record<(typeof METRICS)[number], [number, number]>> = {}) => Object.fromEntries(METRICS.map((m) => {
  const [included, total] = over[m] ?? [4, 4];
  return [m, { included, total }];
}));
const wire = (over: Partial<Record<(typeof METRICS)[number], [number, number]>> = {}, call = side(3000, 70, 50, 30, 20), put = side(1000, 10, -20, -60, 90), dexBalance = -12345.5) => ({ call, put, coverage: coverage(over), dexBalance });
const day = (over: Record<string, unknown> = {}) => ({
  available: true, provenance: 'nightly', referenceKind: 'spot', roll: { status: 'notApplicable', carry: null },
  bases: wire(), definition: 'expiry-scoped', expiryQualifier: null, ...over,
});

// the proxy's buildEodExposureResponse body (packages/shared/src/data/eodExposure.ts), SPY 2026-09-29's numbers
const legacyEod = () => ({
  schemaVersion: 1, symbol: 'SPY', date: '2026-10-23', asOf: '2026-10-23T21:40:00Z', source: 'eod_options_snapshot',
  dteWindow: { minDte: 0, maxDte: 60, unit: 'calendar_days' }, spotPrice: 764.03, netGex: -10894620007, netDex: 16246461968,
  gammaMagnet: 761, gammaFlip: 771.58, callWall: 765, putWall: 760, dealerRegime: 'negative_gamma',
  expectedMovePct30d: 0.0388, expectedMove30d: 29.66, topContributingStrikes: [{ strike: 765, netGex: -1597560842.5, netDex: 1234.5 }], topContributingStrikesLimit: 10,
  units: { netGex: 'USD per 1% move', netDex: 'USD' },
  sincePriorSession: {
    status: 'found', priorDate: '2026-10-22', sessionsSkipped: 0, dealerRegimeChanged: false,
    prior: { spotPrice: 765.54, netGex: -8801431612, netDex: 11348727140, gammaFlip: 772.75, callWall: 785, putWall: 765, gammaMagnet: 765, dealerRegime: 'negative_gamma' },
    change: { spotPrice: -1.51, netGex: -2093188395, netDex: 4897734828, gammaFlip: -1.17, callWall: -20, putWall: 0, gammaMagnet: -4 },
  },
});
const v2Eod = (session: unknown = day(), prior: unknown = { status: 'found', priorDate: '2026-10-21', sessionsSkipped: 1, prior: day({ bases: wire({}, side(2500, 70, 50, 30, 20)) }) }) => {
  const body: any = legacyEod();
  body.exposureV2 = session;
  body.sincePriorSession.exposureV2 = prior;
  return body;
};
/** The answer with every `levels` object removed: what must carry no earlier total */
function withoutLevels(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutLevels);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'levels').map(([key, v]) => [key, withoutLevels(v)]));
}

describe('get_dealer_positioning: the assumed dealer book only', () => {
  test('the session\'s book in `exposures`, the 0-60 day levels unlabeled, each prior its own, no label', async () => {
    const { out, text, routeCalls } = await call('get_dealer_positioning', () => v2Eod(), { symbol: 'spy' });
    expect(routeCalls).toEqual([{ path: '/eod/exposure/SPY', params: { exposure: 'v2' } }]);
    expect(out).toMatchObject({ date: '2026-10-23' });
    for (const key of LABELS) expect(out).not.toHaveProperty(key);
    expect(out.exposures).toEqual({
      scope: 'every expiration after the session',
      gex: 2000, vegaExposure: 60, vanna: 70, charmFlow: -90, vomma: -70,
      longOi: { gex: 4000, vegaExposure: 80, vanna: 30, charmFlow: 30, vomma: 110 },
      putMinusCallDeltaBalance: -12345.5, referenceKind: 'spot', charmBasis: 'cash',
    });
    expect(out.levels).not.toHaveProperty('methodology');
    expect(out.levels).toMatchObject({ window: { minDte: 0, maxDte: 60 }, gammaFlip: 771.58, callWall: 765, putWall: 760, gammaMagnet: 761, dealerRegime: 'negative_gamma' });
    expect(out.levels.topContributingStrikes[0]).toMatchObject({ strike: 765, netGex: -1597560842.5 });
    expect(out.levels.topContributingStrikesUnits).toEqual({ netGex: 'USD per 1% move', netDex: 'USD' });
    expect(out.sincePriorSession.levels).toEqual({
      status: 'found', priorDate: '2026-10-22', sessionsSkipped: 0, dealerRegimeChanged: false,
      prior: { spotPrice: 765.54, gammaFlip: 772.75, callWall: 785, putWall: 765, gammaMagnet: 765, dealerRegime: 'negative_gamma' },
      change: { spotPrice: -1.51, gammaFlip: -1.17, callWall: -20, putWall: 0, gammaMagnet: -4 },
    });
    expect(out.sincePriorSession.exposures).toMatchObject({ status: 'found', priorDate: '2026-10-21', sessionsSkipped: 1, prior: { gex: 1500 }, change: { gex: 500, vegaExposure: 0, charmFlow: 0, putMinusCallDeltaBalance: 0 } });
    expect(out.sincePriorSession.exposures.change).not.toHaveProperty('charmBasisChanged');
    // no earlier total outside `levels`, and the note key reaches the wire
    expect(JSON.stringify(withoutLevels(out))).not.toMatch(/"net(Gex|Dex|Gamma|Vega|Vanna|Charm|Vomma)"/);
    expect(out.bookNote).toMatch(/^`exposures` is the assumed dealer book.*Here `exposures` cover the scope `exposures\.scope` states/s);
    expect(text).not.toMatch(/scan_strikes|compute_run|exposureV2/);
    expect(text).not.toMatch(NAMED_A_METHOD);
  });

  test('the charm-flow change is withheld across a change of charm basis; an unavailable side gives null changes', async () => {
    const forward = (status: string) => day({ referenceKind: 'forward', roll: { status, carry: status === 'fitted' ? 0.04 : null } });
    const basis = await call('get_dealer_positioning', () => v2Eod(forward('fitted'), { status: 'found', priorDate: '2026-10-22', sessionsSkipped: 0, prior: forward('insufficientData') }), { symbol: 'spx' });
    expect(basis.out.exposures).toMatchObject({ referenceKind: 'forward', charmBasis: 'cash', roll: 'fitted', carry: 0.04 });
    expect(basis.out.sincePriorSession.exposures.prior).toMatchObject({ charmBasis: 'fixed reference', roll: 'insufficient data' });
    expect(basis.out.sincePriorSession.exposures.change).toMatchObject({ charmFlow: null, charmBasisChanged: true, gex: 0 });
    const partialPrior = day({ bases: wire({ vega: [0, 4] }) });
    const gap = await call('get_dealer_positioning', () => v2Eod(day(), { status: 'found', priorDate: '2026-10-22', sessionsSkipped: 0, prior: partialPrior }), { symbol: 'spy' });
    expect(gap.out.sincePriorSession.exposures.prior.coverage).toEqual({ vegaExposure: { status: 'unavailable', included: 0, total: 4 } });
    expect(gap.out.sincePriorSession.exposures.change.vegaExposure).toBeNull();
  });

  test('a session or prior without book numbers says why in fixed words; the qualifier and the legacy scope are stated', async () => {
    const mismatch = await call('get_dealer_positioning', () => v2Eod({ available: false, reason: 'the methodology-2 row is not of the session\'s current publication' }, { status: 'none-on-file' }), { symbol: 'spy' });
    expect(mismatch.out).toMatchObject({ exposures: null, exposuresUnavailable: 'the stored book is not of the session\'s current publication' });
    expect(mismatch.out.sincePriorSession.exposures).toEqual({ status: 'none-on-file' });
    const noRow = await call('get_dealer_positioning', () => v2Eod({ available: false, reason: 'no methodology-2 row' }, { status: 'unavailable' }), { symbol: 'spy' });
    expect(noRow.out.exposuresUnavailable).toBe('the assumed dealer book is not published for this session');
    expect(noRow.text).not.toMatch(NAMED_A_METHOD);
    expect(noRow.out.sincePriorSession.exposures).toEqual({ status: 'unavailable' });
    const legacy = await call('get_dealer_positioning', () => v2Eod(day({ definition: 'legacy-scope', expiryQualifier: { kind: 'mayInclude', cause: 'pending' } })), { symbol: 'spy' });
    expect(legacy.out.exposures.scope).toBe('every expiration on file for the session (stored before the expiry rule was recorded)');
    expect(legacy.out.exposures.exposureStatus).toEqual({ expiryQualifier: 'may count contracts expiring that day (their correction is in progress)' });
    const proven = await call('get_dealer_positioning', () => v2Eod(day({ definition: 'legacy-scope', expiryQualifier: null })), { symbol: 'spy' });
    expect(proven.out.exposures.scope).toMatch(/proven to hold none expiring that session/);
    expect(proven.out.exposures).not.toHaveProperty('exposureStatus');
  });

  test('an answer without the book day is refused, never relabeled', async () => {
    const { isError, text } = await call('get_dealer_positioning', () => legacyEod(), { symbol: 'spy' });
    expect(isError).toBe(true);
    expect(text).toMatch(/did not carry the assumed dealer book/);
    expect(text).not.toMatch(NAMED_A_METHOD);
  });

  test('the end-of-day note states the after-session scope only where the expiry rule is proven', async () => {
    const eod = await call('get_dealer_positioning', () => v2Eod(), { symbol: 'spy' });
    expect(eod.out.bookNote).toMatch(/Here `exposures` cover the scope `exposures\.scope` states, from the stored end-of-day chain - every expiration after the session where the expiry rule is proven; an older row's own expiring contracts may be included/);
    expect(eod.out.bookNote).not.toMatch(/cover every expiration after the session, from|publication, over every expiration after the session:/);
  });
});

// the route's single snapshot (proxy SupabaseService.getTickerSnapshot) with its qualified book block
const snapshotBody = (exposureV2: unknown) => ({
  ticker: 'SPY', date: '2026-10-23', spotPrice: 671.2, maxPain: 670, netGex: 1.5e9, netDex: -2e9, atmIv: 0.15, putCallRatio: 1.1, ivRank: 0.4,
  gexByStrike: [{ strike: 670, callGex: 9, putGex: -3, netGex: 6 }], dexByStrike: [{ strike: 670, netDex: -1 }],
  maxPainCurve: [], volSkew: [], analyticsExpiry: '2026-11-20', chainExpiry: '2026-10-24',
  exposureV2,
});
const assetBlock = (over: Record<string, unknown> = {}) => ({
  available: true, methodology: 2, date: '2026-10-23', computeRunId: 'run-SPY-2026-10-23', referenceKind: 'spot', scope: 'all expirations',
  roll: { status: 'notApplicable', carry: null }, totals: wire(),
  strikes: [
    { strike: 665, bases: wire({}, side(1000, 1, 1, 1, 1), side(400, 1, 1, 1, 1), -100) },
    { strike: 670, bases: wire({}, side(2000, 1, 1, 1, 1), side(600, 1, 1, 1, 1), -200) },
  ],
  definition: 'expiry-scoped', expiryQualifier: null, ...over,
});

// Greek exposure methodology v2: the snapshot's exposure figures are the assumed dealer book only - the single
// snapshot's always-present block and the batch's opt-in - with no method label, no default read and none of the stored
// net GEX and DEX or their curves (the bodies below carry them, at values the book never takes, so a leak shows).
const NAMED_A_METHOD = /[Mm]ethodolog|\bv2\b|V2/;
const LABELS = ['methodology', 'methodologySource', 'methodologyStale', 'exposuresWithheld', 'methodologyNote'];

describe('get_options_snapshot: the assumed dealer book only', () => {
  // The route marks its failed bases read with the transport name; the answer names `exposures`
  test('a failed read of the book stays partial, named `exposures` in words, and no method is named', async () => {
    const body = { ...snapshotBody({ available: false, reason: 'the methodology-2 bases could not be read' }), partial: true, unavailable: ['exposureV2'] };
    const { out, text, isError } = await call('get_options_snapshot', () => body, { symbols: 'spy' });
    expect(isError).toBe(false);
    expect(out).toMatchObject({ partial: true, unavailable: ['exposures'], exposures: null });
    expect(out.partialNote).toBe('Part of this snapshot could not be read: the stored book (`exposures` is null and its gex and dex curves are unknown).');
    expect(text).not.toMatch(/exposureV2|[Mm]ethodolog|\bv2\b|V2/);
    // with the curves unread too, the curves' note says the book was not read either
    const both = await call('get_options_snapshot', () => ({ ...body, unavailable: ['curves', 'exposureV2'] }), { symbols: 'spy' });
    expect(both.out.unavailable).toEqual(['curves', 'exposures']);
    expect(both.out.partialNote).toMatch(/the curves are unknown\. Nor could the stored book: `exposures` is null\.$/);
  });

  test('one symbol: the publication in `exposures`, its strikes the gex and dex curves, no stored total and no label', async () => {
    const { out, text, calls, routeCalls } = await call('get_options_snapshot', () => snapshotBody(assetBlock()), { symbols: 'spy', curves: ['gex', 'dex'] });
    expect(routeCalls).toEqual([{ path: '/scanner/snapshot/SPY', params: undefined }]);
    expect(calls.map((c) => c.path)).not.toContain('/exposure/methodology');
    for (const key of LABELS) expect(out).not.toHaveProperty(key);
    expect(out.metrics).not.toHaveProperty('netGex');
    expect(out.metrics).not.toHaveProperty('netDex');
    expect(out.metrics.ivRank).toBe(0.4);
    expect(out.exposures).toMatchObject({ scope: 'every expiration after the session', gex: 2000, putMinusCallDeltaBalance: -12345.5 });
    expect(out.curves.gex).toMatchObject({ strikes: 2, total: 2000, largestAbsolute: { strike: 670, gex: 1400 } });
    expect(out.curves.dex).toMatchObject({ strikes: 2, total: -300, largestAbsolute: { strike: 670, putMinusCallDeltaBalance: -200 } });
    expect(out.bookNote).toMatch(/^`exposures` is the assumed dealer book.*The snapshot's `exposures` and its gex and dex curves are its newest published book/s);
    // the stored totals (1.5e9, -2e9) and the stored curve's total (6) reach nothing
    expect(text).not.toMatch(/1500000000|-2000000000|"total":6\b|"net(Gex|Dex)"/);
    expect(text).not.toMatch(/run-SPY|computeRunId/);
    expect(text).not.toMatch(NAMED_A_METHOD);
  });

  test('a book curve keeps each strike\'s coverage, the largest included, and says how many are short', async () => {
    const block = assetBlock({
      strikes: [
        { strike: 670, bases: { ...wire({ gamma: [1, 2] }, side(2500, 1, 1, 1, 1), side(500, 1, 1, 1, 1), -200) } },
        { strike: 675, bases: wire({}, side(800, 1, 1, 1, 1), side(300, 1, 1, 1, 1), -100) },
        { strike: 680, bases: { ...wire({ delta: [0, 2] }, side(100, 1, 1, 1, 1), side(100, 1, 1, 1, 1)), dexBalance: null } },
      ],
    });
    const { out } = await call('get_options_snapshot', () => snapshotBody(block), { symbols: 'spy', curves: ['gex', 'dex'] });
    // the partial strike is the largest: it says so, and so does the curve
    expect(out.curves.gex.largestAbsolute).toEqual({ strike: 670, gex: 2000, coverage: { status: 'partial', included: 1, total: 2 } });
    expect(out.curves.gex.totalCoverage).toEqual({ status: 'partial', strikesPartial: 1, strikesUnavailable: 0 });
    expect(out.curves.gex.nearSpot).toEqual([
      { strike: 670, gex: 2000, coverage: { status: 'partial', included: 1, total: 2 } },
      { strike: 675, gex: 500 },
      { strike: 680, gex: 0 },
    ]);
    // the balance's own coverage: a strike without delta is unavailable, its value null, counted
    expect(out.curves.dex.totalCoverage).toEqual({ status: 'partial', strikesPartial: 0, strikesUnavailable: 1 });
    expect(out.curves.dex.nearSpot.find((r: any) => r.strike === 680)).toEqual({ strike: 680, putMinusCallDeltaBalance: null, coverage: { status: 'unavailable', included: 0, total: 2 } });
    expect(out.curves.dex).toMatchObject({ strikes: 3, strikesWithValue: 2, total: -300, largestAbsolute: { strike: 670, putMinusCallDeltaBalance: -200 } });
    // A curve where no strike contributes a value is unavailable, not partial
    const none = assetBlock({ strikes: [665, 670].map((strike) => ({ strike, bases: wire({ gamma: [0, 2] }) })) });
    const empty = await call('get_options_snapshot', () => snapshotBody(none), { symbols: 'spy', curves: ['gex'] });
    expect(empty.out.curves.gex).toMatchObject({ strikesWithValue: 0, total: null, largestAbsolute: null, totalCoverage: { status: 'unavailable', strikesPartial: 0, strikesUnavailable: 2 } });
    // a complete curve carries no coverage at all
    const clean = await call('get_options_snapshot', () => snapshotBody(assetBlock()), { symbols: 'spy', curves: ['gex'] });
    expect(clean.out.curves.gex).not.toHaveProperty('totalCoverage');
    expect(clean.out.curves.gex.largestAbsolute).not.toHaveProperty('coverage');
  });

  test('each book note states the after-session scope only where the expiry rule is proven', async () => {
    const single = await call('get_options_snapshot', () => snapshotBody(assetBlock()), { symbols: 'spy' });
    expect(single.out.bookNote).toMatch(/over the scope `exposures\.scope` states - every expiration after the session where the expiry rule is proven; where no scope is stated, or exposureStatus carries an expiryQualifier, it may count contracts expiring that session/);
    const batch = await call('get_options_snapshot', () => ({ methodology: 2, exposure: { view: 'assumedDealerBook', p: 1 }, count: 0, data: [] }), { symbols: 'aaa,bbb' });
    expect(batch.out.bookNote).toMatch(/over every expiration after the session where its expiry rule is proven \(a value marked qualified is not\)/);
    for (const note of [single.out.bookNote, batch.out.bookNote]) {
      expect(note).not.toMatch(/cover every expiration after the session, from|publication, over every expiration after the session:/);
      expect(note).not.toMatch(NAMED_A_METHOD);
    }
  });

  test('one symbol: an unavailable block or an unverified qualifier says so; a mislabeled block is refused', async () => {
    const off = await call('get_options_snapshot', () => snapshotBody({ available: false, reason: 'methodology 2 has not been published for 2026-10-23' }), { symbols: 'spy', curves: ['gex'] });
    expect(off.out).toMatchObject({ exposures: null, exposuresUnavailable: 'the assumed dealer book is not published for this session' });
    expect(off.out.curves.gex).toBeNull();
    expect(off.text).not.toMatch(NAMED_A_METHOD);
    const unverified = await call('get_options_snapshot', () => snapshotBody(assetBlock({ definition: null, expiryQualifier: { kind: 'mayInclude', cause: 'unverified' } })), { symbols: 'spy' });
    expect(unverified.out.exposures).not.toHaveProperty('scope');
    expect(unverified.out.exposures.exposureStatus).toEqual({ expiryQualifier: 'may count contracts expiring that day (their correction could not be confirmed)' });
    const mislabeled = await call('get_options_snapshot', () => snapshotBody(assetBlock({ methodology: 1 })), { symbols: 'spy' });
    expect(mislabeled.isError).toBe(true);
    expect(mislabeled.text).toMatch(/did not carry the assumed dealer book, so it was not used/);
    expect(mislabeled.text).not.toMatch(NAMED_A_METHOD);
  });

  test('one symbol whose row carries no book block: exposures null with its reason, never the stored totals or curves', async () => {
    const { out, text, calls } = await call('get_options_snapshot', () => snapshotBody(undefined), { symbols: 'spy', curves: ['gex', 'dex'] });
    expect(out).toMatchObject({ exposures: null, exposuresUnavailable: 'the stored book is unreadable', curves: { gex: null, dex: null } });
    expect(out.metrics).not.toHaveProperty('netGex');
    expect(out.metrics.ivRank).toBe(0.4);
    expect(out.bookNote).toMatch(/^`exposures` is the assumed dealer book/);
    for (const key of LABELS) expect(out).not.toHaveProperty(key);
    expect(text).not.toMatch(/1500000000|-2000000000|"total":6\b/);
    expect(calls.map((c) => c.path)).not.toContain('/exposure/methodology');
  });

  const batchRow = (symbol: string, exposureV2: unknown, stored: Record<string, unknown> = {}) => ({ symbol, date: '2026-10-23', atmIv: 0.2, ivRank: 0.5, spotPrice: 100, exposureV2, ...stored });
  const valued = (value: number | null, status = 'complete') => ({ value, status });
  const BATCH = { methodology: 2, exposure: { view: 'assumedDealerBook', p: 1, expiryScope: 'eod-session-1', expirations: 'all' } };
  const ok = (gex: number, gexStatus = 'complete', dex = 5) => ({ available: true, netGex: valued(gex, gexStatus), netDex: valued(dex), referenceKind: 'spot', charmBasis: 'cash' });

  test('several symbols: the opt-in, its envelope checked, each row\'s standing, the shared reference once, no label', async () => {
    const body = { ...BATCH, count: 3, data: [batchRow('AAA', ok(10)), batchRow('BBB', ok(1000, 'partial')), batchRow('CCC', { available: false, reason: 'the methodology-2 row is not of the session\'s current publication' })] };
    const { out, text, calls, routeCalls } = await call('get_options_snapshot', () => body, { symbols: 'aaa,bbb,ccc' });
    expect(routeCalls).toEqual([{ path: '/scanner/metrics/batch', params: { symbols: 'AAA,BBB,CCC', exposure: 'v2' } }]);
    expect(calls.map((c) => c.path)).not.toContain('/exposure/methodology');
    const [a, b, c] = out.metrics;
    expect(a).toMatchObject({ symbol: 'AAA', netGex: 10, netDex: 5 });
    expect(a).not.toHaveProperty('exposureStatus');
    expect(b.exposureStatus).toEqual({ netGex: 'partial' });
    expect(c).toMatchObject({ netGex: null, netDex: null, exposureUnavailable: 'the stored book is not of the session\'s current publication' });
    expect(out.exposuresCommon).toEqual({ referenceKind: 'spot', charmBasis: 'cash' });
    expect(out.bookNote).toMatch(/^Each row's netGex is the assumed dealer book's GEX/);
    for (const key of LABELS) expect(out).not.toHaveProperty(key);
    expect(text).not.toMatch(NAMED_A_METHOD);
    // an answer that does not say it carries the book (an envelope-less body, or one naming another book) is refused
    for (const envelope of [{}, { methodology: 1, exposure: { view: 'assumedDealerBook', p: 1 } }, { methodology: 2, exposure: { view: 'longOi', p: 1 } }]) {
      const refused = await call('get_options_snapshot', () => ({ ...envelope, count: 1, data: [batchRow('AAA', ok(10))] }), { symbols: 'aaa,bbb' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/did not carry the assumed dealer book, so it was not used/);
    }
  });

  test.each([['desc'], ['asc']])('rankBy netGex %s ranks only complete, proven values; the rest follow in request order, counted', async (order) => {
    const body = { ...BATCH, count: 5, data: [
      batchRow('PART', ok(1000, 'partial')), batchRow('TEN', ok(10)), batchRow('QUAL', ok(500, 'qualified')),
      batchRow('NONE', { available: false, reason: 'no methodology-2 row' }), batchRow('TWENTY', ok(20)), batchRow('TIE', ok(20)),
    ] };
    const { out } = await call('get_options_snapshot', () => body, { symbols: 'part,ten,qual,none,twenty,tie', rankBy: 'netGex', order });
    const ranked = order === 'desc' ? ['TWENTY', 'TIE', 'TEN'] : ['TEN', 'TWENTY', 'TIE'];
    expect(out.metrics.map((r: any) => r.symbol)).toEqual([...ranked, 'PART', 'QUAL', 'NONE']);
    expect(out.rankMeta).toMatchObject({ rankBy: 'netGex', ranked: 3, unranked: 3, unrankedSymbols: ['PART', 'QUAL', 'NONE'], unrankedReasons: { partial: 1, qualified: 1, unavailable: 1 } });
    expect(out.metrics.find((r: any) => r.symbol === 'NONE').exposureUnavailable).toBe('the assumed dealer book is not published for this session');
  });

  test('several symbols: the stored totals never reach a row or its ranking, whatever they say', async () => {
    // each row stores legacy totals that would rank it the other way round
    const body = { ...BATCH, count: 2, data: [
      batchRow('AAA', ok(1, 'complete', -7), { netGex: 900, netDex: 3 }),
      batchRow('BBB', ok(2, 'complete', 8), { netGex: -900, netDex: -3 }),
    ] };
    const { out, text } = await call('get_options_snapshot', () => body, { symbols: 'aaa,bbb', rankBy: 'netDex' });
    expect(out.metrics.map((r: any) => [r.symbol, r.netGex, r.netDex])).toEqual([['BBB', 2, 8], ['AAA', 1, -7]]);
    expect(text).not.toMatch(/\b900\b|"netDex":3\b|"netDex":-3\b/);
  });

  test('the published schema takes no methodology, and the description names no method', async () => {
    const server = new McpServer({ name: 'u12-g2-snapshot', version: '1' });
    registerSnapshot(server, { get: async () => ({}) } as unknown as LiveApiClient);
    const reader = new Client({ name: 'u12-g2-snapshot-reader', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), reader.connect(a)]);
    try {
      const tool = (await reader.listTools()).tools.find((t) => t.name === 'get_options_snapshot')!;
      expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(['curveLimit', 'curves', 'order', 'rankBy', 'symbols']);
      expect(tool.description).not.toMatch(NAMED_A_METHOD);
      expect(tool.description).toContain('its exposures (the assumed dealer book\'s GEX, delta balance, vega exposure, vanna, charm flow and vomma)');
      expect(tool.description).not.toMatch(/over ALL expirations on file|-16,795,316,756/);
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(NAMED_A_METHOD);
    } finally {
      await reader.close();
      await server.close();
    }
  });
});

// The wire contract with the proxy's own routes (the real /eod/exposure and /scanner/metrics/batch answers read by
// this server's shapers) is pinned from the proxy's side, proxy/tests/mcp-exposure-v2-opt-ins.test.ts: the routes'
// stored rows name their producer, which this server's public mirror never carries.
