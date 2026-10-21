import { describe, test, expect } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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

function intradayBoundaryScans(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(2026, 9, 16 - Math.floor(i / 5))).toISOString().slice(0, 10);
    return {
      date, scan_time: `${date}T${['13:45', '15:00', '17:00', '18:30', '19:45'][i % 5]}:00.000Z`,
      interval: ['open', 'morning', 'midday', 'afternoon', 'pre-close'][i % 5], scope: 'bellwether',
      label: 'ELEVATED', stress_score: 0.4229, confidence: 0.9414,
      drivers: ['skew_pressure', 'tail_dominance', 'vol_level'].map((feature, j) => ({ feature, z: 1.234 + j, contribution: 0.1234 + j / 10 })),
      vector: { _meta: {
        prevLabel: 'ELEVATED', prevLabelSource: i % 5 ? 'earlier-scan' : 'daily', calibration: { models_succeeded: 8, models_attempted: 8 },
        gex: { spotPrice: 765.14, netGamma: 123456789.1, netDelta: 23456789.1, netVega: 3456789.1,
          netVanna: 456789.1, netCharm: 56789.1, netVomma: 6789.1, callWall: 770, putWall: 760,
          gammaFlip: 764.97, absGamma: 765, regime: 'positive',
          topStrikes: Array.from({ length: 5 }, (_, j) => ({ strike: 765 + j, netGamma: 123456.123456 + j })),
        },
      } },
    };
  });
}

test('a 90-day intraday request retains all 49 scans that fitted before the prior reminder', async () => {
  const scans = intradayBoundaryScans(49);
  const result = await createHarness({ symbol: 'SPY', count: scans.length, scans }).handler({ scope: 'intraday', symbol: 'SPY', days: 90 });
  const wire = JSON.parse(result.content[0].text);
  expect(wire.scans).toHaveLength(49);
  expect(wire.scansMeta.order).toContain('newest date first');
  expect(wire.scansMeta.scanTime).toContain("run's start");
  expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(49_920);
});

test.each([49, 450])('intraday precision boundary retains the existing view for %i input scans', async (count) => {
  const scans = intradayBoundaryScans(count);
  for (const scan of scans) {
    const gex = scan.vector._meta.gex;
    for (const key of ['netGamma', 'netDelta', 'netVega', 'netVanna', 'netCharm', 'netVomma'] as const) {
      if (count === 450) gex[key] = Math.round(gex[key] / 10);
    }
  }
  for (let i = 0; i < (count === 49 ? 92 : 35); i++) {
    const gex = scans[i % Math.min(count, 50)].vector._meta.gex;
    const key = i < Math.min(count, 50) ? 'netGamma' : 'netDelta';
    gex[key] += count === 49 ? 0.03 : 0.3;
  }
  const wire = await callRegimeClient({ symbol: 'SPY', count, scans }, { scope: 'intraday', symbol: 'SPY', days: 90 });
  expect(wire.scans).toHaveLength(Math.min(count, 50));
  expect(wire.scans[0].exposures.netGamma).toBe(scans[0].vector._meta.gex.netGamma);
  expect(wire.stressScoreNote).toContain('The next daily label applies this rule against the latest earlier daily, not this scan.');
  expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(49_920);
});

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
    expect(JSON.stringify(parsed)).toContain('"callWall"');
    expect(JSON.stringify(parsed)).not.toContain('call wall');
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
    expect(parsed.exposures.gammaMagnet).toBe(500);
    expect(parsed.exposures['abs gamma']).toBeUndefined();
    expect(parsed.exposures.absGamma).toBeUndefined();
    expect(parsed.exposures.topStrikes).toEqual([500, 505, 495]);
    expect(parsed.vector).toBeUndefined();
  });
});

describe('get_regime - every exposures path publishes camelCase level keys', () => {
  // Field names are camelCase on every tool; absGamma is published as
  // gammaMagnet, the name both positioning tools use for the same strike.
  const gex = {
    spotPrice: 500, netGamma: 1e9, netDelta: 5e8, netVega: 1e7, netVanna: 100, netCharm: 50, netVomma: 25,
    callWall: 510, putWall: 490, gammaFlip: 495, absGamma: 500, regime: 'positive',
    topStrikes: [{ strike: 500, netGamma: 5 }],
  };
  const levels = { callWall: 510, putWall: 490, gammaFlip: 495, gammaMagnet: 500 };
  const noOldNames = (value: unknown) => {
    const text = JSON.stringify(value);
    expect(text).not.toMatch(/call wall|put wall|gamma flip|abs gamma|symbol tier|"absGamma"/);
  };

  test('the market composite', async () => {
    const { handler } = createHarness({ market: { stress_score: 0.5, label: 'NORMAL', vector: { _meta: { gex } } } });
    const parsed = JSON.parse((await handler({ scope: 'market' })).content[0].text);
    expect(parsed.market.exposures).toMatchObject(levels);
    noOldNames(parsed);
  });

  test('the include_symbols rows', async () => {
    const { handler } = createHarness({
      market: { stress_score: 0.5, label: 'NORMAL' },
      symbols: { bellwether: [{ symbol: 'AAA', scope: 'bellwether', stress_score: 1, label: 'NORMAL', vector: { _meta: { gex } } }] },
    });
    const parsed = JSON.parse((await handler({ scope: 'market', include_symbols: true })).content[0].text);
    expect(parsed.symbols.bellwether[0].exposures).toMatchObject(levels);
    expect(parsed.symbols.bellwether[0].symbolTier).toBe('bellwether');
    noOldNames(parsed);
  });

  // review: the one-day and intraday paths (hoistExposures)
  // were pinned on callWall, gammaFlip and gammaMagnet but not putWall.
  test('the one-day symbol entry', async () => {
    const { handler } = createHarness({ symbol: 'AAA', scope: 'bellwether', history: [{ date: '2026-09-17', label: 'NORMAL', vector: { _meta: { gex } } }] });
    const parsed = JSON.parse((await handler({ scope: 'symbol', symbol: 'AAA' })).content[0].text);
    expect(parsed.exposures).toMatchObject(levels);
    noOldNames(parsed);
  });

  test('the intraday scans', async () => {
    const { handler } = createHarness({ symbol: 'AAA', scans: [{ date: '2026-09-17', scan_time: '13:00', interval: 'midday', label: 'NORMAL', scope: 'bellwether', vector: { _meta: { gex } } }] });
    const parsed = JSON.parse((await handler({ scope: 'intraday', symbol: 'AAA' })).content[0].text);
    expect(parsed.scans[0].exposures).toMatchObject(levels);
    noOldNames(parsed);
  });

  test('the full symbol history', async () => {
    const { handler } = createHarness({
      symbol: 'AAA', scope: 'bellwether',
      history: [{ date: '2026-09-16', label: 'NORMAL', vector: { _meta: { gex } } }, { date: '2026-09-17', label: 'NORMAL', vector: { _meta: { gex } } }],
    });
    const parsed = JSON.parse((await handler({ scope: 'symbol', symbol: 'AAA', days: 2, full: true })).content[0].text);
    expect(parsed.history).toHaveLength(2);
    for (const entry of parsed.history) expect(entry.exposures).toMatchObject(levels);
    expect(parsed.symbolTier).toBe('bellwether');
    noOldNames(parsed);
  });
});

