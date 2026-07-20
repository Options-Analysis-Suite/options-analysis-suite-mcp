import { describe, test, expect } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { register } from './calendar.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }> }>;

function createHarness(stubResponse: unknown = []) {
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

describe('get_market_calendar — routing', () => {
  test('type=economic → /economic-calendar with uppercased country', async () => {
    const { calls, handler } = createHarness({});
    await handler({ type: 'economic', from: '2026-04-01', to: '2026-04-30', country: 'us' });
    expect(calls[0].path).toBe('/economic-calendar');
    expect(calls[0].params?.from).toBe('2026-04-01');
    expect(calls[0].params?.to).toBe('2026-04-30');
    expect(calls[0].params?.country).toBe('US');
  });

  test('type=ipo → /ipo-calendar', async () => {
    const { calls, handler } = createHarness([]);
    await handler({ type: 'ipo' });
    expect(calls[0].path).toBe('/ipo-calendar');
  });

  test('type=dividend → /dividend-calendar', async () => {
    const { calls, handler } = createHarness([]);
    await handler({ type: 'dividend' });
    expect(calls[0].path).toBe('/dividend-calendar');
  });

  test('type=split → /split-calendar', async () => {
    const { calls, handler } = createHarness([]);
    await handler({ type: 'split' });
    expect(calls[0].path).toBe('/split-calendar');
  });
});

describe('get_market_calendar — economic full=true wraps arrays as { events }', () => {
  test('bare array response gets wrapped as { events: [...] }', async () => {
    const rawFeed = [{ name: 'FOMC', date: '2026-05-01' }, { name: 'CPI', date: '2026-05-13' }];
    const { handler } = createHarness(rawFeed);
    const result = await handler({ type: 'economic', full: true });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ events: rawFeed });
  });

  test('non-array response is passed through unchanged', async () => {
    const res = { events: [], _note: 'empty' };
    const { handler } = createHarness(res);
    const result = await handler({ type: 'economic', full: true });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ events: [], note: 'empty' });
  });
});

describe('get_market_calendar — irrelevant sub-params are ignored', () => {
  test('type=ipo ignores country/full', async () => {
    const { calls, handler } = createHarness([]);
    await handler({ type: 'ipo', country: 'US', full: true });
    expect(calls[0].params?.country).toBeUndefined();
    // full is unused for non-economic types — response shape not wrapped
  });

  test('type=economic ignores symbol', async () => {
    const { calls, handler } = createHarness({});
    await handler({ type: 'economic', symbol: 'AAPL' });
    expect(calls[0].path).toBe('/economic-calendar');
    // No symbol param on economic endpoint
    expect(calls[0].params?.symbol).toBeUndefined();
  });
});
