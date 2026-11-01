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
        { id: 2, data: { id: 6, callWall: 510, absGamma: 505 } },
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
    expect(parsed.data[0].data.gammaFlip).toBe(495);
    expect(parsed.data[1].data.callWall).toBe(510);
    expect(parsed.data[1].data.gammaMagnet).toBe(505);
    expect(JSON.stringify(parsed)).not.toMatch(/gamma flip|call wall|abs gamma|absGamma/);
  });

  // review: putWall, gammaTilt and secondaryFlips could revert
  // to spaced keys, and the record-root normalization could go, unnoticed.
  test('type=gex publishes every level key camelCase on the data block and the record root, default and full', async () => {
    const stored = { callWall: 510, putWall: 490, gammaFlip: 495, gammaTilt: -1, secondaryFlips: [480], absGamma: 505 };
    const published = { callWall: 510, putWall: 490, gammaFlip: 495, gammaTilt: -1, secondaryFlips: [480], gammaMagnet: 505 };
    for (const full of [false, true]) {
      const { handler } = createHarness({ data: [{ id: 1, ...stored, data: { ...stored } }] });
      const parsed = JSON.parse((await handler({ type: 'gex', symbol: 'SPY', full })).content[0].text);
      expect(parsed.data[0].data).toMatchObject(published);
      expect(parsed.data[0]).toMatchObject(published);
      expect(JSON.stringify(parsed)).not.toMatch(/call wall|put wall|gamma flip|gamma tilt|secondary flips|abs gamma|absGamma/);
    }
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

describe('get_snapshot - strategy definitions', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 7, user_id: 1, strategy_key: 'a'.repeat(64), symbol: 'SPY', label: 'Bull call spread', timestamp: 1_760_000_100_000, created_at: '2026-10-02T00:00:00Z',
    data: {
      schemaVersion: 1, strategyKey: 'a'.repeat(64), symbol: 'SPY', label: 'Bull call spread',
      legs: [{ type: 'call', side: 'long', quantity: 1, strike: 500, expiration: '2026-10-17', expiryYears: null, premium: 8.1, premiumSource: 'market', iv: 0.18, ivSource: 'chain' }],
      inputs: { spot: 503.1, spotSource: 'live', rate: 0.04, dividendYield: 0.012, volatilityMode: 'chain', model: 'Black-Scholes' },
      builtAt: 1_760_000_000_000, updatedAt: 1_760_000_100_000,
    },
    ...over,
  });

  test('routes to the strategy type with the symbol and limit, and publishes each definition with the note', async () => {
    const { calls, handler } = createHarness({ data: [row()], count: 1 });
    const result = await handler({ type: 'strategy', symbol: 'spy', limit: 5 });
    expect(result.isError).not.toBe(true);
    expect(calls[0]).toEqual({ path: '/sync/analysis-data', params: { type: 'strategy', symbol: 'SPY', limit: '5' } });
    const wire = JSON.parse(result.content[0].text);
    expect(wire.count).toBe(1);
    expect(wire.data[0]).toEqual({
      strategyKey: 'a'.repeat(64), symbol: 'SPY', label: 'Bull call spread',
      legs: [{ type: 'call', side: 'long', quantity: 1, strike: 500, expiration: '2026-10-17', expiryYears: null, premium: 8.1, premiumSource: 'market', iv: 0.18, ivSource: 'chain' }],
      inputs: { spot: 503.1, spotSource: 'live', rate: 0.04, dividendYield: 0.012, volatilityMode: 'chain', model: 'Black-Scholes' },
      builtAt: new Date(1_760_000_000_000).toISOString(), updatedAt: new Date(1_760_000_100_000).toISOString(),
    });
    expect(wire.note).toContain('compute_scenario');
    expect(wire.note).toContain('strategyKey');
    expect(wire.data[0].id).toBeUndefined();
    expect(wire.data[0].userId).toBeUndefined();
  });

  test('without a symbol, every record comes back; full keeps the sanitized rows', async () => {
    const { calls, handler } = createHarness({ data: [row(), row({ id: 8, symbol: 'QQQ', strategy_key: 'b'.repeat(64) })], count: 2 });
    const result = await handler({ type: 'strategy', limit: 3, full: true });
    expect(calls[0].params).toEqual({ type: 'strategy', limit: '3' });
    const wire = JSON.parse(result.content[0].text);
    expect(wire.data).toHaveLength(2);
    expect(wire.data[0].user_id).toBeUndefined();
    expect(wire.data[0].data.legs).toHaveLength(1);
  });

  test('an empty list says there is nothing sent yet, with how to send one', async () => {
    const { handler } = createHarness({ data: [], count: 0 });
    const result = await handler({ type: 'strategy' });
    const wire = JSON.parse(result.content[0].text);
    expect(wire.data).toEqual([]);
    expect(wire.note).toContain('Send to assistant');
  });
});

