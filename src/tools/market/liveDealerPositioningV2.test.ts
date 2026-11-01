import { describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { LiveApiClient } from '../../proxy/liveApiClient.js';
import { register } from './dealerPositioning.js';
import { LEVELS_BASIS, LIVE_V2_NOTE, LIVE_V2_SCOPE } from './dealerPositioningShaping.js';
import { BOOK_NOTE } from '../exposureMethodology.js';

// get_live_dealer_positioning answers one calculation (methodology v2's book; Greek exposure methodology v2): every call
// asks the proxy's /live/exposure for its book (`exposure=v2`, internal transport), every exposure number is the
// book's, and the levels are the gamma-derived levels in `levels`, unlabeled.

const budget = { provider: 'tradier', limit: 120, remaining: 110, resetSeconds: 20 };

async function call(answer: (path: string, params?: Record<string, string>) => unknown, args: Record<string, unknown>) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const server = new McpServer({ name: 'u12-g2-live', version: '1' });
  const client = {
    get: async (path: string, params?: Record<string, string>, onRateLimit?: (r: typeof budget) => void) => {
      calls.push({ path, params });
      onRateLimit?.(budget);
      return structuredClone(await answer(path, params));
    },
  } as unknown as LiveApiClient;
  register(server, client);
  const reader = new Client({ name: 'u12-g2-live-reader', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), reader.connect(a)]);
  try {
    const result = await reader.callTool({ name: 'get_live_dealer_positioning', arguments: { symbol: 'TEST', ...args } });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    let out: Record<string, any> = {};
    try { out = JSON.parse(text); } catch { /* an error's text */ }
    if (result.isError !== true) expect(result.structuredContent).toEqual(out);
    const listed = (await reader.listTools()).tools.find((t) => t.name === 'get_live_dealer_positioning')!;
    return { isError: result.isError === true, text, out, calls, listed };
  } finally {
    await reader.close();
    await server.close();
  }
}

const METRICS = ['gamma', 'delta', 'vega', 'vanna', 'charm', 'vomma'] as const;
type Metric = (typeof METRICS)[number];
const side = (gex: number, vega: number, vanna: number, charm: number, vomma: number) => ({ gex, dex: 0, vega, vanna, charmFixedRef: charm, rollBasis: null, charm, vomma });
const coverage = (over: Partial<Record<Metric, [number, number]>> = {}, n = 4) => Object.fromEntries(METRICS.map((m) => {
  const [included, total] = over[m] ?? [n, n];
  return [m, { included, total }];
}));
const wire = (call = side(3000, 70, 50, 30, 20), put = side(1000, 10, -20, -60, 90), dexBalance = -1500.5, over: Partial<Record<Metric, [number, number]>> = {}, n = 4) => ({ call, put, coverage: coverage(over, n), dexBalance });

const EXPIRATIONS = ['2026-10-23', '2026-10-30'];
const legCoverage = (total = 8, included = total) => ({ total, included });

