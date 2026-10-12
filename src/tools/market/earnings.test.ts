import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { LiveApiError, type LiveApiClient } from '../../proxy/liveApiClient.js';
import { ApiError } from '../../types.js';
import { register } from './earnings.js';
import { SEARCH_NOTE, SUMMARY_NOTE, WITHHELD_NOTE } from './transcriptShaping.js';

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

async function harness(liveAnswer: (path: string) => Promise<unknown>) {
  const liveGets: string[] = [];
  const server = new McpServer({ name: 'earnings-test', version: '1' });
  register(server, { get: async () => EPS } as unknown as ProxyClient, {
    get: async (path: string) => { liveGets.push(path); return liveAnswer(path); },
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

  const CALLS = [
    { fiscalYear: 2026, quarter: 3, callDate: '2026-07-30', summary: 'available' },
    { fiscalYear: 2026, quarter: 2, callDate: '2026-04-30', summary: 'stale' },
  ];
  const SUMMARY = {
    schemaVersion: 1, symbol: 'AAPL', fiscalYear: 2026, quarter: 3, callDate: '2026-07-30', generatedAt: '2026-10-10T04:23:10+00:00',
    linesWithheld: 1, quotesWithheld: 0,
    summary: {
      preparedRemarks: [{ speaker: 'Tim Cook', role: 'CEO', summary: 'A June quarter record.', turns: [1] }],
      qa: [{ askedBy: 'Amit Daryanani', firm: 'Evercore', question: 'Supply or FX?', answeredBy: ['Kevan Parekh'], answer: 'Both.', turns: [10, 11] }],
      guidance: [{ text: 'September quarter revenue to grow 9%-11%.', turns: [8] }],
      quotes: [{ speaker: 'Tim Cook', text: 'We reluctantly raised prices.', turn: 20 }],
      sectionSplit: 'detected',
    },
    callsOnFile: CALLS,
  };

  it('transcript: {} adds the newest summary beside the history, labelled, with turn numbers dropped', async () => {
    const { client, liveGets, close } = await harness(async () => SUMMARY);
    try {
      const result = await client.callTool({ name: 'get_earnings', arguments: { symbol: 'aapl', transcript: {} } });
      expect(result.isError).not.toBe(true);
      const wire = result.structuredContent as any;
      expect(liveGets).toEqual(['/earnings/AAPL/transcripts/summary']);
      expect(wire.summary.latestReported.date).toBe('2026-07-30');
      expect(wire.moves).toBeUndefined();
      expect(wire.transcript).toEqual({
        dataAvailable: true, kind: 'summary', symbol: 'AAPL', fiscalYear: 2026, quarter: 3, callDate: '2026-07-30',
        note: SUMMARY_NOTE, sectionSplit: 'detected',
        preparedRemarks: [{ speaker: 'Tim Cook', role: 'CEO', summary: 'A June quarter record.' }],
        qa: [{ askedBy: 'Amit Daryanani', firm: 'Evercore', question: 'Supply or FX?', answeredBy: ['Kevan Parekh'], answer: 'Both.' }],
        guidance: ['September quarter revenue to grow 9%-11%.'],
        quotes: [{ speaker: 'Tim Cook', text: 'We reluctantly raised prices.' }],
        withheld: { lines: 1, quotes: 0, note: WITHHELD_NOTE },
        generatedAt: '2026-10-10T04:23:10+00:00',
        callsOnFile: CALLS,
      });
      expect(JSON.stringify(wire)).not.toMatch(/"turns?"/);
    } finally {
      await close();
    }
  });

  it('a named quarter and a query reach the right routes; with includeMoves both requests are made', async () => {
    const { client, liveGets, close } = await harness(async (path) => (path.includes('/search') ? { symbol: 'AAPL', query: 'S&P tariffs', terms: ['s&p', 'tariffs'], calls: [], callsOnFile: CALLS } : path.endsWith('/moves') ? MOVES : SUMMARY));
    try {
      await client.callTool({ name: 'get_earnings', arguments: { symbol: 'AAPL', transcript: { fiscalYear: 2026, quarter: 3 } } });
      const search = await client.callTool({ name: 'get_earnings', arguments: { symbol: 'AAPL', includeMoves: true, transcript: { query: 'S&P tariffs', calls: 2 } } });
      expect(liveGets).toEqual([
        '/earnings/AAPL/transcripts/summary?fiscalYear=2026&quarter=3',
        '/earnings/AAPL/moves',
        '/earnings/AAPL/transcripts/search?q=S%26P+tariffs&calls=2',
      ]);
      const wire = search.structuredContent as any;
      expect(wire.moves.dataAvailable).toBe(true);
      expect(wire.transcript).toMatchObject({ dataAvailable: true, kind: 'search', query: 'S&P tariffs', note: SEARCH_NOTE, callsSearched: 0 });
    } finally {
      await close();
    }
  });

  it('a transcript refusal is reported under transcript with its code and the calls on file, and the history still returns', async () => {
    const { client, close } = await harness(async () => {
      throw new LiveApiError('No summary is available for AAPL fiscal 2026 Q2', 404, 'SUMMARY_UNAVAILABLE', false, undefined, { callsOnFile: CALLS });
    });
    try {
      const result = await client.callTool({ name: 'get_earnings', arguments: { symbol: 'AAPL', transcript: { fiscalYear: 2026, quarter: 2 } } });
      expect(result.isError).not.toBe(true);
      const wire = result.structuredContent as any;
      expect(wire.summary.latestReported.date).toBe('2026-07-30');
      expect(wire.transcript).toEqual({ dataAvailable: false, code: 'SUMMARY_UNAVAILABLE', message: 'No summary is available for AAPL fiscal 2026 Q2', retryable: false, callsOnFile: CALLS });
    } finally {
      await close();
    }
  });

  it('a body that is not JSON on the moves or the transcript read is reported under its section, and the history still returns', async () => {
    const { client, close } = await harness(async (path) => { throw new ApiError(`Invalid JSON response from ${path}`, 200); });
    try {
      const result = await client.callTool({ name: 'get_earnings', arguments: { symbol: 'AAPL', includeMoves: true, transcript: {} } });
      expect(result.isError).not.toBe(true);
      const wire = result.structuredContent as any;
      expect(wire.summary.latestReported.date).toBe('2026-07-30');
      expect(wire.moves).toEqual({ dataAvailable: false, code: 'INVALID_RESPONSE', message: 'The moves could not be read. This may be retried.' });
      expect(wire.transcript).toEqual({ dataAvailable: false, code: 'INVALID_RESPONSE', message: 'The earnings call summary could not be read. This may be retried.', retryable: true });
    } finally {
      await close();
    }
  });

  it('an oversized summary of any section is trimmed inside the answer, which keeps the history and the moves', async () => {
    const preparedRemarks = Array.from({ length: 12 }, (_, i) => ({ speaker: `Exec ${i}`, summary: Array.from({ length: 700 }, (_, j) => `margin${j}`).join(' ') }));
    const big = { ...SUMMARY, summary: { ...SUMMARY.summary, preparedRemarks, qa: [] } };
    const { client, close } = await harness(async (path) => (path.endsWith('/moves') ? MOVES : big));
    try {
      const result = await client.callTool({ name: 'get_earnings', arguments: { symbol: 'AAPL', includeMoves: true, transcript: {} } });
      expect(result.isError).not.toBe(true);
      const wire = result.structuredContent as any;
      expect(wire.summary.latestReported.date).toBe('2026-07-30');
      expect(wire.moves.dataAvailable).toBe(true);
      expect(wire.transcript.trimMeta.preparedRemarks.total).toBe(12);
      expect(Buffer.byteLength((result.content as { type: string; text: string }[])[0].text, 'utf8')).toBeLessThan(50_000);
    } finally {
      await close();
    }
  });

  it('the block gets what the answer has left: beside large moves, the whole answer still fits and keeps every section', async () => {
    const VENDOR = Buffer.from('Rk1Q', 'base64').toString('utf8');
    // Many mid-size entries, so a block allowed its full budget would fill it and push the answer past the guard.
    const preparedRemarks = Array.from({ length: 40 }, (_, i) => ({ speaker: `Exec ${i}`, summary: `${VENDOR} `.repeat(150) }));
    const qa = Array.from({ length: 12 }, (_, i) => ({ askedBy: `A${i}`, question: `${VENDOR} `.repeat(60), answer: `${VENDOR} `.repeat(90) }));
    const big = { ...SUMMARY, summary: { ...SUMMARY.summary, preparedRemarks, qa: [] } };
    const search = {
      symbol: 'AAPL', query: 'tariffs', terms: ['tariffs'], callsOnFile: CALLS,
      calls: [3, 2].map((q) => ({ fiscalYear: 2026, quarter: q, callDate: '2026-07-30', matchCount: 12, matches: { preparedRemarks: [], qa, guidance: [], quotes: [] } })),
    };
    const wideMoves = { ...MOVES, notes: { ...MOVES.notes, moves: 'm'.repeat(30_000) } };
    const { client, close } = await harness(async (path) => (path.endsWith('/moves') ? wideMoves : path.includes('/search') ? search : big));
    try {
      for (const transcript of [{}, { query: 'tariffs' }]) {
        const result = await client.callTool({ name: 'get_earnings', arguments: { symbol: 'AAPL', includeMoves: true, transcript } });
        expect(result.isError).not.toBe(true);
        const text = (result.content as { type: string; text: string }[])[0].text;
        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(50 * 1024);
        const wire = result.structuredContent as any;
        expect(wire.summary.latestReported.date).toBe('2026-07-30');
        expect(wire.moves.notes.moves).toHaveLength(30_000);
        // Every list as its meta says: nothing was cut behind it by the guard.
        if (wire.transcript.kind === 'summary') {
          expect(wire.transcript.trimMeta.preparedRemarks).toEqual({ shown: wire.transcript.preparedRemarks.length, total: 40 });
          expect(wire.transcript.preparedRemarks.length).toBeGreaterThan(0);
        } else {
          expect(wire.transcript.calls.every((c: any) => c.matchesShown === c.qa.length)).toBe(true);
          expect(wire.transcript.calls[0].qa.length).toBeGreaterThan(0);
          expect(wire.transcript.budgetNote).toBeDefined();
        }
      }
    } finally {
      await close();
    }
  });

  it('beside a history and moves that nearly fill the answer, the transcript gives way and the rest is never lost', async () => {
    const calls = Array.from({ length: 24 }, (_, i) => ({ fiscalYear: 2026 - Math.floor(i / 4), quarter: 4 - (i % 4), callDate: '2026-01-01', summary: 'available' }));
    const short = { ...SUMMARY, summary: { ...SUMMARY.summary, qa: [], guidance: [], quotes: [] }, callsOnFile: calls };
    const oneMatch = { symbol: 'AAPL', query: 'record', terms: ['record'], callsOnFile: calls, calls: [{ fiscalYear: 2026, quarter: 3, callDate: '2026-07-30', matchCount: 1, matches: { preparedRemarks: [{ speaker: 'Tim Cook', summary: 'A June quarter record.' }], qa: [], guidance: [], quotes: [] } }] };
    const refusal = new LiveApiError('No summary is available for AAPL fiscal 2026 Q2', 404, 'SUMMARY_UNAVAILABLE', false, undefined, { callsOnFile: calls });
    let note = 0;
    const { client, close } = await harness(async (path) => {
      if (path.endsWith('/moves')) return { ...MOVES, notes: { ...MOVES.notes, moves: 'm'.repeat(note) } };
      if (path.includes('/search')) return oneMatch;
      if (path.includes('quarter=2')) throw refusal;
      return short;
    });
    const rungs = new Set<string>();
    try {
      for (note = 45_000; note <= 51_000; note += 40) {
        for (const transcript of [{}, { query: 'record' }, { fiscalYear: 2026, quarter: 2 }]) {
          const result = await client.callTool({ name: 'get_earnings', arguments: { symbol: 'AAPL', includeMoves: true, transcript } });
          const text = (result.content as { type: string; text: string }[])[0].text;
          expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(50 * 1024);
          const wire = result.structuredContent as any;
          if (wire.moves === undefined) {
            // Past this the history and the moves alone are over the guard: nothing of ours left to give way.
            expect(note).toBeGreaterThan(49_000);
            continue;
          }
          expect(wire.summary.latestReported.date).toBe('2026-07-30');
          expect(wire.moves.notes.moves).toHaveLength(note);
          const t = wire.transcript;
          rungs.add(t === undefined ? 'none' : t.callsOnFileNote ? 'compact' : t.code === 'RESPONSE_BUDGET' ? (t.message ? 'notice' : 'bare') : 'full');
        }
      }
      expect([...rungs].sort()).toEqual(['bare', 'compact', 'full', 'none', 'notice']);
    } finally {
      await close();
    }
  });

  it('refuses a malformed transcript argument before any request', async () => {
    const { client, liveGets, close } = await harness(async () => SUMMARY);
    try {
      for (const transcript of [{ quarter: 5 }, { query: 'a' }, { calls: 9 }, { fiscalYear: 26.5 }]) {
        const result = await client.callTool({ name: 'get_earnings', arguments: { symbol: 'AAPL', transcript } });
        expect(result.isError).toBe(true);
      }
      expect(liveGets).toEqual([]);
    } finally {
      await close();
    }
  });
});

