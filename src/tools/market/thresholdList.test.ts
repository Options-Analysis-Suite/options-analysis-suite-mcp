import { describe, test, expect } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { register } from './thresholdList.js';

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

describe('get_threshold_history — routing', () => {
  test('uppercases symbol and passes generated date list', async () => {
    const { calls, handler } = createHarness({ symbol: 'GME', thresholdDates: [] });
    await handler({ symbol: 'gme', days: 5 });
    expect(calls[0].path).toBe('/sec/threshold-history/GME');
    expect(calls[0].params?.dates?.split(',')).toHaveLength(5);
  });
});

describe('get_threshold_history — full mode source cleanup', () => {
  test('relabels Supabase source in full=true payload', async () => {
    const { handler } = createHarness({
      symbol: 'GME',
      thresholdDates: ['2026-04-24'],
      source: 'supabase',
    });

    const result = await handler({ symbol: 'GME', days: 5, full: true });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.source).toBe('Reg SHO threshold list');
    expect(result.content[0].text).not.toContain('supabase');
  });
});