/** /live/exposure's body without its book: strikes 95..105 by 5, two expirations, spot 100 (the levels' fields) */
const routeBody = () => ({
  schemaVersion: 1, symbol: 'TEST', dataSource: 'live', provider: 'tradier', asOf: '2026-10-23T15:00:00.000Z',
  expirations: EXPIRATIONS, expirationSelection: 'nearest', expirationsAvailable: 9, strikesUsed: 6,
  coverage: {
    strikes: 3, strikesWithGamma: 3, strikesWithDelta: 3,
    gamma: legCoverage(12), delta: legCoverage(12), vega: legCoverage(12), vanna: legCoverage(12), charm: legCoverage(12), vomma: legCoverage(12),
    gammaFlip: legCoverage(12), gammaFlipMethod: 'repriced', gammaFlipResolution: 0.02, gammaFlipSearchStatus: 'found',
  },
  resolved: { S: { value: 100, source: 'broker-tradier', asOf: '2026-10-23T14:59:00Z', stale: false }, r: { value: 0.04, source: 'fred', asOf: '2026-10-22' }, q: { value: 0.01, source: 'supplied', asOf: null } },
  snapshot: {
    spotPrice: 100, gammaFlip: 98.5, netGamma: 9000, netDelta: -4000, netVega: 300, netVanna: 70, netCharm: -90, netVomma: 110,
    callWall: 105, putWall: 95, absGamma: 100, gammaConcentration: 0.4, regime: 'positive', topStrikes: [],
  },
  byStrike: [95, 100, 105].map((strike) => ({
    strike, netGamma: 3000, callGamma: 4000, putGamma: -1000, netDelta: -1300, netVega: 100,
    coverage: { gamma: legCoverage(4), delta: legCoverage(4), vega: legCoverage(4) },
    callOpenInterest: 600, putOpenInterest: 200,
    deltasByExpiration: EXPIRATIONS.map((expiration) => ({ expiration, call: 0.5, put: -0.5 })),
  })),
  spotSides: {
    atSpotStrike: 100,
    above: { strikes: 1, netGamma: 3000, callGamma: 4000, putGamma: -1000, gammaCoverage: legCoverage(4), callOpenInterest: 600, callOpenInterestCoverage: legCoverage(2), putOpenInterest: 200, putOpenInterestCoverage: legCoverage(2) },
    below: { strikes: 1, netGamma: 3000, callGamma: 4000, putGamma: -1000, gammaCoverage: legCoverage(4), callOpenInterest: 600, callOpenInterestCoverage: legCoverage(2), putOpenInterest: 200, putOpenInterestCoverage: legCoverage(2) },
    callOpenInterestShareAbove: 0.3333,
  },
  byExpiration: EXPIRATIONS.map((expiration, i) => ({
    expiration, daysToExpiration: i * 7, netGamma: 4500, netDelta: -2000, callGamma: 6000, putGamma: -1500, grossGamma: 7500, shareOfGrossGamma: 0.5,
    coverage: { gamma: legCoverage(6), delta: legCoverage(6) },
    expectedMove: { strike: 100, callMid: 1, putMid: 1, straddle: 2, pctOfSpot: 0.02, lower: 98, upper: 102, atmIv: 0.2, ivOneSigma: 2.5 },
    expectedMoveUnavailable: null,
    events: { earningsOnOrBefore: null, exDividendOnOrBefore: null },
  })),
  events: { from: '2026-10-23', through: '2026-10-30', earnings: [], exDividends: [] },
});

/** The route's book (proxy/lib/liveExposureV2.ts) over the same strikes */
const liveV2 = (over: Record<string, unknown> = {}) => ({
  available: true, methodology: 2, referenceKind: 'spot', roll: { status: 'notApplicable', carry: null },
  expiryScope: 'intraday-clock-1', scopeAsOf: '2026-10-23T14:59:59.000Z',
  expirationsIncluded: EXPIRATIONS, strikeRows: { inScope: 6, expired: 0, unscoped: 0 },
  totals: wire(side(9000, 210, 150, 90, 60), side(3000, 30, -60, -180, 270), -4500, {}, 12),
  strikes: [95, 100, 105].map((strike) => ({
    strike, bases: wire(), callOpenInterest: 600, putOpenInterest: 200,
    deltasByExpiration: EXPIRATIONS.map((expiration) => ({ expiration, call: 0.5, put: -0.5 })),
  })),
  expirations: EXPIRATIONS.map((expiration) => ({ expiration, bases: wire(side(4500, 105, 75, 45, 30), side(1500, 15, -30, -90, 135), -2250, {}, 6) })),
  spotSides: {
    atSpotStrike: 100, callOpenInterestShareAbove: 0.3333,
    above: { strikes: 1, bases: wire(), callOpenInterest: 600, callOpenInterestCoverage: legCoverage(2), putOpenInterest: 200, putOpenInterestCoverage: legCoverage(2) },
    below: { strikes: 1, bases: wire(), callOpenInterest: 600, callOpenInterestCoverage: legCoverage(2), putOpenInterest: 200, putOpenInterestCoverage: legCoverage(2) },
  },
  ...over,
});

