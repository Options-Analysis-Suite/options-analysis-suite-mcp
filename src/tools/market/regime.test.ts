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
  // Ninth run: SPY's 2026-09-18 midday scan read stress_score 0.4229 with
  // label ELEVATED, inside the "NORMAL -0.5 to 0.5" band the description
  // gave under scope=market. The producer's classifyWithHysteresis
  // (proxy/scripts/regime-worker/regime-scorer.ts) enters a state at its
  // entry level and keeps it until the score falls below its exit level
  // (ELEVATED: enter 0.5, exit 0.0), against the previous scan's label, and
  // every scope uses it: daily symbol (regime-scorer.ts:404), intraday
  // (intraday-processor.ts:461), market (run-regime-daily.ts:681). The
  // note that said "Typical bands" rode only the market shape; the intraday
  // and symbol payloads carried no band statement at all.
  // review: every prior lookup filters model_version too, so a
  // label stored under an older version is no prior, and a score of 0
  // after yesterday's ELEVATED under the old version reads NORMAL by the
  // no-prior rule (entry levels only); the clause says both.
  // review: the no-prior rule is not only first scans. A
  // prior fetch that throws is classified without hysteresis (run-regime-
  // daily.ts:678, intraday-processor.ts:456), and a stored label outside
  // STATE_THRESHOLDS falls through prevIdx < 0 to the same loop; score 0
  // after an unreadable ELEVATED prior reads NORMAL. And "scope" there
  // is the classification tier this tool publishes as `symbolTier`,
  // not its own scope selector, so the clause uses the published name.
  // Tenth run: the note ran to 1,100 characters on every response and
  // carried a SPY example on every symbol and on the market composite, and
  // that example chained 09-18's label through 09-17's intraday scans when
  // the rule it sits under says a day's open takes the previous DAILY label
  // (09-17 daily: ELEVATED at 0.506). The payload now carries the rule in
  // short and points at the description, which keeps the full rule and a
  // corrected example; and the market scope's note sits beside `market`
  // like every other scope's, not inside it.
  const hysteresis = /^stressScore is a raw composite regime score, not a 0-100 index\. `label` is a state with hysteresis against the prior label, not a band read off the score \(entry NORMAL -0\.5, ELEVATED 0\.5, STRESS 1\.5, CRISIS 2\.5; exit -1\.0, 0\.0, 1\.0, 2\.0\), so a score inside one band can carry the label above it; the tool description has the full rule\.$/;

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
    expect(parsed.stressScoreNote).toMatch(hysteresis);
    expect(parsed.stressScoreNote).not.toMatch(/Typical bands|2026-09-18/);
    expect(parsed.stressScoreNote.length).toBeLessThan(400);
    // The proxy orders market_date DESC then scan_time ASC (regime.ts
    // /regime/intraday, on the days, date and interval branches alike):
    // the newest scan is the LAST entry of the FIRST date, which the run
    // read as "neither newest-first nor oldest-first".
    // review: scan_time ASC is not interval order; a rerun
    // interval stores a later scan_time and sits after pre-close.
    expect(parsed.scansMeta).toEqual({ order: 'newest date first; within a date, by scan time ascending (a rerun scan sits after the ones before it, whatever its interval), so the newest scan is the last entry of the first date' });
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
    expect(parsed.market.label).toBe('NORMAL');
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
    expect(one.exposuresNote).toBe(NOTE);
    expect(one.vector).toBeUndefined();
    const many = JSON.parse((await createHarness(stub()).handler({ scope: 'symbol', symbol: 'KBE', days: 5 })).content[0].text);
    expect(many.history.map((h: any) => h.modelCoverage)).toEqual([{ succeeded: 2, attempted: 8 }, { succeeded: 2, attempted: 8 }]);
    expect(many.exposuresNote).toBe(NOTE);
    const full = JSON.parse((await createHarness(stub()).handler({ scope: 'symbol', symbol: 'KBE', days: 5, full: true })).content[0].text);
    expect(full.history[1].modelCoverage).toEqual({ succeeded: 2, attempted: 8 });
    expect(full.history[1].vector).toBeUndefined();
    expect(full.exposuresNote).toBe(NOTE);
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
    expect(parsed.exposuresNote).toBe(NOTE);
  });

  test('the include_symbols rows carry modelCoverage and the shape carries the note once, naming no topStrikes', async () => {
    const stub = { market: { stress_score: 0.39, label: 'ELEVATED', vector: { z: {} } }, symbols: { industry: [{ symbol: 'KBE', scope: 'industry', ...daily() }] } };
    const parsed = JSON.parse((await createHarness(stub).handler({ scope: 'market', include_symbols: true })).content[0].text);
    expect(parsed.symbols.industry[0].modelCoverage).toEqual({ succeeded: 2, attempted: 8 });
    // Thirteenth run: the breakdown's rows carry no topStrikes (their
    // exposures are the totals and the levels only), and the note named
    // the field anyway. The breakdown's note names what its rows carry.
    expect(parsed.symbols.industry[0].exposures.topStrikes).toBeUndefined();
    expect(parsed.exposuresNote).toBe('callWall, putWall, gammaFlip and gammaMagnet are over the 0-60 day window, and so is regime except with fewer than two gamma-bearing strikes there, when it is the sign of netGamma; netGamma and the other net totals are over the whole exposure input');
    expect(parsed.exposuresNote).not.toMatch(/topStrikes/);
    // The composite stores no model counts and gets no coverage field.
    expect(parsed.market.modelCoverage).toBeUndefined();
    const alone = JSON.parse((await createHarness({ market: { stress_score: 0.39, label: 'ELEVATED', vector: { z: {} } } }).handler({ scope: 'market' })).content[0].text);
    expect(alone.exposuresNote).toBeUndefined();
  });
});
