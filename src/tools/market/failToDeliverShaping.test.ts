import { describe, expect, it } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { summarizeFailToDeliver } from './failToDeliverShaping.js';
import { register } from './failToDeliver.js';
import { sanitizeMcpWireOutput } from '../helpers.js';

describe('summarizeFailToDeliver', () => {
  it('builds a compact summary with recent rows, spikes, and trend samples', () => {
    const summarized = summarizeFailToDeliver({
      symbol: 'AMC',
      data: [
        { date: '2026-02-27', quantity: 1770712, price: 1.14, value: 2018611.68, onThresholdList: false, thresholdSource: 'none' },
        { date: '2026-02-23', quantity: 3907, price: 1.2, value: 4688.4, onThresholdList: false, thresholdSource: 'none' },
        { date: '2026-02-19', quantity: 730594, price: 1.24, value: 905936.56, onThresholdList: true, thresholdSource: 'sec' },
        { date: '2026-02-18', quantity: 2722774, price: 1.25, value: 3403467.5, onThresholdList: true, thresholdSource: 'sec' },
        { date: '2026-02-17', quantity: 1923814, price: 1.23, value: 2366291.22, onThresholdList: false, thresholdSource: 'none' },
        { date: '2026-02-13', quantity: 1445682, price: 1.22, value: 1763732.04, onThresholdList: false, thresholdSource: 'none' },
      ],
      summary: {
        maxFTDShares: 2722774,
        maxFTDDate: '2026-02-18',
        trend: '633.97',
        daysOnThreshold: 2,
        dateRange: { start: '2026-02-13', end: '2026-02-27' },
      },
    }, 3, 2, 2) as Record<string, any>;

    expect(summarized.symbol).toBe('AMC');
    expect(summarized.latestFTD.date).toBe('2026-02-27');
    expect(summarized.summary.recentTrendPct).toBe(633.97);
    expect(summarized.summary.recentTrend).toBe('surging');
    expect(summarized.summary.daysOnThreshold).toBe(2);
    expect(summarized.recentHistory).toHaveLength(3);
    expect(summarized.notableSpikes).toHaveLength(2);
    expect(summarized.notableSpikes[0].date).toBe('2026-02-18');
    expect(summarized.thresholdEvents).toHaveLength(2);
    expect(summarized.trendSample).toHaveLength(2);
    expect(summarized._recent_history_meta).toEqual({ showing: 3, total: 6, truncated: true });
  });

  it('returns a stable empty summary when no FTD rows exist', () => {
    const summarized = summarizeFailToDeliver({
      symbol: 'AAPL',
      data: [],
      summary: { trend: '0.00' },
    }) as Record<string, any>;

    expect(summarized.symbol).toBe('AAPL');
    expect(summarized.summary.totalDataPoints).toBe(0);
    expect(summarized.summary.recentTrend).toBe('stable');
    expect(summarized.recentHistory).toEqual([]);
    expect(summarized.notableSpikes).toEqual([]);
    expect(summarized.thresholdEvents).toEqual([]);
  });
});