/** The route answers its book only when asked for it, as /live/exposure does */
const answering = (exposureV2: unknown = liveV2(), body: Record<string, unknown> = routeBody()) => (_path: string, params?: Record<string, string>) =>
  (params?.exposure === 'v2' && exposureV2 !== undefined ? { ...body, exposureV2 } : body);

/** Every key anywhere in a value, with the paths it sits under */
function keysOf(value: unknown, at = '', out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v, i) => keysOf(v, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) { out.push(`${at}.${key}`); keysOf(v, `${at}.${key}`, out); }
  }
  return out;
}
/** The answer's data keys: the guide's line names are prose keys, not fields */
const dataKeys = (out: unknown) => keysOf(out).filter((path) => !path.startsWith('.guide.'));
/** Every key the earlier calculation's answer carried, and none of the book's */
const EARLIER_KEYS = /\.(netGex|netDex|netGamma|netDelta|netVega|netVanna|netCharm|netVomma|callGex|putGex|grossGex|shareOfGrossGex|exposure|exposureStatus|levelStatus)$/;
/** A key that names a calculation, or the withholding a default once caused */
const LABEL_KEYS = /\.(methodology|methodologySource|methodologyStale|methodologyNote|exposuresWithheld)$/;
/** Text that names a calculation by number or version (O1, O4) */
const NUMBERED = /[Mm]ethodolog|\bv2\b|V2/;

