import { describe, test, expect } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { register } from './rates.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }> }>;

function createHarness(stubResponse: any = {}) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const fakeClient: ProxyClient = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ path, params });
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
  return { calls, handler: captured.handler };
}

describe('get_rates — routing', () => {
  test('view=benchmark → /risk-free-rate', async () => {
    const { calls, handler } = createHarness({ rate: 0.042, maturity: '10Y' });
    await handler({ view: 'benchmark' });
    expect(calls[0].path).toBe('/risk-free-rate');
  });

  test('view=curve → /treasury/yield-curve with default weeks=12', async () => {
    const { calls, handler } = createHarness({});
    await handler({ view: 'curve' });
    expect(calls[0].path).toBe('/treasury/yield-curve');
    expect(calls[0].params?.weeks).toBe('12');
  });

  test('view=curve honors custom weeks', async () => {
    const { calls, handler } = createHarness({});
    await handler({ view: 'curve', weeks: 26 });
    expect(calls[0].params?.weeks).toBe('26');
  });
});

describe('get_rates — benchmark adds 10Y meta annotation', () => {
  test('10Y response gets annotated with structured rate metadata', async () => {
    const stub = { rate: 0.042, maturity: '10Y', source: 'treasury' };
    const { handler } = createHarness(stub);
    const result = await handler({ view: 'benchmark' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.rateContext).toEqual({ source: 'platform 10Y benchmark', maturity: '10Y' });
  });

  test('non-10Y response is left unannotated', async () => {
    const stub = { rate: 0.045, maturity: '3M', source: 'treasury' };
    const { handler } = createHarness(stub);
    const result = await handler({ view: 'benchmark' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed._rate_meta).toBeUndefined();
  });
});

// The benchmark is the 10Y; the platform prices each option at the Treasury rate matched to its expiration, which
// the tool answers for a maturity it is given (the description once said the 10Y was "used for options pricing")
describe('get_rates — the rate matched to a maturity', () => {
  test('tenorYears asks the route for the matched series and labels the answer as that, never the 10Y benchmark', async () => {
    const stub = { rate: 0.0406, maturity: '1M', series: 'DGS1MO', source: 'fred-DGS1MO' };
    const { calls, handler } = createHarness(stub);
    const result = await handler({ view: 'benchmark', tenorYears: 0.08 });
    expect(calls[0]).toEqual({ path: '/risk-free-rate', params: { tenorYears: '0.08' } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.rateContext).toEqual({ source: 'Treasury rate matched to the requested maturity', matched: true, requestedTenorYears: 0.08, maturity: '1M' });
  });

  // Review: the route answers the 3-month series with a warning when the matched one cannot be read
  test('a fallback answer is labelled as one, matched false, its warning kept', async () => {
    const warning = 'Risk-free: 1Y unavailable; falling back to DGS3MO';
    const { handler } = createHarness({ rate: 0.0389, maturity: '3M', series: 'DGS3MO', warnings: [warning] });
    const parsed = JSON.parse((await handler({ view: 'benchmark', tenorYears: 1 })).content[0].text);
    expect(parsed.rateContext).toEqual({
      source: 'Fallback: the series matched to the requested maturity could not be read (see warnings)',
      matched: false, requestedTenorYears: 1, maturity: '3M',
    });
    expect(parsed.warnings).toEqual([warning]);
  });

  test('the maturity goes to the route as a plain decimal, never exponent notation it refuses', async () => {
    for (const [tenorYears, sent] of [[0.0000001, '0.0000001'], [0.08, '0.08'], [100, '100'], [1 / 12, '0.0833333333'], [2.5, '2.5']] as const) {
      const { calls, handler } = createHarness({ rate: 0.04, maturity: '1M' });
      await handler({ view: 'benchmark', tenorYears });
      expect(calls[0].params, String(tenorYears)).toEqual({ tenorYears: sent });
    }
  });

  test('a long maturity matched to the 10-year series is still the matched answer', async () => {
    const { handler } = createHarness({ rate: 0.042, maturity: '10Y', series: 'DGS10' });
    const parsed = JSON.parse((await handler({ view: 'benchmark', tenorYears: 8 })).content[0].text);
    expect(parsed.rateContext.source).toBe('Treasury rate matched to the requested maturity');
  });

  test('tenorYears on the curve view is refused by name, nothing fetched', async () => {
    const { calls, handler } = createHarness({});
    const result = await handler({ view: 'curve', tenorYears: 2 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('tenorYears applies to view="benchmark" only');
    expect(calls).toEqual([]);
  });

  test('the description says options price at their own matched rate, not the 10Y', () => {
    let description = '';
    const fakeServer = { registerTool: (_n: string, config: { description: string }) => { description = config.description; } } as unknown as McpServer;
    register(fakeServer, {} as ProxyClient);
    expect(description).not.toContain('used for options pricing');
    expect(description).toContain('Options are NOT priced at it');
    expect(description).toContain('tenorYears');
    expect(description).toContain('matched: false');
  });
});

describe('get_rates — curve full mode', () => {
  test('full=true skips summarizer and returns raw payload', async () => {
    const stub = { current: {}, history: [{ date: '2026-04-10', rates: {} }, { date: '2026-04-11', rates: {} }] };
    const { handler } = createHarness(stub);
    const result = await handler({ view: 'curve', full: true });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(stub);
  });
});