describe('get_regime — scope=market include_symbols', () => {
  test('include_symbols=true caps rows, strips raw vectors, and renames the tier scope to symbolTier', async () => {
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
      expect(row.symbolTier).toBe('bellwether');
      expect(row['symbol tier']).toBeUndefined();
      expect(row.vector).toBeUndefined();
      expect(row.exposures.callWall).toBe(510);
    }
    expect(parsed.symbolCoverage.selection).toBe('top symbols per tier by absolute stress score');
    expect(parsed.symbolCoverage.tiers.bellwether).toEqual({ total: 10, returned: 8 });
    expect(parsed._symbols_truncation_meta).toBeUndefined();
    expect(parsed._stress_score_note).toBeUndefined();
    expect(parsed.market.stressScore).toBe(0.5);
    expect(parsed.market.stress_score).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toMatch(/call wall|gamma flip|abs gamma|symbol tier/);
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

describe('get_regime - the tier is published as symbolTier (avoid input/output `scope` collision)', () => {
  test('scope=symbol days=1 emits `symbolTier`, not `scope` or a spaced key, for the tier value', async () => {
    const stub = {
      symbol: 'NVDA',
      scope: 'bellwether',
      history: [{ date: '2026-04-17', label: 'NORMAL' }],
    };
    const { handler } = createHarness(stub);
    const result = await handler({ scope: 'symbol', symbol: 'NVDA' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.symbolTier).toBe('bellwether');
    expect(parsed['symbol tier']).toBeUndefined();
    expect(parsed.scope).toBeUndefined();
  });

  test('scope=symbol days>1 also renames top-level scope to symbolTier', async () => {
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
    expect(parsed.symbolTier).toBe('sector');
    expect(parsed['symbol tier']).toBeUndefined();
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
      expect(scan.symbolTier).toBe('bellwether');
      expect(scan['symbol tier']).toBeUndefined();
      expect(scan.scope).toBeUndefined();
      expect(scan.vector).toBeUndefined();
      expect(scan.exposures.callWall).toBe(510);
      expect(scan.exposures.gammaFlip).toBe(495);
      expect(scan.exposures.gammaMagnet).toBe(500);
      expect(JSON.stringify(scan)).not.toMatch(/call wall|gamma flip|abs gamma|symbol tier/);
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
    expect(result.content[0].text).not.toMatch(/call wall|gamma flip|abs gamma|symbol tier/);
    expect(result.content[0].text).not.toContain('callGamma');
    expect(result.content[0].text).not.toContain('putGamma');
    expect(result.content[0].text).not.toContain('callDelta');
  });
});

describe('get_regime - the label is a state with hysteresis, on every scope', () => {
  const hysteresis = /^stressScore is a raw composite regime score, not a 0-100 index\. `label` is a state with hysteresis, not a band read off the score[^]*Entry levels: Normal -0\.5, Elevated 0\.5, Stress 1\.5, Crisis 2\.5, and Calm below -0\.5 with no prior; exit levels: Normal -1\.0, Elevated 0\.0, Stress 1\.0, Crisis 2\.0\.[^]*So a score inside one band can carry the label above it\.$/;

  test('the intraday shape carries the note and says its scan order', async () => {
    const stub = {
      symbol: 'SPY',
      count: 2,
      scans: [
        { date: '2026-09-18', scan_time: '13:45', interval: 'open', label: 'ELEVATED', stress_score: 1.3496 },
        { date: '2026-09-18', scan_time: '17:00', interval: 'midday', label: 'ELEVATED', stress_score: 0.4229 },
      ],
    };
    const { handler } = createHarness(stub);
    const parsed = JSON.parse((await handler({ scope: 'intraday', symbol: 'SPY' })).content[0].text);
    expect(parsed.stressScoreNote).toContain('Labels use hysteresis, not fixed score bands.');
    expect(parsed.stressScoreNote).toContain('Entry: Normal -0.5, Elevated 0.5, Stress 1.5, Crisis 2.5; Calm below -0.5 without a prior.');
    expect(parsed.stressScoreNote).toContain('Exit: Normal -1.0, Elevated 0.0, Stress 1.0, Crisis 2.0.');
    expect(parsed.stressScoreNote).toContain("If the score meets a higher state's entry, move to the highest such state; else keep the prior until below its exit, then take the highest lower state whose entry is met.");
    expect(parsed.stressScoreNote).toMatch(/So a score inside one band can carry the label above it\.$/);
    expect(parsed.stressScoreNote).not.toMatch(/Typical bands|2026-09-18/);
    expect(parsed.stressScoreNote).not.toMatch(/tool description has the full rule/);
    expect(parsed.stressScoreNote).toContain("The exit level protects only the prior actually used: a later scan judged against the daily prior can get a lower label than a previous scan while its score is still above that previous label's exit. The next daily label applies this rule against the latest earlier daily, not this scan.");
    expect(parsed.stressScoreNote).toContain('Without a usable prior, including a failed read, take the highest state whose entry is met.');
    // The proxy orders market_date DESC then scan_time ASC (regime.ts
    // /regime/intraday, on the days, date and interval branches alike):
    // the newest scan is the LAST entry of the FIRST date, which the run
    // read as "neither newest-first nor oldest-first".
    // review: scan_time ASC is not interval order; a rerun
    // interval stores a later scan_time and sits after pre-close.
    expect(parsed.scansMeta.order).toBe('newest date first; within a date, by scan time ascending (a rerun scan sits after the ones before it, whatever its interval), so the newest scan is the last entry of the first date');
    expect(parsed.scans).toHaveLength(2);
    expect(parsed._scans_meta).toBeUndefined();
    expect(parsed._stress_score_note).toBeUndefined();
  });

  test('the symbol shape carries the note on the one-day, multi-day and full paths', async () => {
    const stub = () => ({
      symbol: 'SPY',
      scope: 'bellwether',
      history: [
        { date: '2026-09-16', label: 'STRESS', stress_score: 1.4406 },
        { date: '2026-09-17', label: 'ELEVATED', stress_score: 0.7147 },
      ],
    });
    const one = JSON.parse((await createHarness(stub()).handler({ scope: 'symbol', symbol: 'SPY', days: 1 })).content[0].text);
    expect(one.stressScoreNote).toMatch(hysteresis);
    expect(one.stressScoreNote).not.toMatch(/protects only the prior actually used/);   // Intraday only
    expect(one.date).toBe('2026-09-17');
    const many = JSON.parse((await createHarness(stub()).handler({ scope: 'symbol', symbol: 'SPY', days: 5 })).content[0].text);
    expect(many.stressScoreNote).toMatch(hysteresis);
    expect(many.history).toHaveLength(2);
    // Tenth run: the symbol history was the one list left without an
    // order marker; the route sorts market_date ascending past one day.
    expect(many.historyMeta).toEqual({ order: 'oldest first' });
    expect(one.historyMeta).toBeUndefined();
    const full = JSON.parse((await createHarness(stub()).handler({ scope: 'symbol', symbol: 'SPY', days: 5, full: true })).content[0].text);
    expect(full.stressScoreNote).toMatch(hysteresis);
    expect(full.historyMeta).toEqual({ order: 'oldest first' });
    // The no-data record makes no claim about a label it does not carry.
    const none = JSON.parse((await createHarness({ symbol: 'ZZZZ', history: [] }).handler({ scope: 'symbol', symbol: 'ZZZZ' })).content[0].text);
    expect(none.dataAvailable).toBe(false);
    expect(none.stressScoreNote).toBeUndefined();
  });

  test('the market shape carries the same note', async () => {
    const stub = { market: { stress_score: 0.5, label: 'NORMAL', vector: { _meta: { gex: { spotPrice: 500, netGamma: 1 } } } } };
    const parsed = JSON.parse((await createHarness(stub).handler({ scope: 'market' })).content[0].text);
    expect(parsed.stressScoreNote).toMatch(hysteresis);
    expect(parsed.market.stressScoreNote).toBeUndefined();
    expect(parsed.market).toMatchObject({ label: 'Normal', labelKey: 'NORMAL' });   // the display word, the stored key beside it (2026-10-11)
    // And with the per-symbol breakdown, once, beside `market`.
    const withSymbols = JSON.parse((await createHarness({ ...stub, symbols: { bellwether: [] } }).handler({ scope: 'market', include_symbols: true })).content[0].text);
    expect(withSymbols.stressScoreNote).toMatch(hysteresis);
    expect(withSymbols.market.stressScoreNote).toBeUndefined();
  });
});

describe('get_regime - include_symbols orders every tier and keeps the market shape', () => {
  // Eleventh run: the three capped tiers came back by absolute stress score
  // and every uncapped tier alphabetical (commodities: GDXJ, GLD, SLV, UNG,
  // USO at -0.1715, 0.0477, -0.379, -0.3874, 0.2253), because the sort ran
  // only where the cap did; and `market` lost feature_z_scores and its
  // meta under include_symbols, because that path humanized and stripped
  // the entry instead of shaping it as the default path does.
  const market = { stress_score: 0.5, label: 'NORMAL', drivers: [{ feature: 'vol_level', z: -0.6, contribution: 0.07 }], vector: { z: { vol_level: -0.6, skew_pressure: 0.2 }, raw: { vol_level: 1 }, _meta: { gex: { spotPrice: 500, netGamma: 1 } } } };
  const stub = () => ({
    market: structuredClone(market),
    symbols: {
      commodities: [
        { symbol: 'GDXJ', scope: 'commodities', stress_score: -0.1715, vector: { z: {} } },
        { symbol: 'GLD', scope: 'commodities', stress_score: 0.0477, vector: { z: {} } },
        { symbol: 'SLV', scope: 'commodities', stress_score: -0.379, vector: { z: {} } },
        { symbol: 'UNG', scope: 'commodities', stress_score: -0.3874, vector: { z: {} } },
        { symbol: 'USO', scope: 'commodities', stress_score: 0.2253, vector: { z: {} } },
      ],
      bellwether: Array.from({ length: 10 }, (_, i) => ({ symbol: `S${i}`, scope: 'bellwether', stress_score: (i % 2 ? -1 : 1) * i / 10 })),
    },
  });

  test('an uncapped tier is sorted by absolute stress score like a capped one', async () => {
    const parsed = JSON.parse((await createHarness(stub()).handler({ scope: 'market', include_symbols: true })).content[0].text);
    expect(parsed.symbols.commodities.map((r: any) => r.symbol)).toEqual(['UNG', 'SLV', 'USO', 'GDXJ', 'GLD']);
    expect(parsed.symbols.bellwether).toHaveLength(8);
    expect(parsed.symbols.bellwether.map((r: any) => Math.abs(r.stressScore))).toEqual([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]);
    // The coverage block still names only the tiers that were cut.
    expect(parsed.symbolCoverage.tiers).toEqual({ bellwether: { total: 10, returned: 8 } });
  });

  test('the market entry keeps its shaped fields with include_symbols', async () => {
    const withSymbols = JSON.parse((await createHarness(stub()).handler({ scope: 'market', include_symbols: true })).content[0].text);
    const alone = JSON.parse((await createHarness({ market: structuredClone(market) }).handler({ scope: 'market' })).content[0].text);
    // The field names are camelCase; the feature names inside are data.
    expect(withSymbols.market.featureZScores).toEqual({ 'Vol Level': -0.6, 'Skew Pressure': 0.2 });
    expect(withSymbols.market.featureZScores).toEqual(alone.market.featureZScores);
    expect(withSymbols.market.featureVectorMeta).toEqual({ rawInternalsOmitted: true });
    expect(withSymbols.market.featureVectorMeta).toEqual(alone.market.featureVectorMeta);
    expect(withSymbols.market.drivers).toEqual(alone.market.drivers);
    expect(withSymbols.market.vector).toBeUndefined();
    expect(withSymbols.market.exposures).toEqual(alone.market.exposures);
  });
});

describe('get_regime - model coverage and the exposures note ride the entries', () => {
  // Twelfth run: KBE read ELEVATED at confidence 0.1183 and SCHD NORMAL at
  // 0.0955, both well inside their bands, and nothing in the payload said
  // why. The stored vector._meta carries models_succeeded 2 of
  // models_attempted 8 on both (0.25 to the 1.5 is 0.125, the whole
  // story), and the intraday row carries the same under
  // _meta.calibration {succeeded, total}; the vector was stripped whole.
  // And one `exposures` object mixed two books (abs gamma 70 from the
  // 0-60 day window beside topStrikes[0] at 59 from the whole book) with
  // nothing marking which is which.
  // review: with fewer than two gamma-bearing strikes in the
  // window the regime is the sign of the whole-book net gamma (a 10-day
  // put at -10,000 under a 90-day call at +100,000: regime positive), so
  // the note carries that qualification rather than calling regime a
  // window field outright.
  const NOTE = 'callWall, putWall, gammaFlip and gammaMagnet are over the 0-60 day window, and so is regime except with fewer than two gamma-bearing strikes there, when it is the sign of netGamma; netGamma, the other net totals and topStrikes are over the whole exposure input';
  const daily = (over: Record<string, unknown> = {}) => ({
    date: '2026-09-17', label: 'ELEVATED', stress_score: 0.8906, confidence: 0.1183,
    vector: { z: {}, _meta: { models_succeeded: 2, models_attempted: 8, model_coverage: 0.25, gex: { spotPrice: 66.77, netGamma: -6224697, callWall: 66, putWall: 68, absGamma: 70, topStrikes: [{ strike: 59, netGamma: -3204603 }] } } },
    ...over,
  });

  test('symbol entries carry modelCoverage from the daily meta, on every path', async () => {
    const stub = () => ({ symbol: 'KBE', scope: 'industry', history: [daily({ date: '2026-09-16' }), daily()] });
    const one = JSON.parse((await createHarness(stub()).handler({ scope: 'symbol', symbol: 'KBE', days: 1 })).content[0].text);
    expect(one.modelCoverage).toEqual({ succeeded: 2, attempted: 8 });
    expect(one.exposuresNote.startsWith(NOTE + '. ')).toBe(true);
    expect(one.vector).toBeUndefined();
    const many = JSON.parse((await createHarness(stub()).handler({ scope: 'symbol', symbol: 'KBE', days: 5 })).content[0].text);
    expect(many.history.map((h: any) => h.modelCoverage)).toEqual([{ succeeded: 2, attempted: 8 }, { succeeded: 2, attempted: 8 }]);
    expect(many.exposuresNote.startsWith(NOTE + '. ')).toBe(true);
    const full = JSON.parse((await createHarness(stub()).handler({ scope: 'symbol', symbol: 'KBE', days: 5, full: true })).content[0].text);
    expect(full.history[1].modelCoverage).toEqual({ succeeded: 2, attempted: 8 });
    expect(full.history[1].vector).toBeUndefined();
    expect(full.exposuresNote.startsWith(NOTE + '. ')).toBe(true);
    // A row without both counts carries no coverage, never a fabricated
    // or half-filled one.
    for (const meta of [undefined, {}, { models_succeeded: 2 }, { models_attempted: 8 }, { calibration: { succeeded: 8 } }]) {
      const bare = JSON.parse((await createHarness({ symbol: 'ZZ', history: [{ date: '2026-09-17', vector: { z: {}, _meta: meta } }] }).handler({ scope: 'symbol', symbol: 'ZZ' })).content[0].text);
      expect(bare.modelCoverage, JSON.stringify(meta)).toBeUndefined();
    }
  });

  test('intraday scans carry modelCoverage from _meta.calibration', async () => {
    const stub = { symbol: 'SPY', count: 1, scans: [{ date: '2026-09-18', scan_time: '17:00', interval: 'midday', label: 'ELEVATED', stress_score: 0.4229, confidence: 0.8234, vector: { z: {}, _meta: { calibration: { succeeded: 8, total: 8 }, gex: { spotPrice: 760, netGamma: -7e9 } } } }] };
    const parsed = JSON.parse((await createHarness(stub).handler({ scope: 'intraday', symbol: 'SPY' })).content[0].text);
    expect(parsed.scans[0].modelCoverage).toEqual({ succeeded: 8, attempted: 8 });
    expect(parsed.scans[0].vector).toBeUndefined();
    expect(parsed.exposuresNote.startsWith(NOTE + '. ')).toBe(true);
  });

  test('the include_symbols rows carry modelCoverage and the shape carries the note once, naming no topStrikes', async () => {
    const stub = { market: { stress_score: 0.39, label: 'ELEVATED', vector: { z: {} } }, symbols: { industry: [{ symbol: 'KBE', scope: 'industry', ...daily() }] } };
    const parsed = JSON.parse((await createHarness(stub).handler({ scope: 'market', include_symbols: true })).content[0].text);
    expect(parsed.symbols.industry[0].modelCoverage).toEqual({ succeeded: 2, attempted: 8 });
    // Thirteenth run: the breakdown's rows carry no topStrikes (their
    // exposures are the totals and the levels only), and the note named
    // the field anyway. The breakdown's note names what its rows carry.
    expect(parsed.symbols.industry[0].exposures.topStrikes).toBeUndefined();
    expect(parsed.exposuresNote.startsWith('callWall, putWall, gammaFlip and gammaMagnet are over the 0-60 day window, and so is regime except with fewer than two gamma-bearing strikes there, when it is the sign of netGamma; netGamma and the other net totals are over the whole exposure input. ')).toBe(true);
    expect(parsed.exposuresNote).toMatch(/carry no topStrikes/);
    // The composite stores no model counts and gets no coverage field.
    expect(parsed.market.modelCoverage).toBeUndefined();
    const alone = JSON.parse((await createHarness({ market: { stress_score: 0.39, label: 'ELEVATED', vector: { z: {} } } }).handler({ scope: 'market' })).content[0].text);
    expect(alone.exposuresNote).toBeUndefined();
  });
});

describe('get_regime intraday prior label', () => {
  // The intraday producer now records the prior its hysteresis kept
  // (vector._meta.prevLabel / prevLabelSource); rows before that carry
  // neither, and must not read as "no prior".
  const scan = (meta: Record<string, unknown>, interval: string) => ({
    date: '2026-09-24', scan_time: '13:00', interval, label: 'ELEVATED', scope: 'bellwether', vector: { _meta: meta },
  });

  test('each scan names its prior label and where it came from, and an older scan names neither', async () => {
    const { handler } = createHarness({
      symbol: 'SPY',
      scans: [
        scan({ prevLabel: 'NORMAL', prevLabelSource: 'earlier-scan' }, 'midday'),
        scan({ prevLabel: 'ELEVATED', prevLabelSource: 'daily' }, 'afternoon'),
        scan({ prevLabel: null, prevLabelSource: null }, 'open'),
        scan({}, 'morning'),
      ],
    });
    const parsed = JSON.parse((await handler({ scope: 'intraday', symbol: 'SPY' })).content[0].text);
    const byInterval = Object.fromEntries(parsed.scans.map((s: any) => [s.interval, s]));
    expect(byInterval.midday).toMatchObject({ priorLabel: 'Normal', priorLabelKey: 'NORMAL', priorLabelSource: 'earlier scan' });
    expect(byInterval.afternoon).toMatchObject({ priorLabel: 'Elevated', priorLabelKey: 'ELEVATED', priorLabelSource: 'daily label' });
    expect(byInterval.open.priorLabel).toBeNull();
    expect(byInterval.open.priorLabelSource).toBeNull();
    expect('priorLabel' in byInterval.morning).toBe(false);
    expect('priorLabelSource' in byInterval.morning).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('prevLabel');
  });
});

describe('scope=intraday migration', () => {
  const scan = (date: string, scanTime: string, interval: string, gex: Record<string, unknown> | null) => ({
    date, scan_time: scanTime, interval, scope: 'market', label: 'NORMAL', stress_score: 0.1, confidence: 0.8, drivers: [],
    vector: { z: {}, raw: {}, _meta: { gex } },
  });
  const level = (spotPrice: number, gammaFlip: number | null, callWall: number, putWall: number, absGamma: number, netGamma: number) =>
    ({ spotPrice, netGamma, netDelta: 0, netVega: 0, netVanna: 0, netCharm: 0, netVomma: 0, callWall, putWall, gammaFlip, absGamma, regime: 'positive', topStrikes: [] });
  // The proxy's order: newest date first, scan time ascending within a date.
  // Built per call: the handler shapes the scans it is given in place.
  const stub = () => ({
    symbol: 'SPY', count: 5,
    scans: [
      scan('2026-09-17', '2026-09-17T13:30:00.000Z', 'open', level(100, 100, 105, 95, 100, 1e9)),
      scan('2026-09-17', '2026-09-17T15:00:00.000Z', 'midday', level(101, 101, 106, 95, 105, 1.2e9)),
      scan('2026-09-17', '2026-09-17T17:00:00.000Z', 'afternoon', null),
      scan('2026-09-17', '2026-09-17T19:30:00.000Z', 'pre-close', level(102, null, 106, 96, 105, 1.3e9)),
      scan('2026-09-16', '2026-09-16T13:30:00.000Z', 'open', level(99, 99, 104, 94, 99, 0.8e9)),
      scan('2026-09-16', '2026-09-16T19:30:00.000Z', 'pre-close', level(100.5, 99.5, 105, 94, 100, 0.9e9)),
    ],
  });

  test('each scan carries its levels\' change against the previous scan with exposures, and the first scan of a date against the previous session\'s last', async () => {
    const { handler } = createHarness(stub());
    const parsed = JSON.parse((await handler({ scope: 'intraday', symbol: 'SPY', migration: true })).content[0].text);
    const [open17, midday17, afternoon17, preClose17, open16, preClose16] = parsed.scans;
    expect(String(parsed.migrationNote)).toMatch(/scan start/i);

    // 09-17 open against 09-16 pre-close, eighteen hours earlier.
    expect(open17.migration.basis).toBe('previous-session-last-scan');
    expect(open17.migration.gammaFlip).toEqual({ from: 99.5, to: 100, change: 0.5, changePctOfSpot: 0.5, perHour: 0.0278, direction: 'up' });
    expect(open17.migration.putWall).toEqual({ from: 94, to: 95, change: 1, changePctOfSpot: 1, perHour: 0.0556, direction: 'up' });
    expect(open17.migration.netGamma).toEqual({ from: 0.9e9, to: 1e9, change: 1e8, changePct: 11.1111, perHour: 5555555.5556, direction: 'up' });

    // 09-17 midday against 09-17 open, ninety minutes earlier.
    expect(midday17.migration.basis).toBe('previous-scan');
    expect(midday17.migration.gammaFlip).toEqual({ from: 100, to: 101, change: 1, changePctOfSpot: 0.9901, perHour: 0.6667, direction: 'up' });
    expect(midday17.migration.putWall).toEqual({ from: 95, to: 95, change: 0, changePctOfSpot: 0, perHour: 0, direction: 'flat' });
    expect(midday17.migration.gammaMagnet).toEqual({ from: 100, to: 105, change: 5, changePctOfSpot: 4.9505, perHour: 3.3333, direction: 'up' });
    expect(midday17.migration.netGamma).toEqual({ from: 1e9, to: 1.2e9, change: 2e8, changePct: 20, perHour: 133333333.3333, direction: 'up' });

    // A scan whose exposure compute failed has no levels: null, and it is not a basis.
    expect(afternoon17.migration).toBeNull();
    expect(preClose17.migration.basis).toBe('previous-scan');
    expect(preClose17.migration.callWall).toEqual({ from: 106, to: 106, change: 0, changePctOfSpot: 0, perHour: 0, direction: 'flat' });
    // A null level on either side is a null entry, never zero.
    expect(preClose17.migration.gammaFlip).toEqual({ from: 101, to: null, change: null, changePctOfSpot: null, perHour: null, direction: null });

    // The oldest date in the payload has no earlier session to measure from.
    expect(open16.migration).toBeNull();
    expect(preClose16.migration.basis).toBe('previous-scan');
    expect(preClose16.migration.gammaFlip.change).toBe(0.5);
  });

  test('without migration the scans carry no migration keys', async () => {
    const { handler } = createHarness(stub());
    const parsed = JSON.parse((await handler({ scope: 'intraday', symbol: 'SPY' })).content[0].text);
    expect(parsed.scans.every((entry: any) => !('migration' in entry))).toBe(true);
    expect('migrationNote' in parsed).toBe(false);
  });
});

describe('a partial regime answer', () => {
  const market = { date: '2026-10-07', label: 'NORMAL', stress_score: 0.2, scan_source: 'eod', top_driver: null };

  test('an unread intraday scan: partial, named, with a note that this is the end-of-day regime', async () => {
    const { handler } = createHarness({ market, partial: true, unavailable: ['intraday'] });
    const parsed = JSON.parse((await handler({ scope: 'market' }) as any).content[0].text);
    expect(parsed.partial).toBe(true);
    expect(parsed.unavailable).toEqual(['intraday']);
    expect(parsed.partialNote).toMatch(/intraday scan could not be read/);
  });

  test('an unread breakdown with include_symbols: the note says the breakdown is missing, not empty', async () => {
    const { handler } = createHarness({ market, partial: true, unavailable: ['symbols'] });
    const parsed = JSON.parse((await handler({ scope: 'market', include_symbols: true }) as any).content[0].text);
    expect(parsed.partialNote).toMatch(/per-symbol breakdown could not be read/);
  });

  test('a whole answer: no partial fields (the control)', async () => {
    const { handler } = createHarness({ market });
    const parsed = JSON.parse((await handler({ scope: 'market' }) as any).content[0].text);
    expect('partial' in parsed).toBe(false);
  });
});

describe('get_regime rules in the answer', () => {
  const run = async (stub: unknown, args: Record<string, unknown>) => JSON.parse((await createHarness(stub).handler(args)).content[0].text);
  const gex = { spotPrice: 66.77, netGamma: -6224697, callWall: 66, putWall: 68, gammaFlip: null, absGamma: 70, regime: 'negative', topStrikes: [{ strike: 59, netGamma: -3204603 }] };
  const dailyRow = { date: '2026-09-17', label: 'ELEVATED', stress_score: 0.8906, confidence: 0.1183, vector: { z: {}, _meta: { models_succeeded: 2, models_attempted: 8, gex } } };
  const symbolStub = () => ({ symbol: 'KBE', scope: 'industry', history: [dailyRow] });
  const intradayStub = (scans: unknown[] = [{ date: '2026-09-18', scan_time: '17:00', interval: 'midday', label: 'ELEVATED', stress_score: 0.4229, vector: { z: {}, _meta: { gex } } }]) => ({ symbol: 'SPY', count: scans.length, scans });
  const marketStub = (over: Record<string, unknown> = {}) => ({ market: { stress_score: 0.39, label: 'ELEVATED', vector: { z: {}, _meta: { gex } } }, ...over });

  test('the full hysteresis rule in stressScoreNote, the daily prior clause on market and symbol, both on intraday', async () => {
    const symbol = (await run(symbolStub(), { scope: 'symbol', symbol: 'KBE' })).stressScoreNote;
    const intraday = (await run(intradayStub(), { scope: 'intraday', symbol: 'SPY' })).stressScoreNote;
    const market = (await run(marketStub(), { scope: 'market' })).stressScoreNote;
    for (const note of [symbol, intraday, market]) {
      expect(note).toMatch(/not a 0-100 index/);
      expect(note).toMatch(/Calm below -0\.5 (with no|without a) prior/);
      expect(note).toMatch(/highest lower state whose entry (level it still meets|is met)/);
      expect(note).toMatch(/including (when the prior could not be read|a failed read)/);
      expect(note).toMatch(/Calm, Normal, Elevated, Stress/);
      expect(note).toMatch(/labelKey/);
      expect(note).toMatch(/priorLabelKey/);
      expect(note).toMatch(/compar(e|ison).*filter/);
      expect(note).toContain('the latest earlier daily label stored for the same symbol, symbolTier and model version');
      expect(note).not.toMatch(/tool description has the full rule/);
      expect(note).not.toMatch(/2026-09/);
    }
    for (const note of [symbol, market]) {
      expect(note).toContain("a score reaching a higher state's entry level moves the label to the highest state whose entry level it meets;");
      expect(note).not.toMatch(/moves the label up/);
    }
    expect(intraday).toContain("The intraday prior is the day's last scan still in the worker's store; else the latest earlier daily label stored for the same symbol, symbolTier and model version");
    expect(intraday).toMatch(/redeploy/);
    expect(symbol).not.toMatch(/scan worker/);
    expect(market).not.toMatch(/scan worker/);
  });

  test('the prior-label provenance, the z clip, the driver contribution and confidence, in the guide', async () => {
    const symbol = (await run(symbolStub(), { scope: 'symbol', symbol: 'KBE' })).guide;
    expect(symbol.priorLabel).toMatch(/store no prior label/);
    expect(symbol.zScores).toMatch(/winsorized to -5\.\.5/);
    expect(symbol.driverContribution).toMatch(/weight times z, signed/);
    expect(symbol.driverContribution).not.toMatch(/unsigned/);
    expect(symbol.confidence).toMatch(/how secure the label is, not how severe/);
    expect(symbol.confidence).toMatch(/modelCoverage/);
    expect(symbol.confidence).toMatch(/unrounded score/);
    const intraday = (await run(intradayStub(), { scope: 'intraday', symbol: 'SPY' })).guide;
    expect(intraday.priorLabel).toMatch(/not recorded, not "no prior"/);
    const market = (await run(marketStub(), { scope: 'market' })).guide;
    expect(market.driverContribution).toMatch(/unsigned and sorted by size/);
    expect(market.driverContribution).not.toMatch(/breakdown/);
    expect(market.confidence).toMatch(/symbols scored over symbols in the composite/);
    const withSymbols = (await run(marketStub({ symbols: { industry: [{ symbol: 'KBE', scope: 'industry', ...dailyRow }] } }), { scope: 'market', include_symbols: true })).guide;
    expect(withSymbols.driverContribution).toMatch(/breakdown/);
    for (const confidence of [symbol.confidence, intraday.confidence, market.confidence, withSymbols.confidence]) {
      expect(confidence).toContain("the lower edge the label's exit level when it was kept, else its entry level");
      expect(confidence).toContain("the upper edge the next state's entry level, or the previous label's exit level when just entered from above");
      expect(confidence).toContain('Calm and Crisis measure from their one edge over 1.5');
      expect(confidence).toContain('as d, the distance to the nearer edge over half the band, through (1 - e^(-2.5 d)) / (1 - e^(-2.5))');
      expect(confidence).toContain('times the share of calibration models that succeeded, raised to the power 1.5');
      expect(confidence).toContain('times 0.85 when the label differs from its prior or had none');
    }
  });

  test('exposuresNote extended on every shape with exposures - its old clauses kept first', async () => {
    const symbol = (await run(symbolStub(), { scope: 'symbol', symbol: 'KBE' })).exposuresNote;
    expect(symbol.startsWith('callWall, putWall, gammaFlip and gammaMagnet are over the 0-60 day window')).toBe(true);
    expect(symbol).toMatch(/largest absolute net gamma/);
    expect(symbol).toMatch(/the first 10/);
    expect(symbol).toMatch(/putWall can sit above callWall/);
    expect(symbol).toMatch(/not a level of zero/);
    expect(symbol).toMatch(/not the sign of netGamma/);
    expect(symbol).toMatch(/every stored row for the daily scan/);
    expect(symbol).toMatch(/own rate and dividend inputs/);
    const intraday = (await run(intradayStub(), { scope: 'intraday', symbol: 'SPY' })).exposuresNote;
    expect(intraday).toMatch(/the first 5/);
    expect(intraday).toMatch(/normalizer/);
    expect(intraday).toMatch(/chain fetch failed is absent/);
    const breakdown = (await run(marketStub({ symbols: { industry: [{ symbol: 'KBE', scope: 'industry', ...dailyRow }] } }), { scope: 'market', include_symbols: true })).exposuresNote;
    expect(breakdown).toMatch(/carry no topStrikes/);
    const composite = (await run(marketStub(), { scope: 'market' })).exposuresNote;
    expect(composite).toMatch(/carry no topStrikes/);
    expect(composite).toMatch(/every stored row for the daily scan/);
    for (const note of [symbol, intraday, breakdown, composite]) {
      expect(note).toContain('callWall is the strike with the largest positive call gamma');
      expect(note).toContain('putWall the strike with the most negative put gamma');
      expect(note).toContain('ties go to the lower strike');
      expect(note).toContain('a side with no such strike leaves that one null');
      expect(note).toContain('nothing orders them, so putWall can sit above callWall');
    }
  });

  test('scansMeta says what scanTime is on every intraday answer, and why a window can be empty', async () => {
    const one = await run(intradayStub(), { scope: 'intraday', symbol: 'SPY' });
    expect(one.scansMeta.scanTime).toMatch(/run's start/);
    expect(one.scansMeta.emptyWindow).toBeUndefined();
    const empty = await run(intradayStub([]), { scope: 'intraday', symbol: 'SPY', days: 2 });
    expect(empty.scansMeta.scanTime).toMatch(/run's start/);
    expect(empty.scansMeta.emptyWindow).toMatch(/weekends and holidays not skipped/);
    expect(empty.scansMeta.emptyWindow).toMatch(/days 2/);
  });

  test('the breakdown\'s selection when include_symbols brought symbols; that none came when it did not', async () => {
    expect((await run(marketStub(), { scope: 'market' })).guide.symbolSelection).toBeUndefined();
    const withSymbols = (await run(marketStub({ symbols: { industry: [{ symbol: 'KBE', scope: 'industry', ...dailyRow }] } }), { scope: 'market', include_symbols: true })).guide;
    expect(withSymbols.symbolSelection).toMatch(/capped at 8/);
    expect(withSymbols.symbolSelection).toMatch(/symbolCoverage/);
    const none = (await run(marketStub(), { scope: 'market', include_symbols: true })).guide;
    expect(none.symbolSelection).toMatch(/Pro and above/);
  });
});

describe('regime', () => {
  const run = async (stub: unknown, args: Record<string, unknown>) => JSON.parse((await createHarness(stub).handler(args)).content[0].text);
  test('a breakdown whose read FAILED is not called a Pro feature', async () => {
    const failed = await run({ market: { stress_score: 0.4, label: 'ELEVATED' }, partial: true, unavailable: ['symbols'] }, { scope: 'market', include_symbols: true });
    expect(failed.guide.symbolSelection).toMatch(/could not be read/);
    expect(failed.guide.symbolSelection).not.toMatch(/Pro and above/);
  });
  test('an empty window asked by date says the date overrides days, not a count back', async () => {
    const empty = await run({ symbol: 'SPY', count: 0, scans: [] }, { scope: 'intraday', symbol: 'SPY', date: '2026-09-20' });
    expect(empty.scansMeta.emptyWindow).toMatch(/2026-09-20/);
    expect(empty.scansMeta.emptyWindow).toMatch(/overrides days/);
    expect(empty.scansMeta.emptyWindow).not.toMatch(/counts calendar dates back/);
  });
});

async function callRegimeClient(stub: unknown, args: Record<string, unknown>) {
  const server = new McpServer({ name: 'regime-guidance-test', version: '1' });
  register(server, { get: async () => structuredClone(stub) } as unknown as ProxyClient);
  const client = new Client({ name: 'regime-guidance-reader', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: 'get_regime', arguments: args });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual(result.structuredContent);
    return result.structuredContent as Record<string, any>;
  } finally {
    await client.close();
    await server.close();
  }
}

describe('confidence and empty-window guidance matches the returned rows', () => {
  test('market breakdown confidence explains counts and unrounded scores even when counts were not stored', async () => {
    for (const counts of [
      { models_succeeded: 2, models_attempted: 8 },
      { models_succeeded: 2 },
      { models_attempted: 8 },
      {},
    ]) {
      const stub = {
        market: { date: '2026-10-15', label: 'NORMAL', stress_score: 0.2, confidence: 0.8 },
        symbols: { industry: [{ symbol: 'KBE', scope: 'industry', label: 'ELEVATED', stress_score: 0.8906, confidence: 0.1183, vector: { _meta: counts } }] },
      };
      const out = await callRegimeClient(stub, { scope: 'market', include_symbols: true });
      expect(out.symbols.industry[0].modelCoverage).toEqual('models_succeeded' in counts && 'models_attempted' in counts ? { succeeded: 2, attempted: 8 } : undefined);
      const note = out.guide.confidence;
      expect(note).toMatch(/composite.*symbols scored over symbols in the composite/);
      expect(note).toMatch(/composite rounds its score/);
      expect(note).toMatch(/breakdown.*modelCoverage \{succeeded, attempted\}.*numerator and denominator/);
      expect(note).toMatch(/absent when.*count is missing.*not stored, never full coverage/);
      expect(note).toMatch(/rows.*unrounded score.*four-decimal stressScore can differ in the last digit/);
    }
    const summary = await callRegimeClient({ market: { label: 'NORMAL', stress_score: 0.2 } }, { scope: 'market' });
    expect(summary.guide.confidence).not.toMatch(/breakdown|modelCoverage/);
  });

  test('an empty interval filter does not assert that the whole date has no scans', async () => {
    const out = await callRegimeClient({ symbol: 'SPY', count: 0, scans: [] }, { scope: 'intraday', symbol: 'SPY', date: '2026-10-16', interval: 'morning' });
    expect(out.scansMeta.emptyWindow).toMatch(/matching this request.*2026-10-16/);
    expect(out.scansMeta.emptyWindow).toMatch(/interval morning/);
    expect(out.scansMeta.emptyWindow).not.toMatch(/No scan is stored for date/);
    expect(out.scansMeta.emptyWindow).toMatch(/date overrides days/);
  });
});
