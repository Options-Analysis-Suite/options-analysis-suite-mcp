import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LiveApiError, type LiveApiClient, type LiveRateLimit } from '../../proxy/liveApiClient.js';
import { register } from './liveBars.js';

async function harness(answer: (path: string, params?: Record<string, string>) => Promise<unknown>, budget: LiveRateLimit | null = null) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const server = new McpServer({ name: 'live-bars-test', version: '1' });
  register(server, {
    get: async (path: string, params?: Record<string, string>, onRateLimit?: (r: LiveRateLimit) => void) => {
      calls.push({ path, params });
      const result = await answer(path, params);
      if (budget) onRateLimit?.(budget);
      return result;
    },
  } as unknown as LiveApiClient);
  const client = new Client({ name: 'live-bars-consumer', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, calls, close: async () => { await client.close(); await server.close(); } };
}

const payload = {
  schemaVersion: 1, symbol: 'SPY', dataSource: 'live', provider: 'tradier', asOf: '2026-09-17T15:00:00.000Z',
  date: '2026-09-17', interval: '5min', session: 'regular', sessionWindow: { start: '2026-09-17T09:30:00-04:00', end: '2026-09-17T11:00:00-04:00' },
  barCount: 2,
  bars: [
    { time: '2026-09-17T09:30:00-04:00', open: 10, high: 12, low: 8, close: 10, volume: 100, vwap: 10, vwapUpper: 10, vwapLower: 10 },
    { time: '2026-09-17T09:35:00-04:00', open: 10, high: 14, low: 10, close: 12, volume: null, vwap: 11.5, vwapUpper: 12.6, vwapLower: 10.4 },
  ],
  summary: { open: 10, high: 14, low: 8, close: 12, volume: 100, firstBarTime: '2026-09-17T09:30:00-04:00', lastBarTime: '2026-09-17T09:35:00-04:00' },
  vwap: { anchor: '2026-09-17T09:30:00-04:00', value: 11.5, stdev: 1.1, upper: 12.6, lower: 10.4, reason: null },
  indicators: [{ name: 'rsi', params: { period: 14, source: 'close' }, latest: { rsi: null }, series: { rsi: [] } }],
};

describe('registered intraday bars tool', () => {
  it('asks the proxy with the interval, session, date and indicators, and relays the shaped session with its budget', async () => {
    const { client, calls, close } = await harness(async () => payload, { limit: 120, remaining: 119, resetSeconds: 43, provider: 'tradier' });
    try {
      const result = await client.callTool({ name: 'get_intraday_bars', arguments: { symbol: 'spy', interval: '5min', date: '2026-09-17', indicators: [{ name: 'rsi' }], maxBars: 10 } });
      expect(result.isError).not.toBe(true);
      expect(calls).toEqual([{ path: '/live/bars/SPY', params: { interval: '5min', session: 'regular', date: '2026-09-17', indicators: JSON.stringify([{ name: 'rsi' }]) } }]);
      const wire = result.structuredContent as any;
      expect(JSON.parse((result.content as { type: string; text: string }[])[0].text)).toEqual(wire);
      expect(wire.bars.rows[1]).toEqual(['2026-09-17T09:35:00-04:00', 10, 14, 10, 12, null, 11.5]);
      expect(wire.indicators[0].latest.rsi).toBeNull();
      expect(wire.rateLimit).toEqual({ limit: 120, remaining: 119, resetSeconds: 43, provider: 'tradier' });
    } finally {
      await close();
    }
  });

  it('relays a broker refusal by its code, naming the brokers that can', async () => {
    const { client, close } = await harness(async () => {
      throw new LiveApiError('tastytrade has no REST candles', 400, 'BARS_NOT_SUPPORTED', false, undefined, { supportedProviders: ['tradier', 'schwab'] });
    });
    try {
      const result = await client.callTool({ name: 'get_intraday_bars', arguments: { symbol: 'SPY' } });
      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('BARS_NOT_SUPPORTED');
      expect(text).toContain('tradier');
    } finally {
      await close();
    }
  });
});
