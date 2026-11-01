import { describe, test, expect } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { register, SCREENER_IDS } from './screeners.js';

/**
 * Captures the handler registered with `server.registerTool(...)` so we can
 * invoke it directly and assert on the proxy-GET that results.
 */
type ToolHandler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }> }>;

/** The proxy's book envelope (proxy/routes/scanner.ts v2Answer): what a screen asked for the book must carry */
const BOOK_ENVELOPE = { methodology: 2, exposure: { view: 'assumedDealerBook', p: 1, expiryScope: 'eod-session-1', expirations: 'all' } };

function createHarness(stubResponse: unknown = { data: [], metric: 'stub', currentDate: '2026-04-18' }) {
  const proxyCalls: Array<{ path: string; params?: Record<string, string> }> = [];
  const fakeClient: ProxyClient = {
    get: async (path: string, params?: Record<string, string>) => {
      proxyCalls.push({ path, params });
      // a screen with exposure figures asks for the book; its answer carries the envelope
      return params?.exposure === 'v2' && stubResponse && typeof stubResponse === 'object' ? { ...BOOK_ENVELOPE, ...stubResponse } : stubResponse;
    },
    post: async () => ({}),
  } as unknown as ProxyClient;

  const captured: { handler: ToolHandler | null } = { handler: null };
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, handler: ToolHandler) => {
      captured.handler = handler;
    },
  } as unknown as McpServer;

  register(fakeServer, fakeClient);
  if (!captured.handler) throw new Error('Tool handler not captured');
  return { proxyCalls, handler: captured.handler };
}

async function run(args: Record<string, unknown>) {
  const harness = createHarness();
  await harness.handler(args);
  return harness.proxyCalls[0];
}

describe('run_screener — enum coverage', () => {
  test('exposes 18 screener ids (16 families + market-trends + earnings-calendar)', () => {
    expect(SCREENER_IDS).toHaveLength(18);
  });
});

describe('run_screener — main tab routing with view', () => {
  test.each([
    ['most-active', '/scanner/most-active'],
    ['highest-oi', '/scanner/high-oi'],
    ['highest-iv', '/scanner/high-iv'],
    ['unusual', '/scanner/unusual'],
    ['gex', '/scanner/gex'],
  ])('%s routes to %s with default ticker view', async (screener, expectedPath) => {
    const call = await run({ screener, limit: 20 });
    expect(call.path).toBe(expectedPath);
    expect(call.params?.type).toBe('ticker');
    expect(call.params?.limit).toBe('20');
    expect(call.params?.index).toBe('all');
  });

  test('passes view=contract through for the main tabs with a contract view (the gex screen\'s is refused, below)', async () => {
    const call = await run({ screener: 'most-active', view: 'contract' });
    expect(call.params?.type).toBe('contract');
  });

  test('unusual threshold falls through', async () => {
    const call = await run({ screener: 'unusual', threshold: 2.5 });
    expect(call.params?.threshold).toBe('2.5');
  });
});

describe('run_screener — single-view leaderboards', () => {
  test.each([
    ['model-divergence', '/scanner/model-divergence'],
    ['term-backwardation', '/scanner/term-structure-backwardation'],
    ['delta-exposure', '/scanner/delta-exposure-leaders'],
    ['vega-exposure', '/scanner/vega-exposure-leaders'],
    ['pre-earnings-iv', '/scanner/pre-earnings-iv-expansion'],
  ])('%s routes to %s', async (screener, expectedPath) => {
    const call = await run({ screener });
    expect(call.path).toBe(expectedPath);
  });
});

