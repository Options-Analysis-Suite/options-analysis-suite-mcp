import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { LiveApiError, type LiveApiClient } from '../../proxy/liveApiClient.js';
import { register } from './earnings.js';

/**
 * get_earnings answers the EPS history as before; includeMoves adds the
 * proxy's moves route beside it, and a moves refusal is reported in the
 * answer rather than failing the EPS history the caller also asked for.
 */
const EPS = {
  symbol: 'AAPL',
  earnings_history: [
    { date: '2026-07-30', epsActual: 1.4, epsEstimated: 1.3, revenueActual: 9e10, revenueEstimated: 8.9e10 },
    { date: '2026-04-30', epsActual: 1.2, epsEstimated: 1.1, revenueActual: 8e10, revenueEstimated: 7.9e10 },
  ],
  fetched_at: '2026-10-01T00:00:00Z',
};
const MOVES = {
  schemaVersion: 1, symbol: 'AAPL', asOf: '2026-10-02', straddleWindowStart: '2025-10-01',
  events: [{ date: '2026-07-30', timing: 'amc', preSession: '2026-07-29', reportSession: '2026-07-30', nextSession: '2026-07-31', closes: { pre: 200, report: 204, next: 214.2 }, priorCloseToReportClosePct: 2, reportCloseToNextClosePct: 5, implied: { movePct: 3, source: 'straddle', straddle: 6, spot: 200, expiration: '2026-07-31', strike: 200, asOf: '2026-07-29', tenor: null, reason: null }, ivCrush: { pct: 50, tenor: '7d', preIv: 0.6, postIv: 0.3, preSession: '2026-07-29', postSession: '2026-07-31' }, realizedOverImplied: { priorToReport: 0.6667, reportToNext: 1.6667 } }],
  summary: { events: 1, impliedSources: { straddle: 1, atmIv: 0, none: 0 }, avgAbsPriorCloseToReportClosePct: 2, avgAbsReportCloseToNextClosePct: 5, avgRealizedOverImplied: { priorToReport: 0.6667, reportToNext: 1.6667 } },
  notes: { moves: 'm', implied: 'i', crush: 'c' },
  priceHistory: { state: 'current', unconfirmed: 0 },
};

async function harness(movesAnswer: () => Promise<unknown>) {
  const liveGets: string[] = [];
  const server = new McpServer({ name: 'earnings-test', version: '1' });
  register(server, { get: async () => EPS } as unknown as ProxyClient, {
    get: async (path: string) => { liveGets.push(path); return movesAnswer(); },
  } as unknown as LiveApiClient);
  const client = new Client({ name: 'earnings-consumer', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, liveGets, close: async () => { await client.close(); await server.close(); } };
}

describe('registered get_earnings tool', () => {
  it('answers the EPS history alone by default, without touching the moves route', async () => {
    const { client, liveGets, close } = await harness(async () => MOVES);
    try {
      const result = await client.callTool({ name: 'get_earnings', arguments: { symbol: 'aapl' } });
      expect(result.isError).not.toBe(true);
      const wire = result.structuredContent as any;
      expect(wire.summary.latestReported.date).toBe('2026-07-30');
      expect(wire.moves).toBeUndefined();
      expect(liveGets).toEqual([]);
    } finally {
      await close();
    }
  });

  it('includeMoves adds the moves beside the history', async () => {
    const { client, liveGets, close } = await harness(async () => MOVES);
    try {
      const result = await client.callTool({ name: 'get_earnings', arguments: { symbol: 'aapl', includeMoves: true } });
      expect(result.isError).not.toBe(true);
      const wire = result.structuredContent as any;
      expect(liveGets).toEqual(['/earnings/AAPL/moves']);
      expect(wire.summary.latestReported.date).toBe('2026-07-30');
      expect(wire.moves.dataAvailable).toBe(true);
      expect(wire.moves.events[0].implied.source).toBe('straddle');
      expect(wire.moves.events[0].reportCloseToNextClosePct).toBe(5);
      expect(wire.moves.notes.moves).toBe('m');
      expect(JSON.parse((result.content as { type: string; text: string }[])[0].text)).toEqual(wire);
    } finally {
      await close();
    }
  });

  it('a moves refusal is reported in the answer with its code, and the history still comes back', async () => {
    const { client, close } = await harness(async () => {
      throw new LiveApiError('No earnings data for this symbol', 404, 'NOT_FOUND', false, undefined, undefined);
    });
    try {
      const result = await client.callTool({ name: 'get_earnings', arguments: { symbol: 'AAPL', includeMoves: true } });
      expect(result.isError).not.toBe(true);
      const wire = result.structuredContent as any;
      expect(wire.summary.latestReported.date).toBe('2026-07-30');
      expect(wire.moves).toEqual({ dataAvailable: false, code: 'NOT_FOUND', message: 'No earnings data for this symbol' });
    } finally {
      await close();
    }
  });
});
