import { describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools } from './registry.js';
import { getMcpServerInfo } from '../server.js';
import { SERVER_INSTRUCTIONS } from '../serverInstructions.js';
import { readFileSync } from 'node:fs';

// Greek exposure methodology v2: one sweep over
// every tool that takes a methodology, through the registered tools and a mocked proxy. Every methodology-1 book number
// in the proxy's answers is a sentinel of S1, every methodology-2 book number one of S2, so a leak is found by its value
// whatever field carries it (the batch and the screens keep the names netGex and netDex for methodology 2's book):
// - every answer names its methodology and where it came from;
// - under 2 no S1 number appears outside a `levels` object (methodology 1's labeled levels, their strikes included);
// - under 1 no S2 number appears, nor a field only methodology 2 sends.
// The tools that take no methodology (their figures are their own engine's, or methodology 1's labeled) never read the
// platform default.

/** Methodology 1's book numbers, as the legacy routes send them */
const v1 = (k: number) => 7_100_000_000 + k;
/** Methodology 2's: each base on the call side alone (the put side 0), so the twin's outputs are the bases themselves */
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
  // methodology 1's split at spot carries its own sentinels, so a side leaking under 2 is seen (review)
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

/** The GEX page's saved records: one saved under methodology 2 at a dealer share of 0.85, one from before the page recorded any */
const savedGex = [
  { symbol: 'SPY', timestamp: 2, data: { symbol: 'SPY', totalGammaExposure: 5, methodology: 2, savedBook: { view: 'assumedDealerBook', p: 0.85 } } },
  { symbol: 'SPY', timestamp: 1, data: { symbol: 'SPY', totalGammaExposure: 7 } },
];

/** The mocked proxy: each route's methodology-1 answer, or its methodology-2 one when the tool opts in */
function answer(path: string, params: Record<string, string> = {}): unknown {
  const opted = params.exposure === 'v2';
  if (path.startsWith('/regime/symbol/')) return regimeSymbol;
  if (path.startsWith('/regime/intraday/')) return regimeIntraday;
  if (path === '/regime/current') return regimeMarket;
  if (path === '/history') return { symbol: 'SPY', data: [historyRow(opted)] };
  if (path.startsWith('/scanner/snapshot/')) return snapshot;
  if (path === '/scanner/metrics/batch') return opted ? batchV2 : batchV1;
  if (path.startsWith('/scanner/')) return opted ? screenV2 : screenV1;
  if (path.startsWith('/eod/exposure/')) return eod(opted);
  if (path.startsWith('/live/exposure/')) return liveBody(opted);
  if (path === '/sync/analysis-data' && params.type === 'gex') return { data: savedGex };
  if (path === '/sync/analysis-data') return { data: [{ data: { summary: {} } }], count: 1 };
  return {};
}

