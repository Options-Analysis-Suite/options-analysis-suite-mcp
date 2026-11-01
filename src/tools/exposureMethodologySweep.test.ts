import { describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RETIRED_METHODOLOGY_TOOLS, refusingRetiredMethodology, registerAllTools } from './registry.js';
import { z } from 'zod';
import { getMcpServerInfo } from '../server.js';
import { SERVER_INSTRUCTIONS } from '../serverInstructions.js';
import { readFileSync } from 'node:fs';

// Greek exposure methodology v2:
// one sweep over every exposure tool, through the registered tools (the registry's wrapper included) and a mocked proxy.
// Every number of the earlier calculation in the proxy's answers is a sentinel of S1, every number of the book one of S2,
// so a leak is found by its value whatever field carries it (the batch and the screens keep the names netGex and netDex
// for the book):
// - no answer carries a label or a method's name, and no S1 number appears outside a `levels` object (the gamma-derived
//   levels, their strikes included); the book's numbers reach every answer;
// - a call naming `methodology` is refused as an invalid argument before any read, and each tool publishes the schema it
//   did before less that property (plus additionalProperties);
// - no tool reads a platform default.

/** The earlier calculation's numbers, as the legacy routes send them */
const v1 = (k: number) => 7_100_000_000 + k;
/** The book's: each base on the call side alone (the put side 0), so the twin's outputs are the bases themselves */
const v2 = (k: number) => 8_200_000_000 + k;
const S1 = new Set(Array.from({ length: 60 }, (_, k) => v1(k)).flatMap((n) => [n, -n]));
const S2 = new Set(Array.from({ length: 60 }, (_, k) => v2(k)).flatMap((n) => [n, -n]));

const METRICS = ['gamma', 'delta', 'vega', 'vanna', 'charm', 'vomma'] as const;
const complete = (n = 4) => Object.fromEntries(METRICS.map((m) => [m, { included: n, total: n }]));
const zeroSide = { gex: 0, dex: 0, vega: 0, vanna: 0, charmFixedRef: 0, rollBasis: null, charm: 0, vomma: 0 };
/** One book of wire bases whose twin reads gex v2(1), vegaExposure v2(2), vanna v2(3), charmFlow -v2(4), vomma v2(5), balance v2(6) */
const wire = (n = 4) => ({
  call: { gex: v2(1), dex: 0, vega: v2(2), vanna: v2(3), charmFixedRef: v2(4), rollBasis: null, charm: v2(4), vomma: v2(5) },
  put: zeroSide, coverage: complete(n), dexBalance: v2(6),
});
const daily = { available: true, provenance: 'nightly', referenceKind: 'spot', roll: { status: 'notApplicable', carry: null }, bases: wire(), definition: 'expiry-scoped', expiryQualifier: null };

// ---- the routes' answers ----
const v1Gex = { spotPrice: 671.2, netGamma: v1(1), netDelta: v1(2), netVega: v1(3), netVanna: v1(4), netCharm: v1(5), netVomma: v1(6), callWall: 680, putWall: 660, gammaFlip: 668.5, absGamma: 670, regime: 'positive', topStrikes: [{ strike: 670, netGamma: v1(7), callGamma: v1(8), putGamma: v1(9) }] };
const v2Block = (expiryScope: string) => ({
  methodology: 2, rollModel: 'log-forward-theil-sen-v1', asOf: '2026-10-23', source: 'scan_strikes', scope: { expirations: 'all' }, referenceKind: 'spot', charmTimeBasis: 'calendar-day',
  rollStatus: 'notApplicable', carry: null, carryFit: null, expiryScope,
  assumedDealerBook: { gex: v2(1), vegaExposure: v2(2), vanna: v2(3), charmFlow: v2(4), vomma: v2(5) },
  longOi: { gex: v2(11), vegaExposure: v2(12), vanna: v2(13), charmFlow: v2(14), vomma: v2(15) },
  putMinusCallDeltaBalance: v2(6),
  coverage: Object.fromEntries(METRICS.map((m) => [m, { included: 9, total: 9, status: 'complete' }])),
});
const meta = { gex: v1Gex, gexV2: v2Block('eod-session-1') };
const regimeSymbol = { symbol: 'SPY', scope: 'market', history: [{ date: '2026-10-23', label: 'NORMAL', stress_score: 0.2, confidence: 0.8, drivers: [], vector: { _meta: { models_succeeded: 8, models_attempted: 8, ...meta } } }] };
const regimeIntraday = { symbol: 'SPY', count: 1, scans: [{ date: '2026-10-23', scan_time: '2026-10-23T15:00:00.000Z', interval: 'morning', scope: 'bellwether', label: 'NORMAL', stress_score: 0.2, confidence: 0.8, drivers: [], vector: { _meta: { gex: v1Gex, gexV2: { ...v2Block('intraday-clock-1'), source: 'intraday_chain' } } } }] };
const regimeMarket = { market: { date: '2026-10-23', stress_score: 0.2, label: 'NORMAL', confidence: 0.8, drivers: [], vector: { _meta: meta } } };