describe('get_live_dealer_positioning: the assumed dealer book', () => {
  test('asks the route for its book and sends it, no earlier exposure anywhere, the levels unlabeled', async () => {
    const { out, calls, isError } = await call(answering(), {});
    expect(isError).toBe(false);
    expect(calls).toEqual([{ path: '/live/exposure/TEST', params: { exposure: 'v2' } }]);
    expect(Object.keys(out).slice(0, 2)).toEqual(['symbol', 'dataSource']);
    // the book through the twin: the assumed dealer book is calls minus puts, charm flow the negative of its drift
    expect(out.exposures).toEqual({
      scope: LIVE_V2_SCOPE,
      gex: 6000, vegaExposure: 180, vanna: 210, charmFlow: -270, vomma: -210,
      longOi: { gex: 12000, vegaExposure: 240, vanna: 90, charmFlow: 90, vomma: 330 },
      putMinusCallDeltaBalance: -4500,
      referenceKind: 'spot', charmBasis: 'cash',
    });
    // the instant the book was scoped at, which the route's asOf (taken after its other reads) can follow across a close
    expect(out.exposureScope).toEqual({ asOf: '2026-10-23T14:59:59.000Z', expirationsIncluded: EXPIRATIONS });
    expect(out.guide.exposureScope).toContain('exposureScope.asOf is the instant');
    // the gamma-derived levels with their statuses and only the coverage they are read from
    expect(out.levels).toMatchObject({
      basis: LEVELS_BASIS, gammaFlip: 98.5, callWall: 105, putWall: 95, gammaMagnet: 100, dealerRegime: 'positive', gammaConcentration: 0.4,
      status: { gammaFlip: 'complete', callWall: 'complete', putWall: 'complete', gammaMagnet: 'complete', dealerRegime: 'complete', gammaConcentration: 'complete' },
    });
    expect(Object.keys(out.levels)).toEqual(['basis', 'gammaFlip', 'callWall', 'putWall', 'gammaMagnet', 'dealerRegime', 'gammaConcentration', 'status', 'coverage']);
    expect(Object.keys(out.levels.coverage)).toEqual(['unit', 'strikes', 'strikesWithGamma', 'gamma', 'gammaFlip', 'gammaFlipMethod', 'gammaFlipResolution', 'gammaFlipSearchStatus']);
    for (const key of ['exposure', 'exposureStatus', 'levelStatus', 'coverage']) expect(out, key).not.toHaveProperty(key);
    // no earlier exposure field and no label anywhere in the answer
    expect(dataKeys(out).filter((path) => EARLIER_KEYS.test(path))).toEqual([]);
    expect(dataKeys(out).filter((path) => LABEL_KEYS.test(path))).toEqual([]);
    // the rows are the book's
    expect(out.strikes.nearSpot[0]).toEqual({ strike: 95, gex: 2000, putMinusCallDeltaBalance: -1500.5, vegaExposure: 60, callOpenInterest: 600, putOpenInterest: 200, callDelta: null, putDelta: null });
    expect(out.strikes.total).toBe(3);
    // each expiration's own book beside its expected move and events
    expect(out.byExpiration[0]).toMatchObject({
      expiration: '2026-10-23', daysToExpiration: 0,
      exposures: { gex: 3000, putMinusCallDeltaBalance: -2250, longOiGex: 6000, shareOfLongOiGex: 0.5 },
      expectedMove: { straddle: 2 }, events: { earningsOnOrBefore: null },
    });
    expect(out.spotSides).toEqual({
      atSpotStrike: 100,
      above: { strikes: 1, gex: 2000, callOpenInterest: 600, putOpenInterest: 200, status: { callOpenInterest: 'complete', putOpenInterest: 'complete' }, coverage: { callOpenInterest: { total: 2, included: 2, status: 'complete' }, putOpenInterest: { total: 2, included: 2, status: 'complete' } } },
      below: { strikes: 1, gex: 2000, callOpenInterest: 600, putOpenInterest: 200, status: { callOpenInterest: 'complete', putOpenInterest: 'complete' }, coverage: { callOpenInterest: { total: 2, included: 2, status: 'complete' }, putOpenInterest: { total: 2, included: 2, status: 'complete' } } },
      callOpenInterestShareAbove: 0.3333,
    });
    // the book's note, once, last
    expect(out.bookNote).toBe(`${BOOK_NOTE} ${LIVE_V2_NOTE}`);
    expect(Object.keys(out).at(-1)).toBe('bookNote');
    expect(out.rateLimit).toEqual(budget);
    // the guide's book lines, and its paths into `levels`
    expect(out.guide.exposureScope).toContain('session\'s close (4:00 PM New York, 1:00 PM on an NYSE early close)');
    expect(out.guide.exposure).toContain('are one book (bookNote)');
    expect(out.guide.levelStatus).toContain('levels.status reports required coverage');
    expect(out.guide.levelStatus).toContain('levels.coverage.gammaFlip');
    expect(out.guide.levelStatus).toContain('the levels\' net gamma status');
    expect(out.guide.flipMethod).toContain('levels.coverage.gammaFlipMethod');
    expect(out.guide.walls).toStartWith('The levels are their own computation (levels.basis).');
    expect(out.guide.dealerRegime).toContain('not the sign of exposures.gex');
    expect(out.guide.rows).toContain('the book\'s at that strike');
    expect(out.guide.byExpiration).toContain('shareOfLongOiGex');
    expect(out.guide.strikeCounts).toContain('levels.coverage.strikes');
    expect(out.guide.clock).toContain('exactly, gex to its rounding');
    expect(out.guide.sameDay).toContain('the whole book at the close');
    expect(JSON.stringify(out.guide)).not.toMatch(/netGex|netCharm|netDex|grossGex/);
    // the levels' clock claims, said of the levels only
    expect(out.guide.windowRoll).toContain('shows the levels as it closed');
    expect(out.guide.windowRoll).not.toContain('shows the book as it closed');
    expect(out.guide.clock).toContain('takes an expiration\'s legs out of the book at its session\'s close');
    expect(out.guide.clock).not.toContain('the summed legs unchanged');
    expect(out.guide.spotSides).toContain('over the book\'s call open interest');
    expect(out.guide.tradierGreeks).toContain('vanna, charmFlow and vomma');
    expect(out.limitations[0]).toContain('still in the book when the chain was read');
    expect(out.guide.legEligibility).toBeUndefined();
  });

  test('every call asks for the book, with or without an expiration, r and q, and reads no default', async () => {
    const { calls } = await call(answering(), { expiration: '2026-10-23', r: 0.0425, q: 0.012, provider: 'tradier' });
    expect(calls).toEqual([{ path: '/live/exposure/TEST', params: { expiration: '2026-10-23', exposure: 'v2', provider: 'tradier', r: '0.0425', q: '0.012' } }]);
  });

  test('no text a reader reads names a calculation by number or version: the description, the parameters, the answer', async () => {
    const { listed, text } = await call(answering(), {});
    expect(listed.inputSchema.properties).not.toHaveProperty('methodology');
    for (const [where, value] of [['description', listed.description], ...Object.entries(listed.inputSchema.properties ?? {}).map(([p, v]) => [`param ${p}`, (v as { description?: string }).description])] as Array<[string, string | undefined]>) {
      expect(String(value ?? ''), where).not.toMatch(NUMBERED);
    }
    expect(String(listed.description).length).toBeLessThanOrEqual(4096);
    expect(text).not.toMatch(NUMBERED);
    // the answers that say why there is no book say it in words
    for (const exposureV2 of [{ available: false, reason: 'the methodology-2 book could not be computed' }, { available: false, reason: 'methodology 2 is off' }, { ...liveV2(), totals: { call: {} } }]) {
      const why = await call(answering(exposureV2), {});
      expect(why.isError).toBe(false);
      expect(why.text, JSON.stringify(exposureV2)).not.toMatch(NUMBERED);
      expect(dataKeys(why.out).filter((path) => EARLIER_KEYS.test(path) || LABEL_KEYS.test(path))).toEqual([]);
    }
  });

  test('the description says what the answer holds: the book\'s figures, the levels, the per-expiration share', async () => {
    const { listed } = await call(answering(), {});
    const d = String(listed.description);
    expect(d.slice(0, d.indexOf('. ') + 1)).toContain('the assumed dealer book\'s GEX, delta balance, vega exposure, vanna, charm flow and vomma; the gamma-derived levels in `levels` with their statuses and coverage: the repriced gamma flip, the call wall and put wall');
    expect(d.slice(0, d.indexOf('. ') + 1)).toContain('a dealer regime (normally the sign of net gamma at spot; the levels\' net gamma total is the fallback with fewer than two gamma-bearing strikes or no recognized regime, and the flip side does not determine it); and per-strike rows near spot.');
    // the sibling and the broker prerequisite still end inside the first part a model reads to choose
    for (const line of ['For the most recent session on file, free and without a broker, use get_dealer_positioning; its coarse-grid gamma flip is a different claim from the repriced one here.', 'Requires a broker credential saved to the account under Account -> Broker -> Stored broker credentials; a broker connected only in the browser on the website is not visible to this tool.']) {
      expect(d.indexOf(line)).toBeGreaterThanOrEqual(0);
      expect(d.indexOf(line) + line.length).toBeLessThanOrEqual(1024);
    }
    expect(d).toContain('Per expiration it adds its own GEX, delta balance and share of the book\'s Long OI GEX (0DTE concentration)');
    expect(d).toContain('a null flip beside a complete `levels.status.gammaFlip` is the result of a search over every counted leg (read `levels.coverage.gammaFlipSearchStatus` when reported)');
    expect(d).toContain('for the same symbol, broker, `expiration`, `r` and `q` can be answered from a short cache');
    expect(d).not.toMatch(/net GEX and DEX|netCharm|levelStatus\.|`coverage\./);
  });

  test('an answer without its book, or with another calculation\'s, is refused as invalid', async () => {
    for (const exposureV2 of [undefined, null, { ...liveV2(), methodology: 1 }]) {
      const body = exposureV2 === undefined ? routeBody() : { ...routeBody(), exposureV2 };
      const { isError, text } = await call(() => body, {});
      expect(isError, JSON.stringify(exposureV2)).toBe(true);
      expect(text).toContain('The answer did not carry the assumed dealer book, so it was not used.');
      expect(text).not.toMatch(NUMBERED);
    }
  });

  test('the unpublished-open-interest limitation points at the levels\' own statuses', async () => {
    const body = { ...routeBody(), openInterestUnpublishedExpirations: ['2026-10-30'] };
    const { out } = await call(answering(liveV2(), body), {});
    const line = out.limitations.find((l: string) => l.startsWith('The broker published no open interest'));
    expect(line).toContain('`levels.status` says which');
    expect(line).toContain('the book\'s numbers it feeds carry the shortfall in their coverage');
  });

  test('a book the route could not compute: no exposures, said why, and no other number in its place', async () => {
    const { out } = await call(answering({ available: false, reason: 'the methodology-2 book could not be computed' }), {});
    expect(out.exposures).toBeNull();
    expect(out.exposuresUnavailable).toBe('the assumed dealer book could not be computed on this call');
    expect(out).not.toHaveProperty('exposureScope');
    expect(out.byExpiration.map((e: any) => e.exposures)).toEqual([null, null]);
    expect(out.strikes).toMatchObject({ total: 0, returned: 0, nearSpot: [] });
    expect(out.spotSides).toBeNull();
    expect(dataKeys(out).filter((path) => EARLIER_KEYS.test(path))).toEqual([]);
    // the levels stand
    expect(out.levels).toMatchObject({ gammaFlip: 98.5, basis: LEVELS_BASIS });
    expect(out.bookNote).toBe(`${BOOK_NOTE} ${LIVE_V2_NOTE}`);
    const unreadable = await call(answering({ ...liveV2(), totals: { call: {} } }), {});
    expect(unreadable.out.exposuresUnavailable).toBe('the book the route sent could not be read');
    // any other reason the route sends is not repeated: it is transport text
    const other = await call(answering({ available: false, reason: 'methodology 2 is off' }), {});
    expect(other.out.exposuresUnavailable).toBe('the book the route sent could not be read');
  });

  test('partial and unavailable numbers carry their coverage, on the totals and on each row', async () => {
    const strikes = liveV2().strikes;
    strikes[1] = { ...strikes[1], bases: wire(side(3000, 70, 50, 30, 20), side(1000, 10, -20, -60, 90), -1500.5, { gamma: [3, 4], vega: [0, 4] }), callOpenInterest: null } as any;
    const v2 = liveV2({ totals: wire(side(9000, 210, 150, 90, 60), side(3000, 30, -60, -180, 270), -4500, { gamma: [11, 12], vanna: [0, 12] }, 12), strikes });
    const { out } = await call(answering(v2), {});
    expect(out.exposures.coverage).toEqual({ gex: { status: 'partial', included: 11, total: 12 }, vanna: { status: 'unavailable', included: 0, total: 12 } });
    expect(out.exposures.vanna).toBeNull();
    expect(out.exposures.gex).toBe(6000);
    expect(out.guide.legEligibility).toContain('a leg of unknown size counts toward none');
    // the book's own gamma short of complete leaves every share unknown, each expiration's complete or not
    expect(out.byExpiration.map((e: any) => e.exposures.shareOfLongOiGex)).toEqual([null, null]);
    const row = out.strikes.nearSpot.find((r: any) => r.strike === 100);
    expect(row).toEqual({
      strike: 100, gex: 2000, putMinusCallDeltaBalance: -1500.5, vegaExposure: null, callOpenInterest: null, putOpenInterest: 200, callDelta: null, putDelta: null,
      coverage: { gex: { status: 'partial', included: 3, total: 4 }, vegaExposure: { status: 'unavailable', included: 0, total: 4 } },
    });
    // a partial expiration leaves every share unknown
    const expirations = liveV2().expirations;
    expirations[1] = { ...expirations[1], bases: wire(side(4500, 105, 75, 45, 30), side(1500, 15, -30, -90, 135), -2250, { gamma: [5, 6] }, 6) };
    const partial = await call(answering(liveV2({ expirations })), {});
    expect(partial.out.byExpiration.map((e: any) => e.exposures.shareOfLongOiGex)).toEqual([null, null]);
    expect(partial.out.byExpiration[1].exposures.coverage).toEqual({ gex: { status: 'partial', included: 5, total: 6 } });
    // a broker's negative gamma can carry a date's Long OI GEX past the book's: a share outside 0 to 1 is not sent
    const signed = liveV2({
      totals: wire(side(6000, 210, 150, 90, 60), side(0, 30, -60, -180, 270), -4500, {}, 12),
      expirations: [
        { expiration: '2026-10-23', bases: wire(side(7000, 105, 75, 45, 30), side(0, 15, -30, -90, 135), -2250, {}, 6) },
        { expiration: '2026-10-30', bases: wire(side(-1000, 105, 75, 45, 30), side(0, 15, -30, -90, 135), -2250, {}, 6) },
      ],
    });
    const outside = await call(answering(signed), {});
    expect(outside.out.byExpiration.map((e: any) => e.exposures.longOiGex)).toEqual([7000, -1000]);
    expect(outside.out.byExpiration.map((e: any) => e.exposures.shareOfLongOiGex)).toEqual([null, null]);
  });

  test('a side of spot short of complete gamma says so; a named same-day expiration says the book left it at its close', async () => {
    const sides = liveV2().spotSides;
    sides.below = { ...sides.below, bases: wire(side(3000, 70, 50, 30, 20), side(1000, 10, -20, -60, 90), -1500.5, { gamma: [3, 4] }), callOpenInterest: 400, callOpenInterestCoverage: legCoverage(2, 1) };
    const { out } = await call(answering(liveV2({ spotSides: sides })), {});
    expect(out.spotSides.below).toEqual({
      strikes: 1, gex: 2000, callOpenInterest: 400, putOpenInterest: 200, status: { callOpenInterest: 'partial', putOpenInterest: 'complete' },
      coverage: { gex: { status: 'partial', included: 3, total: 4 }, callOpenInterest: { total: 2, included: 1, status: 'partial' }, putOpenInterest: { total: 2, included: 2, status: 'complete' } },
    });
    expect(out.spotSides.above.coverage).not.toHaveProperty('gex');
    const named = { ...routeBody(), expirations: ['2026-10-23'], expirationSelection: 'requested', byExpiration: [routeBody().byExpiration[0]] };
    const sameDay = await call(answering(liveV2({ expirationsIncluded: [], expirations: [{ expiration: '2026-10-23', bases: null, reason: 'expired' }] }), named), { expiration: '2026-10-23' });
    expect(sameDay.out.guide.sameDayNamed).toBe('Named after its session\'s close, an expiration\'s legs are out of the book (exposureScope) but inside the levels.');
    expect(sameDay.out.guide.windowRoll).toBeUndefined();
  });

  test('an expiration past its close is out of the book and said so; one answered empty leaves the shares unknown', async () => {
    const expired = liveV2({
      expirationsIncluded: ['2026-10-30'], strikeRows: { inScope: 3, expired: 3, unscoped: 0 },
      expirations: [{ expiration: '2026-10-23', bases: null, reason: 'expired' }, liveV2().expirations[1]],
      totals: liveV2().expirations[1].bases,
    });
    const { out } = await call(answering(expired), {});
    expect(out.exposureScope).toEqual({ asOf: '2026-10-23T14:59:59.000Z', expirationsIncluded: ['2026-10-30'], strikeRowsExpired: 3 });
    expect(out.byExpiration[0]).toMatchObject({ exposures: null, exposuresUnavailable: 'its session had closed when the chain was read, so its legs are out of the book' });
    // the book is the one expiration left in it: all its gamma
    expect(out.byExpiration[1].exposures.shareOfLongOiGex).toBe(1);
    expect(out.guide.exposureScope).toContain('strikeRowsExpired counts');
    const empty = liveV2({ expirations: [liveV2().expirations[0], { expiration: '2026-10-30', bases: null, reason: 'no legs' }] });
    const answered = await call(answering(empty), {});
    expect(answered.out.byExpiration[1]).toMatchObject({ exposures: null, exposuresUnavailable: 'the broker answered it with no contracts' });
    expect(answered.out.byExpiration[0].exposures.shareOfLongOiGex).toBeNull();
    // a date the book does not hold at all is said so in words
    const absent = await call(answering(liveV2({ expirations: [liveV2().expirations[0]] })), {});
    expect(absent.out.byExpiration[1]).toMatchObject({ exposures: null, exposuresUnavailable: 'not in the book the route sent' });
  });

  test('every leg past its close: an empty book is said so, never a complete zero', async () => {
    const zero = { call: side(0, 0, 0, 0, 0), put: side(0, 0, 0, 0, 0), coverage: coverage({}, 0), dexBalance: 0 };
    const v2 = liveV2({
      expirationsIncluded: [], strikeRows: { inScope: 0, expired: 6, unscoped: 0 }, totals: zero, strikes: [],
      expirations: EXPIRATIONS.map((expiration) => ({ expiration, bases: null, reason: 'expired' })),
    });
    const { out } = await call(answering(v2), {});
    expect(out.exposures).toBeNull();
    expect(out.exposuresUnavailable).toContain('each had passed its expiration session\'s close');
    expect(out.exposureScope).toEqual({ asOf: '2026-10-23T14:59:59.000Z', expirationsIncluded: [], strikeRowsExpired: 6 });
    expect(out.guide.sameDayNamed ?? '').not.toContain('inside the totals');
  });

  test('the rows are chosen from the book\'s strikes: a level\'s strike outside the window is returned at the level, from the book', async () => {
    const body = routeBody();
    (body.snapshot as any).callWall = 130;
    const strikes = [...liveV2().strikes, { ...liveV2().strikes[0], strike: 130 }];
    const { out } = await call(answering(liveV2({ strikes }), body), { strikeRange: 2 });
    expect(out.strikes.nearSpot.map((r: any) => r.strike)).toEqual([95, 100]);
    expect(out.strikes.atLevels).toEqual([{ levels: ['callWall'], strike: 130, gex: 2000, putMinusCallDeltaBalance: -1500.5, vegaExposure: 60, callOpenInterest: 600, putOpenInterest: 200, callDelta: null, putDelta: null }]);
    expect(out.strikes.total).toBe(4);
    // the levels key their strikes to the cent; the book keeps a sub-cent strike its own: a level names each strike at it
    const subCent = [...liveV2().strikes, { ...liveV2().strikes[0], strike: 129.996 }, { ...liveV2().strikes[0], strike: 130.004 }];
    const atCent = await call(answering(liveV2({ strikes: subCent }), body), { strikeRange: 2 });
    expect(atCent.out.strikes.atLevels.map((r: any) => [r.levels, r.strike])).toEqual([[['callWall'], 129.996], [['callWall'], 130.004]]);
    expect(atCent.out.guide.rowsAtLevels).toContain('to the cent');
    expect(out.guide.rowsAtLevels).toContain('the book\'s strikes at it to the cent, where the book holds any');
    expect(out.guide.rowsAtLevels).not.toContain('strikes.total');
    // a delta band reads the book's deltas
    const banded = liveV2({ strikes: liveV2().strikes.map((s) => ({ ...s, deltasByExpiration: s.strike === 105 ? [{ expiration: '2026-10-23', call: 0.05, put: -0.95 }] : s.deltasByExpiration })) });
    const band = await call(answering(banded), { strikeWindowDelta: 0.1 });
    expect(band.out.strikes.nearSpot.map((r: any) => r.strike)).toEqual([95, 100]);
  });

  test('a wide book stays under the response ceiling, the rows dropped farthest first and said so', async () => {
    const strikes = Array.from({ length: 1600 }, (_, i) => ({
      strike: 50 + i * 0.5, bases: wire(side(3000.123456, 70.5, 50.25, 30.125, 20.0625), side(1000.5, 10.25, -20.125, -60.0625, 90.03125), -1500.123456, { gamma: [3, 4] }),
      callOpenInterest: 123456, putOpenInterest: 654321, deltasByExpiration: [],
    }));
    const { out, text } = await call(answering(liveV2({ strikes })), { strikeRange: 150 });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(49_152);
    expect(out.strikes.limitedBySize).toBe(true);
    expect(out.guide.rowsLimited).toContain('dropped farthest from spot first');
    expect(out.strikes.returned).toBeGreaterThan(60);
    expect(out.bookNote).toBe(`${BOOK_NOTE} ${LIVE_V2_NOTE}`);
  });
});
