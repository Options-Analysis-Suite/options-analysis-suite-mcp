/**
 * Provider sign-in (Google/Apple/GitHub/Microsoft) + refresh_token grant tests.
 *
 * The provider flow round-trips through the auth server's BFF; here we drive
 * the mcp-server side: provider-start parks the client's PKCE params, the
 * sealed handoff blob comes back via provider-callback, and the token exchange
 * issues access + refresh tokens. Blob sealing is replicated locally with the
 * same AES-256-GCM layout the auth server uses (sha256(secret) key, iv|ct|tag).
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  handleAuthorizeGet,
  handleAuthorizePost,
  handleAuthServerMetadata,
  handleProviderStart,
  handleProviderCallbackGet,
  handleProviderCallbackPost,
  handleConsentPost,
  handleTokenExchange,
  MAX_OUTSTANDING_AUTHORIZATIONS,
} from './oauth.js';

const originalFetch = globalThis.fetch;
const ORIGINAL_TOKEN_SECRET = process.env.OAS_TOKEN_SECRET;
const ORIGINAL_HANDOFF_SECRET = process.env.OAS_MCP_HANDOFF_SECRET;

const TOKEN_SECRET = 'test-token-secret';
// Real gate requires >= 32 chars; keep the test secret above it.
const HANDOFF_SECRET = 'test-handoff-secret-0123456789abcdef';
const REDIRECT_URI = 'https://chatgpt.com/connector/oauth/cb_abc123';
const CODE_VERIFIER = 'v'.repeat(43);
const CODE_CHALLENGE = createHash('sha256').update(CODE_VERIFIER).digest('base64url');

beforeEach(() => {
  process.env.OAS_TOKEN_SECRET = TOKEN_SECRET;
  process.env.OAS_MCP_HANDOFF_SECRET = HANDOFF_SECRET;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (ORIGINAL_TOKEN_SECRET === undefined) delete process.env.OAS_TOKEN_SECRET;
  else process.env.OAS_TOKEN_SECRET = ORIGINAL_TOKEN_SECRET;
  if (ORIGINAL_HANDOFF_SECRET === undefined) delete process.env.OAS_MCP_HANDOFF_SECRET;
  else process.env.OAS_MCP_HANDOFF_SECRET = ORIGINAL_HANDOFF_SECRET;
});

function aesGcmSeal(payload: string, secret: string): string {
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url');
}

function aesGcmOpen(data: string, secret: string): string {
  const key = createHash('sha256').update(secret).digest();
  const buf = Buffer.from(data, 'base64url');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const encrypted = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

function sealHandoff(overrides: Partial<{ a: string; r: string; s: string; e: number }> & { s: string }): string {
  const payload = {
    a: makeJwt(3600),
    r: 'gotrue-refresh-1',
    e: Date.now() + 60_000,
    ...overrides,
  };
  return aesGcmSeal(JSON.stringify(payload), HANDOFF_SECRET);
}

/** Unsigned JWT with an exp claim (signature is never verified by this server). */
function makeJwt(expiresInSeconds: number): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds })}.sig`;
}

function providerStartQuery(overrides: Record<string, string> = {}): URLSearchParams {
  const q = new URLSearchParams({
    provider: 'google',
    client_id: 'test-client',
    redirect_uri: REDIRECT_URI,
    state: 'state-123',
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    scope: 'mcp',
  });
  for (const [k, v] of Object.entries(overrides)) q.set(k, v);
  return q;
}

/** Turn a Set-Cookie response header into the Cookie header a browser would send back. */
function cookieHeaderFrom(setCookie: string | undefined): string {
  return (setCookie ?? '').split(';')[0] ?? '';
}

/**
 * Run provider-start and return both halves of the flow: the public mcp_state
 * and the browser-binding cookie the response set. Every callback call has to
 * present the cookie, exactly as the browser that started the flow would.
 */
function startProviderFlow(query = providerStartQuery(), browserCookie?: string): { mcpState: string; cookie: string } {
  const result = handleProviderStart(query, browserCookie);
  expect(result.status).toBe(302);
  const location = new URL(result.headers.Location);
  expect(location.pathname).toBe('/api/v1/oauth/start');
  expect(location.searchParams.get('provider')).toBe(query.get('provider'));
  expect(location.searchParams.get('flow')).toBe('mcp');
  const mcpState = location.searchParams.get('mcp_state');
  expect(mcpState).toMatch(/^[a-f0-9]{32}$/);
  return { mcpState: mcpState as string, cookie: cookieHeaderFrom(result.headers['Set-Cookie']) };
}

/** Mock the profile endpoint (hasActiveSubscription) with an active sub. */
function mockActiveSubscription() {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    expect(href).toEndWith('/api/v1/user/profile');
    return new Response(JSON.stringify({
      user: { isDeveloper: false, bypassSubscription: false },
      subscription: { status: 'active' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

describe('authorize page provider buttons', () => {
  const authorizeQuery = () => new URLSearchParams({
    client_id: 'test-client',
    redirect_uri: REDIRECT_URI,
    state: 'xyz',
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
  });

  test('renders all four provider buttons when the handoff secret is set', () => {
    const result = handleAuthorizeGet(authorizeQuery());
    expect(result.status).toBe(200);
    for (const label of ['Google', 'Apple', 'GitHub', 'Microsoft']) {
      expect(result.body).toContain(`Continue with ${label}`);
    }
    expect(result.body).toContain('/oauth/provider-start?provider=google');
  });

  test('renders no provider buttons when the handoff secret is missing', () => {
    delete process.env.OAS_MCP_HANDOFF_SECRET;
    const result = handleAuthorizeGet(authorizeQuery());
    expect(result.status).toBe(200);
    expect(result.body).not.toContain('Continue with');
    expect(result.body).not.toContain('/oauth/provider-start');
  });

  test('treats a short handoff secret as unconfigured (fail-dark)', () => {
    process.env.OAS_MCP_HANDOFF_SECRET = 'too-short';
    const result = handleAuthorizeGet(authorizeQuery());
    expect(result.status).toBe(200);
    expect(result.body).not.toContain('Continue with');
  });
});

describe('provider-start', () => {
  test('parks the flow and redirects to the auth server BFF', () => {
    startProviderFlow();
  });

  test('404s when provider sign-in is not configured', () => {
    delete process.env.OAS_MCP_HANDOFF_SECRET;
    const result = handleProviderStart(providerStartQuery());
    expect(result.status).toBe(404);
  });

  test('rejects unknown providers and disallowed redirect URIs', () => {
    expect(handleProviderStart(providerStartQuery({ provider: 'facebook' })).status).toBe(400);
    expect(handleProviderStart(providerStartQuery({ redirect_uri: 'https://evil.com/cb' })).status).toBe(400);
    expect(handleProviderStart(providerStartQuery({ code_challenge: '' })).status).toBe(400);
    expect(handleProviderStart(providerStartQuery({ code_challenge_method: 'plain' })).status).toBe(400);
  });
});

describe('provider-callback', () => {
  test('GET error bounce re-renders the login page with a friendly message', () => {
    const { mcpState, cookie } = startProviderFlow();
    const result = handleProviderCallbackGet(new URLSearchParams({ mcp_state: mcpState, error: 'provider' }), cookie);
    expect(result.status).toBe(200);
    expect(result.body).toContain('The provider could not sign you in');
    // The client's PKCE params survive into the re-rendered form
    expect(result.body).toContain(`value="${CODE_CHALLENGE}"`);
    expect(result.body).toContain('value="state-123"');
  });

  test('GET with an unknown flow renders the expired page', () => {
    const result = handleProviderCallbackGet(new URLSearchParams({ mcp_state: 'f'.repeat(32), error: 'provider' }));
    expect(result.status).toBe(400);
    expect(result.body).toContain('Sign-in session expired');
  });

  test('POST with a valid handoff issues an authorization code redirect', async () => {
    mockActiveSubscription();
    const { mcpState, cookie } = startProviderFlow();
    const handoff = sealHandoff({ s: mcpState });
    const result = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff }).toString(), cookie);
    expect(result.status).toBe(302);
    const location = new URL(result.headers.Location);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get('state')).toBe('state-123');
    expect(location.searchParams.get('code')).toMatch(/^[a-f0-9]{64}$/);
  });

  test('POST rejects a handoff sealed for a different flow', async () => {
    const { mcpState, cookie } = startProviderFlow();
    const handoff = sealHandoff({ s: 'a'.repeat(32) });
    const result = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff }).toString(), cookie);
    expect(result.status).toBe(200);
    expect(result.body).toContain('Sign-in expired or could not be verified');
  });

  test('POST with an invalid blob does NOT consume the flow (valid retry succeeds)', async () => {
    mockActiveSubscription();
    const { mcpState, cookie } = startProviderFlow();
    const bad = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff: 'garbage' }).toString(), cookie);
    expect(bad.status).toBe(200);
    expect(bad.body).toContain('Sign-in expired or could not be verified');
    const good = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff: sealHandoff({ s: mcpState }) }).toString(), cookie);
    expect(good.status).toBe(302);
  });

  test('POST rejects an expired handoff blob', async () => {
    const { mcpState, cookie } = startProviderFlow();
    const handoff = sealHandoff({ s: mcpState, e: Date.now() - 1000 });
    const result = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff }).toString(), cookie);
    expect(result.status).toBe(200);
    expect(result.body).toContain('Sign-in expired or could not be verified');
  });

  test('POST consumes the flow (replay of the same mcp_state fails)', async () => {
    mockActiveSubscription();
    const { mcpState, cookie } = startProviderFlow();
    const handoff = sealHandoff({ s: mcpState });
    const first = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff }).toString(), cookie);
    expect(first.status).toBe(302);
    const replay = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff }).toString(), cookie);
    expect(replay.status).toBe(400);
    expect(replay.body).toContain('Sign-in session expired');
  });

  test('POST trusts the sealed blob and issues a code WITHOUT a profile/subscription fetch', async () => {
    // The auth server verifies the subscription before it seals a handoff, so a
    // valid blob always represents an active account. The MCP side must NOT
    // re-fetch the profile (finding R2-3): a transient profile 5xx here would
    // strand an already-transferred session with no retry. Any fetch = failure.
    let fetched = false;
    globalThis.fetch = (async (_url: string | URL | Request) => {
      fetched = true;
      return new Response('should not be called', { status: 500 });
    }) as typeof fetch;
    const { mcpState, cookie } = startProviderFlow();
    const handoff = sealHandoff({ s: mcpState });
    const result = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff }).toString(), cookie);
    expect(fetched).toBe(false);
    expect(result.status).toBe(302);
    expect(new URL(result.headers.Location).searchParams.get('code')).toMatch(/^[a-f0-9]{64}$/);
  });
});

/**
 * Flow fixation (#11). The mcp_state id is public - it rides address bars,
 * Referer headers and logs - so on its own it lets whoever holds it have the NEXT
 * completed sign-in delivered into the MCP client params parked under it. These
 * tests pin the binding that stops that: a flow started in one browser cannot be
 * finished in another.
 */
describe('provider flow browser binding', () => {
  test('provider-start sets an HttpOnly binding cookie carrying the flow id and a fresh secret', () => {
    const result = handleProviderStart(providerStartQuery());
    const setCookie = result.headers['Set-Cookie'];
    const mcpState = new URL(result.headers.Location).searchParams.get('mcp_state') as string;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/oauth');
    // Cross-origin top-level form POST from the auth server's finish page carries
    // it, so Lax would withhold it whenever the two services are not same-site.
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toMatch(new RegExp(`^oas_mcp_flow=${mcpState}\\.[a-f0-9]{64}(;|~)`));
    // A second flow gets its own secret - the binding is per flow, not per browser.
    const other = handleProviderStart(providerStartQuery());
    const secret = (h: string) => h.split('=')[1].split(';')[0].split('~')[0].split('.')[1];
    expect(secret(other.headers['Set-Cookie'])).not.toBe(secret(setCookie));
  });

  test('THE ATTACK: a flow started by the attacker cannot be finished in the victim browser', async () => {
    mockActiveSubscription();
    // Attacker parks their own client params and keeps the flow id (the cookie
    // stays in THEIR browser).
    const { mcpState } = startProviderFlow();
    // Victim's browser completes a real sign-in against that id and posts the
    // sealed handoff. It holds no binding for the flow.
    const handoff = sealHandoff({ s: mcpState });
    const result = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff }).toString());
    expect(result.status).toBe(400);
    expect(result.body).toContain('Sign-in could not be verified');
    expect(result.headers.Location).toBeUndefined();
  });

  test('a binding for a DIFFERENT flow does not authorize this one', async () => {
    mockActiveSubscription();
    const target = startProviderFlow();
    const other = startProviderFlow();
    const handoff = sealHandoff({ s: target.mcpState });
    const result = await handleProviderCallbackPost(
      new URLSearchParams({ mcp_state: target.mcpState, handoff }).toString(),
      other.cookie,
    );
    expect(result.status).toBe(400);
    expect(result.body).toContain('Sign-in could not be verified');
  });

  test('the right flow id with a tampered secret is refused', async () => {
    mockActiveSubscription();
    const { mcpState, cookie } = startProviderFlow();
    const tampered = cookie.replace(/\.[a-f0-9]{64}/, `.${'b'.repeat(64)}`);
    expect(tampered).not.toBe(cookie);
    const handoff = sealHandoff({ s: mcpState });
    const result = await handleProviderCallbackPost(
      new URLSearchParams({ mcp_state: mcpState, handoff }).toString(),
      tampered,
    );
    expect(result.status).toBe(400);
    expect(result.body).toContain('Sign-in could not be verified');
  });

  test('an unbound POST does not consume the flow (the real browser can still finish)', async () => {
    mockActiveSubscription();
    const { mcpState, cookie } = startProviderFlow();
    const handoff = sealHandoff({ s: mcpState });
    const unbound = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff }).toString());
    expect(unbound.status).toBe(400);
    const real = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff }).toString(), cookie);
    expect(real.status).toBe(302);
  });

  test('an unbound GET error bounce cannot burn a live flow', () => {
    const { mcpState, cookie } = startProviderFlow();
    const unbound = handleProviderCallbackGet(new URLSearchParams({ mcp_state: mcpState, error: 'provider' }));
    expect(unbound.status).toBe(400);
    expect(unbound.body).toContain('Sign-in could not be verified');
    // Still live for the browser that owns it.
    const real = handleProviderCallbackGet(new URLSearchParams({ mcp_state: mcpState, error: 'provider' }), cookie);
    expect(real.status).toBe(200);
    expect(real.body).toContain('The provider could not sign you in');
  });

  test('spending a flow drops only its own binding from the cookie jar', async () => {
    mockActiveSubscription();
    const first = startProviderFlow();
    // Same browser starts a second connection before finishing the first.
    const second = startProviderFlow(providerStartQuery({ state: 'state-second' }), first.cookie);
    expect(second.cookie).toContain(first.mcpState);

    const firstDone = await handleProviderCallbackPost(
      new URLSearchParams({ mcp_state: first.mcpState, handoff: sealHandoff({ s: first.mcpState }) }).toString(),
      second.cookie,
    );
    expect(firstDone.status).toBe(302);
    const afterFirst = cookieHeaderFrom(firstDone.headers['Set-Cookie']);
    expect(afterFirst).not.toContain(first.mcpState);
    expect(afterFirst).toContain(second.mcpState);

    // The second connection still completes with the trimmed jar.
    const secondDone = await handleProviderCallbackPost(
      new URLSearchParams({ mcp_state: second.mcpState, handoff: sealHandoff({ s: second.mcpState }) }).toString(),
      afterFirst,
    );
    expect(secondDone.status).toBe(302);
    expect(new URL(secondDone.headers.Location).searchParams.get('state')).toBe('state-second');
    // Nothing left to bind: the cookie is expired rather than left holding a spent id.
    expect(secondDone.headers['Set-Cookie']).toContain('Max-Age=0');
  });

  test('the jar keeps the newest three bindings and evicts the oldest', async () => {
    mockActiveSubscription();
    let cookie: string | undefined;
    const flows: string[] = [];
    for (let i = 0; i < 4; i++) {
      const started = startProviderFlow(providerStartQuery({ state: `state-${i}` }), cookie);
      flows.push(started.mcpState);
      cookie = started.cookie;
    }
    // Oldest evicted, newest three retained.
    expect(cookie).not.toContain(flows[0]);
    for (const flowId of flows.slice(1)) expect(cookie).toContain(flowId);

    const evicted = await handleProviderCallbackPost(
      new URLSearchParams({ mcp_state: flows[0], handoff: sealHandoff({ s: flows[0] }) }).toString(),
      cookie,
    );
    expect(evicted.status).toBe(400);
    const retained = await handleProviderCallbackPost(
      new URLSearchParams({ mcp_state: flows[1], handoff: sealHandoff({ s: flows[1] }) }).toString(),
      cookie,
    );
    expect(retained.status).toBe(302);
  });

  test('a malformed jar entry is dropped rather than shadowing the valid binding', async () => {
    mockActiveSubscription();
    const { mcpState, cookie } = startProviderFlow();
    // A truncated entry for the SAME flow id sits ahead of the real one. Parsing
    // that kept it would hand the lookup a binding that can never match, refusing
    // a browser that does hold the secret.
    const withJunk = cookie.replace('oas_mcp_flow=', `oas_mcp_flow=${mcpState}.short~`);
    const result = await handleProviderCallbackPost(
      new URLSearchParams({ mcp_state: mcpState, handoff: sealHandoff({ s: mcpState }) }).toString(),
      withJunk,
    );
    expect(result.status).toBe(302);
  });

  test('a same-named cookie from another scope cannot hide the real binding', async () => {
    mockActiveSubscription();
    const { mcpState, cookie } = startProviderFlow();
    // What a sibling subdomain could set: same name, parent-domain scope, junk
    // value. It arrives as its own cookie line ahead of ours.
    const shadowed = `oas_mcp_flow=${mcpState}.${'c'.repeat(64)}; ${cookie}`;
    const result = await handleProviderCallbackPost(
      new URLSearchParams({ mcp_state: mcpState, handoff: sealHandoff({ s: mcpState }) }).toString(),
      shadowed,
    );
    expect(result.status).toBe(302);
  });

  test('junk in an incoming jar is never echoed back into Set-Cookie', () => {
    // The jar is re-serialized into a response header on every start and spend,
    // so anything kept from the request lands in Set-Cookie. Only entries that
    // authenticate against a live flow are kept, so what we echo is provably ours.
    const first = startProviderFlow();
    const polluted = `${first.cookie}~evil.1, injected=2`;
    const setCookie = handleProviderStart(providerStartQuery(), polluted).headers['Set-Cookie'];
    expect(setCookie).not.toContain('evil');
    expect(setCookie).not.toContain('injected');
    expect(setCookie).toContain(first.mcpState); // the real entry survives
  });

  test('forged but well-formed entries cannot evict a real binding from the capped jar', () => {
    // A sibling subdomain can set a same-named cookie at a wider scope carrying
    // syntactically perfect entries. Re-serializing those would push the
    // browser's genuine bindings out of a three-slot jar - eviction, not
    // injection, is the reachable harm.
    const real = startProviderFlow();
    const forged = Array.from({ length: 3 }, (_, i) => `${String(i).repeat(32)}.${'d'.repeat(64)}`).join('~');
    const shadowed = `oas_mcp_flow=${forged}; ${real.cookie}`;
    const next = startProviderFlow(providerStartQuery({ state: 'state-next' }), shadowed);
    expect(next.cookie).toContain(real.mcpState);
    expect(next.cookie).not.toContain('d'.repeat(64));
  });

  test('a spent flow is dropped from the jar by authentication, not by name', async () => {
    mockActiveSubscription();
    const { mcpState, cookie } = startProviderFlow();
    const done = await handleProviderCallbackPost(
      new URLSearchParams({ mcp_state: mcpState, handoff: sealHandoff({ s: mcpState }) }).toString(),
      cookie,
    );
    expect(done.status).toBe(302);
    // Presenting the stale jar again keeps nothing: the flow no longer exists.
    const setCookie = handleProviderStart(providerStartQuery(), cookie).headers['Set-Cookie'];
    expect(setCookie).not.toContain(mcpState);
  });

  test('an expired flow loses its jar slot before the sweeper runs', () => {
    // The 60s sweeper is not the gate: a flow past its TTL is dead the moment it
    // expires, and holding its binding would waste one of three slots for a
    // browser that is starting a fresh connection right now.
    const stale = startProviderFlow();
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    try {
      const fresh = startProviderFlow(providerStartQuery({ state: 'state-fresh' }), stale.cookie);
      expect(fresh.cookie).not.toContain(stale.mcpState);
    } finally {
      setSystemTime();
    }
  });

  test('the binding cookie is host-only (no Domain attribute)', () => {
    // A Domain= cookie would be readable by every sibling subdomain and settable
    // by any of them. The binding is only meaningful scoped to this host.
    expect(handleProviderStart(providerStartQuery()).headers['Set-Cookie']).not.toContain('Domain');
  });

  test('the GET error bounce does not consume the flow (no CSRF burn)', () => {
    // The endpoint authenticates the browser but not the auth server: it is a
    // plain GET whose only other input is a flow id that travels in URLs, so a
    // cross-site navigation in the bound browser must not be able to destroy a
    // sign-in in progress.
    mockActiveSubscription();
    const { mcpState, cookie } = startProviderFlow();
    const burn = handleProviderCallbackGet(new URLSearchParams({ mcp_state: mcpState, error: 'provider' }), cookie);
    expect(burn.status).toBe(200);
    // The flow is still live and still spendable by this browser.
    const second = handleProviderCallbackGet(new URLSearchParams({ mcp_state: mcpState, error: 'provider' }), cookie);
    expect(second.status).toBe(200);
    expect(second.body).toContain('The provider could not sign you in');
  });

  test('the GET error bounce leaves the binding in place so the flow stays finishable', async () => {
    mockActiveSubscription();
    const { mcpState, cookie } = startProviderFlow();
    handleProviderCallbackGet(new URLSearchParams({ mcp_state: mcpState, error: 'provider' }), cookie);
    const done = await handleProviderCallbackPost(
      new URLSearchParams({ mcp_state: mcpState, handoff: sealHandoff({ s: mcpState }) }).toString(),
      cookie,
    );
    expect(done.status).toBe(302);
  });

  test('local http deployments fall back to SameSite=Lax (None requires Secure)', () => {
    const original = process.env.OAS_MCP_BASE_URL;
    process.env.OAS_MCP_BASE_URL = 'http://localhost:8787';
    try {
      const setCookie = handleProviderStart(providerStartQuery()).headers['Set-Cookie'];
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).not.toContain('Secure');
    } finally {
      if (original === undefined) delete process.env.OAS_MCP_BASE_URL;
      else process.env.OAS_MCP_BASE_URL = original;
    }
  });
});

describe('token exchange for provider sign-ins', () => {
  /** Full provider flow -> exchange the auth code -> return the token response. */
  async function exchangeProviderCode(): Promise<Record<string, unknown>> {
    mockActiveSubscription();
    const { mcpState, cookie } = startProviderFlow();
    const handoff = sealHandoff({ s: mcpState, r: 'gotrue-refresh-1' });
    const cb = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff }).toString(), cookie);
    expect(cb.status).toBe(302);
    const code = new URL(cb.headers.Location).searchParams.get('code') as string;
    const result = await handleTokenExchange(new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: CODE_VERIFIER,
      redirect_uri: REDIRECT_URI,
      client_id: 'test-client',
    }).toString());
    expect(result.status).toBe(200);
    return JSON.parse(result.body);
  }

  test('issues a JWT-bounded bearer plus a refresh_token wrapping the GoTrue refresh', async () => {
    const json = await exchangeProviderCode();
    expect(typeof json.access_token).toBe('string');
    expect(typeof json.refresh_token).toBe('string');
    // Bearer lifetime tracks the ~1h GoTrue JWT, not the 24h credential TTL
    expect(json.expires_in as number).toBeGreaterThan(3000);
    expect(json.expires_in as number).toBeLessThanOrEqual(3600);
    // The wrapper is bound to the client and carries the GoTrue refresh token
    const opened = JSON.parse(aesGcmOpen(json.refresh_token as string, TOKEN_SECRET));
    const wrapped = JSON.parse((opened.k as string).slice('oauth-refresh:'.length));
    expect(wrapped.c).toBe('test-client');
    expect(wrapped.r).toBe('gotrue-refresh-1');
  });

  test('refresh_token grant rotates via the auth server and re-wraps the new token', async () => {
    const json = await exchangeProviderCode();
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      expect(href).toEndWith('/api/v1/oauth/refresh');
      const cookie = (init?.headers as Record<string, string>)?.Cookie ?? '';
      expect(cookie).toBe('gotrueRefreshToken=gotrue-refresh-1');
      return new Response(JSON.stringify({ accessToken: makeJwt(3600) }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': 'gotrueRefreshToken=gotrue-refresh-2; Path=/api/v1/oauth; HttpOnly',
        },
      });
    }) as typeof fetch;

    const result = await handleTokenExchange(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: json.refresh_token as string,
      client_id: 'test-client',
    }).toString());
    expect(result.status).toBe(200);
    const refreshed = JSON.parse(result.body);
    expect(typeof refreshed.access_token).toBe('string');
    expect(refreshed.expires_in).toBeGreaterThan(3000);
    const opened = JSON.parse(aesGcmOpen(refreshed.refresh_token, TOKEN_SECRET));
    const wrapped = JSON.parse((opened.k as string).slice('oauth-refresh:'.length));
    expect(wrapped.r).toBe('gotrue-refresh-2'); // rotation captured
  });

  test('refresh_token grant rejects a client_id mismatch', async () => {
    const json = await exchangeProviderCode();
    const result = await handleTokenExchange(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: json.refresh_token as string,
      client_id: 'other-client',
    }).toString());
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toBe('invalid_grant');
  });

  test('refresh_token grant maps an auth-server rejection to invalid_grant', async () => {
    const json = await exchangeProviderCode();
    globalThis.fetch = (async (_url: string | URL | Request) => new Response('nope', { status: 401 })) as typeof fetch;
    const result = await handleTokenExchange(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: json.refresh_token as string,
      client_id: 'test-client',
    }).toString());
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toBe('invalid_grant');
  });

  test('refresh_token grant maps a transient upstream failure to 503, not invalid_grant', async () => {
    const json = await exchangeProviderCode();
    globalThis.fetch = (async (_url: string | URL | Request) => new Response('down', { status: 503 })) as typeof fetch;
    const result = await handleTokenExchange(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: json.refresh_token as string,
      client_id: 'test-client',
    }).toString());
    expect(result.status).toBe(503);
    expect(JSON.parse(result.body).error).toBe('temporarily_unavailable');
  });

  test('refresh_token grant maps a malformed 2xx (200, no token) to 503, not invalid_grant', async () => {
    const json = await exchangeProviderCode();
    // A 200 with no accessToken is a server glitch, not a rejected session:
    // clients must retry with the same still-valid token, not discard it (R2-4).
    globalThis.fetch = (async (_url: string | URL | Request) => new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
    const result = await handleTokenExchange(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: json.refresh_token as string,
      client_id: 'test-client',
    }).toString());
    expect(result.status).toBe(503);
    expect(JSON.parse(result.body).error).toBe('temporarily_unavailable');
  });
});

describe('password sign-in issues no refresh_token (owner stays stable)', () => {
  /** Mock a successful (non-MFA) password login + active subscription. */
  function mockPasswordLogin(withRefreshCookie: boolean) {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/api/v1/auth/login')) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (withRefreshCookie) {
          headers['Set-Cookie'] = 'gotrueRefreshToken=pw-refresh-1; Path=/api/v1/oauth; HttpOnly';
        }
        return new Response(JSON.stringify({ token: makeJwt(3600) }), { status: 200, headers });
      }
      // hasActiveSubscription
      return new Response(JSON.stringify({
        user: { isDeveloper: false, bypassSubscription: false },
        subscription: { status: 'active' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  }

  async function passwordExchange(withRefreshCookie: boolean): Promise<Record<string, unknown>> {
    mockPasswordLogin(withRefreshCookie);
    const post = await handleAuthorizePost(new URLSearchParams({
      email: 'user@example.com',
      password: 'hunter2hunter2',
      client_id: 'test-client',
      redirect_uri: REDIRECT_URI,
      state: 'state-pw',
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: 'S256',
    }).toString());
    expect(post.status).toBe(302);
    const code = new URL(post.headers.Location).searchParams.get('code') as string;
    const result = await handleTokenExchange(new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: CODE_VERIFIER,
      redirect_uri: REDIRECT_URI,
      client_id: 'test-client',
    }).toString());
    expect(result.status).toBe(200);
    return JSON.parse(result.body);
  }

  test('no refresh_token even when the login captured a GoTrue refresh cookie', async () => {
    const json = await passwordExchange(true);
    expect(typeof json.access_token).toBe('string');
    expect(json.refresh_token).toBeUndefined();
    // Credential-backed bearer keeps the 24h TTL (owner stays key:<hash>).
    expect(json.expires_in as number).toBeGreaterThan(80000);
  });

  test('no refresh_token when no refresh cookie was captured', async () => {
    const json = await passwordExchange(false);
    expect(json.refresh_token).toBeUndefined();
  });

  test('refresh_token grant rejects garbage tokens', async () => {
    const result = await handleTokenExchange(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'garbage',
      client_id: 'test-client',
    }).toString());
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toBe('invalid_grant');
  });
});

describe('discovery metadata', () => {
  test('advertises the refresh_token grant', () => {
    const meta = JSON.parse(handleAuthServerMetadata('mcp.optionsanalysissuite.com'));
    expect(meta.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
  });
});

/**
 * Connection consent for shared-gateway callbacks. Flow binding cannot stop the
 * sibling lure - a crafted /oauth/authorize link is started by the victim's own
 * browser, so every binding is satisfied. Where the callback is shared across a
 * gateway's tenants, the code can then reach someone other than the person who
 * signed in, so those targets require an explicit confirmation naming the
 * destination.
 */
describe('connection consent for shared gateways', () => {
  const GATEWAY = 'https://smithery.run/oauth/callback';

  /** Password sign-in against a given redirect target; returns the raw result. */
  async function authorizeWithPassword(redirectUri: string) {
    return authorizeWithPasswordWithCookie(redirectUri);
  }

  async function authorizeWithPasswordWithCookie(redirectUri: string, cookie?: string) {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/api/v1/auth/login')) {
        return new Response(JSON.stringify({ token: makeJwt(3600) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        user: { isDeveloper: false, bypassSubscription: false },
        subscription: { status: 'active' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    return handleAuthorizePost(new URLSearchParams({
      email: 'user@example.com',
      password: 'hunter2hunter2',
      client_id: 'test-client',
      redirect_uri: redirectUri,
      state: 'state-consent',
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: 'S256',
    }).toString(), cookie);
  }

  function consentIdFrom(body: string): string {
    return (body.match(/name="consent_id" value="([a-f0-9]{32})"/) as RegExpMatchArray)[1];
  }

  test('a normal client callback still issues a code with no extra step', async () => {
    const result = await authorizeWithPassword(REDIRECT_URI);
    expect(result.status).toBe(302);
    expect(new URL(result.headers.Location).searchParams.get('code')).toMatch(/^[a-f0-9]{64}$/);
  });

  test('a shared gateway callback is held behind a confirmation naming the destination', async () => {
    const result = await authorizeWithPassword(GATEWAY);
    expect(result.status).toBe(200);
    expect(result.headers.Location).toBeUndefined();
    expect(result.body).toContain('Confirm this connection');
    expect(result.body).toContain('smithery.run');
    expect(result.body).toContain('Only continue if you started this yourself');
    expect(result.headers['Set-Cookie']).toContain('oas_mcp_consent=');
    expect(result.headers['Set-Cookie']).toContain('HttpOnly');
  });

  test('no authorization code is delivered or spendable until the user approves', async () => {
    const held = await authorizeWithPassword(GATEWAY);
    const consentId = consentIdFrom(held.body);
    const cookie = cookieHeaderFrom(held.headers['Set-Cookie']);

    const cancelled = handleConsentPost(
      new URLSearchParams({ consent_id: consentId, decision: 'cancel' }).toString(),
      cookie,
    );
    expect(cancelled.status).toBe(400);
    expect(cancelled.body).toContain('Connection cancelled');
    expect(cancelled.headers['Set-Cookie']).toContain('Max-Age=0');
    // The parked grant is gone: approving after cancelling gets nothing.
    const late = handleConsentPost(
      new URLSearchParams({ consent_id: consentId, decision: 'approve' }).toString(),
      cookie,
    );
    expect(late.status).toBe(400);
    expect(late.body).toContain('Sign-in session expired');
  });

  test('approving issues the code to the parked grant and clears the consent cookie', async () => {
    const held = await authorizeWithPassword(GATEWAY);
    const approved = handleConsentPost(
      new URLSearchParams({ consent_id: consentIdFrom(held.body), decision: 'approve' }).toString(),
      cookieHeaderFrom(held.headers['Set-Cookie']),
    );
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.Location);
    expect(`${location.origin}${location.pathname}`).toBe(GATEWAY);
    expect(location.searchParams.get('state')).toBe('state-consent');
    expect(location.searchParams.get('code')).toMatch(/^[a-f0-9]{64}$/);
    expect(approved.headers['Set-Cookie']).toContain('Max-Age=0');
  });

  test('another browser cannot approve a pending consent', async () => {
    const held = await authorizeWithPassword(GATEWAY);
    const consentId = consentIdFrom(held.body);
    const stolen = handleConsentPost(
      new URLSearchParams({ consent_id: consentId, decision: 'approve' }).toString(),
    );
    expect(stolen.status).toBe(400);
    expect(stolen.body).toContain('Sign-in could not be verified');
    // Still approvable by the browser that earned it.
    const real = handleConsentPost(
      new URLSearchParams({ consent_id: consentId, decision: 'approve' }).toString(),
      cookieHeaderFrom(held.headers['Set-Cookie']),
    );
    expect(real.status).toBe(302);
  });

  test('a consent cookie for a different pending consent does not authorize this one', async () => {
    const target = await authorizeWithPassword(GATEWAY);
    const other = await authorizeWithPassword(GATEWAY);
    const result = handleConsentPost(
      new URLSearchParams({ consent_id: consentIdFrom(target.body), decision: 'approve' }).toString(),
      cookieHeaderFrom(other.headers['Set-Cookie']),
    );
    expect(result.status).toBe(400);
    expect(result.body).toContain('Sign-in could not be verified');
  });

  test('the provider sign-in path is gated too, not just the password form', async () => {
    mockActiveSubscription();
    const { mcpState, cookie } = startProviderFlow(providerStartQuery({ redirect_uri: GATEWAY }));
    const result = await handleProviderCallbackPost(
      new URLSearchParams({ mcp_state: mcpState, handoff: sealHandoff({ s: mcpState }) }).toString(),
      cookie,
    );
    expect(result.status).toBe(200);
    expect(result.body).toContain('Confirm this connection');
    expect(result.headers['Set-Cookie']).toContain('oas_mcp_consent=');
  });

  test('the consent cookie is host-only, HttpOnly and SameSite=Lax', async () => {
    // The confirmation form posts back to this same origin, so Lax is the right
    // scope - None would be a needless widening. Domain is omitted so no sibling
    // subdomain receives it.
    const held = await authorizeWithPassword(GATEWAY);
    const setCookie = held.headers['Set-Cookie'];
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Domain');
    expect(setCookie).toContain('Path=/oauth');
  });

  test('two concurrent confirmations in one browser are both approvable', async () => {
    const first = await authorizeWithPassword(GATEWAY);
    const firstId = consentIdFrom(first.body);
    // The second confirmation is opened while the first is still on screen, and
    // the browser presents the cookie the first one set.
    const second = await authorizeWithPasswordWithCookie(GATEWAY, cookieHeaderFrom(first.headers['Set-Cookie']));
    const secondId = consentIdFrom(second.body);
    const jar = cookieHeaderFrom(second.headers['Set-Cookie']);
    expect(jar).toContain(firstId);
    expect(jar).toContain(secondId);

    const approvedSecond = handleConsentPost(
      new URLSearchParams({ consent_id: secondId, decision: 'approve' }).toString(), jar,
    );
    expect(approvedSecond.status).toBe(302);
    // The older tab still works, with the jar the approval handed back.
    const approvedFirst = handleConsentPost(
      new URLSearchParams({ consent_id: firstId, decision: 'approve' }).toString(),
      cookieHeaderFrom(approvedSecond.headers['Set-Cookie']),
    );
    expect(approvedFirst.status).toBe(302);
  });

  test('approving twice issues only one code', async () => {
    const held = await authorizeWithPassword(GATEWAY);
    const consentId = consentIdFrom(held.body);
    const cookie = cookieHeaderFrom(held.headers['Set-Cookie']);
    const approve = new URLSearchParams({ consent_id: consentId, decision: 'approve' }).toString();
    expect(handleConsentPost(approve, cookie).status).toBe(302);
    const replay = handleConsentPost(approve, cookie);
    expect(replay.status).toBe(400);
    expect(replay.body).toContain('Sign-in session expired');
  });

  test('the MFA path reaches the consent gate too', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/api/v1/auth/login')) {
        return new Response(JSON.stringify({ requiresMfa: true, code: 'mfa_required', stepUpToken: 'step-token' }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': 'gotrueRefreshToken=refresh-mfa; Path=/api/v1/oauth; HttpOnly',
          },
        });
      }
      if (href.endsWith('/api/csrf-token')) return Response.json({ csrfToken: 'csrf-1' });
      if (href.endsWith('/api/v1/oauth/mfa/factors')) {
        return Response.json({ factors: [{ id: 'factor-1', status: 'verified', factor_type: 'totp' }] });
      }
      if (href.endsWith('/api/v1/oauth/mfa/challenge')) return Response.json({ challengeId: 'challenge-1' });
      if (href.endsWith('/api/v1/oauth/mfa/verify')) return Response.json({ accessToken: makeJwt(3600) });
      return Response.json({ user: { isDeveloper: false, bypassSubscription: false }, subscription: { status: 'active' } });
    }) as typeof fetch;

    const form = (extra: Record<string, string> = {}) => new URLSearchParams({
      email: 'user@example.com',
      password: 'hunter2hunter2',
      client_id: 'test-client',
      redirect_uri: GATEWAY,
      state: 'state-mfa',
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: 'S256',
      ...extra,
    }).toString();

    const challenge = await handleAuthorizePost(form());
    expect(challenge.body).toContain('name="mfa_flow_id"');
    const flowId = challenge.body.match(/name="mfa_flow_id" value="([^"]+)"/)?.[1] as string;
    const verified = await handleAuthorizePost(form({ mfa_flow_id: flowId, mfa_code: '123456' }));
    // Passing MFA is not consent: the gateway target still asks.
    expect(verified.status).toBe(200);
    expect(verified.body).toContain('Confirm this connection');
    const approved = handleConsentPost(
      new URLSearchParams({ consent_id: consentIdFrom(verified.body), decision: 'approve' }).toString(),
      cookieHeaderFrom(verified.headers['Set-Cookie']),
    );
    expect(approved.status).toBe(302);
    expect(new URL(approved.headers.Location).searchParams.get('state')).toBe('state-mfa');
  });

  test('an expired consent loses its jar slot', async () => {
    const stale = await authorizeWithPassword(GATEWAY);
    const staleId = consentIdFrom(stale.body);
    setSystemTime(new Date(Date.now() + 6 * 60_000));
    try {
      const fresh = await authorizeWithPasswordWithCookie(GATEWAY, cookieHeaderFrom(stale.headers['Set-Cookie']));
      expect(fresh.headers['Set-Cookie']).not.toContain(staleId);
    } finally {
      setSystemTime();
    }
  });

  test('cancelling one confirmation leaves the other approvable', async () => {
    const first = await authorizeWithPassword(GATEWAY);
    const second = await authorizeWithPasswordWithCookie(GATEWAY, cookieHeaderFrom(first.headers['Set-Cookie']));
    const cancelled = handleConsentPost(
      new URLSearchParams({ consent_id: consentIdFrom(second.body), decision: 'cancel' }).toString(),
      cookieHeaderFrom(second.headers['Set-Cookie']),
    );
    expect(cancelled.body).toContain('Connection cancelled');
    const approved = handleConsentPost(
      new URLSearchParams({ consent_id: consentIdFrom(first.body), decision: 'approve' }).toString(),
      cookieHeaderFrom(cancelled.headers['Set-Cookie']),
    );
    expect(approved.status).toBe(302);
  });

  test('a fourth confirmation evicts the oldest from the three-slot jar', async () => {
    let cookie: string | undefined;
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const held = await authorizeWithPasswordWithCookie(GATEWAY, cookie);
      ids.push(consentIdFrom(held.body));
      cookie = cookieHeaderFrom(held.headers['Set-Cookie']);
    }
    expect(cookie).not.toContain(ids[0]);
    for (const id of ids.slice(1)) expect(cookie).toContain(id);

    const evicted = handleConsentPost(
      new URLSearchParams({ consent_id: ids[0], decision: 'approve' }).toString(), cookie,
    );
    expect(evicted.status).toBe(400);
    expect(evicted.body).toContain('Sign-in could not be verified');
    const retained = handleConsentPost(
      new URLSearchParams({ consent_id: ids[1], decision: 'approve' }).toString(), cookie,
    );
    expect(retained.status).toBe(302);
  });

  test('a pending consent expires', async () => {
    const held = await authorizeWithPassword(GATEWAY);
    const consentId = consentIdFrom(held.body);
    const cookie = cookieHeaderFrom(held.headers['Set-Cookie']);
    setSystemTime(new Date(Date.now() + 6 * 60_000));
    try {
      const late = handleConsentPost(
        new URLSearchParams({ consent_id: consentId, decision: 'approve' }).toString(),
        cookie,
      );
      expect(late.status).toBe(400);
      expect(late.body).toContain('Sign-in session expired');
    } finally {
      setSystemTime();
    }
  });
});

/**
 * Every OAuth HTML page is a security surface: the consent click is what stands
 * between a crafted authorization link and a connected account, and the login and
 * MFA forms take credentials. RFC 9700 requires an authorization server to
 * prevent clickjacking, so none of these may be framed or cached, and none may
 * post anywhere but back here.
 */
describe('OAuth page security headers', () => {
  const pages: Array<[string, () => Promise<{ status: number; headers: Record<string, string>; body: string }>]> = [
    ['login', async () => handleAuthorizeGet(new URLSearchParams({
      client_id: 'c', redirect_uri: REDIRECT_URI, state: 's',
      code_challenge: CODE_CHALLENGE, code_challenge_method: 'S256',
    }))],
    ['notice', async () => handleProviderCallbackGet(new URLSearchParams({ mcp_state: 'f'.repeat(32) }))],
    ['MFA', async () => {
      globalThis.fetch = (async () => new Response(
        JSON.stringify({ requiresMfa: true, code: 'mfa_required', stepUpToken: 'step-token' }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'gotrueRefreshToken=r; Path=/; HttpOnly' } },
      )) as unknown as typeof fetch;
      const page = await handleAuthorizePost(new URLSearchParams({
        email: 'user@example.com', password: 'hunter2hunter2', client_id: 'c',
        redirect_uri: REDIRECT_URI, state: 's',
        code_challenge: CODE_CHALLENGE, code_challenge_method: 'S256',
      }).toString());
      expect(page.body).toContain('name="mfa_flow_id"');
      return page;
    }],
    ['consent', async () => {
      globalThis.fetch = (async (url: string | URL | Request) => {
        const body = String(url).endsWith('/api/v1/auth/login')
          ? { token: makeJwt(3600) }
          : { user: { isDeveloper: false, bypassSubscription: false }, subscription: { status: 'active' } };
        return Response.json(body);
      }) as typeof fetch;
      return handleAuthorizePost(new URLSearchParams({
        email: 'user@example.com', password: 'hunter2hunter2', client_id: 'c',
        redirect_uri: 'https://smithery.run/oauth/callback', state: 's',
        code_challenge: CODE_CHALLENGE, code_challenge_method: 'S256',
      }).toString());
    }],
  ];

  for (const [name, render] of pages) {
    test(`the ${name} page cannot be framed, posted elsewhere, or cached`, async () => {
      const result = await render();
      expect(result.headers['X-Frame-Options']).toBe('DENY');
      expect(result.headers['Cache-Control']).toBe('no-store');
      expect(result.headers['Referrer-Policy']).toBe('no-referrer');
      const csp = result.headers['Content-Security-Policy'];
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("default-src 'none'");
      // These pages style themselves with an inline <style> block and style
      // attributes, and run no script at all - so inline STYLE is allowed and
      // nothing else may load.
      expect(csp).toContain("style-src 'unsafe-inline'");
      expect(csp).not.toContain('script-src');
    });
  }
});

describe('outstanding-authorization budget', () => {
  const GATEWAY_REDIRECT = 'https://smithery.run/oauth/callback';

  // Each test here mints thousands of codes to fill the budget, and issuance
  // now emits one `code_issued` telemetry line per code (see the OAuth
  // telemetry note in oauth.ts). That is expected, but it would bury CI output,
  // so drop only those lines for this describe; any other console.log still
  // prints, and no test here asserts on log content.
  let restoreConsoleLog: (() => void) | undefined;
  beforeEach(() => {
    const original = console.log;
    restoreConsoleLog = () => { console.log = original; };
    console.log = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('[OAS MCP OAuth]')) return;
      original(...args);
    };
  });
  afterEach(() => { restoreConsoleLog?.(); restoreConsoleLog = undefined; });

  /** Password login that always succeeds, no second factor. */
  function mockPasswordSuccess() {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const body = String(url).endsWith('/api/v1/auth/login')
        ? { token: makeJwt(3600) }
        : { user: { isDeveloper: false, bypassSubscription: false }, subscription: { status: 'active' } };
      return Response.json(body);
    }) as typeof fetch;
  }

  /** Password login that always demands a second factor (parks an MFA flow). */
  function mockMfaChallenge() {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ requiresMfa: true, code: 'mfa_required', stepUpToken: 'step-token' }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'gotrueRefreshToken=r; Path=/; HttpOnly' } },
    )) as unknown as typeof fetch;
  }

  const authorize = (state: string, redirectUri = REDIRECT_URI) => handleAuthorizePost(new URLSearchParams({
    email: 'user@example.com', password: 'hunter2hunter2', client_id: 'c',
    redirect_uri: redirectUri, state,
    code_challenge: CODE_CHALLENGE, code_challenge_method: 'S256',
  }).toString());

  /** Authorize until the budget refuses; returns how many succeeded. */
  async function fillBudget(mix = true): Promise<number> {
    let succeeded = 0;
    for (let i = 0; i < MAX_OUTSTANDING_AUTHORIZATIONS + 2; i++) {
      const result = await authorize(`s-${i}`, mix && i % 2 === 1 ? GATEWAY_REDIRECT : REDIRECT_URI);
      if (result.status === 503) return succeeded;
      succeeded++;
    }
    throw new Error('budget never refused');
  }

  /**
   * Empty the shared maps through production code. These maps are module state
   * shared by every test file in this process, so a test that walks away from a
   * full budget leaks it into the next file.
   *
   * Two things make this reliable, and both were bugs first:
   *
   * TOP UP TO CAPACITY BEFORE PRUNING. Production prunes only when the budget is
   * full, so a drain called with room to spare prunes nothing and merely adds one
   * more authorization. When already full the top-up loop refuses on its first
   * call and costs nothing; it only does real work for a drain that follows a
   * partially-used budget.
   *
   * STEP THE CLOCK FORWARD EACH CALL. A drain necessarily leaves its own
   * authorization behind, minted under whatever clock it ran at, so a fixed
   * offset would never expire the previous drain's leftover and the baseline
   * would creep by one per call - which is what made the boundary assertion below
   * read one short before this was fixed.
   *
   * Floor is exactly one outstanding authorization: pruning cannot run without
   * being at capacity, and reaching capacity means issuing one.
   */
  let drainEpochMinutes = 0;
  async function drainBudget(): Promise<void> {
    mockPasswordSuccess();
    for (let i = 0; i < MAX_OUTSTANDING_AUTHORIZATIONS + 2; i++) {
      if ((await authorize(`top-up-${i}`)).status === 503) break;
    }
    drainEpochMinutes += 60;
    setSystemTime(new Date(Date.now() + drainEpochMinutes * 60_000));
    try {
      expect((await authorize('drain')).status).toBe(302);
    } finally {
      setSystemTime();
    }
  }

  test('refuses retryably once too many authorizations are outstanding', async () => {
    mockPasswordSuccess();
    await fillBudget();
    const refused = await authorize('over-cap');
    expect(refused.status).toBe(503);
    expect(refused.headers['Retry-After']).toBe('60');
    expect(refused.body).toContain('Too many sign-ins in progress');
    await drainBudget();
  });

  test('exactly the budget is issued, and a parked consent costs exactly one slot', async () => {
    // The boundary is the assertion: if any path quietly consumed two slots -
    // a consent that also minted a code, say - the count would come up short.
    mockPasswordSuccess();
    await fillBudget();
    await drainBudget(); // leaves exactly the drain's own code outstanding
    const succeeded = await fillBudget();
    expect(succeeded).toBe(MAX_OUTSTANDING_AUTHORIZATIONS - 1);
    await drainBudget();
  });

  test('MFA challenges count toward the budget', async () => {
    // Reaching one needs only a valid password - no subscription check has run -
    // so an uncounted mfaFlows map is an unbounded allocation.
    mockMfaChallenge();
    let refused = null as null | { status: number; body: string };
    for (let i = 0; i < MAX_OUTSTANDING_AUTHORIZATIONS + 2; i++) {
      const result = await authorize(`mfa-${i}`);
      if (result.status === 503) { refused = result; break; }
      expect(result.body).toContain('name="mfa_flow_id"');
    }
    expect(refused).not.toBeNull();
    expect((refused as { body: string }).body).toContain('Too many sign-ins in progress');
    await drainBudget();
  });

  test('completing a second factor is net zero and survives a full budget', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/api/v1/auth/login')) {
        return new Response(JSON.stringify({ requiresMfa: true, code: 'mfa_required', stepUpToken: 'step-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'gotrueRefreshToken=r; Path=/; HttpOnly' },
        });
      }
      if (href.endsWith('/api/csrf-token')) return Response.json({ csrfToken: 'csrf-1' });
      if (href.endsWith('/api/v1/oauth/mfa/factors')) {
        return Response.json({ factors: [{ id: 'factor-1', status: 'verified', factor_type: 'totp' }] });
      }
      if (href.endsWith('/api/v1/oauth/mfa/challenge')) return Response.json({ challengeId: 'challenge-1' });
      if (href.endsWith('/api/v1/oauth/mfa/verify')) return Response.json({ accessToken: makeJwt(3600) });
      return Response.json({ user: { isDeveloper: false, bypassSubscription: false }, subscription: { status: 'active' } });
    }) as typeof fetch;

    const challenge = await authorize('mfa-net-zero');
    const flowId = challenge.body.match(/name="mfa_flow_id" value="([^"]+)"/)?.[1] as string;
    expect(flowId).toBeTruthy();

    // Fill every remaining slot, then finish the second factor anyway.
    for (let i = 0; i < MAX_OUTSTANDING_AUTHORIZATIONS + 2; i++) {
      const result = await authorize(`filler-${i}`);
      if (result.status === 503) break;
    }
    const verified = await handleAuthorizePost(new URLSearchParams({
      email: 'user@example.com', password: 'hunter2hunter2', client_id: 'c',
      redirect_uri: REDIRECT_URI, state: 'mfa-net-zero',
      code_challenge: CODE_CHALLENGE, code_challenge_method: 'S256',
      mfa_flow_id: flowId, mfa_code: '123456',
    }).toString());
    expect(verified.status).toBe(302);
    await drainBudget();
  });

  test('approving a parked consent is net zero and survives a full budget', async () => {
    mockPasswordSuccess();
    const held = await authorize('consent-net-zero', GATEWAY_REDIRECT);
    expect(held.status).toBe(200);
    const consentId = (held.body.match(/name="consent_id" value="([a-f0-9]{32})"/) as RegExpMatchArray)[1];
    const cookie = cookieHeaderFrom(held.headers['Set-Cookie']);
    await fillBudget(false);
    const approved = handleConsentPost(
      new URLSearchParams({ consent_id: consentId, decision: 'approve' }).toString(), cookie,
    );
    expect(approved.status).toBe(302);
    await drainBudget();
  });

  test('a full budget refuses the provider spend WITHOUT destroying the flow', async () => {
    mockPasswordSuccess();
    const { mcpState, cookie } = startProviderFlow();
    const handoff = sealHandoff({ s: mcpState });
    await fillBudget(false);

    const refused = await handleProviderCallbackPost(
      new URLSearchParams({ mcp_state: mcpState, handoff }).toString(), cookie,
    );
    expect(refused.status).toBe(503);
    expect(refused.body).toContain('Too many sign-ins in progress');

    // The flow survived, so the same attempt works once there is room. A refusal
    // that consumed it would come back "Sign-in session expired" instead.
    await drainBudget();
    mockActiveSubscription();
    const retried = await handleProviderCallbackPost(
      new URLSearchParams({ mcp_state: mcpState, handoff: sealHandoff({ s: mcpState }) }).toString(), cookie,
    );
    expect(retried.status).toBe(302);
    await drainBudget();
  });
});
