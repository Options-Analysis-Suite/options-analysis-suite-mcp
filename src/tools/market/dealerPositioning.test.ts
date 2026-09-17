import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { LiveApiClient } from '../../proxy/liveApiClient.js';
import { register } from './dealerPositioning.js';

describe('registered live dealer-positioning tool', () => {
  it('preserves search meaning through shaping, wire cleanup and structured output', async () => {
    const base = {
      symbol: 'TEST', provider: 'tradier', dataSource: 'live', asOf: '2026-09-10T15:00:00Z',
      expirations: ['2026-09-18'], expirationsAvailable: 1, strikesUsed: 1,
      resolved: { r: 0.04, q: 0 },
      snapshot: {
        spotPrice: 100, gammaFlip: 98.05, netGamma: 12, netDelta: -100,
        netVega: 30, netVanna: 2, netCharm: 3, netVomma: 4,
        callWall: 100, putWall: 95, absGamma: 100, gammaConcentration: 1,
        regime: 'positive', topStrikes: [],
      },
      coverage: {
        strikes: 1, strikesWithGamma: 1, strikesWithDelta: 1,
        gamma: { total: 2, included: 2 }, delta: { total: 2, included: 2 },
        vega: { total: 2, included: 2 }, vanna: { total: 2, included: 2 },
        charm: { total: 2, included: 2 }, vomma: { total: 2, included: 2 },
        gammaFlip: { total: 2, included: 2 }, gammaFlipMethod: 'mixed',
        gammaFlipResolution: 0.0185, gammaFlipSearchStatus: 'found',
      },
      byStrike: [],
    };
    let response: Record<string, unknown> = base;
    const server = new McpServer({ name: 'dealer-positioning-test', version: '1' });
    register(server, { get: async () => response } as unknown as LiveApiClient);
    const client = new Client({ name: 'dealer-positioning-consumer', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const cases = [
        { name: 'found', coverage: base.coverage, rawFlip: 98.05, flip: 98.05, resolution: 0.0185, status: 'found' },
        { name: 'partial', coverage: { ...base.coverage, gammaFlip: { total: 3, included: 2 } }, rawFlip: 98.05, flip: null, resolution: null, status: 'found' },
        { name: 'not-found', coverage: { ...base.coverage, gammaFlipResolution: null, gammaFlipSearchStatus: 'not-found' }, rawFlip: null, flip: null, resolution: null, status: 'not-found' },
        { name: 'unresolved', coverage: { ...base.coverage, gammaFlipResolution: null, gammaFlipSearchStatus: 'unresolved' }, rawFlip: null, flip: null, resolution: null, status: 'unresolved' },
        { name: 'legacy', coverage: { ...base.coverage, gammaFlipSearchStatus: undefined }, rawFlip: 98.05, flip: 98.05, resolution: 0.0185, status: null },
      ];
      for (const scenario of cases) {
        response = { ...base, coverage: scenario.coverage, snapshot: { ...base.snapshot, gammaFlip: scenario.rawFlip } };
        const result = await client.callTool({ name: 'get_live_dealer_positioning', arguments: { symbol: 'TEST' } });
        expect(result.isError, scenario.name).not.toBe(true);
        const wire = result.structuredContent as any;
        const text = (result.content as { type: string; text: string }[])[0].text;
        expect(JSON.parse(text), scenario.name).toEqual(wire);
        expect(wire.levels.gammaFlip, scenario.name).toBe(scenario.flip);
        expect(wire.coverage.gammaFlipResolution, scenario.name).toBe(scenario.resolution);
        expect(wire.coverage.gammaFlipSearchStatus, scenario.name).toBe(scenario.status);
        expect(wire.coverage.gammaFlipMethod, scenario.name).toBe('mixed');
        expect(wire.limitations.join(' '), scenario.name).toMatch(/can be missed/);
        if (scenario.name === 'unresolved') expect(wire.limitations.join(' ')).toMatch(/numerical/);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
