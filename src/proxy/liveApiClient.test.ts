/**
 * The proxy's structured error contract, as the model will see it.
 *
 * ProxyClient flattens every 403 into one "your subscription does not include
 * access" message and turns 404 into null. The routes this client reaches
 * answer an envelope - code, retryable, an action URL, the expirations that
 * would have worked, the market input that could not be resolved - and every
 * field has to survive the trip. `retryable` is the whole mechanism that stops
 * a model retrying a live-broker call that cannot succeed and burning the
 * user's own broker quota. There is no end-of-day fallback behind these.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { LiveApiClient, LiveApiError } from './liveApiClient.js';
import { ApiError, AuthError } from '../types.js';
import { toolHandler } from '../tools/helpers.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function client(status: number, body: unknown) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
  return new LiveApiClient('https://proxy.example.com', { getAccessToken: async () => 'DUMMY_TOKEN' });
}
const caught = (p: Promise<unknown>) => p.then(() => null, (e) => e);

describe('LiveApiClient', () => {
  it('returns the body on success', async () => {
    const c = client(200, { symbol: 'SPY', dataSource: 'live' });
    expect(await c.get('/live/options-chain/SPY')).toMatchObject({ dataSource: 'live' });
  });

  it('keeps the tier refusal structured: the code, that retrying is futile, and where to upgrade', async () => {
    // The proxy's requireProTier envelope, verbatim. A model that receives
    // `retryable: false` stops; one that receives the upgrade URL can tell the
    // user exactly where to go. Flattened to a SubscriptionError it would have
    // neither, which is what the former client did.
    const tier = await caught(client(403, {
      error: 'This feature requires a Pro subscription', code: 'PRO_TIER_REQUIRED',
      retryable: false, upgradeUrl: 'https://x/pricing',
    }).get('/live/x')) as LiveApiError;
    expect(tier).toBeInstanceOf(LiveApiError);
    expect(tier.code).toBe('PRO_TIER_REQUIRED');
    expect(tier.retryable).toBe(false);
    expect(tier.actionUrl).toBe('https://x/pricing');
    expect(tier.message).toContain('Pro subscription');
  });

  it('does not call a 403 without a tier envelope a subscription problem', async () => {
    // Other 403s exist on the proxy (an origin refusal answers an empty body).
    // Claiming "upgrade your subscription" for one of those is confident
    // wrong advice; the honest answer is the status and nothing more.
    const err = await caught(client(403, null).get('/live/x')) as LiveApiError;
    expect(err).toBeInstanceOf(LiveApiError);
    expect(err.code).toBeUndefined();
    expect(err.message).not.toMatch(/subscription|upgrade/i);
    expect(err.message).toContain('403');
  });

  it('carries retryable and the action URL through a broker failure', async () => {
    const err = await caught(client(400, {
      error: 'tradier rejected the stored credential',
      code: 'BROKER_CREDENTIAL_INVALID', retryable: false,
      message: 'Reconnect tradier on your account page.',
      reconnectUrl: 'https://x/account?tab=broker',
    }).get('/live/options-chain/SPY')) as LiveApiError;
    expect(err).toBeInstanceOf(LiveApiError);
    expect(err.code).toBe('BROKER_CREDENTIAL_INVALID');
    expect(err.retryable).toBe(false);
    expect(err.actionUrl).toBe('https://x/account?tab=broker');
    expect(err.message).toContain('Reconnect tradier');
  });

  it('marks a transient broker failure retryable', async () => {
    const err = await caught(client(503, {
      error: 'tradier did not answer the chain request',
      code: 'BROKER_UNAVAILABLE', retryable: true,
    }).get('/live/x')) as LiveApiError;
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(503);
  });

  it('surfaces the not-connected case with its connect URL', async () => {
    const err = await caught(client(400, {
      error: 'No stored broker credential for this account',
      code: 'BROKER_NOT_CONNECTED', retryable: false,
      connectUrl: 'https://x/account?tab=broker',
    }).get('/live/x')) as LiveApiError;
    expect(err.code).toBe('BROKER_NOT_CONNECTED');
    expect(err.actionUrl).toBe('https://x/account?tab=broker');
  });

  it('reads a code-less 401 as the bearer being refused, and says to re-authenticate', async () => {
    // A refused bearer carries no code. Tier is a 403 with its own envelope,
    // so this is the same advice ProxyClient gives, from the same function,
    // and it must NOT mention a subscription: the former backend's four-way
    // 401 no longer exists.
    const err = await caught(client(401, {
      error: 'Unauthorized', message: 'Invalid or expired JWT token',
    }).get('/live/x')) as Error;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toContain('re-authenticate');
    expect(err.message).not.toMatch(/tier|subscription/i);
  });

  it('keeps the two MFA 401s structured: a step-up to complete, and an outage to wait out', async () => {
    // Both come from enforceAal2 on a VALID session. "Authentication expired,
    // restart the extension" is wrong for both: restarting changes nothing
    // for the first, and hides an outage for the second.
    const stepUp = await caught(client(401, {
      error: 'Multi-factor authentication required', code: 'mfa_required',
    }).get('/live/x')) as LiveApiError;
    expect(stepUp).toBeInstanceOf(LiveApiError);
    expect(stepUp.code).toBe('mfa_required');
    expect(stepUp.retryable).toBe(false);
    expect(stepUp.message).toMatch(/step-up/i);
    expect(stepUp.message).not.toMatch(/expired/i);

    const outage = await caught(client(401, {
      error: 'Could not verify MFA status', code: 'mfa_check_unavailable',
    }).get('/live/x')) as LiveApiError;
    expect(outage).toBeInstanceOf(LiveApiError);
    expect(outage.code).toBe('mfa_check_unavailable');
    expect(outage.retryable).toBe(true);
    expect(outage.message).toMatch(/temporarily unavailable/i);
    expect(outage.message).not.toMatch(/expired/i);
  });

  it('keeps the expirations that WOULD work', async () => {
    // Without them the model knows only that its guess was wrong, so it guesses
    // again - and each guess is another broker round trip.
    const err = await caught(client(400, {
      error: 'Expiration 2026-09-19 is not listed for SPY',
      code: 'UNKNOWN_EXPIRATION', retryable: false,
      availableExpirations: ['2026-09-18', '2026-09-25'],
      availableExpirationsTruncated: true,
    }).get('/live/x')) as LiveApiError;
    expect(err.details?.availableExpirations).toEqual(['2026-09-18', '2026-09-25']);
    expect(err.details?.availableExpirationsTruncated).toBe(true);
  });

  it('keeps the reason a market input was refused, not just that it was', async () => {
    // A withheld q is often a DELIBERATE refusal - a liquidating issuer whose
    // trailing yield is not a forward rate - and the caller is meant to supply
    // one. Reduced to "Failed to resolve required market parameters. Retrying
    // will not succeed." it is true, unactionable, and indistinguishable from
    // an outage, so the model gives up on a call it could have completed.
    const err = await caught(client(422, {
      error: 'Failed to resolve required market parameters',
      code: 'RESOLUTION_FAILED', retryable: false,
      missingFields: ['q'],
      warnings: ['VYNE: trailing dividend yield is 70.5%; issuer disclosure identifies a special '
        + 'merger-related cash distribution (last special ex-date 2026-07-24, entry overdue for '
        + 're-verification); the trailing observation is not used as forward q; supply q explicitly'],
    }).get('/live/x')) as LiveApiError;
    expect(err.details?.missingFields).toEqual(['q']);
    expect((err.details?.warnings as string[]).join(' ')).toMatch(/overdue for re-verification/);
    expect((err.details?.warnings as string[]).join(' ')).toMatch(/supply q explicitly/);
  });

  it('carries the per-leg recovery fields of a basket refusal', async () => {
    const err = await caught(client(422, {
      error: 'MultiAsset resolution failed',
      code: 'MULTIASSET_RESOLUTION_FAILED', retryable: false,
      missingFields: ['modelParams.dividends[1]'],
      warnings: ['ARI: trailing dividend yield is 66.6%; supply modelParams.dividends[1] explicitly'],
    }).get('/live/x')) as LiveApiError;
    expect(err.details?.missingFields).toEqual(['modelParams.dividends[1]']);
  });

  it('omits an empty warnings array rather than padding the detail budget', async () => {
    const err = await caught(client(422, {
      error: 'Failed to resolve required market parameters',
      code: 'RESOLUTION_FAILED', retryable: false, missingFields: ['q'], warnings: [],
    }).get('/live/x')) as LiveApiError;
    expect(err.details?.missingFields).toEqual(['q']);
    expect(err.details).not.toHaveProperty('warnings');
  });

  it('treats a mid-body DISCONNECT as retryable, not as malformed JSON', async () => {
    // The common real case under Bun: ECONNRESET arrives as a TypeError, not
    // an abort, so matching only the abort names reported "Invalid JSON,
    // HTTP 200" for a connection that died.
    globalThis.fetch = (async () => ({
      ok: true, status: 200,
      json: async () => { throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }); },
    })) as unknown as typeof fetch;
    const c = new LiveApiClient('https://proxy.example.com', { getAccessToken: async () => 'DUMMY' });
    const err = await caught(c.get('/live/x')) as LiveApiError;
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(504);
  });

  it('still reports GENUINELY malformed JSON as malformed', async () => {
    // A SyntaxError is a real server defect and must not be laundered into a
    // retryable transport blip that a model retries forever.
    globalThis.fetch = (async () => ({
      ok: true, status: 200,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    })) as unknown as typeof fetch;
    const c = new LiveApiClient('https://proxy.example.com', { getAccessToken: async () => 'DUMMY' });
    const err = await caught(c.get('/live/x')) as LiveApiError;
    expect(err.message).toContain('Invalid JSON');
    expect(err.retryable).toBeUndefined();
  });

  for (const code of ['ERR_INVALID_JSON', 'ECONNRESET']) {
    it(`does not reclassify a SyntaxError with code ${code} as a transport failure`, async () => {
      globalThis.fetch = (async () => ({
        ok: true, status: 200,
        json: async () => { throw Object.assign(new SyntaxError('Unexpected token < in JSON'), { code }); },
      })) as unknown as typeof fetch;
      const c = new LiveApiClient('https://proxy.example.com', { getAccessToken: async () => 'DUMMY' });
      const err = await caught(c.get('/live/x'));

      expect(err).toBeInstanceOf(ApiError);
      expect(err).not.toBeInstanceOf(LiveApiError);
      expect(err.message).toBe('Invalid JSON response from /live/x');
      expect(err.statusCode).toBe(200);
    });
  }

  it('does not treat an unrelated string error code as a network disconnect', async () => {
    globalThis.fetch = (async () => ({
      ok: true, status: 200,
      json: async () => { throw Object.assign(new Error('Invalid response'), { code: 'ERR_INVALID_STATE' }); },
    })) as unknown as typeof fetch;
    const c = new LiveApiClient('https://proxy.example.com', { getAccessToken: async () => 'DUMMY' });
    const err = await caught(c.get('/live/x'));

    expect(err).not.toBeInstanceOf(LiveApiError);
    expect(err.message).toBe('Invalid JSON response from /live/x');
  });

  for (const failure of [
    Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    new DOMException('The operation was aborted', 'AbortError'),
    new DOMException('The operation timed out', 'TimeoutError'),
  ]) {
    it(`keeps ${failure.name} ${'code' in failure ? failure.code : ''} body failures retryable`, async () => {
      globalThis.fetch = (async () => ({
        ok: true, status: 200,
        json: async () => { throw failure; },
      })) as unknown as typeof fetch;
      const c = new LiveApiClient('https://proxy.example.com', { getAccessToken: async () => 'DUMMY' });
      const err = await caught(c.get('/live/x'));

      expect(err).toBeInstanceOf(LiveApiError);
      expect(err).toMatchObject({ code: 'UPSTREAM_TRUNCATED', retryable: true, statusCode: 504 });
    });
  }

  it('keeps the backend explanation of WHICH input was invalid', async () => {
    const err = await caught(client(422, {
      error: 'Validation failed',
      issues: [{ code: 'custom', path: ['symbol'], message: 'symbol contains unsupported characters' }],
    }).get('/live/x')) as LiveApiError;
    expect(err.details?.issues).toEqual([{ path: ['symbol'], message: 'symbol contains unsupported characters' }]);
  });

  it('exposes only validation issue paths and messages, excluding internal fields', async () => {
    const err = await caught(client(400, {
      error: 'Validation failed',
      issues: [{
        code: 'custom', path: ['legs', 0, 'symbol'], message: 'symbol contains unsupported characters',
        input: 'DUMMY_PRIVATE_INPUT', params: { brokerSecret: 'DUMMY_PRIVATE_SECRET' },
        _debug: 'DUMMY_INTERNAL_METADATA',
      }],
    }).get('/live/x')) as LiveApiError;

    expect(err.details).toEqual({
      issues: [{ path: ['legs', 0, 'symbol'], message: 'symbol contains unsupported characters' }],
    });
  });

  const issuePaths: Array<{ path: unknown; text: string }> = [
    { path: [''], text: '[""]' },
    { path: ['filters', 'a.b', 'say"hi\\bye'], text: String.raw`filters["a.b"]["say\"hi\\bye"]` },
    { path: ['legs', -1, 'strike'], text: 'legs[-1].strike' },
    { path: ['legs', 9007199254740991], text: 'legs[9007199254740991]' },
    { path: ['legs', 9007199254740992], text: 'path ["legs",9007199254740992]' },
    { path: ['legs', 0.5, 'strike'], text: 'path ["legs",0.5,"strike"]' },
    { path: ['legs', true, 'strike'], text: 'path ["legs",true,"strike"]' },
    { path: ['legs', null, 'strike'], text: 'path ["legs",null,"strike"]' },
    { path: ['legs', [0], 'strike'], text: 'path ["legs",[0],"strike"]' },
    { path: ['legs', { toString: 'not callable' }], text: 'path ["legs",{"toString":"not callable"}]' },
    { path: 'legs.0.strike', text: 'path "legs.0.strike"' },
    { path: { field: 'strike' }, text: 'path {"field":"strike"}' },
    { path: false, text: 'path false' },
    { path: null, text: 'path null' },
    { path: 0, text: 'path 0' },
    { path: [], text: '' },
  ];
  for (const { path, text } of issuePaths) {
    it(`preserves the received HTTP issue path ${JSON.stringify(path)} through the tool result`, async () => {
      const c = client(422, {
        error: 'Validation failed',
        issues: [{ path, message: 'invalid field', input: 'DUMMY_PRIVATE_INPUT' }],
      });
      const result = await toolHandler(async () => c.get('/live/x'))({});
      const wire = JSON.parse(JSON.stringify(result));

      expect(wire.isError).toBe(true);
      expect(wire.structuredContent.issues).toEqual([{ path, message: 'invalid field' }]);
      expect(wire.content[0].text).toContain(text ? `${text}: invalid field` : 'issues: invalid field.');
      expect(JSON.stringify(wire)).not.toContain('DUMMY_PRIVATE_INPUT');
    });
  }

  it('floors a fractional length instead of reading past the end', async () => {
    // length 1.5 with a real issue at index 1: Array iteration would never
    // reach it, so neither should this. Separated from the throwing-element
    // case, because a try/catch there would hide a missing floor entirely.
    const hostile = new Proxy([] as unknown[], {
      get(target, prop, receiver) {
        if (prop === 'length') return 1.5;
        if (prop === '0') return { path: ['a'], message: 'first' };
        if (prop === '1') return { path: ['b'], message: 'second' };
        return Reflect.get(target, prop, receiver);
      },
    });
    const err = new LiveApiError('Validation failed', 422, 'VALIDATION', false, undefined, { issues: hostile });
    expect((err.details as any).issues).toEqual([{ path: ['a'], message: 'first' }]);
  });

  it('keeps the issues around one that throws on read', async () => {
    // An integer length, so the floor is not what saves this: the read itself
    // throws, in a CONSTRUCTOR, and must not take the error down with it.
    const hostile = new Proxy([] as unknown[], {
      get(target, prop, receiver) {
        if (prop === 'length') return 3;
        if (prop === '0') return { path: ['a'], message: 'first' };
        if (prop === '1') throw new Error('hostile getter');
        if (prop === '2') return { path: ['c'], message: 'third' };
        return Reflect.get(target, prop, receiver);
      },
    });
    const err = new LiveApiError('Validation failed', 422, 'VALIDATION', false, undefined, { issues: hostile });
    expect(err.retryable).toBe(false);
    expect((err.details as any).issues).toEqual([
      { path: ['a'], message: 'first' },
      { path: ['c'], message: 'third' },
    ]);
  });

  it('survives a lying length and a throwing element without losing the error', async () => {
    // Reading `length` off a value we did not author: a fractional length made
    // the loop reach an index Array semantics would never visit, and a getter
    // that throws there escaped the CONSTRUCTOR, replacing a structured 422
    // with the getter's own error and taking `code` and `retryable` with it.
    const hostile = new Proxy([] as unknown[], {
      get(target, prop, receiver) {
        if (prop === 'length') return 1.5;
        if (prop === '0') return { path: ['symbol'], message: 'invalid field' };
        if (prop === '1') throw new Error('hostile getter');
        return Reflect.get(target, prop, receiver);
      },
    });

    const err = new LiveApiError('Validation failed', 422, 'VALIDATION', false, undefined, { issues: hostile });
    expect(err.code).toBe('VALIDATION');
    expect(err.retryable).toBe(false);
    expect((err.details as any).issues).toEqual([{ path: ['symbol'], message: 'invalid field' }]);

    const result = await toolHandler(async () => { throw err; })({});
    expect((result.structuredContent as any)?.code).toBe('VALIDATION');
    expect((result.structuredContent as any)?.retryable).toBe(false);
  });

  it('does not add a path to an HTTP issue that omitted it', async () => {
    const c = client(422, { error: 'Validation failed', issues: [{ message: 'invalid body' }] });
    const result = await toolHandler(async () => c.get('/live/x'))({});
    expect(result.structuredContent?.issues).toEqual([{ message: 'invalid body' }]);
    expect(result.content[0].text).toContain('issues: invalid body.');
  });

  it('treats a body cut off in transit as retryable, not as a malformed response', async () => {
    globalThis.fetch = (async () => ({
      ok: true, status: 200,
      json: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); },
    })) as unknown as typeof fetch;
    const c = new LiveApiClient('https://proxy.example.com', { getAccessToken: async () => 'DUMMY' });
    const err = await caught(c.get('/live/x')) as LiveApiError;
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(504);
  });

  it('reports the live limiter\'s retryAfterSeconds on a 429 and marks it retryable', async () => {
    // The proxy's live-broker limiter names the field retryAfterSeconds. The
    // former backend said retryAfter, and a client still reading that name
    // would tell the model only "wait a moment" for a budget it could have
    // timed exactly.
    const err = await caught(client(429, {
      error: 'Live broker request budget exhausted', code: 'RATE_LIMITED',
      retryable: true, retryAfterSeconds: 42, limit: 10, cost: 5,
    }).get('/live/x')) as LiveApiError;
    expect(err.retryable).toBe(true);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.message).toContain('42 seconds');
    expect(err.details?.retryAfterSeconds).toBe(42);
  });

  it('posts a JSON body and reads the same envelope on the way back', async () => {
    // The compute route takes a body. Same bearer, same Accept, same refusal
    // handling as a GET; only the method and the body differ.
    let seen: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ price: 6.55, greekConvention: 'dapi' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const c = new LiveApiClient('https://proxy.example.com', { getAccessToken: async () => 'DUMMY' });
    const body = await c.post('/compute/black-scholes', { optionType: 'call', S: 100, K: 100, sigma: 0.25, t: 0.5, r: 0.04, q: 0.01 });
    expect(body).toMatchObject({ price: 6.55 });
    expect(seen!.url).toBe('https://proxy.example.com/compute/black-scholes');
    expect(seen!.init.method).toBe('POST');
    expect((seen!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer DUMMY');
    expect(JSON.parse(String(seen!.init.body))).toEqual({ optionType: 'call', S: 100, K: 100, sigma: 0.25, t: 0.5, r: 0.04, q: 0.01 });

    // And a refusal keeps its structure: the route's INVALID_REQUEST carries
    // the offending field in `issues`.
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: 'Supply exactly one of t (years) or daysToExpiry', code: 'INVALID_REQUEST', retryable: false,
      issues: [{ path: ['t'], message: 'Supply exactly one of t (years) or daysToExpiry' }],
    }), { status: 400, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const err = await caught(c.post('/compute/black-scholes', { optionType: 'call', S: 100, K: 100, sigma: 0.25 })) as LiveApiError;
    expect(err).toBeInstanceOf(LiveApiError);
    expect(err.code).toBe('INVALID_REQUEST');
    expect(err.retryable).toBe(false);
    expect(err.details?.issues).toEqual([{ path: ['t'], message: 'Supply exactly one of t (years) or daysToExpiry' }]);
  });

  it('still marks a 429 without a budget field retryable', async () => {
    // The proxy's general and backtest limiters answer a bare message.
    const err = await caught(client(429, {
      error: 'Too many requests from this IP, please try again later',
    }).get('/scanner/x')) as LiveApiError;
    expect(err.retryable).toBe(true);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.details).toBeUndefined();
  });

  it('treats a transport failure as retryable rather than as a bad request', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const c = new LiveApiClient('https://proxy.example.com', { getAccessToken: async () => 'DUMMY' });
    const err = await caught(c.get('/live/x')) as LiveApiError;
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(503);
  });

  it('never puts the bearer token in an error message', async () => {
    const err = await caught(client(500, { error: 'boom' }).get('/live/x')) as Error;
    expect(err.message).not.toContain('DUMMY_TOKEN');
  });

  it('survives an error body that is not JSON', async () => {
    globalThis.fetch = (async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch;
    const c = new LiveApiClient('https://proxy.example.com', { getAccessToken: async () => 'DUMMY' });
    const err = await caught(c.get('/live/x')) as LiveApiError;
    expect(err.statusCode).toBe(502);
    expect(err.retryable).toBeUndefined();
  });
});
