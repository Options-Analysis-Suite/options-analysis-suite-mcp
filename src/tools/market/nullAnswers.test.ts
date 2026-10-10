import { describe, test, expect } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { register as registerRates } from './rates.js';
import { register as registerThreshold } from './thresholdList.js';
import { register as registerFtd } from './failToDeliver.js';
import { register as registerActivist } from './activistFilings.js';
import { register as registerSecFilings } from './secFilings.js';

/**
 * Proxy failure campaign (review F2 r2 note): the proxy client maps a 404 to null. A summary-mode shaper read that null
 * and answered an internal error; the tool now answers "No data available" (or, for SEC filings, an empty filing list
 * beside the deal flags, which are their own read).
 */

type ToolResult = { isError?: boolean; content: Array<{ type: 'text'; text: string }>; structuredContent?: unknown };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function handlerOf(register: (server: McpServer, client: ProxyClient) => void, answer: (path: string) => unknown): Handler {
  const client = { get: async (path: string) => answer(path), post: async () => ({}) } as unknown as ProxyClient;
  let handler: Handler | null = null;
  register({ registerTool: (_n: string, _c: unknown, h: Handler) => { handler = h; } } as unknown as McpServer, client);
  if (!handler) throw new Error('handler not captured');
  return handler;
}

const NO_DATA = 'No data available for this query.';

describe('a 404 (the client\'s null) in summary mode is no data, never an internal error', () => {
  const cases: Array<[string, (s: McpServer, c: ProxyClient) => void, Record<string, unknown>]> = [
    ['get_yield_curve-style rates (curve view)', registerRates, { view: 'curve' }],
    ['threshold history', registerThreshold, { symbol: 'ZZZZ', days: 5 }],
    ['fails to deliver', registerFtd, { symbol: 'ZZZZ', days: 30 }],
    ['activist filings', registerActivist, { symbol: 'ZZZZ' }],
  ];
  for (const [name, register, args] of cases) {
    test(name, async () => {
      const result = await handlerOf(register, () => null)(args);
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toBe(NO_DATA);
    });
  }

  test('SEC filings: an empty filing list beside the deal flags, not an error', async () => {
    const flags = { filings: [], asOf: '2026-10-08', coverageThrough: '2026-10-08', flags: [] };
    const result = await handlerOf(registerSecFilings, (path) => (path.startsWith('/sec-corporate-filings/') ? flags : null))({
      symbol: 'ZZZZ', scope: 'symbol', limit: 10, type: 'all', days: 30,
    });
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).not.toBe(NO_DATA);
  });
});