describe('a threshold list that could not be read', () => {
  const rows = [
    { date: '2026-10-06', symbol: 'AAPL', quantity: 1000, price: 231.4, value: 231400, onThresholdList: null, thresholdSource: 'unread' },
    { date: '2026-10-05', symbol: 'AAPL', quantity: 500, price: 230.1, value: 115050, onThresholdList: null, thresholdSource: 'unread' },
  ];

  it('never says "No threshold-list overlap" nor 0 days: unknown, with a note', () => {
    const out = summarizeFailToDeliver({ symbol: 'AAPL', data: rows, summary: { daysOnThreshold: null }, partial: true, unavailable: ['thresholdList'] } as any) as any;
    expect(out.summary.daysOnThreshold).toBeNull();
    expect(out._threshold_note).toBeUndefined();
    expect(out.partial).toBe(true);
    expect(out.partialNote).toMatch(/threshold list could not be read/);
  });

  // Review: the row shaping turned the unknown membership into false in every list.
  it('each row keeps its membership unknown (null), never false, in every list; no threshold events claimed', () => {
    const out = sanitizeMcpWireOutput(summarizeFailToDeliver({ symbol: 'AAPL', data: rows, summary: { daysOnThreshold: null }, partial: true, unavailable: ['thresholdList'] } as any)) as any;
    for (const row of [out.latestFTD, out.summary.latestFTD, ...out.recentHistory, ...out.notableSpikes]) {
      expect(row.onThresholdList).toBeNull();
      expect(row.thresholdSource).toBe('unread');
    }
    expect(out.thresholdEvents).toBeNull();
  });

  it('no FTD rows beside an unread threshold list: the partial fields are carried there too', () => {
    const out = summarizeFailToDeliver({ symbol: 'AAPL', data: [], summary: { daysOnThreshold: null }, partial: true, unavailable: ['thresholdList'] } as any) as any;
    expect(out.partial).toBe(true);
    expect(out.unavailable).toEqual(['thresholdList']);
    expect(out.summary.daysOnThreshold).toBeNull();
  });

  it('a read with no overlap keeps its note and 0 (the control)', () => {
    const out = summarizeFailToDeliver({ symbol: 'AAPL', data: rows.map(r => ({ ...r, onThresholdList: false, thresholdSource: 'none' })), summary: { daysOnThreshold: 0 } } as any) as any;
    expect(out.summary.daysOnThreshold).toBe(0);
    expect(out._threshold_note).toBe('No threshold-list overlap in the requested window.');
    expect(out.recentHistory.every((r: any) => r.onThresholdList === false)).toBe(true);
    expect(out.thresholdEvents).toEqual([]);
  });

  // The answer's partial marker and the rows' own null are one fact: neither may be read alone.
  it('the partial marker makes every row unknown, whatever the row says', () => {
    const out = summarizeFailToDeliver({
      symbol: 'AAPL',
      data: [{ ...rows[0], onThresholdList: false, thresholdSource: 'none' }, { ...rows[1], onThresholdList: true, thresholdSource: 'sec' }],
      summary: { daysOnThreshold: null }, partial: true, unavailable: ['thresholdList'],
    } as any) as any;
    expect(out.recentHistory.map((r: any) => [r.onThresholdList, r.thresholdSource])).toEqual([[null, 'unread'], [null, 'unread']]);
    expect(out.latestFTD.onThresholdList).toBeNull();
    expect(out.thresholdEvents).toBeNull();
  });

  it('rows left unknown make the summary unknown even without the partial marker: never 0 days or the no-overlap note', () => {
    const out = summarizeFailToDeliver({ symbol: 'AAPL', data: rows, summary: { daysOnThreshold: null } } as any) as any;
    expect(out.summary.daysOnThreshold).toBeNull();
    expect(out.thresholdEvents).toBeNull();
    expect(out._threshold_note).toBeUndefined();
    expect(out.partial).toBe(true);
    expect(out.unavailable).toEqual(['thresholdList']);
  });

  it('a row with no true/false, or marked unread, is unknown (null), never false', () => {
    const { onThresholdList: _omitted, ...noFlag } = rows[0];
    const out = summarizeFailToDeliver({
      symbol: 'AAPL',
      data: [{ ...noFlag, thresholdSource: 'none' }, { ...rows[1], onThresholdList: false, thresholdSource: 'unread' }],
      summary: {},
    } as any) as any;
    expect(out.recentHistory.map((r: any) => [r.onThresholdList, r.thresholdSource])).toEqual([[null, 'unread'], [null, 'unread']]);
    expect(out.summary.daysOnThreshold).toBeNull();
  });
});

