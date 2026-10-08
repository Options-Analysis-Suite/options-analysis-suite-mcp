import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LiveApiError, type LiveApiClient, type LiveRateLimit } from '../../proxy/liveApiClient.js';
import { register } from './liveQuote.js';

/**
 * get_live_quote relays the proxy's quote payload: a null stays null (the
 * broker published nothing), the budget rides beside it, and the broker's
 * own rate limit reaches the model as its code and wait.
 */
async function harness(answer: () => Promise<unknown>, budget: LiveRateLimit | null = null) {
  const server = new McpServer({ name: 'live-quote-test', version: '1' });
  register(server, {
    get: async (_path: string, _params?: Record<string, string>, onRateLimit?: (r: LiveRateLimit) => void) => {
      const result = await answer();
      if (budget) onRateLimit?.(budget);
      return result;
    },
  } as unknown as LiveApiClient);
  const client = new Client({ name: 'live-quote-consumer', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const payload = {
  schemaVersion: 1, symbol: 'SPX', dataSource: 'live', provider: 'schwab', asOf: '2026-09-17T15:00:00.000Z',
  quote: {
    last: 6500.2, bid: 6500.1, ask: 6500.3, bidSize: 1, askSize: 2, mid: 6500.2, mark: 6500.25,
    open: 6490, high: 6510, low: 6480, previousClose: 6495.5, volume: null,
    quoteTime: '2026-09-17T15:00:00.000Z', tradeTime: null,
  },
  change: 4.7, changePercent: 0.0724,
};

describe('registered live quote tool', () => {
  it('keeps every null, carries the budget with its provider, and matches text to structured output', async () => {
    const { client, close } = await harness(async () => payload, { limit: 120, remaining: 119, resetSeconds: 43, provider: 'schwab' });
    try {
      const result = await client.callTool({ name: 'get_live_quote', arguments: { symbol: 'SPX', provider: 'schwab' } });
      expect(result.isError).not.toBe(true);
      const wire = result.structuredContent as any;
      expect(JSON.parse((result.content as { type: string; text: string }[])[0].text)).toEqual(wire);
      expect(wire.quote.volume).toBeNull();
      expect(wire.quote.tradeTime).toBeNull();
      expect(wire.quote.mark).toBe(6500.25);
      expect(wire.rateLimit).toEqual({ limit: 120, remaining: 119, resetSeconds: 43, provider: 'schwab' });
      expect(wire.symbol).toBe('SPX');
    } finally {
      await close();
    }
  });

  it('reports the budget as null when the proxy sent none', async () => {
    const { client, close } = await harness(async () => payload);
    try {
      const result = await client.callTool({ name: 'get_live_quote', arguments: { symbol: 'SPX' } });
      expect((result.structuredContent as any).rateLimit).toBeNull();
    } finally {
      await close();
    }
  });

  it('relays the broker\'s own rate limit as its code and wait', async () => {
    const { client, close } = await harness(async () => {
      throw new LiveApiError('schwab asks for 9 seconds before the next request.', 429, 'BROKER_RATE_LIMITED', true, undefined, { retryAfterSeconds: 9, provider: 'schwab' });
    });
    try {
      const result = await client.callTool({ name: 'get_live_quote', arguments: { symbol: 'SPX' } });
      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('BROKER_RATE_LIMITED');
      expect(text).toContain('9 seconds');
    } finally {
      await close();
    }
  });
});
