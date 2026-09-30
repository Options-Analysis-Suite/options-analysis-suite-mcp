import { describe, expect, test } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { register } from './stockPrices.js';

/**
 * get_stock_prices carries each bar's confirmation and the symbol's history
 * state. The proxy names the state in X-Stock-History-State;
 * rows carry `confirmed` (null for index, future and crypto symbols).
 */
type ToolHandler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }>; structuredContent?: any }>;

function harness(rows: unknown[], state: string | null) {
  const calls: Array<{ path: string; params?: Record<string, string>; headers?: string[] }> = [];
  const client = {
    get: async () => { throw new Error('get_stock_prices must read the state header'); },
    getWithHeaders: async (path: string, params: Record<string, string>, names: string[]) => {
      calls.push({ path, params, headers: names });
      return { body: rows, headers: Object.fromEntries(names.map(n => [n, n.toLowerCase() === 'x-stock-history-state' ? state : null])) };
    },
    post: async () => ({}),
  } as unknown as ProxyClient;
  const captured: { handler: ToolHandler | null } = { handler: null };
  register({ registerTool: (_n: string, _c: unknown, h: ToolHandler) => { captured.handler = h; } } as unknown as McpServer, client);
  return { calls, handler: captured.handler! };
}

const rows = [
  { date: '2026-09-24', open: 10, high: 10, low: 10, close: 10, volume: 1, confirmed: true },
  { date: '2026-09-25', open: null, high: null, low: null, close: 11, volume: 1, confirmed: false },
];

describe('get_stock_prices history state', () => {
  test('reads the state header and returns it with each bar\'s confirmation', async () => {
    const { calls, handler } = harness(rows, 'pending_split');
    const out = await handler({ symbol: 'abc', days: 2 });
    expect(calls[0].path).toBe('/stock-prices');
    expect(calls[0].params).toEqual({ symbol: 'ABC', limit: '2' });
    expect(calls[0].headers).toEqual(['X-Stock-History-State']);
    const body = out.structuredContent;
    expect(body.historyState).toBe('pending_split');
    expect(body.data.map((r: any) => r.confirmed)).toEqual([true, false]);
    expect(body.data[1].open).toBeNull();
    expect(body.summary.unconfirmedSessions).toBe(1);
    expect(String(body.historyNote)).toMatch(/split/i);
  });

  test('a held symbol gets a note too; a current one does not', async () => {
    expect(String((await harness(rows, 'held').handler({ symbol: 'ABC', days: 2 })).structuredContent.historyNote)).toMatch(/held/i);
    expect((await harness(rows, 'current').handler({ symbol: 'ABC', days: 2 })).structuredContent.historyNote).toBeUndefined();
  });

  test('an index symbol is not_applicable, with no note and no unconfirmed count', async () => {
    const idx = rows.map(r => ({ ...r, confirmed: null }));
    const body = (await harness(idx, 'not_applicable').handler({ symbol: 'SPX', days: 2 })).structuredContent;
    expect(body.historyState).toBe('not_applicable');
    expect(body.historyNote).toBeUndefined();
    expect(body.summary.unconfirmedSessions).toBe(0);
  });

  test('a missing header is an unknown state, said as null', async () => {
    const body = (await harness(rows, null).handler({ symbol: 'ABC', days: 2 })).structuredContent;
    expect(body.historyState).toBeNull();
  });

  test('an empty result keeps the history state, its note and the summary', async () => {
    const out = await harness([], 'pending_split').handler({ symbol: 'ABC', days: 2 });
    const body = out.structuredContent;
    expect(body.dataAvailable).toBe(false);
    expect(body.data).toEqual([]);
    expect(body.historyState).toBe('pending_split');
    expect(String(body.historyNote)).toMatch(/split/i);
    expect(body.summary).toEqual({ sessionsReturned: 0, unconfirmedSessions: 0 });
    expect(out.content[0].text).toContain('historyState');
  });

  // Vendor names in the note text are caught by toolOutputSchemas.test.ts's
  // public-surface scan, which reads this source.
  test('no output key carries an underscore', async () => {
    const out = await harness(rows, 'pending_split').handler({ symbol: 'ABC', days: 2 });
    const keys: string[] = [];
    const walk = (v: any) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
    };
    walk(out.structuredContent);
    expect(keys.filter(k => k.includes('_'))).toEqual([]);
  });
});
