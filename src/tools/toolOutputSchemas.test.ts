import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { registerPlatformInfo } from './platformInfo.js';
import { registerAllTools } from './registry.js';
import { LiveApiClient, LiveApiError } from '../proxy/liveApiClient.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function captureRegisteredTools() {
  const tools: Array<{ name: string; config: Record<string, unknown>; handler: Function }> = [];
  const server = {
    registerTool(name: string, config: Record<string, unknown>, handler: Function) {
      tools.push({ name, config, handler });
    },
  };
  return { tools, server };
}

const stubClient = () => ({ get: async () => ({}), post: async () => ({}) } as any);
const stubTokens = () => ({ getAccessToken: async () => 'token' } as any);

describe('MCP tool output schemas', () => {
  test('all registered tools advertise an outputSchema', () => {
    const { tools, server } = captureRegisteredTools();

    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());

    expect(tools).toHaveLength(38);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...new Set(tools.map((tool) => tool.name))].sort());
    for (const tool of tools) {
      expect(tool.config.outputSchema, `${tool.name} outputSchema`).toBeTruthy();
    }
  });

  test('the six proxy-backed live, EOD and compute tools are always registered', () => {
    // Formerly gated on OAS_DATA_API_URL being set, and dark in production.
    // There is no switch now: the proxy gates the live tools by tier at call
    // time with an envelope the model can act on, so hiding them here would
    // only stop a free user discovering what Pro buys.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    for (const name of ['get_live_options_chain', 'get_options_snapshot', 'get_regime_fits', 'get_live_dealer_positioning', 'get_dealer_positioning', 'compute_black_scholes']) {
      expect(tools.map((t) => t.name), name).toContain(name);
    }
    // Four say Pro; the two anonymous-on-the-proxy reads must not.
    const titled = (name: string) => String(tools.find((t) => t.name === name)!.config.title);
    expect(titled('get_live_options_chain')).toContain('(Pro)');
    expect(titled('get_live_dealer_positioning')).toContain('(Pro)');
    expect(titled('get_regime_fits')).toContain('(Pro)');
    expect(titled('compute_black_scholes')).toContain('(Pro)');
    expect(titled('get_options_snapshot')).not.toContain('Pro');
    expect(titled('get_options_snapshot')).not.toContain('API tier');
    expect(titled('get_dealer_positioning')).not.toContain('Pro');
  });

  test('the EOD chain points at the live tool, conditioned on the question', () => {
    // Without the pointer a Pro user asking for prices "right now" is quietly
    // served the last completed session.
    const withApi = captureRegisteredTools();
    registerAllTools(withApi.server as any, stubClient(), stubTokens(), stubClient());
    const eod = withApi.tools.find((t) => t.name === 'get_options_chain')!;
    expect(eod.config.description).toContain('get_live_options_chain');
    expect(eod.config.description).toContain('Pro subscription');
    expect(eod.config.description).not.toContain('API tier');
    // Conditioned on the QUESTION, not the tier. Both halves must be present:
    // the explicit ask for current prices, AND the implicit one - a request for
    // a specific contract's quote is a question about now even without the
    // word. Routing on the literal phrase alone leaves the common case stale.
    const text = String(eod.config.description);
    expect(text, 'explicit freshness').toMatch(/live, current or intraday/);
    expect(text, 'implicit freshness: a quote request').toMatch(/quote, bid, ask or mark/);
    // And it must not read as "always prefer the API tool": the live call
    // spends the user's own broker quota, so past sessions stay here.
    expect(text, 'when to stay').toMatch(/Stay here for/);
  });

  test('the six proxy-backed tools request the proxy paths that exist', async () => {
    // The paths are the retarget. Every other test here stubs the client and
    // ignores what was asked for, so a tool still requesting /v1/data/... would
    // pass all of them and 404 in production. Recorded, and pinned to the
    // routes proxy/routes/live-broker.ts, regime.ts and scanner.ts mount.
    const requests: Array<{ path: string; params?: Record<string, string>; body?: unknown }> = [];
    const recording = {
      get: async (path: string, params?: Record<string, string>) => { requests.push({ path, params }); return {}; },
      post: async (path: string, body: unknown) => { requests.push({ path, body }); return {}; },
    } as any;
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), recording);
    const call = (name: string, args: Record<string, unknown>) =>
      tools.find((t) => t.name === name)!.handler(args);

    await call('get_live_options_chain', { symbol: 'spy', expiration: '2026-10-16', provider: 'tradier' });
    await call('get_live_dealer_positioning', { symbol: 'spy' });
    await call('get_regime_fits', { symbol: 'spy', days: 5 });
    await call('get_options_snapshot', { symbols: 'spy' });
    await call('get_options_snapshot', { symbols: 'spy, qqq' });
    await call('get_dealer_positioning', { symbol: 'spy', date: '2026-09-15' });
    await call('get_dealer_positioning', { symbol: 'spy' });
    await call('compute_black_scholes', { optionType: 'put', S: 100, K: 95, sigma: 0.3, daysToExpiry: 30, symbol: 'spy' });

    expect(requests).toEqual([
      { path: '/live/options-chain/SPY', params: { expiration: '2026-10-16', provider: 'tradier' } },
      { path: '/live/exposure/SPY', params: {} },
      { path: '/regime/fits/SPY/history', params: { days: '5' } },
      { path: '/scanner/snapshot/SPY', params: undefined },
      { path: '/scanner/metrics/batch', params: { symbols: 'SPY,QQQ' } },
      { path: '/eod/exposure/SPY', params: { date: '2026-09-15' } },
      { path: '/eod/exposure/SPY', params: {} },
      // Only what was given: no `undefined` keys, so the route's exactly-one
      // rule for t / daysToExpiry sees what the caller sent.
      { path: '/compute/black-scholes', body: { optionType: 'put', S: 100, K: 95, sigma: 0.3, daysToExpiry: 30, symbol: 'spy' } },
    ]);
  });

  test('the live chain tool declares that it reaches an external system', () => {
    // openWorldHint is false on every tool that reads our own stored data.
    // This one calls the user's broker, and a client deciding whether to
    // confirm a call needs to know the difference.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const live = tools.find((t) => t.name === 'get_live_options_chain');
    expect((live!.config.annotations as Record<string, unknown>).openWorldHint).toBe(true);
    expect((live!.config.annotations as Record<string, unknown>).readOnlyHint).toBe(true);
    // No `full`: it would be an unbounded live broker call.
    expect(Object.keys(live!.config.inputSchema as object)).not.toContain('full');
  });

  test('a structured proxy error reaches the model with its recovery fields', async () => {
    // THE WHOLE MECHANISM. toolHandler's ApiError branch emitted only the
    // message, so `retryable` never arrived - and a model facing a dead broker
    // credential retried, spending the user's own broker quota on a call that
    // could never succeed. Driven through the REGISTERED tool, because a
    // client-only test cannot see what the handler drops.
    const { tools, server } = captureRegisteredTools();
    const failing = {
      get: async () => {
        throw new LiveApiError(
          'tradier rejected the stored credential', 400, 'BROKER_CREDENTIAL_INVALID',
          false, 'https://x/account?tab=broker', undefined,
        );
      },
    } as any;
    registerAllTools(server as any, stubClient(), stubTokens(), failing);
    const live = tools.find((t) => t.name === 'get_live_options_chain')!;

    const result: any = await live.handler({ symbol: 'SPY' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'BROKER_CREDENTIAL_INVALID',
      retryable: false,
      actionUrl: 'https://x/account?tab=broker',
    });
    // Repeated in the text, because not every client reads structuredContent.
    expect(result.content[0].text).toContain('Retrying will not succeed');
    expect(result.content[0].text).toContain('https://x/account?tab=broker');
  });

  test('an unlisted expiration reaches the model with the dates that would work', async () => {
    const { tools, server } = captureRegisteredTools();
    const failing = {
      get: async () => {
        throw new LiveApiError(
          'Expiration 2026-09-19 is not listed for SPY', 400, 'UNKNOWN_EXPIRATION',
          false, undefined, { availableExpirations: ['2026-09-18', '2026-09-25'] },
        );
      },
    } as any;
    registerAllTools(server as any, stubClient(), stubTokens(), failing);
    const live = tools.find((t) => t.name === 'get_live_options_chain')!;
    const result: any = await live.handler({ symbol: 'SPY', expiration: '2026-09-19' });
    expect(result.structuredContent.availableExpirations).toEqual(['2026-09-18', '2026-09-25']);
    // And in the TEXT, for clients that render nothing else.
    expect(result.content[0].text).toContain('2026-09-18, 2026-09-25');
  });

  for (const status of [400, 422]) {
    test(`a ${status} Zod validation response reaches the registered tool without code or retryable`, async () => {
      // A body carrying Zod's issue objects, without code or retryable at the
      // top level. The proxy's own zod hook answers only the first message,
      // so this is the shape a body MAY carry, not the usual one; the client
      // must still pass it through. Exercise both HTTP parsing and the tool.
      const validation = z.object({
        symbol: z.string().refine((value) => /^[A-Z0-9./-]+$/.test(value), 'symbol contains unsupported characters'),
      }).safeParse({ symbol: 'BAD%' });
      if (validation.success) throw new Error('Expected invalid symbol fixture');
      globalThis.fetch = (async () => new Response(JSON.stringify({
        error: 'Validation failed', issues: validation.error.issues,
      }), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
      const dataClient = new LiveApiClient('https://proxy.example.com', stubTokens());
      const { tools, server } = captureRegisteredTools();
      registerAllTools(server as any, stubClient(), stubTokens(), dataClient);

      const result = await tools.find((tool) => tool.name === 'get_live_options_chain')!
        .handler({ symbol: 'BAD%' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        dataAvailable: false,
        error: 'Validation failed',
        issues: [{ path: ['symbol'], message: 'symbol contains unsupported characters' }],
      });
      expect(result.structuredContent.code).toBeUndefined();
      expect(result.structuredContent.retryable).toBeUndefined();
      expect(result.content[0].text).toContain('symbol: symbol contains unsupported characters');
      expect(result.content[0].text).not.toContain('[object Object]');
    });
  }

  test('platform info describes the four proxy-backed tools and names their overlaps', async () => {
    const on = captureRegisteredTools();
    registerAllTools(on.server as any, stubClient(), stubTokens(), stubClient());
    const onInfo: any = await on.tools.find((t) => t.name === 'get_platform_info')!
      .handler({ topic: 'capabilities' });
    for (const name of ['get_live_options_chain', 'get_options_snapshot', 'get_regime_fits', 'get_live_dealer_positioning', 'get_dealer_positioning', 'compute_black_scholes']) {
      expect(onInfo.structuredContent.text, name).toContain(name);
    }
    // The tier is named per tool, and it is Pro, not the API tier.
    expect(onInfo.structuredContent.text).toContain('(Pro and above)');
    expect(onInfo.structuredContent.text).not.toContain('API tier');
    expect(onInfo.structuredContent.text).not.toContain('/v1 data API');
    // No MCP session is on the free tier: TokenManager.initialize refuses to
    // start without entitlement and the OAuth handoff gates the same way.
    // "Every tier" described the proxy route, not who can call the tool from
    // here. But entitlement is NOT only a subscription: developer and comped
    // (bypassSubscription) accounts initialize with `subscription: null` and
    // pass the proxy's Pro gate, so the text names the check, not one way of
    // passing it, and marks the EOD tools by the requirement they lack.
    expect(onInfo.structuredContent.text).not.toContain('every tier');
    expect(onInfo.structuredContent.text).toContain('entitlement check');
    expect(onInfo.structuredContent.text).toContain('comped');
    expect(onInfo.structuredContent.text).not.toMatch(/every MCP session (?:already )?holds an active subscription/);
    expect(onInfo.structuredContent.text).toContain('(no Pro requirement)');
    // The overlaps are named, so a model is not left guessing which of two
    // similarly-named tools answers the question it was actually asked.
    expect(onInfo.structuredContent.text).toContain('Distinct from get_snapshot');
    expect(onInfo.structuredContent.text).toContain('Distinct from get_regime,');
    // And in the combined view a model is most likely to request.
    const onAll: any = await on.tools.find((t) => t.name === 'get_platform_info')!
      .handler({ topic: 'all' });
    expect(onAll.structuredContent.text).toContain('get_live_options_chain');
  });

  test('the analytics history names the expected move by its unit on every response path', async () => {
    // The summarizer only runs past 90 rows. A one-row answer and a `full`
    // answer both went out with expected_move_pct: 0.018 and no units.
    const canned = { symbol: 'SPY', data: [{ date: '2026-09-15', spot_price: 650.12, expected_move_pct: 0.018 }] };
    const client = { get: async (path: string) => (path === '/history' ? structuredClone(canned) : {}), post: async () => ({}) } as any;
    const on = captureRegisteredTools();
    registerAllTools(on.server as any, client, stubTokens(), stubClient());
    const history = on.tools.find((t) => t.name === 'get_options_analytics_history')!;
    for (const args of [{ symbol: 'SPY', days: 30 }, { symbol: 'SPY', days: 30, full: true }, { symbol: 'SPY', from: '2026-09-15', to: '2026-09-15' }]) {
      const text = JSON.stringify(await history.handler(args));
      expect(text, JSON.stringify(args)).toContain('"expected_move_30d_fraction":0.018');
      expect(text, JSON.stringify(args)).not.toContain('expected_move_pct');
      expect(text, JSON.stringify(args)).toContain('decimal fraction of spot');
    }
  });

  test('platform info names only tools that are registered', async () => {
    // Three names in the Conventions text were invented (get_analyses,
    // query_analyses, get_analysis_stats); the tools are get_analysis_history,
    // query_analysis and get_analysis_rollups. A model that follows a pointer
    // to a tool that does not exist gets a protocol error, so every tool-like
    // token in every topic has to resolve to a registered tool.
    const on = captureRegisteredTools();
    registerAllTools(on.server as any, stubClient(), stubTokens(), stubClient());
    const registered = new Set(on.tools.map((t) => t.name));
    const info: any = await on.tools.find((t) => t.name === 'get_platform_info')!.handler({ topic: 'all' });
    // The token is everything word-like, hyphenated or dotted after the
    // prefix, in any case, compared to the registry as written: a digit
    // suffix (get_analysis_history2), a letter suffix
    // (get_analysis_historyX), a hyphenated tail (get_analysis_history-extra),
    // a dotted tail (get_analysis_history.extra, which the MCP SDK's name
    // validator accepts), an upper-cased name (GET_ANALYSIS_HISTORY) and a
    // name broken after its prefix (a bare "get_") all resolve to no tool.
    // In prose only a sentence-ending dot is stripped, so "use get_regime."
    // names the tool and "get_analysis_history.extra" does not. Inside a
    // code span the token is literal and nothing is stripped, so a backticked
    // "get_analysis_history." or "get_analysis_history..." is a name that
    // does not exist, not the registered name plus punctuation.
    // A code span naming a tool is read literally (nothing inside it is
    // stripped, so a backticked "get_analysis_history." does not exist). A
    // span glued to prose on either side (`get_analysis_history`2,
    // `get_analysis_history`-extra, x`get_regime`) renders as one name, so
    // the glued whole is the token and must be registered as such; the
    // gluing is checked on the SPAN'S content, since a glued prefix breaks
    // the tool-like shape of the whole. A run of dots after the closing
    // backtick is sentence punctuation ("Use `get_analysis_history`."), not
    // glue.
    const text = String(info.structuredContent.text);
    const pattern = /\b(?:get|query|compute|run)_[\w.-]*/gi;
    // Tool-likeness is judged on the span's content AND on the glued whole:
    // x`get_regime` is tool-like inside and glued outside, get_`nonexistent`
    // is tool-like only as a whole (its prefix is outside the span). Either
    // way the glued whole is the token.
    const spanTokens: string[] = [];
    for (const match of text.matchAll(/([\w.-]*)`([^`]+)`([\w.-]*)/g)) {
      const [, before, inner, after] = match;
      const glue = after.replace(/^\.+$/, '');
      const whole = `${before}${inner}${glue}`;
      const innerTokens = inner.match(pattern) ?? [];
      const wholeTokens = whole.match(pattern) ?? [];
      if (innerTokens.length === 0 && wholeTokens.length === 0) continue;
      if (before || glue) spanTokens.push(whole);
      else spanTokens.push(...innerTokens);
    }
    const prose = text.replace(/[\w.-]*`[^`]+`[\w.-]*/g, ' ');
    const mentioned = Array.from(new Set([
      ...spanTokens,
      ...(prose.match(pattern) ?? []).map((token) => token.replace(/\.+$/, '')),
    ]));
    expect(mentioned.length).toBeGreaterThan(5);
    expect(mentioned.filter((name) => !registered.has(name))).toEqual([]);
  });

  test('platform info names the Greek convention compute_black_scholes publishes, beside the web app\'s', async () => {
    // The Greeks topic defined vanna, vomma, zomma and ultima per 1% IV move,
    // which is the web app's scaling. compute_black_scholes publishes the
    // commercial API's, per UNIT of volatility, and tags it. A model reading
    // both was handed two readings of one number with nothing saying which
    // applied where.
    const on = captureRegisteredTools();
    registerAllTools(on.server as any, stubClient(), stubTokens(), stubClient());
    const greeks: any = await on.tools.find((t) => t.name === 'get_platform_info')!
      .handler({ topic: 'greeks' });
    const text: string = greeks.structuredContent.text;
    expect(text).toContain('greekConvention: "dapi"');
    expect(text).toContain('compute_black_scholes');
    expect(text).toContain('per unit of volatility');
    // The web app's vega rule has one exception applyGreekScaling makes on
    // purpose: the Digital model's vega is left per unit of volatility. A
    // synced Digital record read as "per point" is a 100x misreading.
    expect(text).toContain('Digital');
    // Not every synced record went through applyGreekScaling: the FFT scanner
    // syncs computeFFTGreek's raw output (vega per unit, theta per year in the
    // mathematical direction), so the text must say so by tool name.
    expect(text).toContain('get_fft_results');
    expect(text).toContain('computeFFTGreek');
    // Rollups are not under the display scaling's Digital exception: the
    // producer normalizes Digital's vega to per point before averaging, so
    // listing get_analysis_rollups there invited the 100x conversion the
    // tool's own units line forbids.
    const lines = text.split('\n');
    const displayBullet = lines.find((line) => line.startsWith("- The web app's display scaling"));
    expect(displayBullet).toBeDefined();
    expect(displayBullet).not.toContain('get_analysis_rollups');
    const rollupsLine = lines.find((line) => line.includes('get_analysis_rollups'));
    expect(rollupsLine).toBeDefined();
    expect(rollupsLine).toContain('per percentage point');
    expect(rollupsLine).toContain('Digital');
    // The two conventions differ on dcharmDvol by 100 and on veta's sign;
    // "per day" on both sides hid the first and the second went unsaid.
    expect(text).toContain('dcharmDvol by 100');
    expect(text).toContain('veta differs in sign');
    // Market-convention theta is a direction, not a guaranteed sign (a deep
    // ITM long put carries positive daily theta), and the scalings are
    // defaults the caller can override.
    expect(text).not.toContain('negative for long options)');
    expect(text).toContain('override');
    for (const prefix of ['- Vanna:', '- Vomma (Volga):', '- Ultima:', '- Zomma:']) {
      const definition = text.split('\n').find((line) => line.startsWith(prefix));
      expect(definition, prefix).toBeDefined();
      expect(definition, prefix).not.toContain('per 1% IV');
    }
  });

  test('get_platform_info returns structuredContent and advertises an outputSchema', async () => {
    const { tools, server } = captureRegisteredTools();
    registerPlatformInfo(server as any);

    expect(tools).toHaveLength(1);
    expect(tools[0].config.outputSchema).toBeTruthy();

    const result = await tools[0].handler({ topic: 'models' });
    expect(result.structuredContent).toMatchObject({
      topic: 'models',
      text: expect.stringContaining('Black-Scholes'),
    });
    expect(result.content[0].text).toContain('Black-Scholes');
  });
});
