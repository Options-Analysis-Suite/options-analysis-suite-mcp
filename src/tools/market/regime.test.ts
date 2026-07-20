import { describe, test, expect } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { register } from './regime.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }> }>;

function createHarness(stubResponse: any = {}) {
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

describe('get_regime — scope routing', () => {
  test('scope=market → /regime/current', async () => {
    const { calls, handler } = createHarness({ market: { stress_score: 0.5, label: 'NORMAL' } });
    await handler({ scope: 'market' });
    expect(calls[0].path).toBe('/regime/current');
  });

  test('scope=market with date passes through', async () => {
    const { calls, handler } = createHarness({ market: {} });
    await handler({ scope: 'market', date: '2026-04-01' });
    expect(calls[0].params?.date).toBe('2026-04-01');
  });

  test('scope=intraday → /regime/intraday/:SYMBOL', async () => {
    const { calls, handler } = createHarness({ entries: [] });
    await handler({ scope: 'intraday', symbol: 'SPY', days: 3, interval: 'open' });
    expect(calls[0].path).toBe('/regime/intraday/SPY');
    expect(calls[0].params?.days).toBe('3');
    expect(calls[0].params?.interval).toBe('open');
  });

  test('scope=intraday default days=5', async () => {
    const { calls, handler } = createHarness({ entries: [] });
    await handler({ scope: 'intraday', symbol: 'AAPL' });
    expect(calls[0].params?.days).toBe('5');
  });

  test('scope=symbol → /regime/symbol/:SYMBOL (uppercased)', async () => {
    const { calls, handler } = createHarness({ history: [{ stress: 0, label: 'NORMAL' }] });
    await handler({ scope: 'symbol', symbol: 'spy' });
    expect(calls[0].path).toBe('/regime/symbol/SPY');
    expect(calls[0].params?.days).toBe('1');
  });
});

describe('get_regime — required symbol errors', () => {
  test('scope=intraday without symbol throws', async () => {
    const { handler } = createHarness({});
    const result = await handler({ scope: 'intraday' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("scope='intraday' requires `symbol`");
  });

  test('scope=symbol without symbol throws', async () => {
    const { handler } = createHarness({});
    const result = await handler({ scope: 'symbol' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("scope='symbol' requires `symbol`");
  });
});

describe('get_regime — scope=symbol days cap', () => {
  test('days > 30 throws', async () => {
    const { handler } = createHarness({ history: [] });
    const result = await handler({ scope: 'symbol', symbol: 'SPY', days: 45 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("scope='symbol' 'days' must be between 1 and 30");
  });

  test('days = 30 boundary accepted', async () => {
    const { calls, handler } = createHarness({ history: [{ entry: 1 }] });
    await handler({ scope: 'symbol', symbol: 'SPY', days: 30 });
    expect(calls[0].params?.days).toBe('30');
  });
});

describe('get_regime — GEX exposure hoist', () => {
  test('scope=market hoists market.vector._meta.gex to market.exposures', async () => {
    const stub = {
      market: {
        stress_score: 0.5,
        label: 'NORMAL',
        vector: {
          _meta: {
            gex: {
              spotPrice: 500, netGamma: 1e9, netDelta: 5e8, netVega: 1e7,
              netVanna: 100, netCharm: 50, netVomma: 25,
              callWall: 510, putWall: 490, gammaFlip: 495, regime: 'NORMAL',
            },
          },
        },
      },
    };
    const { handler } = createHarness(stub);
    const result = await handler({ scope: 'market' });
    const parsed = JSON.parse(result.content[0].text);
    // shapeMarketRegimeResponse may rewrap, but exposures must be present somewhere
    expect(JSON.stringify(parsed)).toContain('netGamma');
    expect(JSON.stringify(parsed)).toContain('call wall');
  });

  test('scope=symbol hoists history[].vector._meta.gex and strips raw vector', async () => {
    const stub = {
      symbol: 'SPY', scope: 'bellwether',
      history: [
        {
          date: '2026-04-17',
          vector: {
            _meta: {
              gex: {
                spotPrice: 500, netGamma: 1e9, callWall: 510, putWall: 490,
                gammaFlip: 495, absGamma: 500, topStrikes: [500, 505, 495],
              },
            },
          },
        },
      ],
    };
    const { handler } = createHarness(stub);
    const result = await handler({ scope: 'symbol', symbol: 'SPY' });
    const parsed = JSON.parse(result.content[0].text);
    // days=1 unwraps the latest entry
    expect(parsed.exposures).toBeDefined();
    expect(parsed.exposures.netGamma).toBe(1e9);
    expect(parsed.exposures['abs gamma']).toBe(500);
    expect(parsed.exposures.topStrikes).toEqual([500, 505, 495]);
    expect(parsed.vector).toBeUndefined();
  });
});

describe('get_regime — scope=market include_symbols', () => {
  test('include_symbols=true caps rows, strips raw vectors, and renames symbol tier scope', async () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      symbol: `SYM${index}`,
      scope: 'bellwether',
      stress_score: index === 9 ? -9 : index,
      vector: {
        z: { tail_dominance: 1 },
        _meta: {
          gex: {
            spotPrice: 500,
            netGamma: 1e9,
            netDelta: 5e8,
            netVega: 1e7,
            netVanna: 100,
            netCharm: 50,
            netVomma: 25,
            callWall: 510,
            putWall: 490,
            gammaFlip: 495,
            regime: 'positive',
          },
        },
      },
    }));
    const stub = {
      market: { stress_score: 0.5 },
      symbols: { bellwether: rows },
    };
    const { handler } = createHarness(stub);
    const result = await handler({ scope: 'market', include_symbols: true });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.symbols.bellwether).toHaveLength(8);
    expect(parsed.symbols.bellwether[0].symbol).toBe('SYM9');
    expect(parsed.symbols.bellwether.some((row: any) => row.symbol === 'SYM0')).toBe(false);
    for (const row of parsed.symbols.bellwether) {
      expect(row.scope).toBeUndefined();
      expect(row['symbol tier']).toBe('bellwether');
      expect(row.symbolTier).toBeUndefined();
      expect(row.vector).toBeUndefined();
      expect(row.exposures['call wall']).toBe(510);
    }
    expect(parsed.symbolCoverage.selection).toBe('top symbols per tier by absolute stress score');
    expect(parsed.symbolCoverage.tiers.bellwether).toEqual({ total: 10, returned: 8 });
    expect(parsed._symbols_truncation_meta).toBeUndefined();
    expect(parsed._stress_score_note).toBeUndefined();
    expect(parsed.market.stress_score).toBe(0.5);
    expect(JSON.stringify(parsed)).not.toContain('callWall');
    expect(JSON.stringify(parsed)).not.toContain('tail_dominance');
  });

  test('scope=symbol with no daily history returns structured no-data record', async () => {
    const { handler } = createHarness({ symbol: 'SPY', history: [] });
    const result = await handler({ scope: 'symbol', symbol: 'SPY' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({
      symbol: 'SPY',
      view: 'symbol',
      dataAvailable: false,
      message: 'No daily symbol-regime data available for this symbol. Symbol-regime classification covers a curated universe; not every ticker is included.',
    });
  });
});

describe('get_regime — scope=symbol days>1 keeps full history', () => {
  test('days=5 returns the full res (not unwrapped)', async () => {
    const stub = {
      symbol: 'SPY',
      history: [
        { date: '2026-04-13' },
        { date: '2026-04-14' },
        { date: '2026-04-15' },
      ],
    };
    const { handler } = createHarness(stub);
    const result = await handler({ scope: 'symbol', symbol: 'SPY', days: 5 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.history).toHaveLength(3);
  });
});

describe('get_regime — symbol tier rename (avoid input/output `scope` collision)', () => {
  test('scope=symbol days=1 emits `symbol tier` not `scope` or `symbolTier` for the tier value', async () => {
    const stub = {
      symbol: 'NVDA',
      scope: 'bellwether',
      history: [{ date: '2026-04-17', label: 'NORMAL' }],
    };
    const { handler } = createHarness(stub);
    const result = await handler({ scope: 'symbol', symbol: 'NVDA' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed['symbol tier']).toBe('bellwether');
    expect(parsed.symbolTier).toBeUndefined();
    expect(parsed.scope).toBeUndefined();
  });

  test('scope=symbol days>1 also renames top-level scope → symbol tier', async () => {
    const stub = {
      symbol: 'XLF',
      scope: 'sector',
      history: [
        { date: '2026-04-15' },
        { date: '2026-04-16' },
        { date: '2026-04-17' },
      ],
    };
    const { handler } = createHarness(stub);
    const result = await handler({ scope: 'symbol', symbol: 'XLF', days: 5 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed['symbol tier']).toBe('sector');
    expect(parsed.symbolTier).toBeUndefined();
    expect(parsed.scope).toBeUndefined();
  });

  test('scope=intraday strips raw vector blobs and hoists GEX exposures', async () => {
    const stub = {
      symbol: 'SPY',
      count: 1,
      scans: [
        {
          date: '2026-04-17',
          scan_time: '13:00',
          interval: 'midday',
          scope: 'bellwether',
          label: 'NORMAL',
          drivers: [{ feature: 'skew_pressure', z: 1.2 }],
          vector: {
            z: { tail_dominance: 1 },
            raw: { skew_pressure: 2 },
            data_quality: { vol_level: 'ok' },
            _meta: {
              gex: {
                spotPrice: 500,
                netGamma: 1e9,
                callWall: 510,
                putWall: 490,
                gammaFlip: 495,
                absGamma: 500,
                topStrikes: [
                  { strike: 500, callGamma: 10, putGamma: -5, netGamma: 5, callDelta: 1 },
                  { strike: 505, callGamma: 8, putGamma: -2, netGamma: 6, callDelta: 2 },
                  { strike: 495, callGamma: 7, putGamma: -1, netGamma: 6, callDelta: 3 },
                  { strike: 510, callGamma: 6, putGamma: -1, netGamma: 5, callDelta: 4 },
                  { strike: 490, callGamma: 5, putGamma: -1, netGamma: 4, callDelta: 5 },
                  { strike: 515, callGamma: 4, putGamma: -1, netGamma: 3, callDelta: 6 },
                ],
              },
            },
          },
        },
      ],
    };
    const { handler } = createHarness(stub);
    const result = await handler({ scope: 'intraday', symbol: 'SPY' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.scans).toHaveLength(1);
    for (const scan of parsed.scans) {
      expect(scan['symbol tier']).toBe('bellwether');
      expect(scan.symbolTier).toBeUndefined();
      expect(scan.scope).toBeUndefined();
      expect(scan.vector).toBeUndefined();
      expect(scan.exposures['call wall']).toBe(510);
      expect(scan.exposures['gamma flip']).toBe(495);
      expect(scan.exposures['abs gamma']).toBe(500);
      expect(scan.exposures.topStrikes).toEqual([
        { strike: 500, netGamma: 5 },
        { strike: 505, netGamma: 6 },
        { strike: 495, netGamma: 6 },
        { strike: 510, netGamma: 5 },
        { strike: 490, netGamma: 4 },
      ]);
      expect(scan.drivers[0].feature).toBe('Skew Pressure');
    }
    expect(result.content[0].text).not.toContain('tail_dominance');
    expect(result.content[0].text).not.toContain('skew_pressure');
    expect(result.content[0].text).not.toContain('callWall');
    expect(result.content[0].text).not.toContain('callGamma');
    expect(result.content[0].text).not.toContain('putGamma');
    expect(result.content[0].text).not.toContain('callDelta');
  });
});
