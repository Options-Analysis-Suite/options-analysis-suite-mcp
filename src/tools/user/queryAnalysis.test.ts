import { describe, expect, test } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { register } from './queryAnalysis.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }> }>;

function createHarness(stubResponse: any = { data: [], count: 0 }) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const fakeClient: ProxyClient = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ path, params });
      return structuredClone(stubResponse);
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

describe('query_analysis — routing', () => {
  test('normalizes Variance Gamma model filters to backend ids', async () => {
    const { calls, handler } = createHarness();

    await handler({ model: 'Variance Gamma', limit: 1 });

    expect(calls[0].path).toBe('/sync/analysis-data');
    expect(calls[0].params?.model).toBe('VarianceGamma');
  });

  test('normalizes lowercase human-readable model filters to backend ids', async () => {
    const { calls, handler } = createHarness();

    await handler({ model: 'variance gamma', limit: 1 });

    expect(calls[0].params?.model).toBe('VarianceGamma');
  });

  test('normalizes Local Volatility model filters to backend ids', async () => {
    const { calls, handler } = createHarness();

    await handler({ model: 'Local Volatility', limit: 1 });

    expect(calls[0].params?.model).toBe('LocalVol');
  });
});
