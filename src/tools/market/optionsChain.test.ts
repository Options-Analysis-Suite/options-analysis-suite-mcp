import { describe, test, expect } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { register } from './optionsChain.js';

// get_options_chain on a symbol with no chain on file: the proxy answers 404 (an unknown ticker, or one with no strike
// rows at all) and this client answers every 404 null, so the tool says which symbol has no chain itself, in the
// summary and the full view alike. A chain on file is summarized as before.

type ToolHandler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }>; structuredContent?: unknown }>;

function harness(answer: unknown) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const client = {
    get: async (path: string, params?: Record<string, string>) => { calls.push({ path, params }); return answer; },
    post: async () => ({}),
  } as unknown as ProxyClient;
  const captured: { handler: ToolHandler | null } = { handler: null };
  const server = { registerTool: (_name: string, _config: unknown, handler: ToolHandler) => { captured.handler = handler; } } as unknown as McpServer;
  register(server, client);
  if (!captured.handler) throw new Error('Tool handler not captured');
  return { calls, handler: captured.handler };
}

describe('get_options_chain: no chain on file', () => {
  for (const args of [{ symbol: 'zzzq' }, { symbol: 'zzzq', full: true }, { symbol: 'zzzq', date: '2026-10-08' }]) {
    test(`names the symbol (${JSON.stringify(args)})`, async () => {
      const { calls, handler } = harness(null);
      const result = await handler(args);
      expect(calls[0]).toEqual({ path: '/scanner/options-chain', params: { ticker: 'ZZZQ', ...(args.date ? { date: args.date } : {}) } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0].text)).toEqual({ symbol: 'ZZZQ', dataAvailable: false, message: 'No options chain on file for ZZZQ.' });
    });
  }

  test('a chain on file is summarized as before', async () => {
    const { handler } = harness({ ticker: 'SPY', date: '2026-10-08', spotPrice: 668.2, pricingTier: 'eod', contracts: [] });
    const parsed = JSON.parse((await handler({ symbol: 'SPY' })).content[0].text);
    expect(parsed).toMatchObject({ ticker: 'SPY', date: '2026-10-08', spotPrice: 668.2, summary: { expirationCount: 0 } });
  });
});