const screenV1 = { type: 'ticker', data: [{ symbol: 'SPY', netGex: v1(20), spotPrice: 671.2 }] };
const screenV2 = { methodology: 2, exposure: { view: 'assumedDealerBook', p: 1, expiryScope: 'eod-session-1', expirations: 'all' }, type: 'ticker', data: [{ symbol: 'SPY', netGex: v2(1), exposureStatus: { netGex: 'complete' }, spotPrice: 671.2 }] };

const historyRow = (withV2: boolean) => ({
  date: '2026-10-23', spot_price: 671.2, atm_iv: 0.15, iv_rank: 0.3, put_call_ratio: 1.1,
  net_gex: v1(21), net_dex: v1(22), net_vex: v1(23), net_vanna: v1(24), net_charm: v1(25), net_vomma: v1(26), gamma_concentration: 0.12,
  ...(withV2 ? { exposureV2: daily } : {}),
});

const assetBlock = { available: true, methodology: 2, date: '2026-10-23', computeRunId: 'run-1', referenceKind: 'spot', scope: 'all expirations', roll: { status: 'notApplicable', carry: null }, totals: wire(), strikes: [{ strike: 670, bases: wire() }], definition: 'expiry-scoped', expiryQualifier: null };
const snapshot = {
  ticker: 'SPY', date: '2026-10-23', spotPrice: 671.2, maxPain: 670, netGex: v1(30), netDex: v1(31), atmIv: 0.15, putCallRatio: 1.1, ivRank: 0.4,
  gexByStrike: [{ strike: 670, callGex: v1(32), putGex: v1(33), netGex: v1(34) }], dexByStrike: [{ strike: 670, netDex: v1(35) }],
  maxPainCurve: [], volSkew: [], analyticsExpiry: '2026-11-20', chainExpiry: '2026-10-24', exposureV2: assetBlock,
};
const batchV1 = { count: 2, data: [{ symbol: 'AAA', date: '2026-10-23', atmIv: 0.2, netGex: v1(36), netDex: v1(37) }, { symbol: 'BBB', date: '2026-10-23', atmIv: 0.3, netGex: v1(38), netDex: v1(39) }] };
const valued = (value: number) => ({ value, status: 'complete' });
const batchV2 = {
  methodology: 2, exposure: { view: 'assumedDealerBook', p: 1, expiryScope: 'eod-session-1', expirations: 'all' }, count: 2,
  data: ['AAA', 'BBB'].map((symbol) => ({ symbol, date: '2026-10-23', atmIv: 0.2, exposureV2: { available: true, netGex: valued(v2(1)), netDex: valued(v2(6)), referenceKind: 'spot', charmBasis: 'cash' } })),
};

