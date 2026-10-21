import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LiveApiError, type LiveApiClient, type LiveRateLimit } from '../../proxy/liveApiClient.js';
import { INDEX_UNDERLYINGS, liveErrorMeaning } from '../liveGuide.js';
import { register } from './liveOptionsChain.js';

/**
 * get_live_options_chain through a real MCP client: the guide and the budget ride inside the
 * shaped answer in both channels, an omitted expiration reaches the shaper, and the chain's RATE_LIMITED legend carries
 * its reservation mechanics.
 */
async function harness(answer: () => Promise<unknown>, budget: LiveRateLimit | null = null) {
  const server = new McpServer({ name: 'live-chain-test', version: '1' });
  const seen: Record<string, string>[] = [];
  register(server, {
    get: async (_path: string, params?: Record<string, string>, onRateLimit?: (r: LiveRateLimit) => void) => {
      seen.push(params ?? {});
      const result = await answer();
      if (budget) onRateLimit?.(budget);
      return result;
    },
  } as unknown as LiveApiClient);
  const client = new Client({ name: 'live-chain-consumer', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, seen, close: async () => { await client.close(); await server.close(); } };
}

const CHAIN = {
  symbol: 'AAPL', expiration: '2026-10-16', dataSource: 'live', provider: 'tradier', asOf: '2026-10-14T15:00:00.000Z',
  spotPrice: 250, spotTime: '2026-10-14T14:59:58.000Z', spotStale: false,
  calls: [{ strike: 250, type: 'call', bid: 3, ask: 3.2, mid: 3.1, iv: 0.3, delta: 0.5, last: 3.1, volume: 10, openInterest: 100 }],
  puts: [{ strike: 250, type: 'put', bid: 3, ask: 3.2, mid: 3.1, iv: 0.3, delta: -0.5, last: 3.1, volume: 10, openInterest: 100 }],
};
const BUDGET = { limit: 120, remaining: 118, resetSeconds: 50, provider: 'tradier' };

describe('registered live options chain', () => {
  it('carries the guide and the budget in both channels; an omitted expiration says the nearest was chosen', async () => {
    const { client, close } = await harness(async () => CHAIN, BUDGET);
    try {
      const result = await client.callTool({ name: 'get_live_options_chain', arguments: { symbol: 'AAPL' } });
      expect(result.isError).not.toBe(true);
      const wire = result.structuredContent as any;
      expect(JSON.parse((result.content as { type: string; text: string }[])[0].text)).toEqual(wire);
      expect(wire.rateLimit).toEqual(BUDGET);
      expect(wire.guide.rateLimit).toMatch(/budget after this call/);
      expect(wire.guide.expiration).toMatch(/nearest listed/);
      expect(wire.guide.asOf).toBeDefined();
    } finally {
      await close();
    }
  });

  it('a named expiration does not claim it was chosen', async () => {
    const { client, close } = await harness(async () => CHAIN, BUDGET);
    try {
      const result = await client.callTool({ name: 'get_live_options_chain', arguments: { symbol: 'AAPL', expiration: '2026-10-16' } });
      expect((result.structuredContent as any).guide.expiration).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('the chain\'s RATE_LIMITED legend adds the reservation mechanics', async () => {
    const { client, close } = await harness(async () => {
      throw new LiveApiError('Rate limit exceeded. Retry in 12 seconds.', 429, 'RATE_LIMITED', true, undefined, { retryAfterSeconds: 12, rateLimit: BUDGET });
    });
    try {
      const wire = (await client.callTool({ name: 'get_live_options_chain', arguments: { symbol: 'AAPL' } })).structuredContent as any;
      expect(wire.meaning).toBe(liveErrorMeaning('chain', 'RATE_LIMITED', { retryAfterSeconds: 12, rateLimit: BUDGET }, false));
      expect(wire.meaning).toMatch(/bigger than the whole budget/);
      expect(liveErrorMeaning('quote', 'RATE_LIMITED', { rateLimit: BUDGET }, false)).not.toMatch(/bigger than the whole budget/);
    } finally {
      await close();
    }
  });
});

describe('INDEX_UNDERLYINGS', () => {
  // The public mirror ships the MCP server alone, without packages/shared: there this comparison has nothing to read.
  const sharedPackage = new URL('../../../../packages/shared/', import.meta.url);
  const sharedList = new URL('src/data/indexUnderlyings.ts', sharedPackage);
  it.skipIf(!existsSync(sharedPackage))('is the shared list (packages/shared/src/data/indexUnderlyings.ts): the MCP server imports nothing outside itself', () => {
    const shared = readFileSync(sharedList, 'utf8');
    const listed = [...shared.matchAll(/^\s+'([A-Z]+)',$/gm)].map((m) => m[1]).sort();
    expect(listed.length).toBe(11);
    expect([...INDEX_UNDERLYINGS].sort()).toEqual(listed);
  });
});

describe('the dealer tool\'s RATE_LIMITED legend', () => {
  it('adds the reservation mechanics and the whole-budget call', () => {
    const m = liveErrorMeaning('dealer', 'RATE_LIMITED', { rateLimit: BUDGET }, false)!;
    expect(m).toMatch(/four very large tastytrade chains/);
    expect(m).toMatch(/runs alone/);
  });
});

describe('the scan\'s SCAN_TOO_LARGE legend', () => {
  it('says the chain was charged only when fetched (a cached one was free), and a narrower band within 15 seconds can re-scan the cached chain uncharged', () => {
    const m = liveErrorMeaning('scan', 'SCAN_TOO_LARGE', { rateLimit: BUDGET }, false)!;
    // Review: the refusal also comes from a cached chain, with nothing sent and nothing reserved.
    expect(m).not.toMatch(/The chain was read and charged/);
    expect(m).toContain('a fresh fetch from the broker was charged, a chain from the 15-second cache was not');
    expect(m).toMatch(/within 15 seconds can re-scan the cached chain uncharged/);
    expect(m).toMatch(/per proxy instance/);
  });
});

describe('the ranking\'s BROKER_CREDENTIAL_INVALID legend', () => {
  it('says nothing more was sent and the symbols computed before it stay cached', () => {
    const m = liveErrorMeaning('ranking', 'BROKER_CREDENTIAL_INVALID', {}, false)!;
    expect(m).toMatch(/nothing more was sent/);
    expect(m).toMatch(/stay cached/);
  });
});

