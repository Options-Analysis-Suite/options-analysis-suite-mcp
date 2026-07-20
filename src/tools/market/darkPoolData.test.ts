import { describe, test, expect } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { register } from './darkPoolData.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }> }>;

function createHarness(stubByPath: Record<string, unknown | null> = {}) {
  const calls: Array<{ path: string }> = [];
  const fakeClient: ProxyClient = {
    get: async (path: string) => {
      calls.push({ path });
      if (path in stubByPath) return stubByPath[path];
      return null;
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

describe('get_dark_pool_data — view=summary (default behavior)', () => {
  test('defaults to summary view; fetches OTC aggregate + ATS aggregate', async () => {
    const { calls, handler } = createHarness({
      '/finra/otc-trading/SPY': { symbol: 'SPY', weeklyData: [{ weekEnding: '2026-04-11', totalShares: 1e9, totalTrades: 1e6 }], summary: {} },
      '/finra/ats-data/SPY': { symbol: 'SPY', weeklyData: [{ weekEnding: '2026-04-11', totalShares: 5e8, totalTrades: 5e5 }], summary: {} },
    });
    await handler({ symbol: 'spy' });
    const paths = calls.map(c => c.path);
    expect(paths).toContain('/finra/otc-trading/SPY');
    expect(paths).toContain('/finra/ats-data/SPY');
  });

  test('both sources missing returns "No data available"', async () => {
    const { handler } = createHarness({});
    const result = await handler({ symbol: 'ZZZZ' });
    expect(result.content[0].text).toContain('No data available');
  });

  test('full=true returns less-summarized aggregate payload', async () => {
    const otc = { symbol: 'SPY', weeklyData: Array.from({ length: 52 }, (_, i) => ({ weekEnding: `w${i}` })), summary: {} };
    const ats = { symbol: 'SPY', weeklyData: [{ weekEnding: 'w0' }], summary: {} };
    const { handler } = createHarness({
      '/finra/otc-trading/SPY': otc,
      '/finra/ats-data/SPY': ats,
    });
    const result = await handler({ symbol: 'SPY', full: true });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.otcTrading.weeklyData).toHaveLength(52);
    expect(parsed.atsData.weeklyData).toHaveLength(1);
  });
});

describe('get_dark_pool_data — view=dealers', () => {
  test('routes to /finra/otc-trading/:SYMBOL/firms', async () => {
    const firms = { symbol: 'SPY', firms: { '2026-04-11': [{ mpid: 'CDRG', name: 'Citadel Securities', shares: 5e8, trades: 2e5 }] } };
    const { calls, handler } = createHarness({ '/finra/otc-trading/SPY/firms': firms });
    const result = await handler({ symbol: 'spy', view: 'dealers' });
    expect(calls[0].path).toBe('/finra/otc-trading/SPY/firms');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.firms['2026-04-11'][0].mpid).toBe('CDRG');
  });

  test('passes weeks through', async () => {
    const { calls, handler } = createHarness({ '/finra/otc-trading/SPY/firms?weeks=26': { symbol: 'SPY', firms: {} } });
    await handler({ symbol: 'SPY', view: 'dealers', weeks: 26 });
    expect(calls[0].path).toBe('/finra/otc-trading/SPY/firms?weeks=26');
  });

  test('missing data returns "No data available"', async () => {
    const { handler } = createHarness({});
    const result = await handler({ symbol: 'ZZZZ', view: 'dealers' });
    expect(result.content[0].text).toContain('No data available');
  });
});

describe('get_dark_pool_data — view=venues', () => {
  test('routes to /finra/ats-data/:SYMBOL/firms', async () => {
    const firms = { symbol: 'SPY', firms: { '2026-04-11': [{ mpid: 'UBSA', name: 'UBS ATS', shares: 3e7, trades: 1e4 }] } };
    const { calls, handler } = createHarness({ '/finra/ats-data/SPY/firms': firms });
    const result = await handler({ symbol: 'SPY', view: 'venues' });
    expect(calls[0].path).toBe('/finra/ats-data/SPY/firms');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.firms['2026-04-11'][0].mpid).toBe('UBSA');
  });

  test('passes weeks through', async () => {
    const { calls, handler } = createHarness({ '/finra/ats-data/SPY/firms?weeks=4': { symbol: 'SPY', firms: {} } });
    await handler({ symbol: 'SPY', view: 'venues', weeks: 4 });
    expect(calls[0].path).toBe('/finra/ats-data/SPY/firms?weeks=4');
  });
});

