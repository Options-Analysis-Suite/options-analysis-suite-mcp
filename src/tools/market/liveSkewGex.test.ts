import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LiveApiError, type LiveApiClient, type LiveRateLimit } from '../../proxy/liveApiClient.js';
import { register } from './liveSkewGex.js';

/**
 * rank_live_skew_gex: the request it makes of the proxy, what it refuses
 * before making one, and the budget and errors it carries back.
 */
async function harness(answer: () => Promise<unknown>, budget: LiveRateLimit | null = null) {
  const calls: Array<{ path: string; params: Record<string, string> | undefined }> = [];
  const server = new McpServer({ name: 'live-skew-gex-test', version: '1' });
  register(server, {
    get: async (path: string, params?: Record<string, string>, onRateLimit?: (r: LiveRateLimit) => void) => {
      calls.push({ path, params });
      const result = await answer();
      if (budget) onRateLimit?.(budget);
      return result;
    },
  } as unknown as LiveApiClient);
  const client = new Client({ name: 'live-skew-gex-consumer', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, calls, close: async () => { await client.close(); await server.close(); } };
}

const row = (symbol: string, skew: number, gexChange: number) => ({
  symbol, spot: { value: 100, time: null, stale: null }, valuation: 'now', q: { value: 0.01, source: 'ratios_ttm', asOf: null }, rates: [],
  baseline: { status: 'found', date: '2026-10-19', sessionsSkipped: 0, spot: 99, missingExpirations: [] },
  skew: { status: 'ok', value: skew, callIv25d: 0.2, putIv25d: 0.2 + skew, ivSkew10d: null, expiration: '2026-11-20', dte: 31, prior: { value: 0.04, status: 'ok' }, change: skew - 0.04, ageSeconds: 0, baselineDate: '2026-10-19' },
  gex: {
    status: 'ok', value: 1000, expirations: ['2026-10-20'], gammaCoverage: { total: 10, included: 10 }, oiShare: 1,
    strikeCoverage: { strikes: 5, strikesOtmSide: 5, strikesFilled: 0, strikesNoIv: 0 },
    prior: { value: 1000 - gexChange, oiShare: 1, status: 'ok' }, change: gexChange, changePct: gexChange / Math.abs(1000 - gexChange), ageSeconds: 0, baselineDate: '2026-10-19',
  },
});

const payload = {
  schemaVersion: 1, dataSource: 'live', provider: 'schwab', asOf: '2026-10-20T15:00:00.000Z',
  session: { liveSessionDate: '2026-10-20', marketOpen: true, valuation: 'now' },
  method: { id: 'own-model-v1' }, notes: {}, metrics: ['skew', 'gex'], maxAgeSeconds: 120,
  results: [row('AAA', 0.03, -500), row('BBB', 0.07, 20), row('CCC', 0.05, 300)],
  pending: [{ symbol: 'DDD', metrics: ['skew', 'gex'], reason: 'budget' }], refreshPending: [], errors: [],
  retryAfterSeconds: 41, complete: false,
};

const text = (result: any) => (result.content as { type: string; text: string }[])[0].text;

describe('registered rank_live_skew_gex tool', () => {
  it('asks the proxy for the list, de-duplicated and upper-cased, the metrics in one order, the age and the broker', async () => {
    const { client, calls, close } = await harness(async () => payload);
    try {
      await client.callTool({ name: 'rank_live_skew_gex', arguments: { symbols: ' aaa, BBB,aaa ,ccc,, ', metrics: ['gex', 'skew', 'gex'], maxAgeSeconds: 300, provider: 'schwab' } });
      expect(calls).toEqual([{ path: '/live/skew-gex', params: { symbols: 'AAA,BBB,CCC', metrics: 'skew,gex', maxAgeSeconds: '300', provider: 'schwab' } }]);
    } finally {
      await close();
    }
  });

  it('sends both metrics and no age or broker when none are named', async () => {
    const { client, calls, close } = await harness(async () => payload);
    try {
      await client.callTool({ name: 'rank_live_skew_gex', arguments: { symbols: 'AAA' } });
      expect(calls).toEqual([{ path: '/live/skew-gex', params: { symbols: 'AAA', metrics: 'skew,gex' } }]);
    } finally {
      await close();
    }
  });

  it('ranks, carries the budget with its provider, keeps pending and the wait, and matches text to structured output', async () => {
    const { client, close } = await harness(async () => payload, { limit: 120, remaining: 0, resetSeconds: 41, provider: 'schwab' });
    try {
      const result = await client.callTool({ name: 'rank_live_skew_gex', arguments: { symbols: 'AAA,BBB,CCC,DDD', rankBy: 'gexChange' } });
      expect(result.isError).not.toBe(true);
      const wire = result.structuredContent as any;
      expect(JSON.parse(text(result))).toEqual(wire);
      expect(wire.results.map((r: any) => [r.symbol, r.gex.change])).toEqual([['AAA', -500], ['CCC', 300], ['BBB', 20]]);
      expect(wire.rankMeta).toMatchObject({ rankBy: 'gexChange', order: 'desc', ranked: 3, unranked: 0 });
      expect(wire.pending).toEqual([{ symbol: 'DDD', metrics: ['skew', 'gex'], reason: 'budget' }]);
      expect(wire).toMatchObject({ complete: false, retryAfterSeconds: 41, requested: 4, returned: 3 });
      expect(wire.rateLimit).toEqual({ limit: 120, remaining: 0, resetSeconds: 41, provider: 'schwab' });
    } finally {
      await close();
    }
  });

  it('reports the budget as null when the proxy sent none', async () => {
    const { client, close } = await harness(async () => payload);
    try {
      const result = await client.callTool({ name: 'rank_live_skew_gex', arguments: { symbols: 'AAA' } });
      expect((result.structuredContent as any).rateLimit).toBeNull();
    } finally {
      await close();
    }
  });

  it('refuses a ranking on a metric it was not asked to compute, before any request', async () => {
    const { client, calls, close } = await harness(async () => payload);
    try {
      const result = await client.callTool({ name: 'rank_live_skew_gex', arguments: { symbols: 'AAA', metrics: ['skew'], rankBy: 'gexChange' } });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('rankBy gexChange needs the gex metric');
      expect(calls).toEqual([]);
    } finally {
      await close();
    }
  });

  it('refuses more than 50 distinct symbols, and none, before any request', async () => {
    const { client, calls, close } = await harness(async () => payload);
    try {
      const many = Array.from({ length: 51 }, (_, i) => `S${i}`).join(',');
      const tooMany = await client.callTool({ name: 'rank_live_skew_gex', arguments: { symbols: many } });
      expect(tooMany.isError).toBe(true);
      expect(text(tooMany)).toContain('at most 50');
      const none = await client.callTool({ name: 'rank_live_skew_gex', arguments: { symbols: ' , ' } });
      expect(none.isError).toBe(true);
      expect(calls).toEqual([]);
      // Fifty after de-duplication is fine.
      const fifty = `${Array.from({ length: 50 }, (_, i) => `S${i}`).join(',')},S0`;
      const ok = await client.callTool({ name: 'rank_live_skew_gex', arguments: { symbols: fifty } });
      expect(ok.isError).not.toBe(true);
      expect(calls).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('relays a call-ending refusal with its code: a dead credential', async () => {
    const { client, close } = await harness(async () => {
      throw new LiveApiError('The stored broker credential was refused; sign in again.', 400, 'BROKER_CREDENTIAL_INVALID', false, 'https://example.test/account', undefined);
    });
    try {
      const result = await client.callTool({ name: 'rank_live_skew_gex', arguments: { symbols: 'AAA,BBB' } });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('BROKER_CREDENTIAL_INVALID');
    } finally {
      await close();
    }
  });
});
