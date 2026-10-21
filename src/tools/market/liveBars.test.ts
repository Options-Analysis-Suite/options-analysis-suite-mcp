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
    { time: '2026-09-17T09:35:00-04:00', open: 10, high: 14, low: 10, close: 12, volume: null, vwap: null, vwapUpper: null, vwapLower: null },
  ],
  summary: { open: 10, high: 14, low: 8, close: 12, volume: null, firstBarTime: '2026-09-17T09:30:00-04:00', lastBarTime: '2026-09-17T09:35:00-04:00' },
  vwap: { anchor: '2026-09-17T09:30:00-04:00', value: null, stdev: null, upper: null, lower: null, reason: 'no-volume' },
  indicators: [{ name: 'rsi', params: { period: 14, source: 'close' }, latest: { rsi: null }, series: { rsi: [] } }],
};

describe('registered intraday bars tool', () => {
  it('keeps incomplete session volume and VWAP null through the registered tool, with the valid bar prefix and indicator reason', async () => {
    const { client, close } = await harness(async () => ({
      ...payload,
      indicators: [{ name: 'obv', params: {}, latest: { obv: null }, series: { obv: [] }, reason: 'no-volume' }],
    }));
    try {
      const result = await client.callTool({ name: 'get_intraday_bars', arguments: { symbol: 'SPY', indicators: [{ name: 'obv' }] } });
      expect(result.isError).not.toBe(true);
      const wire = result.structuredContent as any;
      expect(JSON.parse((result.content as { type: string; text: string }[])[0]!.text)).toEqual(wire);
      expect(wire.summary.volume).toBeNull();
      expect(wire.vwap).toMatchObject({ value: null, stdev: null, upper: null, lower: null, reason: 'no-volume' });
      expect(wire.bars.rows.map((row: unknown[]) => row[6])).toEqual([10, null]);
      expect(wire.indicators[0]).toMatchObject({ latest: { obv: null }, points: { obv: [] }, reason: 'no-volume' });
    } finally {
      await close();
    }
  });

  it('asks the proxy with the interval, session, date and indicators, and relays the shaped session with its budget', async () => {
    const { client, calls, close } = await harness(async () => payload, { limit: 120, remaining: 119, resetSeconds: 43, provider: 'tradier' });
    try {
      const result = await client.callTool({ name: 'get_intraday_bars', arguments: { symbol: 'spy', interval: '5min', date: '2026-09-17', indicators: [{ name: 'rsi' }], maxBars: 10 } });
      expect(result.isError).not.toBe(true);
      expect(calls).toEqual([{ path: '/live/bars/SPY', params: { interval: '5min', session: 'regular', date: '2026-09-17', indicators: JSON.stringify([{ name: 'rsi' }]) } }]);
      const wire = result.structuredContent as any;
      expect(JSON.parse((result.content as { type: string; text: string }[])[0].text)).toEqual(wire);
      expect(wire.bars.rows[1]).toEqual(['2026-09-17T09:35:00-04:00', 10, 14, 10, 12, null, null]);
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

describe('bars error guidance after the description cut', () => {
  for (const code of ['BROKER_REJECTED', 'BROKER_UNAVAILABLE']) it(`${code} reaches both wire channels with its details and meaning`, async () => {
    const { client, close } = await harness(async () => {
      throw new LiveApiError('Broker request failed', 502, code, code === 'BROKER_UNAVAILABLE', undefined, {
        brokerFailure: 'http-status', brokerStatus: code === 'BROKER_REJECTED' ? 422 : 503,
      });
    });
    try {
      const result = await client.callTool({ name: 'get_intraday_bars', arguments: { symbol: 'SPY' } });
      expect(result.isError).toBe(true);
      const out = result.structuredContent as any;
      expect(out.code).toBe(code);
      expect(out.brokerFailure).toBe('http-status');
      expect(out.brokerStatus).toBe(code === 'BROKER_REJECTED' ? 422 : 503);
      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain(out.meaning);
      if (code === 'BROKER_REJECTED') {
        expect(out.retryable).toBe(false);
        expect(out.meaning).toContain('an HTTP 4xx other than 408, 409, 425 and 429');
        expect(out.meaning).toContain('not a credential refusal or a failed sign-in');
        expect(out.meaning).toContain('Retrying the same request on the same broker will not help');
        expect(out.meaning).toContain('another stored broker may answer');
      } else {
        expect(out.retryable).toBe(true);
        for (const value of ['http-status', 'brokerStatus', 'timeout', 'unreadable-response', 'no-usable-answer', 'other']) expect(out.meaning).toContain(value);
        expect(out.meaning).toContain('No broker text is passed on');
      }
    } finally { await close(); }
  });
});