const eod = (withV2: boolean) => ({
  schemaVersion: 1, symbol: 'SPY', date: '2026-10-23', asOf: '2026-10-23T21:40:00Z', source: 'eod_options_snapshot',
  dteWindow: { minDte: 0, maxDte: 60, unit: 'calendar_days' }, spotPrice: 764.03, netGex: v1(40), netDex: v1(41),
  gammaMagnet: 761, gammaFlip: 771.58, callWall: 765, putWall: 760, dealerRegime: 'negative_gamma',
  expectedMovePct30d: 0.0388, expectedMove30d: 29.66, topContributingStrikes: [{ strike: 765, netGex: v1(42), netDex: v1(43) }], topContributingStrikesLimit: 10,
  units: { netGex: 'USD per 1% move', netDex: 'USD' },
  sincePriorSession: {
    status: 'found', priorDate: '2026-10-22', sessionsSkipped: 0, dealerRegimeChanged: false,
    prior: { spotPrice: 765.54, netGex: v1(44), netDex: v1(45), gammaFlip: 772.75, callWall: 785, putWall: 765, gammaMagnet: 765, dealerRegime: 'negative_gamma' },
    change: { spotPrice: -1.51, netGex: v1(46), netDex: v1(47), gammaFlip: -1.17, callWall: -20, putWall: 0, gammaMagnet: -4 },
    ...(withV2 ? { exposureV2: { status: 'found', priorDate: '2026-10-22', sessionsSkipped: 0, prior: daily } } : {}),
  },
  ...(withV2 ? { exposureV2: daily } : {}),
});

const legs = (n: number) => ({ total: n, included: n });
const liveBody = (withV2: boolean) => ({
  schemaVersion: 1, symbol: 'SPY', dataSource: 'live', provider: 'tradier', asOf: '2026-10-23T15:00:00.000Z',
  expirations: ['2026-10-30'], expirationSelection: 'nearest', expirationsAvailable: 9, strikesUsed: 1,
  coverage: { strikes: 1, strikesWithGamma: 1, strikesWithDelta: 1, ...Object.fromEntries([...METRICS, 'gammaFlip'].map((m) => [m, legs(2)])), gammaFlipMethod: 'repriced', gammaFlipResolution: 0.02, gammaFlipSearchStatus: 'found' },
  resolved: { S: { value: 100, source: 'broker-tradier', asOf: '2026-10-23T14:59:00Z', stale: false }, r: { value: 0.04, source: 'fred', asOf: '2026-10-22' }, q: { value: 0.01, source: 'supplied', asOf: null } },
  snapshot: { spotPrice: 100, gammaFlip: 98.5, netGamma: v1(50), netDelta: v1(51), netVega: v1(52), netVanna: v1(53), netCharm: v1(54), netVomma: v1(55), callWall: 100, putWall: 100, absGamma: 100, gammaConcentration: 1, regime: 'positive', topStrikes: [] },
  byStrike: [{ strike: 100, netGamma: v1(56), callGamma: v1(57), putGamma: v1(58), netDelta: v1(59), netVega: v1(19), coverage: { gamma: legs(2), delta: legs(2), vega: legs(2) }, callOpenInterest: 600, putOpenInterest: 200, deltasByExpiration: [] }],
  // the earlier split at spot carries its own sentinels, so a side leaking is seen
  spotSides: { atSpotStrike: null, above: { strikes: 1, netGamma: v1(15), callGamma: v1(16), putGamma: v1(17), gammaCoverage: legs(2), callOpenInterest: 600, callOpenInterestCoverage: legs(1), putOpenInterest: 200, putOpenInterestCoverage: legs(1) }, below: { strikes: 1, netGamma: v1(18), callGamma: v1(27), putGamma: v1(28), gammaCoverage: legs(2), callOpenInterest: 600, callOpenInterestCoverage: legs(1), putOpenInterest: 200, putOpenInterestCoverage: legs(1) }, callOpenInterestShareAbove: 0.5 },
  byExpiration: [{ expiration: '2026-10-30', daysToExpiration: 7, netGamma: v1(10), netDelta: v1(11), callGamma: v1(12), putGamma: v1(13), grossGamma: v1(14), shareOfGrossGamma: 1, coverage: { gamma: legs(2), delta: legs(2) }, expectedMove: null, expectedMoveUnavailable: 'atm-quote-missing', events: null }],
  events: null,
  ...(withV2 ? {
    exposureV2: {
      available: true, methodology: 2, referenceKind: 'spot', roll: { status: 'notApplicable', carry: null }, expiryScope: 'intraday-clock-1', scopeAsOf: '2026-10-23T14:59:59.000Z',
      expirationsIncluded: ['2026-10-30'], strikeRows: { inScope: 1, expired: 0, unscoped: 0 }, totals: wire(2),
      strikes: [{ strike: 100, bases: wire(2), callOpenInterest: 600, putOpenInterest: 200, deltasByExpiration: [] }],
      expirations: [{ expiration: '2026-10-30', bases: wire(2) }],
      spotSides: { atSpotStrike: null, callOpenInterestShareAbove: 0.5, above: { strikes: 1, bases: wire(2), callOpenInterest: 600, callOpenInterestCoverage: legs(1), putOpenInterest: 200, putOpenInterestCoverage: legs(1) }, below: { strikes: 1, bases: wire(2), callOpenInterest: 600, callOpenInterestCoverage: legs(1), putOpenInterest: 200, putOpenInterestCoverage: legs(1) } },
    },
  } : {}),
});

