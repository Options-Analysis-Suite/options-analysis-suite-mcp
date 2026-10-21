import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './server.js';
import { SERVER_INSTRUCTIONS } from './serverInstructions.js';

/** The data vendors' short names, which no published text may carry (base64: the repo scans for the names). */
const VENDOR_SHORT = new RegExp(`(?<![A-Za-z])(?:${Buffer.from('Zm1w', 'base64')}s?|${Buffer.from('b3JhdHM=', 'base64')})(?![a-z])`, 'i');

async function connected() {
  const server = createMcpServer({ proxyUrl: 'http://proxy.test' } as any, { getAccessToken: async () => 'token' } as any);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'instructions-test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { server, client };
}

describe('server instructions', () => {
  test('a client receives them at initialization, the live-or-end-of-day choice and the prerequisites first', async () => {
    const { server, client } = await connected();
    try {
      const got = String(client.getInstructions());
      expect(got).toBe(SERVER_INSTRUCTIONS);
      expect(got.length).toBeLessThanOrEqual(1500);
      const head = got.slice(0, 512);
      for (const fact of ['end-of-day', 'LIVE', 'broker credential stored', 'get_snapshot']) expect(head, fact).toContain(fact);
      expect(got).not.toMatch(/\bPro\b|subscription/);
      expect(got).not.toMatch(/[–—]/);
      expect(got).not.toMatch(VENDOR_SHORT);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('no budget or rateLimit sentence (the descriptions and each answer carry them)', () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(/rateLimit|quota|budget|spend|cold call|cold-call|Cache-only/i);
  });

  test('the snapshots are named, and the live-or-end-of-day choice turns on the price now, with no sibling list', () => {
    expect(SERVER_INSTRUCTIONS.startsWith('Options Analysis Suite: options analytics, dealer positioning, regime and market data, and the user\'s synced snapshots (get_snapshot). ')).toBe(true);
    expect(SERVER_INSTRUCTIONS).toContain('Use a live tool when the answer depends on the current price or session (a quote, level or option price as of now), and otherwise the end-of-day sibling its description names.');
    expect(SERVER_INSTRUCTIONS).not.toContain('get_options_snapshot');
  });

  test('the no-loop rule is scoped to dealer and scan while ranking permits waited list retries', () => {
    expect(SERVER_INSTRUCTIONS).toContain('Do not poll get_live_dealer_positioning or scan_option_strategies in a loop or call them over a symbol list.');
    expect(SERVER_INSTRUCTIONS).toContain('For watchlist skew/GEX use rank_live_skew_gex; wait `retryAfterSeconds` before repeating its list.');
    expect(SERVER_INSTRUCTIONS).not.toContain('Never poll a live tool');
  });

  test('every tool they name is registered', async () => {
    const { server, client } = await connected();
    try {
      const registered = new Set((await client.listTools()).tools.map((t) => t.name));
      const named = SERVER_INSTRUCTIONS.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g) ?? [];
      expect(named.length).toBeGreaterThan(5);
      for (const name of named) expect(registered.has(name), name).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