describe('get_fail_to_deliver on the proxy\'s answer: each row\'s threshold status in every list', () => {
  // The proxy's /sec/fail-to-deliver/:symbol answer (proxy/routes/finra-sec.ts), ten rows newest first so every row
  // list fills: recentHistory 8, notableSpikes 5 (the largest quantities), trendSample 4 (rows 0, 3, 6 and 9).
  const DATES = Array.from({ length: 10 }, (_, i) => `2026-09-${25 - i}`);
  function proxyAnswer(onList: ((date: string) => boolean) | 'unread') {
    const data = DATES.map((date, i) => {
      const quantity = 1000 + ((i * 7) % 10) * 100;
      const member = onList === 'unread' ? null : onList(date);
      return {
        date, symbol: 'AAPL', quantity, price: 230, value: quantity * 230, cusip: '037833100', description: 'AAPL',
        onThresholdList: member, thresholdSource: member === null ? 'unread' : member ? 'sec' : 'none',
      };
    });
    const unread = onList === 'unread';
    return {
      symbol: 'AAPL',
      data,
      summary: {
        totalDataPoints: data.length, totalFTDShares: 14_500, totalFTDValue: 3_335_000, avgFTDShares: 1450,
        maxFTDShares: 1900, maxFTDDate: '2026-09-18', trend: '12.50',
        latestFTD: { date: data[0].date, quantity: data[0].quantity, price: 230, value: data[0].value },
        dateRange: { start: '2026-09-16', end: '2026-09-25' },
        daysOnThreshold: unread ? null : data.filter((r) => r.onThresholdList).length,
      },
      ...(unread ? { partial: true, unavailable: ['thresholdList'] } : {}),
    };
  }

  async function callTool(answer: unknown, args: Record<string, unknown> = {}) {
    let handler: ((a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) | null = null;
    const server = { registerTool: (_n: string, _c: unknown, h: typeof handler) => { handler = h; } } as unknown as McpServer;
    register(server, { get: async () => answer } as unknown as ProxyClient);
    const result = await handler!({ symbol: 'AAPL', days: 180, ...args });
    return JSON.parse(result.content[0].text);
  }
  const status = (rows: any[]) => rows.map((r) => [r.date, r.onThresholdList, r.thresholdSource]);
  const unknown = (dates: string[]) => dates.map((date) => [date, null, 'unread']);

  it('a failed threshold read: null in latestFTD, summary.latestFTD and every recentHistory, notableSpikes and trendSample row', async () => {
    const out = await callTool(proxyAnswer('unread'));
    expect(status([out.latestFTD])).toEqual(unknown(['2026-09-25']));
    expect(status([out.summary.latestFTD])).toEqual(unknown(['2026-09-25']));
    expect(status(out.recentHistory)).toEqual(unknown(DATES.slice(0, 8)));
    expect(status(out.notableSpikes)).toEqual(unknown(['2026-09-24', '2026-09-21', '2026-09-20', '2026-09-18', '2026-09-17']));
    expect(status(out.trendSample)).toEqual(unknown(['2026-09-25', '2026-09-22', '2026-09-19', '2026-09-16']));
    expect(out.thresholdEvents).toBeNull();
    expect(out.summary.daysOnThreshold).toBeNull();
    expect(out.partial).toBe(true);
    expect(out.unavailable).toEqual(['thresholdList']);
    expect(out.partialNote).toMatch(/threshold list could not be read/);
    expect('thresholdNote' in out || '_threshold_note' in out).toBe(false);
  });

  it('a failed threshold read with full=true: the raw rows keep null and unread', async () => {
    const out = await callTool(proxyAnswer('unread'), { full: true });
    expect(status(out.data)).toEqual(unknown(DATES));
    expect(out.summary.daysOnThreshold).toBeNull();
    expect(out.partial).toBe(true);
  });

  it('a read list: each row keeps its own true or false in every list (the control)', async () => {
    const ON = new Set(['2026-09-24', '2026-09-19', '2026-09-18']);
    const out = await callTool(proxyAnswer((date) => ON.has(date)));
    const known = (pairs: Array<[string, boolean]>) => pairs.map(([date, on]) => [date, on, on ? 'sec' : 'none']);
    expect(status([out.latestFTD])).toEqual(known([['2026-09-25', false]]));
    expect(status([out.summary.latestFTD])).toEqual(known([['2026-09-25', false]]));
    expect(status(out.recentHistory)).toEqual(known([
      ['2026-09-25', false], ['2026-09-24', true], ['2026-09-23', false], ['2026-09-22', false],
      ['2026-09-21', false], ['2026-09-20', false], ['2026-09-19', true], ['2026-09-18', true],
    ]));
    expect(status(out.notableSpikes)).toEqual(known([
      ['2026-09-24', true], ['2026-09-21', false], ['2026-09-20', false], ['2026-09-18', true], ['2026-09-17', false],
    ]));
    expect(status(out.trendSample)).toEqual(known([['2026-09-25', false], ['2026-09-22', false], ['2026-09-19', true], ['2026-09-16', false]]));
    expect(status(out.thresholdEvents)).toEqual(known([['2026-09-24', true], ['2026-09-19', true], ['2026-09-18', true]]));
    expect(out.summary.daysOnThreshold).toBe(3);
    expect('partial' in out).toBe(false);
  });
});
