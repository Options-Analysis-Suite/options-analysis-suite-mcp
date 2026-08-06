import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { handleHttpRequest as HandleHttpRequest } from './remote.js';
import type { extractApiKey as ExtractApiKey } from './remote.js';
import type { parseRequestUrl as ParseRequestUrl } from './remote.js';
import type { ownerKeyFor as OwnerKeyFor } from './remote.js';

let parseRequestUrl: typeof ParseRequestUrl;
let extractApiKey: typeof ExtractApiKey;
let ownerKeyFor: typeof OwnerKeyFor;

/** Unsigned JWT with the given claims (payload is all this server reads). */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

describe('parseRequestUrl', () => {
  const BASE = 'https://mcp.example.com';

  beforeAll(async () => {
    const originalTokenSecret = process.env.OAS_TOKEN_SECRET;
    delete process.env.OAS_TOKEN_SECRET;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      ({ parseRequestUrl, extractApiKey, ownerKeyFor } = await import('./remote.js'));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      if (originalTokenSecret === undefined) {
        delete process.env.OAS_TOKEN_SECRET;
      } else {
        process.env.OAS_TOKEN_SECRET = originalTokenSecret;
      }
      warn.mockRestore();
    }
  });

  test('parses a normal pathname against the base URL', () => {
    const url = parseRequestUrl('/health', BASE);
    expect(url).toBeInstanceOf(URL);
    expect(url?.pathname).toBe('/health');
    expect(url?.origin).toBe(BASE);
  });

  test('falls back to "/" when req.url is undefined', () => {
    const url = parseRequestUrl(undefined, BASE);
    expect(url?.pathname).toBe('/');
  });

  test('returns null and warns when the request target is malformed', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const url = parseRequestUrl('http://[::1', BASE);
      expect(url).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const [message, ctx] = warn.mock.calls[0] as [string, { url?: string; err?: string }];
      expect(message).toBe('[OAS MCP Remote] invalid request target');
      expect(ctx.url).toBe('http://[::1');
      expect(typeof ctx.err).toBe('string');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('extractApiKey', () => {
  test('rejects oauth-access credentials from direct API-key headers', () => {
    expect(extractApiKey({ authorization: 'Api-Key oauth-access:header.jwt' })).toBeNull();
    expect(extractApiKey({ 'x-api-key': 'oauth-access:header.jwt' })).toBeNull();
  });
});

describe('ownerKeyFor (session identity survives bearer rotation)', () => {
  test('two different bearers for the SAME GoTrue session map to one owner key', () => {
    // The refresh grant hands out a fresh JWT (new iat/exp) hourly, but the
    // session_id claim is stable for the life of the GoTrue session. Owner
    // identity must follow session_id, not the raw bearer string - otherwise a
    // refreshed client gets locked out of its own MCP session (Codex finding 1).
    const first = `oauth-access:${jwt({ session_id: 'sess-abc', exp: 1000, iat: 1 })}`;
    const second = `oauth-access:${jwt({ session_id: 'sess-abc', exp: 5000, iat: 2 })}`;
    expect(ownerKeyFor(first)).toBe(ownerKeyFor(second));
    expect(ownerKeyFor(first)).toBe('sid:sess-abc');
  });

  test('different GoTrue sessions get distinct owner keys', () => {
    const a = `oauth-access:${jwt({ session_id: 'sess-a', exp: 1000 })}`;
    const b = `oauth-access:${jwt({ session_id: 'sess-b', exp: 1000 })}`;
    expect(ownerKeyFor(a)).not.toBe(ownerKeyFor(b));
  });

  test('a token with no session_id falls back to a per-token hash (no cross-token collisions)', () => {
    const a = `oauth-access:${jwt({ exp: 1000 })}`;
    const b = `oauth-access:${jwt({ exp: 2000 })}`;
    expect(ownerKeyFor(a)).toStartWith('tok:');
    expect(ownerKeyFor(a)).not.toBe(ownerKeyFor(b));
  });

  test('password credentials hash to a stable key (raw creds never become a map key)', () => {
    const key = Buffer.from('user@example.com:hunter2').toString('base64');
    expect(ownerKeyFor(key)).toBe(ownerKeyFor(key));
    expect(ownerKeyFor(key)).toStartWith('key:');
    expect(ownerKeyFor(key)).not.toContain('user@example.com');
  });
});

/**
 * The browser-binding seam. handleProviderStart/CallbackGet/CallbackPost can only
 * enforce the binding if the dispatcher hands them the request's Cookie header,
 * and that wiring is invisible to the handler-level tests in
 * oauth.provider.test.ts. Drive real requests through the exported dispatcher so
 * a rewire cannot pass unnoticed.
 */
describe('provider-flow cookie forwarding', () => {
  let handleHttpRequest: typeof HandleHttpRequest;
  const ORIGINAL_HANDOFF_SECRET = process.env.OAS_MCP_HANDOFF_SECRET;

  beforeAll(async () => {
    process.env.OAS_MCP_HANDOFF_SECRET = 'test-handoff-secret-0123456789abcdef';
    ({ handleHttpRequest } = await import('./remote.js'));
  });

  afterAll(() => {
    if (ORIGINAL_HANDOFF_SECRET === undefined) delete process.env.OAS_MCP_HANDOFF_SECRET;
    else process.env.OAS_MCP_HANDOFF_SECRET = ORIGINAL_HANDOFF_SECRET;
  });

  /** Minimal node http req/res pair: enough surface for the routes under test. */
  async function request(
    url: string,
    cookie?: string,
    postBody?: string,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const reqHeaders: Record<string, string> = cookie ? { cookie } : {};
    const req = (postBody === undefined
      ? { url, method: 'GET', headers: reqHeaders }
      : Object.assign(Readable.from([Buffer.from(postBody)]), { url, method: 'POST', headers: reqHeaders })
    ) as unknown as IncomingMessage;
    let status = 0;
    let headers: Record<string, string> = {};
    let body = '';
    const res = {
      headersSent: false,
      setHeader() {},
      writeHead(code: number, given?: Record<string, string>) {
        status = code;
        headers = { ...headers, ...(given ?? {}) };
        return res;
      },
      end(chunk?: string) { body = chunk ?? ''; },
    } as unknown as ServerResponse;
    await handleHttpRequest(req, res);
    return { status, headers, body };
  }

  const START = '/oauth/provider-start?provider=google&client_id=c&redirect_uri='
    + encodeURIComponent('https://claude.ai/api/mcp/auth_callback')
    + '&state=s&code_challenge=' + 'x'.repeat(43) + '&code_challenge_method=S256&scope=mcp';

  test('a flow started through the dispatcher is finishable only with the cookie it set', async () => {
    const start = await request(START);
    expect(start.status).toBe(302);
    const setCookie = start.headers['Set-Cookie'];
    expect(setCookie).toStartWith('oas_mcp_flow=');
    const mcpState = new URL(start.headers.Location).searchParams.get('mcp_state') as string;

    // Without the cookie the dispatcher's callback refuses: the binding reached
    // the handler, which means the header was forwarded on both calls.
    const unbound = await request(`/oauth/provider-callback?mcp_state=${mcpState}&error=provider`);
    expect(unbound.status).toBe(400);
    expect(unbound.body).toContain('Sign-in could not be verified');

    const bound = await request(`/oauth/provider-callback?mcp_state=${mcpState}&error=provider`, setCookie.split(';')[0]);
    expect(bound.status).toBe(200);
    expect(bound.body).toContain('The provider could not sign you in');
  });

  test('the POST callback sees the cookie too', async () => {
    const start = await request(START);
    const cookie = start.headers['Set-Cookie'].split(';')[0];
    const mcpState = new URL(start.headers.Location).searchParams.get('mcp_state') as string;
    const post = `mcp_state=${mcpState}&handoff=garbage`;

    // Unbound: refused before the blob is even opened.
    const unbound = await request('/oauth/provider-callback', undefined, post);
    expect(unbound.status).toBe(400);
    expect(unbound.body).toContain('Sign-in could not be verified');

    // Bound: the binding passes and the request fails later, on the bad blob.
    const bound = await request('/oauth/provider-callback', cookie, post);
    expect(bound.status).toBe(200);
    expect(bound.body).toContain('Sign-in expired or could not be verified');
  });

  test('the consent POST route is wired and sees the cookie', async () => {
    // A shared-gateway target parks the grant behind a confirmation, so the
    // consent POST must reach handleConsentPost WITH the browser's cookie or the
    // connection can never be approved by anyone.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const body = String(url).endsWith('/api/v1/auth/login')
        ? { token: `${jwt({ exp: Math.floor(Date.now() / 1000) + 3600 })}` }
        : { user: { isDeveloper: false, bypassSubscription: false }, subscription: { status: 'active' } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const authorize = new URLSearchParams({
        email: 'user@example.com',
        password: 'hunter2hunter2',
        client_id: 'c',
        redirect_uri: 'https://smithery.run/oauth/callback',
        state: 'st',
        code_challenge: 'x'.repeat(43),
        code_challenge_method: 'S256',
      }).toString();
      const held = await request('/oauth/authorize', undefined, authorize);
      expect(held.status).toBe(200);
      expect(held.body).toContain('Confirm this connection');
      const consentCookie = held.headers['Set-Cookie'].split(';')[0];
      const consentId = (held.body.match(/name="consent_id" value="([a-f0-9]{32})"/) as RegExpMatchArray)[1];
      const approve = `consent_id=${consentId}&decision=approve`;

      const unbound = await request('/oauth/consent', undefined, approve);
      expect(unbound.status).toBe(400);
      expect(unbound.body).toContain('Sign-in could not be verified');

      // A second confirmation opened in the same browser must join the jar
      // rather than evict the first, which only happens if the dispatcher hands
      // the authorize POST the request's cookie too.
      const secondHeld = await request('/oauth/authorize', consentCookie, authorize);
      expect(secondHeld.status).toBe(200);
      expect(secondHeld.headers['Set-Cookie']).toContain(consentId);

      const bound = await request('/oauth/consent', consentCookie, approve);
      expect(bound.status).toBe(302);
      expect(bound.headers.Location).toStartWith('https://smithery.run/oauth/callback?code=');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('flow-proof is wired and sees the cookie', async () => {
    // Same gap class as the routes above: oauth.flowproof.test.ts injects the
    // cookie directly, so dropping the dispatcher's forwarding would leave all of
    // it green while every legitimate bounce from the auth server looked unbound -
    // an early refusal for real users, which is worse than the bug being closed.
    const start = await request(START);
    const cookie = start.headers['Set-Cookie'].split(';')[0];
    const mcpState = new URL(start.headers.Location).searchParams.get('mcp_state') as string;
    const proofUrl = `/oauth/flow-proof?mcp_state=${mcpState}&nonce=${'b'.repeat(32)}`;

    const unbound = await request(proofUrl);
    expect(unbound.status).toBe(400);
    expect(unbound.headers.Location).toBeUndefined();

    const bound = await request(proofUrl, cookie);
    expect(bound.status).toBe(302);
    expect(new URL(bound.headers.Location).searchParams.get('flow_proof')).toMatch(/^[a-f0-9]{64}$/);
  });

  test('provider-start carries an existing binding forward through the dispatcher', async () => {
    const first = await request(START);
    const firstCookie = first.headers['Set-Cookie'].split(';')[0];
    const firstState = new URL(first.headers.Location).searchParams.get('mcp_state') as string;

    const second = await request(START, firstCookie);
    expect(second.headers['Set-Cookie']).toContain(firstState);
  });
});