describe('run_screener — output labels', () => {
  test('regime-stress and the regime dod-change rows show the state as a word with the stored key beside it (2026-10-11)', async () => {
    const harness = createHarness({ data: [{ symbol: 'SPY', label: 'ELEVATED', stressScore: 0.7 }, { symbol: 'QQQ', label: 'STRESS', stressScore: 1.6 }], metric: 'regime-stress-leaders', currentDate: '2026-10-10' });
    const parsed = JSON.parse((await harness.handler({ screener: 'regime-stress' })).content[0].text);
    expect(parsed.data.map((r: any) => [r.label, r.labelKey])).toEqual([['Elevated', 'ELEVATED'], ['Stress', 'STRESS']]);
    const change = JSON.parse((await createHarness({ data: [{ symbol: 'SPY', label: 'NORMAL', stressScore: 0.1, priorLabel: 'CALM' }], metric: 'biggest-regime-stress-change', currentDate: '2026-10-10', priorDate: '2026-10-09' }).handler({ screener: 'dod-change', metric: 'regime' })).content[0].text);
    expect(change.data[0]).toMatchObject({ label: 'Normal', labelKey: 'NORMAL', priorLabel: 'Calm', priorLabelKey: 'CALM' });
  });

  test('regime-stress humanizes backend feature identifiers in topDriver', async () => {
    const harness = createHarness({
      data: [
        { symbol: 'SPY', topDriver: 'skew_pressure' },
        { symbol: 'QQQ', topDriver: 'term_structure' },
        { symbol: 'IWM', topDriver: 'vol_level' },
      ],
    });

    const result = await harness.handler({ screener: 'regime-stress' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.data.map((row: any) => row.topDriver)).toEqual([
      'Skew Pressure',
      'Term Structure',
      'Vol Level',
    ]);
    expect(result.content[0].text).not.toContain('skew_pressure');
    expect(result.content[0].text).not.toContain('term_structure');
  });

  test('model-divergence rows carry their regime state as a word with the key beside it (regimeLabel)', async () => {
    const parsed = JSON.parse((await createHarness({ data: [{ symbol: 'SPY', regimeLabel: 'NORMAL', bestModel: 'heston' }], metric: 'model-divergence', currentDate: '2026-10-10' }).handler({ screener: 'model-divergence' })).content[0].text);
    expect(parsed.data[0]).toMatchObject({ regimeLabel: 'Normal', regimeLabelKey: 'NORMAL' });
  });

  test('model-divergence humanizes model identifiers in best/worst model fields', async () => {
    const harness = createHarness({
      data: [
        { symbol: 'SPY', bestModel: 'merton', worstModel: 'essvi' },
        { symbol: 'QQQ', bestModel: 'heston', worstModel: 'kou' },
      ],
    });

    const result = await harness.handler({ screener: 'model-divergence' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.data).toEqual([
      { symbol: 'SPY', bestModel: 'Merton', worstModel: 'ESSVI' },
      { symbol: 'QQQ', bestModel: 'Heston', worstModel: 'Kou' },
    ]);
    expect(result.content[0].text).not.toContain('"merton"');
    expect(result.content[0].text).not.toContain('"essvi"');
  });
});

describe('run_screener — regime-stress and put-skew always route to mode=level', () => {
  test('regime-stress without metric -> mode=level', async () => {
    const call = await run({ screener: 'regime-stress' });
    expect(call.path).toBe('/scanner/regime-stress');
    expect(call.params?.mode).toBe('level');
  });

  test('put-skew without metric -> mode=level', async () => {
    const call = await run({ screener: 'put-skew' });
    expect(call.path).toBe('/scanner/skew');
    expect(call.params?.mode).toBe('level');
  });

  test('regime-stress ignores a stray metric=regime (does NOT silently switch to mode=change)', async () => {
    const call = await run({ screener: 'regime-stress', metric: 'regime' });
    expect(call.path).toBe('/scanner/regime-stress');
    expect(call.params?.mode).toBe('level');
  });

  test('put-skew ignores a stray metric=skew (does NOT silently switch to mode=change)', async () => {
    const call = await run({ screener: 'put-skew', metric: 'skew' });
    expect(call.path).toBe('/scanner/skew');
    expect(call.params?.mode).toBe('level');
  });
});

describe('run_screener — dod-change', () => {
  test.each([
    ['gex', '/scanner/changes/gex'],
    ['iv', '/scanner/changes/iv'],
    ['put-call', '/scanner/changes/put-call'],
  ])('metric=%s routes to %s', async (metric, expectedPath) => {
    const call = await run({ screener: 'dod-change', metric });
    expect(call.path).toBe(expectedPath);
  });

  test('metric=skew falls through to /scanner/skew?mode=change', async () => {
    const call = await run({ screener: 'dod-change', metric: 'skew' });
    expect(call.path).toBe('/scanner/skew');
    expect(call.params?.mode).toBe('change');
  });

  test('metric=regime falls through to /scanner/regime-stress?mode=change', async () => {
    const call = await run({ screener: 'dod-change', metric: 'regime' });
    expect(call.path).toBe('/scanner/regime-stress');
    expect(call.params?.mode).toBe('change');
  });

  test('missing metric throws a descriptive error', async () => {
    const harness = createHarness();
    const result = await harness.handler({ screener: 'dod-change' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("metric: 'gex' | 'iv'");
  });

  test('dod-change with wrong sub-param (side/mode) does NOT satisfy the required metric check', async () => {
    const harness = createHarness();
    const resultWithSide = await harness.handler({ screener: 'dod-change', side: 'high' });
    expect(resultWithSide.isError).toBe(true);
    expect(resultWithSide.content[0].text).toContain("metric: 'gex' | 'iv'");

    const resultWithMode = await harness.handler({ screener: 'dod-change', mode: 'pinning' });
    expect(resultWithMode.isError).toBe(true);
    expect(resultWithMode.content[0].text).toContain("metric: 'gex' | 'iv'");
  });

  test('direction=up passes through; direction=all is stripped', async () => {
    const upCall = await run({ screener: 'dod-change', metric: 'gex', direction: 'up' });
    expect(upCall.params?.direction).toBe('up');

    const allCall = await run({ screener: 'dod-change', metric: 'iv', direction: 'all' });
    expect(allCall.params?.direction).toBeUndefined();
  });
});

describe('run_screener — vrp / max-pain / unusual-directional require a sub-param', () => {
  test('vrp high', async () => {
    const call = await run({ screener: 'vrp', side: 'high' });
    expect(call.path).toBe('/scanner/vrp');
    expect(call.params?.direction).toBe('high');
  });

  test('vrp low', async () => {
    const call = await run({ screener: 'vrp', side: 'low' });
    expect(call.params?.direction).toBe('low');
  });

  test('vrp without side throws', async () => {
    const harness = createHarness();
    const result = await harness.handler({ screener: 'vrp' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("side: 'high' | 'low'");
  });

  test('vrp with side=call (wrong side kind — Zod schema allows all four) still throws high|low', async () => {
    const harness = createHarness();
    const result = await harness.handler({ screener: 'vrp', side: 'call' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("side: 'high' | 'low'");
  });

  test('max-pain pinning + divergence route to separate endpoints', async () => {
    const pinning = await run({ screener: 'max-pain', mode: 'pinning' });
    expect(pinning.path).toBe('/scanner/max-pain-pinning');

    const divergence = await run({ screener: 'max-pain', mode: 'divergence' });
    expect(divergence.path).toBe('/scanner/max-pain-divergence');
  });

  test('max-pain without mode throws', async () => {
    const harness = createHarness();
    const result = await harness.handler({ screener: 'max-pain' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mode: 'pinning' | 'divergence'");
  });

  test('max-pain with side (wrong sub-param) still throws mode-required', async () => {
    const harness = createHarness();
    const result = await harness.handler({ screener: 'max-pain', side: 'high' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mode: 'pinning' | 'divergence'");
  });

  test('unusual-directional call + put', async () => {
    const callSide = await run({ screener: 'unusual-directional', side: 'call' });
    expect(callSide.params?.side).toBe('call');

    const putSide = await run({ screener: 'unusual-directional', side: 'put' });
    expect(putSide.params?.side).toBe('put');
  });

  test('unusual-directional without side throws', async () => {
    const harness = createHarness();
    const result = await harness.handler({ screener: 'unusual-directional' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("side: 'call' | 'put'");
  });

  test('unusual-directional with mode (wrong sub-param) still throws side-required', async () => {
    const harness = createHarness();
    const result = await harness.handler({ screener: 'unusual-directional', mode: 'pinning' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("side: 'call' | 'put'");
  });

  test('unusual-directional with side=high (wrong side kind) still throws call|put', async () => {
    const harness = createHarness();
    const result = await harness.handler({ screener: 'unusual-directional', side: 'high' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("side: 'call' | 'put'");
  });
});

describe('run_screener — market-trends', () => {
  test('without days param: routes to /scanner/market-trends and lets proxy apply its default', async () => {
    const call = await run({ screener: 'market-trends' });
    expect(call.path).toBe('/scanner/market-trends');
    expect(call.params?.days).toBeUndefined();
  });

  test('passes days through', async () => {
    const call = await run({ screener: 'market-trends', days: 30 });
    expect(call.params?.days).toBe('30');
  });
});

describe('run_screener — earnings-calendar', () => {
  test('defaults to a 14-day forward window on /earnings-calendar', async () => {
    const call = await run({ screener: 'earnings-calendar' });
    expect(call.path).toBe('/earnings-calendar');
    expect(call.params?.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(call.params?.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const from = new Date(call.params!.from as string);
    const to = new Date(call.params!.to as string);
    const deltaDays = Math.round((to.getTime() - from.getTime()) / 86400000);
    expect(deltaDays).toBe(14);
  });

  test('custom days widens the forward window', async () => {
    const call = await run({ screener: 'earnings-calendar', days: 30 });
    const from = new Date(call.params!.from as string);
    const to = new Date(call.params!.to as string);
    const deltaDays = Math.round((to.getTime() - from.getTime()) / 86400000);
    expect(deltaDays).toBe(30);
  });

  test('symbol filter passes through uppercased', async () => {
    const call = await run({ screener: 'earnings-calendar', symbol: 'aapl' });
    expect(call.params?.symbol).toBe('AAPL');
  });

  test('days > 90 throws a descriptive error (even though the Zod schema cap is 730 for market-trends)', async () => {
    const harness = createHarness();
    const result = await harness.handler({ screener: 'earnings-calendar', days: 91 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("earnings-calendar 'days' must be between 1 and 90");
  });

  test('days = 90 (boundary) is accepted', async () => {
    const call = await run({ screener: 'earnings-calendar', days: 90 });
    const from = new Date(call.params!.from as string);
    const to = new Date(call.params!.to as string);
    const deltaDays = Math.round((to.getTime() - from.getTime()) / 86400000);
    expect(deltaDays).toBe(90);
  });
});

describe('run_screener — irrelevant sub-params are ignored', () => {
  test('most-active ignores metric/side/mode', async () => {
    const call = await run({ screener: 'most-active', metric: 'gex', side: 'high', mode: 'pinning' });
    expect(call.path).toBe('/scanner/most-active');
    expect(call.params?.type).toBe('ticker');
    expect(call.params).not.toHaveProperty('metric');
    expect(call.params).not.toHaveProperty('side');
    expect(call.params).not.toHaveProperty('mode');
  });

  test('delta-exposure ignores view/index/metric/side', async () => {
    const call = await run({ screener: 'delta-exposure', view: 'contract', index: 'sp500', metric: 'iv', side: 'low' });
    expect(call.path).toBe('/scanner/delta-exposure-leaders');
    expect(call.params).not.toHaveProperty('type');
    expect(call.params).not.toHaveProperty('index');
    expect(call.params).not.toHaveProperty('metric');
    expect(call.params).not.toHaveProperty('side');
  });

  test('vrp ignores view/index/metric', async () => {
    const call = await run({ screener: 'vrp', side: 'high', view: 'contract', index: 'etf', metric: 'gex' });
    expect(call.path).toBe('/scanner/vrp');
    expect(call.params?.direction).toBe('high');
    expect(call.params).not.toHaveProperty('type');
    expect(call.params).not.toHaveProperty('metric');
  });
});

describe('run_screener - a partial screener answer', () => {
  test('an unread enrichment is named with what is missing, never a row set read as whole', async () => {
    const harness = createHarness({ metric: 'highest-vrp', data: [{ symbol: 'SPY', type: null }], partial: true, unavailable: ['tickerTypes', 'regimeLabels'] });
    const parsed = JSON.parse((await harness.handler({ screener: 'vrp', side: 'high' }) as any).content[0].text);
    expect(parsed.partial).toBe(true);
    expect(parsed.unavailable).toEqual(['tickerTypes', 'regimeLabels']);
    expect(parsed.partialNote).toMatch(/asset type of each row could not be read/);
    expect(parsed.partialNote).toMatch(/regime labels could not be read/);
  });

  // A shown book column whose read failed is marked by the proxy's transport name, exposureV2
  test('an unread book column is named `exposures` with what is missing, and no method is named', async () => {
    const { out, text } = await callScreener(() => ({ ...BOOK_ENVELOPE, type: 'ticker', data: [{ symbol: 'SPY', volume: 10 }], partial: true, unavailable: ['tickerTypes', 'exposureV2'] }), { screener: 'most-active' });
    expect(out).toMatchObject({ partial: true, unavailable: ['tickerTypes', 'exposures'] });
    expect(out.partialNote).toContain('The book\'s exposure figures could not be read, so the exposure columns are missing, not zero.');
    expect(out.partialNote).toMatch(/asset type of each row could not be read/);
    expect(text).not.toMatch(/exposureV2|[Mm]ethodolog|\bv2\b|V2/);
  });

  test('a whole answer carries no partial note (the control)', async () => {
    const harness = createHarness({ metric: 'highest-vrp', data: [{ symbol: 'SPY', type: 'ETF' }] });
    const parsed = JSON.parse((await harness.handler({ screener: 'vrp', side: 'high' }) as any).content[0].text);
    expect('partialNote' in parsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Greek exposure methodology v2: the screens with exposure
// figures answer the assumed dealer book, U8's book route (its transport query `exposure`), its envelope checked;
// nothing names a calculation. Through the registered tool (the server's own call path).

async function callScreener(answer: (path: string, params?: Record<string, string>) => unknown, args: Record<string, unknown>) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const server = new McpServer({ name: 'screener-u12-test', version: '1' });
  register(server, {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ path, params });
      return structuredClone(answer(path, params));
    },
  } as unknown as ProxyClient);
  const client = new Client({ name: 'screener-u12-reader', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: 'run_screener', arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    let out: Record<string, any> = {};
    try { out = JSON.parse(text); } catch { /* an error's text */ }
    const listed = (await client.listTools()).tools.find((t) => t.name === 'run_screener')!;
    return { isError: result.isError === true, text, out, calls, listed };
  } finally {
    await client.close();
    await server.close();
  }
}

const gexTickerRows = [{ symbol: 'SPY', netGex: -13845258254.49, exposureStatus: { netGex: 'complete' }, spotPrice: 671.2 }];
const contractRows = [{ symbol: 'SPY261120C00700000', volume: 12000, openInterest: 50000, netGex: 123456, gamma: 0.01 }];
/** No answer names a calculation: no label key, and no method word in any text */
const NO_LABEL_KEYS = ['methodology', 'methodologySource', 'methodologyStale', 'methodologyNote', 'exposuresWithheld'];
const METHOD_WORDS = /[Mm]ethodolog|\bv2\b|V2/;
const EXPOSURE_SCREENS: Array<[Record<string, unknown>, string]> = [
  [{ screener: 'gex' }, '/scanner/gex'],
  [{ screener: 'most-active' }, '/scanner/most-active'],
  [{ screener: 'highest-oi' }, '/scanner/high-oi'],
  [{ screener: 'highest-iv' }, '/scanner/high-iv'],
  [{ screener: 'unusual' }, '/scanner/unusual'],
  [{ screener: 'dod-change', metric: 'gex' }, '/scanner/changes/gex'],
  [{ screener: 'delta-exposure' }, '/scanner/delta-exposure-leaders'],
  [{ screener: 'vega-exposure' }, '/scanner/vega-exposure-leaders'],
  [{ screener: 'max-pain', mode: 'pinning' }, '/scanner/max-pain-pinning'],
];

describe('run_screener on the assumed dealer book', () => {
  test.each(EXPOSURE_SCREENS)('%o asks %s for the book, checks its envelope and keeps the definition and its calculation off the wire', async (args, path) => {
    const { out, text, calls } = await callScreener(() => ({ ...BOOK_ENVELOPE, data: gexTickerRows, excluded: { unpublished: 3, partial: 1, unavailable: 0, qualified: 0 } }), args);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path, params: { exposure: 'v2' } });
    expect(out).toMatchObject({ excluded: { unpublished: 3, partial: 1 } });
    for (const key of [...NO_LABEL_KEYS, 'exposure']) expect(out, key).not.toHaveProperty(key);
    expect(text).not.toMatch(/eod-session-1|assumedDealerBook/);
    expect(text).not.toMatch(METHOD_WORDS);
    expect(out.bookNote).toMatch(/^Every exposure figure is the assumed dealer book - dealers long the calls and short the puts, every contract of open interest \(share 1\)/);
    // review r1: the complete-book rule is the exposure rankings', and transient names no one cause
    expect(out.bookNote).toMatch(/A ranking BY an exposure figure .* takes only complete books whose expiry scope is proven/);
    expect(out.bookNote).toMatch(/the volume, open-interest, IV and unusual tabs keep their own rankings and show each row's GEX as it stands/);
    expect(out.bookNote).toMatch(/transient: part of the answer may still change \(it was not cached\), so a later call can differ\./);
    expect(out.bookNote).toMatch(/over every expiration after the session where the expiry rule is proven \(a figure whose exposureStatus says qualified may count contracts expiring that session\)/);
    expect(out.bookNote).toMatch(/qualified: its expiry scope is not proven/);
    expect(out.bookNote).toMatch(/The row names follow the book: netGex its GEX \(USD of delta per 1% move\), netDex the put-minus-call delta balance/);
    expect(out.data[0]).toEqual({ symbol: 'SPY', netGex: -13845258254.49, exposureStatus: { netGex: 'complete' }, spotPrice: 671.2 });
  });

  test('an answer that does not carry the book is refused, never relabeled', async () => {
    for (const body of [
      { data: gexTickerRows },
      { methodology: 1, exposure: BOOK_ENVELOPE.exposure, data: gexTickerRows },
      { methodology: 2, exposure: { ...BOOK_ENVELOPE.exposure, view: 'longOi' }, data: gexTickerRows },
      { methodology: 2, exposure: { ...BOOK_ENVELOPE.exposure, p: 0.85 }, data: gexTickerRows },
    ]) {
      const { isError, text } = await callScreener(() => body, { screener: 'gex' });
      expect(isError).toBe(true);
      expect(text).toMatch(/UPSTREAM_INVALID/);
      expect(text).toMatch(/The answer did not carry the assumed dealer book, so it was not used\./);
      expect(text).not.toMatch(METHOD_WORDS);
    }
  });

  test('the vega leaders\' charm basis reads as prose', async () => {
    const rows = [{ symbol: 'SPX', netVex: -1, charmBasis: 'fixedReference' }, { symbol: 'AAPL', netVex: 2, charmBasis: 'cash' }];
    const { out } = await callScreener(() => ({ ...BOOK_ENVELOPE, data: rows }), { screener: 'vega-exposure' });
    expect(out.data.map((r: any) => r.charmBasis)).toEqual(['fixed reference', 'cash']);
  });

  test('the gex contract view is refused before any read; the other tabs\' contract rows lose their GEX, always', async () => {
    const refused = await callScreener(() => ({ data: contractRows }), { screener: 'gex', view: 'contract' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Contract-level GEX is not published, so the gex screen's contract view has no ranking: use view=ticker\./);
    expect(refused.text).not.toMatch(METHOD_WORDS);
    expect(refused.calls).toHaveLength(0);
    for (const screener of ['most-active', 'highest-oi', 'highest-iv', 'unusual']) {
      const { out, text, calls } = await callScreener(() => ({ type: 'contract', data: contractRows }), { screener, view: 'contract' });
      expect(calls[0].params).not.toHaveProperty('exposure');
      expect(out.bookNote).toBe('Contract-level GEX is not published, so the contract rows carry no netGex.');
      expect(out.data[0]).toEqual({ symbol: 'SPY261120C00700000', volume: 12000, openInterest: 50000, gamma: 0.01 });
      for (const key of NO_LABEL_KEYS) expect(out, key).not.toHaveProperty(key);
      expect(text).not.toMatch(METHOD_WORDS);
    }
  });

  test.each([
    [{ screener: 'vrp', side: 'high' }],
    [{ screener: 'regime-stress' }],
    [{ screener: 'model-divergence' }],
    [{ screener: 'dod-change', metric: 'iv' }],
    [{ screener: 'max-pain', mode: 'divergence' }],
    [{ screener: 'unusual-directional', side: 'put' }],
    [{ screener: 'earnings-calendar' }],
  ])('%o carries no exposure figure: no book asked, no note, no label', async (args) => {
    const { out, calls } = await callScreener(() => ({ data: [{ symbol: 'SPY' }] }), args);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).not.toHaveProperty('exposure');
    for (const key of [...NO_LABEL_KEYS, 'bookNote']) expect(out, key).not.toHaveProperty(key);
  });

  test('no screen reads a platform default, and the tool\'s description and parameters name no calculation', async () => {
    const screens: Array<Record<string, unknown>> = [...EXPOSURE_SCREENS.map(([args]) => args), { screener: 'gex', view: 'contract' }, { screener: 'most-active', view: 'contract' }, { screener: 'vrp', side: 'low' }];
    for (const args of screens) {
      const { calls } = await callScreener((_path, params) => (params?.exposure === 'v2' ? { ...BOOK_ENVELOPE, data: gexTickerRows } : { data: contractRows }), args);
      expect(calls.map((c) => c.path), JSON.stringify(args)).not.toContain('/exposure/methodology');
    }
    const { listed } = await callScreener(() => ({ data: [] }), { screener: 'vrp', side: 'high' });
    const properties = (listed.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
    expect(Object.keys(properties)).not.toContain('methodology');
    expect(String(listed.description)).not.toMatch(METHOD_WORDS);
    for (const [name, property] of Object.entries(properties)) expect(String(property.description ?? ''), name).not.toMatch(METHOD_WORDS);
  });
});
