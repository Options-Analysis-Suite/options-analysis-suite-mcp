import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { register } from './analysisHistory.js';

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
  const server = new McpServer({ name: 'get_analysis_history-test', version: '1' });
  register(server, {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ path, params });
      return { data: [], count: 0 };
    },
    post: async () => ({}),
  } as unknown as ProxyClient);
  const client = new Client({ name: 'get_analysis_history-consumer', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, calls, close: async () => { await client.close(); await server.close(); } };
}

describe('get_analysis_history - model filter length', () => {
  const tooLong = 'MCP error -32602: Input validation error: Invalid arguments for tool get_analysis_history: Too big: expected string to have <=120 characters at model';

  test('refuses a model filter past 120 characters before any request', async () => {
    const { client, calls, close } = await connectedHarness();
    try {
      for (const model of ['x'.repeat(121), `Jump Diffusion${' (Merton)'.repeat(60_000)}`]) {
        const result = await client.callTool({ name: 'get_analysis_history', arguments: { model } });
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
      const result = await client.callTool({ name: 'get_analysis_history', arguments: { model: 'x'.repeat(120) } });
      expect(result.isError).not.toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].params?.model).toBe('x'.repeat(120));
      const { tools } = await client.listTools();
      expect(tools.find((tool) => tool.name === 'get_analysis_history')?.inputSchema.properties?.model).toEqual({
        description: 'Filter by pricing model (e.g., Heston, SABR, Jump Diffusion)',
        type: 'string',
        maxLength: 120,
      });
    } finally {
      await close();
    }
  });
});

describe('get_analysis_history — routing', () => {
  test('normalizes human-readable model filters to backend ids', async () => {
    const { calls, handler } = createHarness();

    await handler({ model: 'Black-Scholes', limit: 1 });

    expect(calls[0].path).toBe('/sync/analysis-data');
    expect(calls[0].params?.model).toBe('BlackScholes');
  });

  test('normalizes lowercase human-readable model filters to backend ids', async () => {
    const { calls, handler } = createHarness();

    await handler({ model: 'black-scholes', limit: 1 });

    expect(calls[0].params?.model).toBe('BlackScholes');
  });
});

describe('get_analysis_history — full-mode sanitization', () => {
  test('strips sync metadata and internal result ids from less-summarized rows', async () => {
    const { handler } = createHarness({
      data: [
        {
          id: 91,
          user_id: 7,
          created_at: '2026-04-01T00:00:00.000Z',
          data: {
            id: 91,
            user_id: 7,
            resultId: 91,
            symbol: 'TSLA',
            model: 'VarianceGamma',
          },
          facts: {
            resultId: 91,
            model: 'VarianceGamma',
          },
          artifacts: {
            resultId: 91,
            calibrationSummary: {
              model: 'VarianceGamma',
              params: { vgNu: 0.1, vgSigma: 0.2, vgTheta: -0.1 },
            },
          },
        },
      ],
      count: 1,
    });

    const result = await handler({ limit: 1, full: true });
    const text = result.content[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.data[0].data.symbol).toBe('TSLA');
    expect(parsed.data[0].data.model).toBe('Variance Gamma');
    expect(parsed.data[0].artifacts.calibrationSummary.params).toEqual({
      nu: 0.1,
      sigma: 0.2,
      theta: -0.1,
    });
    expect(text).not.toContain('"id"');
    expect(text).not.toContain('user_id');
    expect(text).not.toContain('created_at');
    expect(text).not.toContain('resultId');
    expect(text).not.toContain('VarianceGamma');
  });
});

describe('get_analysis_history - a synced record whose keys all read as one name (review: quadratic key settling)', () => {
  test('8,000 such keys on full are answered with a few lookups per key', async () => {
    // The scan's payload: a stored result whose 8,000 keys are spellings of
    // the equity vendor's full name, each read as "vendor". Every key used to
    // restart the numbered-name search, about 32 million lookups per
    // sanitizing pass and three passes before the size guard answered.
    const words = Buffer.from('RmluYW5jaWFsIE1vZGVsaW5nIFByZXA=', 'base64').toString('utf8').toLowerCase().split(' ');
    const separators = [' ', '_', '.', '-'];
    const data: Record<string, number> = {};
    for (let i = 0; i < 8_000; i += 1) {
      const run = (from: number) => Array.from({ length: 4 }, (_, j) => separators[(i >> (2 * (from + j))) & 3]).join('');
      data[`${words[0]}${run(0)}${words[1]}${run(4)}${words[2]}`] = i;
    }
    const { handler } = createHarness({ data: [{ id: 1, symbol: 'SPY', model: 'Heston', timestamp: 1, data }], count: 1 });

    const budget = 20 * 8_000;
    const has = Set.prototype.has;
    let lookups = 0;
    Set.prototype.has = function (this: Set<unknown>, value: unknown) {
      lookups += 1;
      if (lookups > budget) throw new Error(`more than ${budget} Set lookups`);
      return has.call(this, value);
    };
    let result: Awaited<ReturnType<ToolHandler>>;
    try {
      result = await handler({ limit: 10, full: true });
    } finally {
      Set.prototype.has = has;
    }

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'Response too large for MCP response budget.',
      responseBudget: { tooLarge: true, sizeKb: 139 },
    });
    expect(lookups).toBeLessThanOrEqual(budget);
  });
});

describe('get_analysis_history time convention', () => {
  test('the full response states an untagged record\'s time convention as legacy', async () => {
    const { handler } = createHarness({
      data: [
        { symbol: 'SPY', model: 'BlackScholes', timestamp: 1_790_820_000_000, data: { isCall: true, greeks: { Charm: 0.002 } } },
        { symbol: 'SPY', model: 'BlackScholes', timestamp: 1_790_830_000_000, data: { isCall: true, greeks: { Charm: -0.002 }, greekTimeConvention: 'time-passing', greekTimeBasis: 'tradingDay' } },
      ],
      count: 2,
    });
    const parsed = JSON.parse((await handler({ limit: 2, full: true })).content[0].text);
    expect(parsed.data[0].data.greekTimeConvention).toBe('legacy: model-dependent time sign');
    expect(parsed.data[1].data.greekTimeConvention).toBe('time-passing');
  });
});
