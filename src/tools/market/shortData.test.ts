import { describe, test, expect } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { register } from './shortData.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }> }>;

function createHarness(stubByPath: Record<string, unknown> = {}, errorByPath: Record<string, Error> = {}) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const fakeClient: ProxyClient = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ path, params });
      if (errorByPath[path]) throw errorByPath[path];
      return stubByPath[path] ?? {};
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

describe('get_short_data — routing', () => {
  test('type=volume → /finra/short-volume/:SYMBOL (uppercased)', async () => {
    const { calls, handler } = createHarness({ '/finra/short-volume/SPY': {} });
    await handler({ type: 'volume', symbol: 'spy' });
    expect(calls[0].path).toBe('/finra/short-volume/SPY');
  });

  test('type=interest fires BOTH short-interest AND company-profile in parallel', async () => {
    const { calls, handler } = createHarness({
      '/finra/short-interest/AAPL': { symbol: 'AAPL', history: [] },
      '/company-profile/AAPL': { free_float_shares: 15_000_000_000 },
    });
    await handler({ type: 'interest', symbol: 'aapl' });
    const paths = calls.map(c => c.path);
    expect(paths).toContain('/finra/short-interest/AAPL');
    expect(paths).toContain('/company-profile/AAPL');
  });
});

describe('get_short_data — full mode', () => {
  test('type=volume full=true trims history to 30 most recent entries', async () => {
    const history = Array.from({ length: 50 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, shortVolume: 1e6 - i }));
    const { handler } = createHarness({ '/finra/short-volume/SPY': { symbol: 'SPY', history } });
    const result = await handler({ type: 'volume', symbol: 'SPY', full: true });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.history).toHaveLength(30);
    expect(parsed._history_meta).toBeUndefined();
  });

  test('type=volume full=true with short history leaves it untouched', async () => {
    const history = [{ date: '2026-04-17', shortVolume: 100 }];
    const { handler } = createHarness({ '/finra/short-volume/SPY': { symbol: 'SPY', history } });
    const result = await handler({ type: 'volume', symbol: 'SPY', full: true });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.history).toHaveLength(1);
    expect(parsed._history_meta).toBeUndefined();
  });

  test('type=interest full=true returns raw payload', async () => {
    const stub = { symbol: 'AAPL', history: [{ settlementDate: '2026-04-15' }] };
    const { handler } = createHarness({
      '/finra/short-interest/AAPL': stub,
      '/company-profile/AAPL': {},
    });
    const result = await handler({ type: 'interest', symbol: 'AAPL', full: true });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(stub);
  });
});

describe('get_short_data — interest tolerates company-profile failure', () => {
  test('company-profile throw is swallowed (.catch → null); short-interest still summarized', async () => {
    const { handler } = createHarness(
      {
        '/finra/short-interest/AAPL': { symbol: 'AAPL', history: [{ settlementDate: '2026-04-15', shortInterest: 1_000_000 }] },
      },
      {
        '/company-profile/AAPL': new Error('profile API down'),
      },
    );
    const result = await handler({ type: 'interest', symbol: 'AAPL' });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.symbol).toBe('AAPL');
  });
});