describe('get_dark_pool_data — view=all', () => {
  test('fetches aggregate + firm paths in one call', async () => {
    const { calls, handler } = createHarness({
      '/finra/otc-trading/SPY': { symbol: 'SPY', weeklyData: [], summary: {} },
      '/finra/ats-data/SPY': { symbol: 'SPY', weeklyData: [], summary: {} },
      '/finra/otc-trading/SPY/firms': { symbol: 'SPY', firms: {} },
      '/finra/ats-data/SPY/firms': { symbol: 'SPY', firms: {} },
    });
    await handler({ symbol: 'SPY', view: 'all' });
    const paths = calls.map(c => c.path);
    expect(paths).toContain('/finra/otc-trading/SPY');
    expect(paths).toContain('/finra/ats-data/SPY');
    expect(paths).toContain('/finra/otc-trading/SPY/firms');
    expect(paths).toContain('/finra/ats-data/SPY/firms');
  });

  test('returns { summary, dealers, venues } envelope; missing firm paths get notes', async () => {
    const { handler } = createHarness({
      '/finra/otc-trading/SPY': { symbol: 'SPY', weeklyData: [{ weekEnding: '2026-04-11', totalShares: 1e9, totalTrades: 1e6 }], summary: {} },
      '/finra/ats-data/SPY': { symbol: 'SPY', weeklyData: [{ weekEnding: '2026-04-11', totalShares: 5e8, totalTrades: 5e5 }], summary: {} },
      '/finra/otc-trading/SPY/firms': { symbol: 'SPY', firms: { '2026-04-11': [] } },
      // ats firms: missing
    });
    const result = await handler({ symbol: 'SPY', view: 'all' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.summary).toBeDefined();
    expect(parsed.dealers).toBeDefined();
    expect(parsed.venues).toBeNull();
    expect(parsed.venuesNote).toContain('No ATS venue breakdown');
  });

  test('all four paths missing returns "No data available"', async () => {
    const { handler } = createHarness({});
    const result = await handler({ symbol: 'ZZZZ', view: 'all' });
    expect(result.content[0].text).toContain('No data available');
  });

  test('weeks applies to all four paths (aggregate + firm-level)', async () => {
    const { calls, handler } = createHarness({
      '/finra/otc-trading/SPY?weeks=4': { symbol: 'SPY', weeklyData: [], summary: {} },
      '/finra/ats-data/SPY?weeks=4': { symbol: 'SPY', weeklyData: [], summary: {} },
      '/finra/otc-trading/SPY/firms?weeks=4': { symbol: 'SPY', firms: {} },
      '/finra/ats-data/SPY/firms?weeks=4': { symbol: 'SPY', firms: {} },
    });
    await handler({ symbol: 'SPY', view: 'all', weeks: 4 });
    const paths = calls.map(c => c.path);
    expect(paths).toContain('/finra/otc-trading/SPY?weeks=4');
    expect(paths).toContain('/finra/ats-data/SPY?weeks=4');
    expect(paths).toContain('/finra/otc-trading/SPY/firms?weeks=4');
    expect(paths).toContain('/finra/ats-data/SPY/firms?weeks=4');
  });

  test('aggregate partial failure surfaces _otc_note / _ats_note in the all envelope', async () => {
    const failingClient: ProxyClient = {
      get: async (path: string) => {
        if (path === '/finra/otc-trading/SPY') {
          throw new Error('upstream 500');
        }
        if (path === '/finra/ats-data/SPY') {
          return { symbol: 'SPY', weeklyData: [{ weekEnding: '2026-04-11', totalShares: 5e8, totalTrades: 5e5 }], summary: {} };
        }
        if (path === '/finra/otc-trading/SPY/firms') {
          return { symbol: 'SPY', firms: { '2026-04-11': [] } };
        }
        if (path === '/finra/ats-data/SPY/firms') {
          return { symbol: 'SPY', firms: { '2026-04-11': [] } };
        }
        return null;
      },
      post: async () => ({}),
    } as unknown as ProxyClient;

    const captured: { handler: ToolHandler | null } = { handler: null };
    const fakeServer = {
      registerTool: (_n: string, _config: unknown, h: ToolHandler) => { captured.handler = h; },
    } as unknown as McpServer;
    register(fakeServer, failingClient);
    if (!captured.handler) throw new Error('handler not captured');

    const result = await captured.handler({ symbol: 'SPY', view: 'all' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.otcNote).toContain('OTC aggregate unavailable');
    expect(parsed.otcNote).toContain('upstream 500');
    expect(parsed._ats_note).toBeUndefined(); // ATS aggregate succeeded
    expect(parsed.dealers).not.toBeNull();
    expect(parsed.venues).not.toBeNull();
  });
});
