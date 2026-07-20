/**
 * Provider sign-in (Google/Apple/GitHub/Microsoft) + refresh_token grant tests.
 *
 * The provider flow round-trips through the auth server's BFF; here we drive
 * the mcp-server side: provider-start parks the client's PKCE params, the
 * sealed handoff blob comes back via provider-callback, and the token exchange
 * issues access + refresh tokens. Blob sealing is replicated locally with the
 * same AES-256-GCM layout the auth server uses (sha256(secret) key, iv|ct|tag).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  handleAuthorizeGet,
  handleAuthorizePost,
  handleAuthServerMetadata,
  handleProviderStart,
  handleProviderCallbackGet,
  handleProviderCallbackPost,
  handleTokenExchange,
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

/** Run provider-start and pull the minted mcp_state out of the redirect. */
function startProviderFlow(): string {
  const result = handleProviderStart(providerStartQuery());
  expect(result.status).toBe(302);
  const location = new URL(result.headers.Location);
  expect(location.pathname).toBe('/api/v1/oauth/start');
  expect(location.searchParams.get('provider')).toBe('google');
  expect(location.searchParams.get('flow')).toBe('mcp');
  const mcpState = location.searchParams.get('mcp_state');
  expect(mcpState).toMatch(/^[a-f0-9]{32}$/);
  return mcpState as string;
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
    const mcpState = startProviderFlow();
    const result = handleProviderCallbackGet(new URLSearchParams({ mcp_state: mcpState, error: 'provider' }));
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
    const mcpState = startProviderFlow();
    const handoff = sealHandoff({ s: mcpState });
    const result = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff }).toString());
    expect(result.status).toBe(302);
    const location = new URL(result.headers.Location);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get('state')).toBe('state-123');
    expect(location.searchParams.get('code')).toMatch(/^[a-f0-9]{64}$/);
  });

  test('POST rejects a handoff sealed for a different flow', async () => {
    const mcpState = startProviderFlow();
    const handoff = sealHandoff({ s: 'a'.repeat(32) });
    const result = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff }).toString());
    expect(result.status).toBe(200);
    expect(result.body).toContain('Sign-in expired or could not be verified');
  });

  test('POST with an invalid blob does NOT consume the flow (valid retry succeeds)', async () => {
    mockActiveSubscription();
    const mcpState = startProviderFlow();
    const bad = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff: 'garbage' }).toString());
    expect(bad.status).toBe(200);
    expect(bad.body).toContain('Sign-in expired or could not be verified');
    const good = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff: sealHandoff({ s: mcpState }) }).toString());
    expect(good.status).toBe(302);
  });

  test('POST rejects an expired handoff blob', async () => {
    const mcpState = startProviderFlow();
    const handoff = sealHandoff({ s: mcpState, e: Date.now() - 1000 });
    const result = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff }).toString());
    expect(result.status).toBe(200);
    expect(result.body).toContain('Sign-in expired or could not be verified');
  });

  test('POST consumes the flow (replay of the same mcp_state fails)', async () => {
    mockActiveSubscription();
    const mcpState = startProviderFlow();
    const handoff = sealHandoff({ s: mcpState });
    const first = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff }).toString());
    expect(first.status).toBe(302);
    const replay = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff }).toString());
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
    const mcpState = startProviderFlow();
    const handoff = sealHandoff({ s: mcpState });
    const result = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff }).toString());
    expect(fetched).toBe(false);
    expect(result.status).toBe(302);
    expect(new URL(result.headers.Location).searchParams.get('code')).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('token exchange for provider sign-ins', () => {
  /** Full provider flow -> exchange the auth code -> return the token response. */
  async function exchangeProviderCode(): Promise<Record<string, unknown>> {
    mockActiveSubscription();
    const mcpState = startProviderFlow();
    const handoff = sealHandoff({ s: mcpState, r: 'gotrue-refresh-1' });
    const cb = await handleProviderCallbackPost(new URLSearchParams({ mcp_state: mcpState, handoff }).toString());
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