// Greek exposure methodology v2: a saved GEX record states
// the calculation it was saved under, read from its own field, never its date; the internal field is not sent.
describe('a saved GEX record states the calculation it was saved under', () => {
  const records = [
    { symbol: 'SPY', timestamp: 2, data: { symbol: 'SPY', totalGammaExposure: 5, methodology: 2, savedBook: { view: 'assumedDealerBook', p: 0.85 } } },
    { symbol: 'SPY', timestamp: 1, data: { symbol: 'SPY', totalGammaExposure: 7 } },
    { symbol: 'SPY', timestamp: 0, data: { symbol: 'SPY', totalGammaExposure: 9, methodology: 1 } },
  ];
  test.each([[false], [true]])('full=%p: the book kept with its share, an absent or 1 field earlier, the note once, no method named', async (full) => {
    const { calls, handler } = createHarness({ data: structuredClone(records) });
    const text = (await handler({ type: 'gex', symbol: 'SPY', ...(full ? { full: true } : {}) })).content[0].text;
    const out = JSON.parse(text);
    const rows = out.data;
    expect(rows.map((r: any) => r.data.exposureCalculation)).toEqual(['assumedDealerBook', 'earlierDealerHedging', 'earlierDealerHedging']);
    for (const r of rows) expect(r.data).not.toHaveProperty('methodology');
    expect(rows[0].data.savedBook).toEqual({ view: 'assumedDealerBook', p: 0.85 });
    // The GEX total scales with the share; the delta balance does not
    expect(out.gexRecordsNote).toMatch(/totalGammaExposure the assumed dealer book's GEX .* so it scales with that share; its totalDeltaExposure is the put-minus-call delta balance, the same at every share/);
    expect(out.gexRecordsNote).toContain('saved before the page moved to the assumed dealer book (October 2026): its totals are in the earlier dealer-hedging convention and are not comparable with later records.');
    expect(out.gexRecordsNote).toMatch(/Each record keeps the calculation it was saved under\.$/);
    expect(out).not.toHaveProperty('methodologyNote');
    expect(text).not.toMatch(/[Mm]ethodolog|\bv2\b|V2/);
    expect(calls.map((c) => c.path)).not.toContain('/exposure/methodology');
  });

  test('the note says only what the records hold: no earlier sentence without an earlier record, no book sentence without a book', async () => {
    const book = JSON.parse((await createHarness({ data: [structuredClone(records[0])] }).handler({ type: 'gex', symbol: 'SPY' })).content[0].text);
    expect(book.gexRecordsNote).toContain('at the share of open interest in data.savedBook.p');
    expect(book.gexRecordsNote).not.toContain('earlier dealer-hedging');
    const earlier = JSON.parse((await createHarness({ data: [structuredClone(records[1])] }).handler({ type: 'gex', symbol: 'SPY' })).content[0].text);
    expect(earlier.gexRecordsNote).toContain('earlier dealer-hedging convention');
    expect(earlier.gexRecordsNote).not.toContain('savedBook.p');
    // an unrecognised field is not guessed: no calculation stated, the field not sent
    const odd = JSON.parse((await createHarness({ data: [{ symbol: 'SPY', timestamp: 3, data: { symbol: 'SPY', totalGammaExposure: 1, methodology: 3 } }] }).handler({ type: 'gex', symbol: 'SPY' })).content[0].text);
    expect(odd.data[0].data).not.toHaveProperty('exposureCalculation');
    expect(odd.data[0].data).not.toHaveProperty('methodology');
    expect(odd.gexRecordsNote).toBe('Each record keeps the calculation it was saved under.');
  });
});
