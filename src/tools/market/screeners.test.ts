import { describe, test, expect } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
