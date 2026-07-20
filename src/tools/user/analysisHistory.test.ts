import { describe, expect, test } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
