// S2.4 / #69: HTTP-layer tests for the auth client's GoTrue integration - the trusted-proxy
// login header, capturing the gotrueRefreshToken cookie at login, and refreshing via
// /oauth/refresh (with rotation + fail-on-no-session/MFA so the caller re-logins).
import { describe, expect, test, afterEach } from 'bun:test';
import { login, refreshAccessToken } from './authClient.js';

const ORIG_FETCH = globalThis.fetch;
const ORIG_SECRET = process.env.MCP_PROXY_SECRET;
const URL = 'https://api.example.com';

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  if (ORIG_SECRET === undefined) delete process.env.MCP_PROXY_SECRET;
  else process.env.MCP_PROXY_SECRET = ORIG_SECRET;
});

type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
function stubFetch(fn: FetchFn): void {
  globalThis.fetch = fn as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init?: { status?: number; setCookie?: string }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init?.setCookie) headers['Set-Cookie'] = init.setCookie;
  return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers });
}

describe('authClient.login - #69 proxy header + GoTrue cookie capture', () => {
  test('sends x-mcp-proxy-secret when MCP_PROXY_SECRET is set and captures the gotrueRefreshToken cookie', async () => {
    process.env.MCP_PROXY_SECRET = 'secret-xyz';
    const cap: { header: string | null; url: string } = { header: null, url: '' };
    stubFetch(async (url, init) => {
      cap.url = String(url);
      cap.header = new Headers(init?.headers).get('x-mcp-proxy-secret');
      return jsonResponse({ accessToken: 'a.b.c' }, { setCookie: 'gotrueRefreshToken=rt-1; Path=/api/v1/oauth; HttpOnly; SameSite=Lax' });
    });

    const tokens = await login(URL, 'u@e.com', 'pw');
    expect(cap.url).toEndWith('/api/v1/auth/login');
    expect(cap.header).toBe('secret-xyz');
    expect(tokens.accessToken).toBe('a.b.c');
    expect(tokens.refreshToken).toBe('rt-1');
  });

  test('omits the header when MCP_PROXY_SECRET is unset (local extension)', async () => {
    delete process.env.MCP_PROXY_SECRET;
    const cap: { header: string | null } = { header: 'present' };
    stubFetch(async (_url, init) => {
      cap.header = new Headers(init?.headers).get('x-mcp-proxy-secret');
      return jsonResponse({ accessToken: 'a.b.c' }, { setCookie: 'gotrueRefreshToken=rt-1' });
    });

    await login(URL, 'u@e.com', 'pw');
    expect(cap.header).toBeNull();
  });
});

describe('authClient.refreshAccessToken - #69 /oauth/refresh', () => {
  test('POSTs /oauth/refresh with the gotrueRefreshToken cookie and captures a rotated cookie', async () => {
    const cap: { url: string; cookie: string | null } = { url: '', cookie: null };
    stubFetch(async (url, init) => {
      cap.url = String(url);
      cap.cookie = new Headers(init?.headers).get('cookie');
      return jsonResponse({ accessToken: 'new.a.b' }, { setCookie: 'gotrueRefreshToken=rt-2; Path=/api/v1/oauth' });
    });

    const tokens = await refreshAccessToken(URL, 'rt-1');
    expect(cap.url).toEndWith('/api/v1/oauth/refresh');
    expect(cap.cookie).toBe('gotrueRefreshToken=rt-1');
    expect(tokens.accessToken).toBe('new.a.b');
    expect(tokens.refreshToken).toBe('rt-2');
  });

  test('keeps the current refresh token when no rotated cookie is returned', async () => {
    stubFetch(async () => jsonResponse({ accessToken: 'new.a.b' }));
    const tokens = await refreshAccessToken(URL, 'rt-1');
    expect(tokens.refreshToken).toBe('rt-1');
  });

  test('throws on an empty refresh token without hitting the network (caller re-logins)', async () => {
    const cap = { called: false };
    stubFetch(async () => { cap.called = true; return jsonResponse({ accessToken: 'x' }); });
    await expect(refreshAccessToken(URL, '')).rejects.toThrow();
    expect(cap.called).toBe(false);
  });

  test('throws on a 200 no_session response', async () => {
    stubFetch(async () => jsonResponse({ accessToken: null, status: 'no_session' }));
    await expect(refreshAccessToken(URL, 'rt-1')).rejects.toThrow();
  });

  test('throws on requiresMfa (background refresh cannot service step-up)', async () => {
    stubFetch(async () => jsonResponse({ requiresMfa: true, code: 'mfa_required' }));
    await expect(refreshAccessToken(URL, 'rt-1')).rejects.toThrow();
  });

  test('throws on a non-ok response (expired/invalid session)', async () => {
    stubFetch(async () => jsonResponse({ error: 'Session expired' }, { status: 401 }));
    await expect(refreshAccessToken(URL, 'rt-1')).rejects.toThrow();
  });
});
