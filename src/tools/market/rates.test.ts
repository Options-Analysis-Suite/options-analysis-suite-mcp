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

describe('get_rates — curve full mode', () => {
  test('full=true skips summarizer and returns raw payload', async () => {
    const stub = { current: {}, history: [{ date: '2026-04-10', rates: {} }, { date: '2026-04-11', rates: {} }] };
    const { handler } = createHarness(stub);
    const result = await handler({ view: 'curve', full: true });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(stub);
  });
});
