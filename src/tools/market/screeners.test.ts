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

function createHarness(stubResponse: unknown = { data: [], metric: 'stub', currentDate: '2026-04-18' }) {
  const proxyCalls: Array<{ path: string; params?: Record<string, string> }> = [];
  const fakeClient: ProxyClient = {
    get: async (path: string, params?: Record<string, string>) => {
      // the platform default, methodology 1 as today; not a screener read
      if (path === '/exposure/methodology') return { defaultMethodology: 1, stale: false };
      proxyCalls.push({ path, params });
      return stubResponse;
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

  test('passes view=contract through for main tabs', async () => {
    const call = await run({ screener: 'gex', view: 'contract' });
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

  test('a whole answer carries no partial note (the control)', async () => {
    const harness = createHarness({ metric: 'highest-vrp', data: [{ symbol: 'SPY', type: 'ETF' }] });
    const parsed = JSON.parse((await harness.handler({ screener: 'vrp', side: 'high' }) as any).content[0].text);
    expect('partialNote' in parsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Greek exposure methodology v2: the screens with
// exposure figures take a methodology, labeled; methodology 2 is U8's `exposure=v2`, its envelope checked.

async function callScreener(answer: (path: string, params?: Record<string, string>) => unknown, args: Record<string, unknown>, defaultAnswer: unknown = { defaultMethodology: 1, stale: false }) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const server = new McpServer({ name: 'screener-u10-test', version: '1' });
  register(server, {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ path, params });
      if (path === '/exposure/methodology') {
        if (defaultAnswer instanceof Error) throw defaultAnswer;
        return defaultAnswer;
      }
      return structuredClone(answer(path, params));
    },
  } as unknown as ProxyClient);
  const client = new Client({ name: 'screener-u10-reader', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: 'run_screener', arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    let out: Record<string, any> = {};
    try { out = JSON.parse(text); } catch { /* an error's text */ }
    return { isError: result.isError === true, text, out, calls, routeCalls: calls.filter((c) => c.path !== '/exposure/methodology') };
  } finally {
    await client.close();
    await server.close();
  }
}

const V2_ENVELOPE = { methodology: 2, exposure: { view: 'assumedDealerBook', p: 1, expiryScope: 'eod-session-1', expirations: 'all' } };
const gexTickerRows = [{ symbol: 'SPY', netGex: -13845258254.49, exposureStatus: { netGex: 'complete' }, spotPrice: 671.2 }];
const contractRows = [{ symbol: 'SPY261120C00700000', volume: 12000, openInterest: 50000, netGex: 123456, gamma: 0.01 }];

describe('run_screener by methodology', () => {
  test('methodology 1 by default: the legacy route, its rows as they came, labeled', async () => {
    const { out, routeCalls } = await callScreener(() => ({ type: 'ticker', data: [{ symbol: 'SPY', netGex: 1.5e9 }] }), { screener: 'gex' });
    expect(routeCalls[0].params).not.toHaveProperty('exposure');
    expect(out).toMatchObject({ methodology: 1, methodologySource: 'default', data: [{ symbol: 'SPY', netGex: 1.5e9 }] });
    expect(out).not.toHaveProperty('methodologyNote');
  });

  test.each([
    [{ screener: 'gex' }, '/scanner/gex'],
    [{ screener: 'most-active' }, '/scanner/most-active'],
    [{ screener: 'highest-oi' }, '/scanner/high-oi'],
    [{ screener: 'highest-iv' }, '/scanner/high-iv'],
    [{ screener: 'unusual' }, '/scanner/unusual'],
    [{ screener: 'dod-change', metric: 'gex' }, '/scanner/changes/gex'],
    [{ screener: 'delta-exposure' }, '/scanner/delta-exposure-leaders'],
    [{ screener: 'vega-exposure' }, '/scanner/vega-exposure-leaders'],
    [{ screener: 'max-pain', mode: 'pinning' }, '/scanner/max-pain-pinning'],
  ])('methodology 2 asks %o for exposure=v2 at %s, checks its envelope and keeps the definition off the wire', async (args, path) => {
    const { out, text, routeCalls } = await callScreener(() => ({ ...V2_ENVELOPE, data: gexTickerRows, excluded: { unpublished: 3, partial: 1, unavailable: 0, qualified: 0 } }), { ...args, methodology: 2 });
    expect(routeCalls[0]).toMatchObject({ path, params: { exposure: 'v2' } });
    expect(out).toMatchObject({ methodology: 2, methodologySource: 'requested', excluded: { unpublished: 3, partial: 1 } });
    expect(out).not.toHaveProperty('exposure');
    expect(text).not.toMatch(/eod-session-1|assumedDealerBook/);
    expect(out.methodologyNote).toMatch(/^Methodology 2: every exposure figure is the assumed dealer book/);
    // The complete-book rule is the exposure rankings', and transient names no one cause
    expect(out.methodologyNote).toMatch(/A ranking BY an exposure figure .* takes only complete books whose expiry scope is proven/);
    expect(out.methodologyNote).toMatch(/the volume, open-interest, IV and unusual tabs keep their own rankings and show each row's GEX as it stands/);
    expect(out.methodologyNote).toMatch(/transient: part of the answer may still change \(it was not cached\), so a later call can differ\./);
    expect(out.methodologyNote).not.toMatch(/a newer session is still being published/);
    expect(out.methodologyNote).toMatch(/over every expiration after the session where the expiry rule is proven \(a figure whose exposureStatus says qualified may count contracts expiring that session\)/);
    expect(out.methodologyNote).toMatch(/qualified: its expiry scope is not proven/);
    expect(out.data[0]).toEqual({ symbol: 'SPY', netGex: -13845258254.49, exposureStatus: { netGex: 'complete' }, spotPrice: 671.2 });
  });

  test('a methodology-2 answer that does not say so is refused, never relabeled', async () => {
    for (const body of [
      { data: gexTickerRows },
      { methodology: 1, exposure: V2_ENVELOPE.exposure, data: gexTickerRows },
      { methodology: 2, exposure: { ...V2_ENVELOPE.exposure, view: 'longOi' }, data: gexTickerRows },
      { methodology: 2, exposure: { ...V2_ENVELOPE.exposure, p: 0.85 }, data: gexTickerRows },
    ]) {
      const { isError, text } = await callScreener(() => body, { screener: 'gex', methodology: 2 });
      expect(isError).toBe(true);
      expect(text).toMatch(/UPSTREAM_INVALID|did not say it was one/);
    }
  });

  test('the vega leaders\' charm basis reads as prose', async () => {
    const rows = [{ symbol: 'SPX', netVex: -1, charmBasis: 'fixedReference' }, { symbol: 'AAPL', netVex: 2, charmBasis: 'cash' }];
    const { out } = await callScreener(() => ({ ...V2_ENVELOPE, data: rows }), { screener: 'vega-exposure', methodology: 2 });
    expect(out.data.map((r: any) => r.charmBasis)).toEqual(['fixed reference', 'cash']);
  });

  test('under 2 the gex contract view is refused before any read; the other tabs\' contract rows lose their GEX', async () => {
    const refused = await callScreener(() => ({ data: contractRows }), { screener: 'gex', view: 'contract', methodology: 2 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Contract-level GEX is not published under methodology 2/);
    expect(refused.routeCalls).toHaveLength(0);
    for (const screener of ['most-active', 'highest-oi', 'highest-iv', 'unusual']) {
      const { out, routeCalls } = await callScreener(() => ({ type: 'contract', data: contractRows }), { screener, view: 'contract', methodology: 2 });
      expect(routeCalls[0].params).not.toHaveProperty('exposure');
      expect(out).toMatchObject({ methodology: 2, methodologySource: 'requested', methodologyNote: 'Contract-level GEX is not published under methodology 2, so the contract rows carry no netGex.' });
      expect(out.data[0]).toEqual({ symbol: 'SPY261120C00700000', volume: 12000, openInterest: 50000, gamma: 0.01 });
    }
    // under 1 the contract rows keep the legacy figure, labeled
    const v1 = await callScreener(() => ({ type: 'contract', data: contractRows }), { screener: 'most-active', view: 'contract' });
    expect(v1.out).toMatchObject({ methodology: 1, data: [{ netGex: 123456 }] });
  });

  test('an unreadable default: a ranking by exposure refuses retryably, a shown column is withheld, never guessed', async () => {
    for (const args of [{ screener: 'gex' }, { screener: 'dod-change', metric: 'gex' }, { screener: 'vega-exposure' }, { screener: 'max-pain', mode: 'pinning' }, { screener: 'gex', view: 'contract' }]) {
      const { isError, text, routeCalls } = await callScreener(() => ({ data: gexTickerRows }), args, new Error('HTTP 503'));
      expect(isError).toBe(true);
      expect(text).toMatch(/default exposure methodology could not be read/);
      expect(text).toMatch(/This may be retried/);
      expect(routeCalls).toHaveLength(0);
    }
    const shown = await callScreener(() => ({ type: 'ticker', data: [{ symbol: 'SPY', volume: 5, netGex: 9, gammaConcentration: 0.2 }] }), { screener: 'most-active' }, new Error('HTTP 503'));
    expect(shown.out.exposuresWithheld).toMatch(/could not be read/);
    expect(shown.out.data[0]).toEqual({ symbol: 'SPY', volume: 5 });
    expect(shown.out).not.toHaveProperty('methodology');
  });

  test.each([
    [{ screener: 'vrp', side: 'high' }],
    [{ screener: 'regime-stress' }],
    [{ screener: 'model-divergence' }],
    [{ screener: 'dod-change', metric: 'iv' }],
    [{ screener: 'max-pain', mode: 'divergence' }],
    [{ screener: 'unusual-directional', side: 'put' }],
    [{ screener: 'earnings-calendar' }],
  ])('%o carries no exposure figure: no default read, no exposure=v2, no label, named or not', async (args) => {
    for (const named of [{}, { methodology: 2 }]) {
      const { out, calls } = await callScreener(() => ({ data: [{ symbol: 'SPY' }] }), { ...args, ...named });
      expect(calls.map((c) => c.path)).not.toContain('/exposure/methodology');
      expect(calls[0].params).not.toHaveProperty('exposure');
      expect(out).not.toHaveProperty('methodology');
    }
  });
});
