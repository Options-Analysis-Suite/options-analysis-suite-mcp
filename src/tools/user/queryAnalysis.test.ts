import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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

// The registered tool behind a connected client, so its input schema is
// checked as a remote call's is.
async function connectedHarness() {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const server = new McpServer({ name: 'query_analysis-test', version: '1' });
  register(server, {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ path, params });
      return { data: [], count: 0 };
    },
    post: async () => ({}),
  } as unknown as ProxyClient);
  const client = new Client({ name: 'query_analysis-consumer', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, calls, close: async () => { await client.close(); await server.close(); } };
}

describe('query_analysis - model filter length', () => {
  const tooLong = 'MCP error -32602: Input validation error: Invalid arguments for tool query_analysis: Too big: expected string to have <=120 characters at model';

  test('refuses a model filter past 120 characters before any request', async () => {
    const { client, calls, close } = await connectedHarness();
    try {
      for (const model of ['x'.repeat(121), `Jump Diffusion${' (Merton)'.repeat(60_000)}`]) {
        const result = await client.callTool({ name: 'query_analysis', arguments: { model } });
        expect(result.isError).toBe(true);
        expect((result.content as Array<{ text: string }>)[0].text).toBe(tooLong);
      }
      expect(calls).toEqual([]);
    } finally {
      await close();
    }
  });

  test('passes a 120-character filter through and publishes the cap', async () => {
    const { client, calls, close } = await connectedHarness();
    try {
      const result = await client.callTool({ name: 'query_analysis', arguments: { model: 'x'.repeat(120) } });
      expect(result.isError).not.toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].params?.model).toBe('x'.repeat(120));
      const { tools } = await client.listTools();
      expect(tools.find((tool) => tool.name === 'query_analysis')?.inputSchema.properties?.model).toEqual({
        description: 'Filter by pricing model (e.g., Heston, SABR, Jump Diffusion)',
        type: 'string',
        maxLength: 120,
      });
    } finally {
      await close();
    }
  });
});

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