async function run(name: string, args: Record<string, unknown>, defaultMethodology: 1 | 2 = 1) {
  const paths: Array<{ path: string; params?: Record<string, string> }> = [];
  const fake = {
    get: async (path: string, params?: Record<string, string>) => {
      paths.push({ path, params });
      if (path === '/exposure/methodology') return { defaultMethodology, stale: false };
      return structuredClone(answer(path, params));
    },
    post: async () => ({}),
  } as any;
  const server = new McpServer(getMcpServerInfo());
  registerAllTools(server, fake, { getAccessToken: async () => 'token' } as any, fake);
  const client = new Client({ name: 'u10-sweep', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    let out: Record<string, any> | null = null;
    try { out = result.isError ? null : JSON.parse(text); } catch { /* a text answer (get_platform_info) */ }
    return { isError: result.isError === true, text, out, paths };
  } finally {
    await client.close();
    await server.close();
  }
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
/** Fields only a methodology-2 answer sends */
const V2_ONLY = ['charmFlow', 'vegaExposure', 'putMinusCallDeltaBalance', 'longOi', 'longOiGex', 'shareOfLongOiGex', 'exposureScope', 'exposuresCommon', 'methodologyNote', 'charmBasis'];

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

describe('every tool that takes a methodology, swept under both', () => {
  for (const [name, args] of CASES) {
    const label = `${name} ${JSON.stringify(args)}`;
    for (const methodology of [1, 2] as const) {
      test(`${label}: named ${methodology}, and by the default ${methodology}`, async () => {
        for (const [call, source] of [[{ ...args, methodology }, 'requested'], [args, 'default']] as const) {
          const { isError, text, out } = await run(name, call, methodology);
          expect(isError, `${label} ${text.slice(0, 300)}`).toBe(false);
          expect(out!.methodology, label).toBe(methodology);
          expect(out!.methodologySource, label).toBe(source);
          const found = numbers(out);
          if (methodology === 2) {
            expect(found.filter(({ n, inLevels }) => S1.has(n) && !inLevels).map(({ n }) => n), `${label}: methodology 1 outside levels`).toEqual([]);
            // the book reached the answer
            expect(found.some(({ n }) => S2.has(n)), `${label}: no methodology-2 number`).toBe(true);
          } else {
            expect(found.filter(({ n }) => S2.has(n)).map(({ n }) => n), `${label}: a methodology-2 number`).toEqual([]);
            expect(keys(out).filter((key) => V2_ONLY.includes(key)), `${label}: a methodology-2 field`).toEqual([]);
            expect(found.some(({ n }) => S1.has(n)), `${label}: no methodology-1 number`).toBe(true);
          }
        }
      });
    }
  }

  // a compute run's sweep label (methodology 1) needs a whole validated run: computeRuns.test.ts pins it through the tool
  test('the saved records state their own methodology, which a default of 2 never changes', async () => {
    const saved = await run('get_snapshot', { type: 'gex', symbol: 'SPY' }, 2);
    expect(saved.out!.data.map((record: any) => record.data.methodology)).toEqual([2, 1]);
    expect(saved.out!.data[0].data.savedBook).toEqual({ view: 'assumedDealerBook', p: 0.85 });
    expect(saved.out!.methodologyNote).toMatch(/the platform's default does not change it/);
    expect(saved.paths.map((p) => p.path)).not.toContain('/exposure/methodology');
  });

  test('the README and the manifest state no scope the answers would contradict', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const manifest = readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8');
    for (const [name, text] of [['README', readme], ['manifest', manifest]]) {
      expect(text, name).not.toContain('every expiration after the session');
      expect(text, name).not.toMatch(/legs still trading/);
    }
    expect(readme).toContain('over the legs whose expiration session had not closed when the chain was read');
    // the methodology-2 book is not inside the 0-60 day window
    expect(manifest).toContain('net GEX/DEX over 0-60 days (under methodology 2 the stored assumed dealer book, over the scope the answer states) and the 0-60 day dealer regime');
  });

  test('the tools that take no methodology never read the platform default, whatever it is', async () => {
    for (const [name, args] of [
      ['scan_option_strategies', { symbol: 'SPY', expiration: '2026-11-20', strategy: 'short_put' }],
      ['rank_live_skew_gex', { symbols: 'SPY' }],
      ['get_snapshot', { type: 'gex', symbol: 'SPY' }],
      ['get_compute_runs', {}],
    ] as const) {
      const { paths } = await run(name, args, 2);
      expect(paths.map((p) => p.path), name).not.toContain('/exposure/methodology');
      expect(paths.some((p) => p.params?.exposure === 'v2'), name).toBe(false);
    }
  });

  test('the shared texts: the server instructions and the platform info name the methodology and its charm', async () => {
    // the own-model ranking is neither methodology
    expect(SERVER_INSTRUCTIONS).toContain('The tools that take `methodology` (1, legacy, or 2; omitted, the platform default) name the one each answer used; compare exposure figures only within one methodology, and not rank_live_skew_gex\'s GEX (its own model\'s) with either.');
    const info = await run('get_platform_info', { topic: 'all' });
    const text = info.text;
    // the screens keep their row names for methodology 2's numbers, netCharm among them
    expect(text).toContain('Under methodology 2 the exposure tools send charm flow instead - charmFlow, or netCharm on run_screener\'s rows, which keep their names - the assumed dealer book\'s hedge flow per calendar day (+ is the book\'s delta hedger buying), a flow, not a time Greek.');
    expect(text).toContain('run_screener\'s rows keep the names netGex, netDex, netVex, netVanna, netCharm and netVomma for them, and get_options_snapshot\'s several-symbol rows netGex and netDex');
    // no scope stated that a qualified legacy row would contradict
    expect(text).not.toContain('every expiration after the session');
    expect(text).toContain('a compute run\'s exposure sweep is methodology 1\'s on every run (exposureSweepMethodology)');
    expect(text).toContain('- Exposure methodology: get_regime, run_screener, get_options_analytics_history, get_options_snapshot, get_dealer_positioning and get_live_dealer_positioning take `methodology`');
    expect(text).toContain('The gamma-derived levels (gamma flip, walls, magnet, dealer regime) are methodology 1\'s under both, labeled.');
    // the bullet names exactly the tools that take one
    const server = new McpServer(getMcpServerInfo());
    const stub = { get: async () => ({}), post: async () => ({}) } as any;
    registerAllTools(server, stub, { getAccessToken: async () => 'token' } as any, stub);
    const client = new Client({ name: 'u10-sweep-list', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const taking = (await client.listTools()).tools.filter((t: any) => t.inputSchema?.properties?.methodology).map((t) => t.name).sort();
      expect(taking).toEqual(['get_dealer_positioning', 'get_live_dealer_positioning', 'get_options_analytics_history', 'get_options_snapshot', 'get_regime', 'run_screener']);
      expect([...new Set(CASES.map(([name]) => name))].sort()).toEqual(taking);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