/** The GEX page's saved records: one saved on the assumed dealer book at a dealer share of 0.85, one from before the page recorded any */
const savedGex = [
  { symbol: 'SPY', timestamp: 2, data: { symbol: 'SPY', totalGammaExposure: 5, methodology: 2, savedBook: { view: 'assumedDealerBook', p: 0.85 } } },
  { symbol: 'SPY', timestamp: 1, data: { symbol: 'SPY', totalGammaExposure: 7 } },
];

/** The mocked proxy: each route's earlier answer, or its book one when the tool opts in */
function answer(path: string, params: Record<string, string> = {}): unknown {
  const opted = params.exposure === 'v2';
  if (path.startsWith('/regime/symbol/')) return regimeSymbol;
  if (path.startsWith('/regime/intraday/')) return regimeIntraday;
  if (path === '/regime/current') return regimeMarket;
  if (path === '/history') {
    // the route's provenance (history-backtest.ts buildAssetHistoryProvenance), its id naming the opt-in and the revision
    const id = `history:SPY:auto:latest:2026-10-23:2026-10-23:1:sig${opted ? ':v2:v2rev=3' : ''}`;
    const prov = { provider: 'supabase', source: 'option_ticker_snapshots', historySnapshotId: id, snapshotId: id, fetchedAt: '2026-10-23T21:00:00.000Z', fromCache: false };
    return { symbol: 'SPY', data: [historyRow(opted)], ...prov, metadata: prov, provenance: prov };
  }
  if (path.startsWith('/scanner/snapshot/')) return snapshot;
  if (path === '/scanner/metrics/batch') return opted ? batchV2 : batchV1;
  if (path.startsWith('/scanner/')) return opted ? screenV2 : screenV1;
  if (path.startsWith('/eod/exposure/')) return eod(opted);
  if (path.startsWith('/live/exposure/')) return liveBody(opted);
  if (path === '/sync/analysis-data' && params.type === 'gex') return { data: savedGex };
  if (path === '/sync/analysis-data') return { data: [{ data: { summary: {} } }], count: 1 };
  return {};
}

