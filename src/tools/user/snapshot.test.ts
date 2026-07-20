import { describe, test, expect } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { register } from './snapshot.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }> }>;

function createHarness(stubResponse: any = { data: [] }) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const fakeClient: ProxyClient = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ path, params });
      return stubResponse;
    },
    post: async () => ({}),
  } as unknown as ProxyClient;

  const captured: { handler: ToolHandler | null } = { handler: null };
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      captured.handler = handler;
    },
    registerTool: (_name: string, _config: unknown, handler: ToolHandler) => {
      captured.handler = handler;
    },
  } as unknown as McpServer;

  register(fakeServer, fakeClient);
  if (!captured.handler) throw new Error('Tool handler not captured');
  return { calls, handler: captured.handler };
}

describe('get_snapshot — GEX requires symbol', () => {
  test('type=gex without symbol throws', async () => {
    const { handler } = createHarness({ data: [] });
    const result = await handler({ type: 'gex' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("type='gex' requires `symbol`");
  });

  test('type=gex with symbol routes to /sync/analysis-data with type=gex + symbol', async () => {
    const { calls, handler } = createHarness({ data: [] });
    await handler({ type: 'gex', symbol: 'SPY', limit: 5 });
    expect(calls[0].path).toBe('/sync/analysis-data');
    expect(calls[0].params?.type).toBe('gex');
    expect(calls[0].params?.symbol).toBe('SPY');
    expect(calls[0].params?.limit).toBe('5');
  });
});

describe('get_snapshot — portfolio/risk fetchLimit behavior', () => {
  test('type=portfolio default mode fetches limit * 5 (capped at 50)', async () => {
    const { calls, handler } = createHarness({ data: [] });
    await handler({ type: 'portfolio', limit: 3 });
    expect(calls[0].params?.limit).toBe('15'); // 3 * 5
  });

  test('type=portfolio default mode caps at 50 when limit*5 exceeds', async () => {
    const { calls, handler } = createHarness({ data: [] });
    await handler({ type: 'portfolio', limit: 20 });
    expect(calls[0].params?.limit).toBe('50'); // min(100, 50)
  });

  test('type=portfolio full mode uses the requested limit directly', async () => {
    const { calls, handler } = createHarness({ data: [] });
    await handler({ type: 'portfolio', limit: 12, full: true });
    expect(calls[0].params?.limit).toBe('12');
  });

  test('type=risk default mode fetches limit * 5 (capped at 50)', async () => {
    const { calls, handler } = createHarness({ data: [] });
    await handler({ type: 'risk', limit: 4 });
    expect(calls[0].params?.limit).toBe('20');
  });

  test('type=risk full mode passes limit through', async () => {
    const { calls, handler } = createHarness({ data: [] });
    await handler({ type: 'risk', limit: 7, full: true });
    expect(calls[0].params?.limit).toBe('7');
  });
});

describe('get_snapshot — GEX details dual handling', () => {
  test('array-form details: collapsed to { omitted: [\'expiration breakdowns (N items)\'] }', async () => {
    const stub = {
      data: [
        {
          id: 1,
          data: { gammaFlip: 495 },
          details: [{ exp: '2026-04-18' }, { exp: '2026-04-25' }, { exp: '2026-05-16' }],
        },
      ],
    };
    const { handler } = createHarness(stub);
    const result = await handler({ type: 'gex', symbol: 'SPY' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data[0].details.omitted).toEqual(['expiration breakdowns (3 items)']);
  });

  test('object-form details: scalars kept, array keys moved to omitted', async () => {
    const stub = {
      data: [
        {
          id: 1,
          data: { gammaFlip: 495 },
          details: {
            netGEX: 1e9,
            spotPrice: 500,
            callWallLevels: [510, 520],
            putWallLevels: [490, 480],
          },
        },
      ],
    };
    const { handler } = createHarness(stub);
    const result = await handler({ type: 'gex', symbol: 'SPY' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data[0].details.netGEX).toBe(1e9);
    expect(parsed.data[0].details.spotPrice).toBe(500);
    expect(parsed.data[0].details.callWallLevels).toBeUndefined();
    expect(parsed.data[0].details.putWallLevels).toBeUndefined();
    expect(parsed.data[0].details.omitted).toEqual(['call wall levels (2 items)', 'put wall levels (2 items)']);
  });

  test('object-form details: derives visible combo strikes from stored walls', async () => {
    const stub = {
      data: [
        {
          id: 1,
          data: { callWall: 110, putWall: 100 },
          details: {
            comboStrikes: [
              { strike: 95, expiration: '2026-04-18' },
              { strike: 100, expiration: '2026-04-18' },
              { strike: 105, expiration: '2026-04-18' },
              { strike: 115, expiration: '2026-04-18' },
            ],
          },
        },
      ],
    };
    const { handler } = createHarness(stub);
    const result = await handler({ type: 'gex', symbol: 'SPY' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data[0].details.rawComboStrikeCount).toBe(4);
    expect(parsed.data[0].details.visibleComboStrikeCount).toBe(2);
    expect(parsed.data[0].details.omitted).toContain('combo strikes (4 items)');
    expect(parsed.data[0].details.omitted).toContain('visible combo strikes (2 items)');
  });
});

describe('get_snapshot — full mode returns less-summarized payload', () => {
  test('type=gex full=true strips synced row ids', async () => {
    const stub = {
      data: [
        { id: 1, user_id: 10, created_at: '2026-04-01T00:00:00.000Z', data: { id: 5, gammaFlip: 495 } },
        { id: 2, data: { id: 6, callWall: 510 } },
      ],
      count: 2,
      meta: 'x',
    };
    const { handler } = createHarness(stub);
    const result = await handler({ type: 'gex', symbol: 'SPY', full: true });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data[0].id).toBeUndefined();
    expect(parsed.data[0].user_id).toBeUndefined();
    expect(parsed.data[0].created_at).toBeUndefined();
    expect(parsed.data[0].data.id).toBeUndefined();
    expect(parsed.data[1].id).toBeUndefined();
    expect(parsed.data[1].data.id).toBeUndefined();
    expect(parsed.data[0].data['gamma flip']).toBe(495);
    expect(parsed.data[1].data['call wall']).toBe(510);
  });

  test('type=portfolio full=true returns raw payload', async () => {
    const stub = { data: [{ id: 1 }], count: 1 };
    const { handler } = createHarness(stub);
    const result = await handler({ type: 'portfolio', full: true });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(stub);
  });

  test('type=portfolio full=true strips nested synced snapshot ids', async () => {
    const stub = {
      data: [{
        id: 1,
        user_id: 1,
        created_at: '2026-04-01T00:00:00.000Z',
        timestamp: 1776550587306,
        data: {
          id: 2,
          timestamp: 1776550587306,
          totalValue: 107864.29,
          delta: 309.6892,
          details: { greeks: { totalDelta: 309.6892 }, fullAllocation: [{ symbol: 'AAPL' }] },
        },
        details: { greeks: { totalDelta: 309.6892 }, fullAllocation: [{ symbol: 'AAPL' }] },
      }],
      count: 1,
    };
    const { handler } = createHarness(stub);
    const result = await handler({ type: 'portfolio', full: true });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data[0].id).toBeUndefined();
    expect(parsed.data[0].user_id).toBeUndefined();
    expect(parsed.data[0].created_at).toBeUndefined();
    expect(parsed.data[0].data.id).toBeUndefined();
    expect(parsed.data[0].data.totalValue).toBe(107864.29);
    expect(parsed.data[0].data.details).toBe('[see top-level details]');
    expect(parsed.data[0].details.greeks.totalDelta).toBe(309.6892);
  });

  test('type=risk full=true strips raw position contributions', async () => {
    const stub = {
      data: [{
        id: 1,
        user_id: 1,
        timestamp: 1776550584312,
        data: {
          id: 2,
          timestamp: 1776550584312,
          portfolioValue: 161179.82,
          dollarDelta: 148236.55,
          details: { historicalVarDetails: { worstDay: 13.46 } },
          positionContributions: [{ symbol: 'AAPL', contribution: 1200 }],
          position_contributions: [{ symbol: 'META', contribution: -800 }],
          nested: {
            positionContributions: [{ symbol: 'TSLA', contribution: 500 }],
          },
        },
        details: {
          historicalVarDetails: { worstDay: 13.46 },
          positionContributions: [{ symbol: 'AAPL', contribution: 1200 }],
          position_contributions: [{ symbol: 'META', contribution: -800 }],
        },
      }],
      count: 1,
    };
    const { handler } = createHarness(stub);
    const result = await handler({ type: 'risk', full: true });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data[0].id).toBeUndefined();
    expect(parsed.data[0].data.id).toBeUndefined();
    expect(parsed.data[0].data.positionContributions).toBeUndefined();
    expect(parsed.data[0].data.position_contributions).toBeUndefined();
    expect(parsed.data[0].data.nested.positionContributions).toBeUndefined();
    expect(parsed.data[0].data.details).toBe('[see top-level details]');
    expect(parsed.data[0].details.positionContributions).toBeUndefined();
    expect(parsed.data[0].details.position_contributions).toBeUndefined();
    expect(parsed.data[0].details.historicalVarDetails.worstDay).toBe(13.46);
    expect(parsed.data[0].data.dollarDelta).toBe(148236.55);
    expect(result.content[0].text).not.toContain('positionContributions');
    expect(result.content[0].text).not.toContain('position_contributions');
  });
});
