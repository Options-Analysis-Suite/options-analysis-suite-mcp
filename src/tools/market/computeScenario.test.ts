import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LiveApiError, type LiveApiClient } from '../../proxy/liveApiClient.js';
import { register } from './computeScenario.js';

/**
 * compute_scenario posts the request as given to the proxy's scenario route
 * and relays the answer rounded for the model; a refusal naming the missing
 * fields reaches the model as that code and those names.
 */
async function harness(answer: (body: unknown) => Promise<unknown>) {
  const posted: Array<{ path: string; body: unknown }> = [];
  const server = new McpServer({ name: 'scenario-test', version: '1' });
  register(server, {
    post: async (path: string, body: unknown) => { posted.push({ path, body }); return answer(body); },
  } as unknown as LiveApiClient);
  const client = new Client({ name: 'scenario-consumer', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, posted, close: async () => { await client.close(); await server.close(); } };
}

const payload = {
  schemaVersion: 1, symbol: 'SPY', asOf: '2026-10-02T19:00:00.000Z', dayCount: 'calendar', greekConvention: 'dapi',
  inputs: { spot: { value: 500, source: 'supplied', asOf: null }, r: { value: 0.04, source: 'supplied', asOf: null }, q: { value: 0.01, source: 'supplied', asOf: null } },
  legs: [{ index: 0, type: 'call', side: 'long', quantity: 1, strike: 500, expiration: null, t: 0.5, tSource: 't', iv: { value: 0.2, source: 'supplied', asOf: null }, entryPremium: { value: 30.123456789, source: 'model' }, model: 'black-scholes', basePrice: 30.123456789 }],
  base: { positionValue: 3012.3456789, entryValue: 3012.3456789, greeks: { delta: 56.789012345 } },
  grid: { axes: { spotMoves: [0], ivShocks: [0], daysElapsed: [0] }, spots: [500], pnl: [[[0.004]]], positionValue: [[[3012.3456789]]] },
  notes: { pnl: 'note' },
};

describe('registered compute_scenario tool', () => {
  it('posts only what was given, with full kept out of the body, and rounds the answer', async () => {
    const { client, posted, close } = await harness(async () => payload);
    try {
      const result = await client.callTool({
        name: 'compute_scenario',
        arguments: { symbol: 'spy', legs: [{ type: 'call', side: 'long', strike: 500, t: 0.5, iv: 0.2 }], spot: 500, r: 0.04, q: 0.01, shocks: { spotMoves: [0], ivShocks: [0], daysElapsed: [0] } },
      });
      expect(result.isError).not.toBe(true);
      expect(posted).toEqual([{
        path: '/compute/scenario',
        body: { symbol: 'spy', legs: [{ type: 'call', side: 'long', strike: 500, t: 0.5, iv: 0.2 }], spot: 500, r: 0.04, q: 0.01, shocks: { spotMoves: [0], ivShocks: [0], daysElapsed: [0] } },
      }]);
      const wire = result.structuredContent as any;
      expect(JSON.parse((result.content as { type: string; text: string }[])[0].text)).toEqual(wire);
      expect(wire.legs[0].basePrice).toBeUndefined();
      expect(wire.legs[0].entryPremium.value).toBe(30.1235);
      expect(wire.grid.positionValue).toBeUndefined();
      expect(wire.grid.pnl).toEqual([[[0]]]);
      expect(wire.base.greeks.delta).toBe(56.789);
      expect(wire.greekConvention).toBe('dapi');
    } finally {
      await close();
    }
  });

  it('a strategyKey posts the key alone; the route reads the record', async () => {
    const { client, posted, close } = await harness(async () => ({ ...payload, strategy: { strategyKey: 'a'.repeat(64), label: 'Bull call spread', builtAt: 'x', updatedAt: 'y' } }));
    try {
      const result = await client.callTool({ name: 'compute_scenario', arguments: { strategyKey: 'a'.repeat(64), shocks: { spotMoves: [0] } } });
      expect(result.isError).not.toBe(true);
      expect(posted).toEqual([{ path: '/compute/scenario', body: { strategyKey: 'a'.repeat(64), shocks: { spotMoves: [0] } } }]);
      expect((result.structuredContent as any).strategy.label).toBe('Bull call spread');
    } finally {
      await close();
    }
  });

  it('full relays the route\'s exact answer', async () => {
    const { client, posted, close } = await harness(async () => payload);
    try {
      const result = await client.callTool({ name: 'compute_scenario', arguments: { legs: [{ type: 'call', side: 'long', strike: 500, t: 0.5, iv: 0.2 }], spot: 500, r: 0.04, q: 0.01, full: true } });
      expect((posted[0]!.body as Record<string, unknown>).full).toBeUndefined();
      const wire = result.structuredContent as any;
      expect(wire.legs[0].basePrice).toBe(30.123456789);
      expect(wire.grid.positionValue).toEqual([[[3012.3456789]]]);
    } finally {
      await close();
    }
  });

  it('a refusal naming the missing fields reaches the model as that code and those names', async () => {
    const { client, close } = await harness(async () => {
      throw new LiveApiError('Could not resolve spot, legs[0].iv for XYZ', 422, 'RESOLUTION_FAILED', false, undefined, { missingFields: ['spot', 'legs[0].iv'], warnings: ['XYZ: no spot price on file (snapshot or scan_tickers)'] });
    });
    try {
      const result = await client.callTool({ name: 'compute_scenario', arguments: { symbol: 'XYZ', legs: [{ type: 'call', side: 'long', strike: 50, daysToExpiry: 30 }] } });
      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('RESOLUTION_FAILED');
      expect(text).toContain('legs[0].iv');
      expect(text).toContain('no spot price on file');
    } finally {
      await close();
    }
  });
});