async function withClient<T>(fake: unknown, use: (client: Client) => Promise<T>): Promise<T> {
  const server = new McpServer(getMcpServerInfo());
  registerAllTools(server, fake as any, { getAccessToken: async () => 'token' } as any, fake as any);
  const client = new Client({ name: 'u12-sweep', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    return await use(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function run(name: string, args: Record<string, unknown>) {
  const paths: Array<{ path: string; params?: Record<string, string> }> = [];
  const fake = {
    get: async (path: string, params?: Record<string, string>) => {
      paths.push({ path, params });
      return structuredClone(answer(path, params));
    },
    post: async () => ({}),
  };
  return withClient(fake, async (client) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    let out: Record<string, any> | null = null;
    try { out = result.isError ? null : JSON.parse(text); } catch { /* a text answer (get_platform_info) */ }
    return { isError: result.isError === true, text, out, paths };
  });
}

/** Every number in a value, with whether it sits inside a `levels` object */
function numbers(value: unknown, inLevels = false, out: Array<{ n: number; inLevels: boolean }> = []) {
  if (typeof value === 'number') out.push({ n: value, inLevels });
  else if (Array.isArray(value)) value.forEach((v) => numbers(v, inLevels, out));
  else if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) numbers(v, inLevels || key === 'levels', out);
  return out;
}
/** Every key in a value (the guide's line names are prose keys, not fields) */
function keys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keys(v, out));
  else if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) { if (key === 'guide') continue; out.push(key); keys(v, out); }
  return out;
}
const LABELS = ['methodology', 'methodologySource', 'methodologyStale', 'exposuresWithheld', 'methodologyNote'];
const NAMES_A_METHOD = /[Mm]ethodolog|\bv2\b|V2/;

const CASES: Array<[string, Record<string, unknown>]> = [
  ['get_regime', { scope: 'symbol', symbol: 'SPY' }],
  ['get_regime', { scope: 'intraday', symbol: 'SPY', days: 1 }],
  ['get_regime', { scope: 'market' }],
  ['run_screener', { screener: 'gex' }],
  ['get_options_analytics_history', { symbol: 'SPY', days: 5 }],
  ['get_options_snapshot', { symbols: 'SPY', curves: ['gex', 'dex'] }],
  ['get_options_snapshot', { symbols: 'AAA,BBB', rankBy: 'netGex' }],
  ['get_dealer_positioning', { symbol: 'SPY' }],
  ['get_live_dealer_positioning', { symbol: 'SPY' }],
];
/** The tools whose proxy route takes the book's opt-in (the regime routes and the single snapshot always send it) */
const OPTS_IN = new Set(['run_screener', 'get_options_analytics_history', 'get_dealer_positioning', 'get_live_dealer_positioning']);

describe('every exposure tool answers the one calculation', () => {
  for (const [name, args] of CASES) {
    const label = `${name} ${JSON.stringify(args)}`;
    test(`${label}: the book, no label, no earlier number outside levels, no method named`, async () => {
      const { isError, text, out, paths } = await run(name, args);
      expect(isError, `${label} ${text.slice(0, 300)}`).toBe(false);
      for (const key of LABELS) expect(keys(out), `${label}: ${key}`).not.toContain(key);
      const found = numbers(out);
      expect(found.filter(({ n, inLevels }) => S1.has(n) && !inLevels).map(({ n }) => n), `${label}: an earlier number outside levels`).toEqual([]);
      expect(found.some(({ n }) => S2.has(n)), `${label}: no book number`).toBe(true);
      expect(text, label).not.toMatch(NAMES_A_METHOD);
      expect(paths.map((p) => p.path), label).not.toContain('/exposure/methodology');
      if (OPTS_IN.has(name) || (name === 'get_options_snapshot' && String(args.symbols).includes(','))) {
        expect(paths.every((p) => p.params?.exposure === 'v2'), `${label}: every read asks for the book`).toBe(true);
      }
    });
  }

  test('a call naming methodology is refused as an invalid argument, null included, before any read', async () => {
    for (const name of RETIRED_METHODOLOGY_TOOLS) {
      const args = CASES.find(([n]) => n === name)![1];
      for (const methodology of [1, 2, null, '2']) {
        const { isError, text, paths } = await run(name, { ...args, methodology });
        expect(isError, `${name} ${methodology}`).toBe(true);
        expect(text).toBe(`MCP error -32602: Input validation error: Invalid arguments for tool ${name}: methodology is no longer a parameter: exposure has one calculation.`);
        expect(paths, `${name} read before refusing`).toEqual([]);
      }
      // an unknown other key is still stripped, as the strict parse did
      const plain = await run(name, args);
      const extra = await run(name, { ...args, notAParameter: 1 });
      expect(extra.isError, name).toBe(false);
      expect(extra.paths, name).toEqual(plain.paths);
      expect(extra.text, name).toBe(plain.text);
    }
    // an invalid argument of the shape still fails its own validation
    const bad = await run('get_regime', { scope: 'nowhere' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^MCP error -32602: Input validation error: Invalid arguments for tool get_regime:/);
  });

  test('the wrapper hands the handler only its shape\'s keys, refuses an owned methodology, and refuses a shape that keeps one', () => {
    const seen: unknown[] = [];
    const shape = { symbol: z.string(), days: z.number().optional() };
    const [config, handler] = refusingRetiredMethodology('a_tool', { inputSchema: shape }, [(args: unknown) => { seen.push(args); return 'ok'; }]) as [{ inputSchema: z.ZodTypeAny }, (args: unknown, extra: unknown) => unknown];
    expect(config.inputSchema.safeParse({ symbol: 'X', methodology: 2 }).success).toBe(true);
    expect(handler({ symbol: 'X', notAParameter: 1, constructor: 'y' }, {})).toBe('ok');
    expect(handler(undefined, {})).toBe('ok');
    expect(seen).toEqual([{ symbol: 'X' }, {}]);
    // a JSON-parsed __proto__ is an own key and still never reaches the handler
    handler(JSON.parse('{"symbol":"X","__proto__":{"days":3}}'), {});
    expect(seen[2]).toEqual({ symbol: 'X' });
    for (const methodology of [1, null, undefined]) {
      expect(() => handler({ symbol: 'X', methodology }, {})).toThrow('Input validation error: Invalid arguments for tool a_tool: methodology is no longer a parameter: exposure has one calculation.');
    }
    expect(seen).toHaveLength(3);
    expect(() => refusingRetiredMethodology('a_tool', { inputSchema: { ...shape, methodology: z.number() } }, [() => 0])).toThrow('expected a raw input shape without methodology');
    expect(() => refusingRetiredMethodology('a_tool', { inputSchema: z.object(shape) }, [() => 0])).toThrow('expected a raw input shape without methodology');
  });

  test('each tool publishes the schema it did before, less methodology, plus additionalProperties', async () => {
    const before = JSON.parse(readFileSync(new URL('./__fixtures__/exposureToolInputSchemas.json', import.meta.url), 'utf8')) as Record<string, any>;
    // the one description rewritten with the calculation: the migration's gamma figure is the book's GEX
    before.get_regime.properties.migration.description = 'For scope=intraday only: add each scan\'s `migration`, the change in its gamma flip, call wall, put wall, gamma magnet and the assumed book\'s GEX since the previous scan with levels (direction, change, percent of spot, per hour). Default false.';
    const listed = await withClient({ get: async () => ({}), post: async () => ({}) }, async (client) => (await client.listTools()).tools as any[]);
    expect(Object.keys(before).sort()).toEqual([...RETIRED_METHODOLOGY_TOOLS].sort());
    for (const name of RETIRED_METHODOLOGY_TOOLS) {
      const { additionalProperties, ...schema } = listed.find((t) => t.name === name)!.inputSchema;
      expect(additionalProperties, name).toEqual({});
      expect(schema, name).toEqual(before[name]);
    }
    expect(listed.filter((t) => t.inputSchema?.properties?.methodology).map((t) => t.name)).toEqual([]);
  });

  // a compute run's sweep label needs a whole validated run: computeRuns.test.ts pins it through the tool
  test('the saved records state their own calculation, from their own field, and the note only what they hold', async () => {
    const saved = await run('get_snapshot', { type: 'gex', symbol: 'SPY' });
    expect(saved.out!.data.map((record: any) => record.data.exposureCalculation)).toEqual(['assumedDealerBook', 'earlierDealerHedging']);
    for (const record of saved.out!.data) expect(record.data).not.toHaveProperty('methodology');
    expect(saved.out!.data[0].data.savedBook).toEqual({ view: 'assumedDealerBook', p: 0.85 });
    expect(saved.out!.gexRecordsNote).toContain('at the share of open interest in data.savedBook.p');
    expect(saved.out!.gexRecordsNote).toContain('saved before the page moved to the assumed dealer book (October 2026): its totals are in the earlier dealer-hedging convention and are not comparable with later records.');
    expect(saved.text).not.toMatch(NAMES_A_METHOD);
    for (const key of LABELS) expect(keys(saved.out)).not.toContain(key);
  });

  test('the README and the manifest state no scope the answers would contradict, and name no method', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const manifest = readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8');
    for (const [name, text] of [['README', readme], ['manifest', manifest]]) {
      expect(text, name).not.toContain('every expiration after the session');
      expect(text, name).not.toMatch(/legs still trading/);
      expect(text, name).not.toMatch(NAMES_A_METHOD);
    }
    expect(readme).toContain('over the legs whose expiration session had not closed when the chain was read');
    // the book is not inside the 0-60 day window
    expect(manifest).toContain('the stored assumed dealer book over the scope the answer states, and the 0-60 day dealer regime');
  });

  test('the tools with their own figures never ask for the book', async () => {
    for (const [name, args] of [
      ['scan_option_strategies', { symbol: 'SPY', expiration: '2026-11-20', strategy: 'short_put' }],
      ['rank_live_skew_gex', { symbols: 'SPY' }],
      ['get_snapshot', { type: 'gex', symbol: 'SPY' }],
      ['get_compute_runs', {}],
    ] as const) {
      const { paths } = await run(name, args);
      expect(paths.map((p) => p.path), name).not.toContain('/exposure/methodology');
      expect(paths.some((p) => p.params?.exposure === 'v2'), name).toBe(false);
    }
  });

  test('the shared texts: the server instructions and the platform info describe the one calculation and its charm', async () => {
    // The book is the market-data tools'; a saved record or run states its own calculation
    expect(SERVER_INSTRUCTIONS).toContain('The market-data tools\' exposure figures are the assumed dealer book\'s (dealers long the calls and short the puts; Long OI beside it where sent); a saved GEX record or compute run states its own calculation (exposureCalculation), and rank_live_skew_gex\'s GEX is its own model\'s: compare none of these with another.');
    expect(SERVER_INSTRUCTIONS).not.toMatch(NAMES_A_METHOD);
    const info = await run('get_platform_info', { topic: 'all' });
    const text = info.text;
    expect(text).not.toMatch(NAMES_A_METHOD);
    // the screens keep their row names for the book's numbers, netCharm among them
    expect(text).toContain('the exposure tools send charm flow - charmFlow, or netCharm on run_screener\'s rows, which keep their names - the assumed dealer book\'s hedge flow per calendar day (+ is the book\'s delta hedger buying), a flow, not a time Greek.');
    expect(text).toContain('run_screener\'s rows keep the names netGex, netDex, netVex, netVanna, netCharm and netVomma for them, and get_options_snapshot\'s several-symbol rows netGex and netDex');
    // no scope stated that a qualified legacy row would contradict
    expect(text).not.toContain('every expiration after the session');
    expect(text).toContain('A saved GEX snapshot and a compute run\'s exposure sweep state their own calculation (exposureCalculation): earlierDealerHedging carries dealer dollar charm per calendar day on the remaining-maturity sign for the dealer');
    expect(text).toContain('- Exposure: the market-data tools\' exposure figures are the assumed dealer book (dealers long the calls and short the puts, every contract of open interest), Long OI beside it where sent');
    expect(text).toContain('A saved GEX snapshot and a compute run state their own calculation (exposureCalculation), which can be the earlier dealer-hedging one.');
    expect(text).toContain('The gamma-derived levels (gamma flip, walls, magnet, dealer regime) are their own computation, none derived from the book.');
  });
});
