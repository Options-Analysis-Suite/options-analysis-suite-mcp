import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { handleAuthorizeGet, handleAuthorizePost, handleTokenExchange } from './oauth.js';

// Cover the redirect-URI allowlist via the public route handler (no need to
// export the internal validator). handleAuthorizeGet returns a 400 with
// `Redirect URI not allowed` whenever isRedirectAllowed rejects, and a 200
// HTML login form when it accepts.
function authorize(redirectUri: string) {
  const q = new URLSearchParams();
  q.set('client_id', 'test');
  q.set('redirect_uri', redirectUri);
  q.set('state', 'xyz');
  q.set('code_challenge', 'a'.repeat(43));
  q.set('code_challenge_method', 'S256');
  return handleAuthorizeGet(q);
}

const isAllowed = (uri: string) => authorize(uri).status === 200;
const isRejected = (uri: string) => {
  const r = authorize(uri);
  return r.status === 400 && r.body.includes('Redirect URI not allowed');
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function authorizePostBody(overrides: Record<string, string> = {}) {
  const q = new URLSearchParams();
  q.set('email', 'dev@example.com');
  q.set('password', 'correct-password');
  q.set('client_id', 'test-client');
  q.set('redirect_uri', 'https://chatgpt.com/connector/oauth/cb_abc123');
  q.set('state', 'state-123');
  q.set('code_challenge', 'a'.repeat(43));
  q.set('code_challenge_method', 'S256');
  for (const [key, value] of Object.entries(overrides)) q.set(key, value);
  return q;
}

describe('OAuth redirect URI allowlist', () => {
  test('accepts exact-allowlist entries', () => {
    expect(isAllowed('https://chatgpt.com/aip/oauth/callback')).toBe(true);
    expect(isAllowed('https://chat.openai.com/aip/oauth/callback')).toBe(true);
    expect(isAllowed('https://chatgpt.com/connector_platform_oauth_redirect')).toBe(true);
    expect(isAllowed('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(isAllowed('https://claude.com/api/mcp/auth_callback')).toBe(true);
    expect(isAllowed('http://localhost:6274/oauth/callback')).toBe(true);
    expect(isAllowed('http://localhost:6274/oauth/callback/debug')).toBe(true);
  });

  test('accepts ChatGPT/OpenAI variable-app callback paths', () => {
    expect(isAllowed('https://chatgpt.com/g-abc123/oauth/callback')).toBe(true);
    expect(isAllowed('https://chat.openai.com/g-abc123/oauth/callback')).toBe(true);
  });

  test('accepts current ChatGPT Apps connector callback paths', () => {
    expect(isAllowed('https://chatgpt.com/connector/oauth/cb_abc123')).toBe(true);
    expect(isAllowed('https://chatgpt.com/connector/oauth/app-123_ABC')).toBe(true);
  });

  test('rejects arbitrary chatgpt.com paths (the original CVE)', () => {
    expect(isRejected('https://chatgpt.com/evil')).toBe(true);
    expect(isRejected('https://chatgpt.com/')).toBe(true);
    expect(isRejected('https://chat.openai.com/anything')).toBe(true);
    expect(isRejected('https://chatgpt.com/connector/oauth/')).toBe(true);
    expect(isRejected('https://chatgpt.com/connector/oauth/cb_abc123/extra')).toBe(true);
    expect(isRejected('https://chatgpt.com/connector/oauth/cb.abc123')).toBe(true);
  });

  test('rejects look-alike origins (chatgpt.com.evil.com)', () => {
    expect(isRejected('https://chatgpt.com.evil.com/aip/oauth/callback')).toBe(true);
    expect(isRejected('https://chatgpt.com.evil.com/connector/oauth/cb_abc123')).toBe(true);
    expect(isRejected('https://evil.com/chatgpt.com/aip/oauth/callback')).toBe(true);
    expect(isRejected('https://evil.com/connector/oauth/cb_abc123')).toBe(true);
    expect(isRejected('https://notchatgpt.com/aip/oauth/callback')).toBe(true);
  });

  test('rejects malformed URLs', () => {
    expect(isRejected('not-a-url')).toBe(true);
    expect(isRejected('javascript:alert(1)')).toBe(true);
    expect(isRejected('//chatgpt.com/aip/oauth/callback')).toBe(true);
  });
});

describe('OAuth MFA step-up', () => {
  test('renders a two-factor challenge when password login requires MFA', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      expect(String(url)).toEndWith('/api/v1/auth/login');
      return new Response(JSON.stringify({
        requiresMfa: true,
        code: 'mfa_required',
        stepUpToken: 'step-token-1',
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': 'gotrueRefreshToken=refresh-1; Path=/api/v1/oauth; HttpOnly; SameSite=Lax',
        },
      });
    }) as typeof fetch;

    const response = await handleAuthorizePost(authorizePostBody().toString());

    expect(response.status).toBe(200);
    expect(response.body).toContain('Two-factor verification');
    expect(response.body).toContain('name="mfa_flow_id"');
    expect(response.body).toContain('name="mfa_code"');
    expect(response.body).not.toContain('Login service unavailable');
    expect(response.body).not.toContain('step-token-1');
    expect(response.body).not.toContain('refresh-1');
  });

  test('verifies MFA code and redirects with an OAuth authorization code', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push(href);
      if (href.endsWith('/api/v1/auth/login')) {
        return new Response(JSON.stringify({
          requiresMfa: true,
          code: 'mfa_required',
          stepUpToken: 'step-token-2',
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': 'gotrueRefreshToken=refresh-2; Path=/api/v1/oauth; HttpOnly; SameSite=Lax',
          },
        });
      }
      if (href.endsWith('/api/csrf-token')) {
        const headers = new Headers({ 'Content-Type': 'application/json' });
        headers.append('Set-Cookie', 'gotrueRefreshToken=refresh-rotated; Path=/api/v1/oauth; HttpOnly; SameSite=Lax');
        headers.append('Set-Cookie', 'psifi.x-csrf-token=csrf-cookie-1; Path=/; HttpOnly; SameSite=Strict');
        return new Response(JSON.stringify({ csrfToken: 'csrf-token-1' }), {
          status: 200,
          headers,
        });
      }
      if (href.endsWith('/api/v1/oauth/mfa/factors')) {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer step-token-2');
        expect((init?.headers as Record<string, string>).Cookie).toContain('gotrueRefreshToken=refresh-2');
        return Response.json({ factors: [{ id: 'factor-1', status: 'verified', factor_type: 'totp' }] });
      }
      if (href.endsWith('/api/v1/oauth/mfa/challenge')) {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer step-token-2');
        expect(headers.Cookie).not.toContain('gotrueRefreshToken=refresh-2');
        expect(headers.Cookie).toContain('gotrueRefreshToken=refresh-rotated');
        expect(headers.Cookie).toContain('psifi.x-csrf-token=csrf-cookie-1');
        expect(headers['X-CSRF-Token']).toBe('csrf-token-1');
        expect(JSON.parse(String(init?.body))).toEqual({ factorId: 'factor-1' });
        return Response.json({ challengeId: 'challenge-1' });
      }
      if (href.endsWith('/api/v1/oauth/mfa/verify')) {
        expect(JSON.parse(String(init?.body))).toEqual({
          factorId: 'factor-1',
          challengeId: 'challenge-1',
          code: '123456',
        });
        return Response.json({ accessToken: 'aal2-access-token' });
      }
      if (href.endsWith('/api/v1/user/profile')) {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer aal2-access-token');
        return Response.json({
          user: { id: 1, email: 'dev@example.com', role: 'super_admin', isDeveloper: true },
          subscription: null,
        });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    }) as typeof fetch;

    const first = await handleAuthorizePost(authorizePostBody().toString());
    const flowId = first.body.match(/name="mfa_flow_id" value="([^"]+)"/)?.[1];
    expect(flowId).toBeTruthy();

    const secondBody = authorizePostBody({
      mfa_flow_id: flowId!,
      mfa_code: '123456',
    });
    const second = await handleAuthorizePost(secondBody.toString());

    expect(second.status).toBe(302);
    const location = new URL(second.headers.Location);
    expect(location.origin + location.pathname).toBe('https://chatgpt.com/connector/oauth/cb_abc123');
    expect(location.searchParams.get('code')).toBeTruthy();
    expect(location.searchParams.get('state')).toBe('state-123');
    expect(calls).toEqual([
      'https://api.optionsanalysissuite.com/api/v1/auth/login',
      'https://api.optionsanalysissuite.com/api/csrf-token',
      'https://api.optionsanalysissuite.com/api/v1/oauth/mfa/factors',
      'https://api.optionsanalysissuite.com/api/v1/oauth/mfa/challenge',
      'https://api.optionsanalysissuite.com/api/v1/oauth/mfa/verify',
      'https://api.optionsanalysissuite.com/api/v1/user/profile',
    ]);
  });

  test('locks an MFA flow after repeated invalid codes', async () => {
    let verifyCalls = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/api/v1/auth/login')) {
        return new Response(JSON.stringify({
          requiresMfa: true,
          code: 'mfa_required',
          stepUpToken: 'step-token-lockout',
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': 'gotrueRefreshToken=refresh-lockout; Path=/api/v1/oauth; HttpOnly; SameSite=Lax',
          },
        });
      }
      if (href.endsWith('/api/csrf-token')) {
        return Response.json({ csrfToken: 'csrf-token-lockout' });
      }
      if (href.endsWith('/api/v1/oauth/mfa/factors')) {
        return Response.json({ factors: [{ id: 'factor-lockout', status: 'verified', factor_type: 'totp' }] });
      }
      if (href.endsWith('/api/v1/oauth/mfa/challenge')) {
        return Response.json({ challengeId: 'challenge-lockout' });
      }
      if (href.endsWith('/api/v1/oauth/mfa/verify')) {
        verifyCalls += 1;
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer step-token-lockout');
        return new Response(JSON.stringify({ error: 'invalid_code' }), { status: 401 });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    }) as typeof fetch;

    const first = await handleAuthorizePost(authorizePostBody().toString());
    const flowId = first.body.match(/name="mfa_flow_id" value="([^"]+)"/)?.[1];
    expect(flowId).toBeTruthy();

    for (const code of ['111111', '222222']) {
      const retry = await handleAuthorizePost(authorizePostBody({
        mfa_flow_id: flowId!,
        mfa_code: code,
      }).toString());
      expect(retry.status).toBe(200);
      expect(retry.body).toContain('That code didn&#39;t match. Try again.');
      expect(retry.body).toContain(`value="${flowId}"`);
    }

    const locked = await handleAuthorizePost(authorizePostBody({
      mfa_flow_id: flowId!,
      mfa_code: '333333',
    }).toString());
    expect(locked.status).toBe(400);
    expect(locked.body).toContain('Too many invalid two-factor codes. Start sign-in again.');
    expect(verifyCalls).toBe(3);

    const afterLockout = await handleAuthorizePost(authorizePostBody({
      mfa_flow_id: flowId!,
      mfa_code: '123456',
    }).toString());
    expect(afterLockout.status).toBe(400);
    expect(afterLockout.body).toContain('Two-factor verification expired. Start sign-in again.');
    expect(verifyCalls).toBe(3);
  });

});

describe('connector OAuth telemetry (PII-free)', () => {
  // Capture console.log for the duration of fn, always restoring it.
  async function capture(fn: () => Promise<unknown> | unknown): Promise<string[]> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try { await fn(); } finally { console.log = original; }
    return lines;
  }
  const tokenExchangeLines = (lines: string[]) => lines.filter((l) => l.includes('"event":"token_exchange"'));
  const codeIssuedLines = (lines: string[]) => lines.filter((l) => l.includes('"event":"code_issued"'));
  const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);

  // A lean MFA login mock (verified factor, correct code 123456) so the flow
  // reaches issueAuthorizationRedirect. Distinct from the strict-assert mock in
  // the MFA describe block: here the endpoint contract is not under test, the
  // telemetry it produces is.
  function mfaLoginFetch(): typeof fetch {
    return (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/api/v1/auth/login')) {
        return new Response(JSON.stringify({ requiresMfa: true, code: 'mfa_required', stepUpToken: 'step-tok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'gotrueRefreshToken=refresh-x; Path=/api/v1/oauth; HttpOnly; SameSite=Lax' },
        });
      }
      if (href.endsWith('/api/csrf-token')) {
        const headers = new Headers({ 'Content-Type': 'application/json' });
        headers.append('Set-Cookie', 'gotrueRefreshToken=refresh-rot; Path=/api/v1/oauth; HttpOnly; SameSite=Lax');
        headers.append('Set-Cookie', 'psifi.x-csrf-token=csrf-cookie; Path=/; HttpOnly; SameSite=Strict');
        return new Response(JSON.stringify({ csrfToken: 'csrf-tok' }), { status: 200, headers });
      }
      if (href.endsWith('/api/v1/oauth/mfa/factors')) return Response.json({ factors: [{ id: 'factor-1', status: 'verified', factor_type: 'totp' }] });
      if (href.endsWith('/api/v1/oauth/mfa/challenge')) return Response.json({ challengeId: 'challenge-1' });
      if (href.endsWith('/api/v1/oauth/mfa/verify')) return Response.json({ accessToken: 'aal2-access-token' });
      if (href.endsWith('/api/v1/user/profile')) return Response.json({ user: { id: 1, email: 'dev@example.com', role: 'super_admin', isDeveloper: true }, subscription: null });
      throw new Error(`Unexpected fetch: ${href}`);
    }) as typeof fetch;
  }

  // Drive the full login → 302 and return the issued code plus the console
  // lines captured during issuance (which carry the `code_issued` event).
  async function issueCode(overrides: Record<string, string> = {}): Promise<{ code: string; issueLines: string[] }> {
    globalThis.fetch = mfaLoginFetch();
    const first = await handleAuthorizePost(authorizePostBody(overrides).toString());
    const flowId = first.body.match(/name="mfa_flow_id" value="([^"]+)"/)?.[1];
    expect(flowId).toBeTruthy();
    let code = '';
    const issueLines = await capture(async () => {
      const second = await handleAuthorizePost(authorizePostBody({ ...overrides, mfa_flow_id: flowId!, mfa_code: '123456' }).toString());
      expect(second.status).toBe(302);
      code = new URL(second.headers.Location).searchParams.get('code') || '';
    });
    expect(code).toBeTruthy();
    return { code, issueLines };
  }

  test('a failed exchange logs exactly one outcome, by code fingerprint, never the raw code or client id', async () => {
    const rawCode = 'deadbeef'.repeat(8); // 64 hex, same shape as a real code
    const rawClient = 'client-secret-looking-id-xyz';
    let res: Awaited<ReturnType<typeof handleTokenExchange>> | undefined;
    const lines = await capture(async () => {
      res = await handleTokenExchange(new URLSearchParams({
        grant_type: 'authorization_code',
        code: rawCode,            // never issued, so this is the unknown-code path
        client_id: rawClient,
        redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
        code_verifier: 'v'.repeat(43),
      }).toString());
    });
    expect(res!.status).toBe(400);

    // Exactly one outcome line for one call, and no double-logging.
    const events = tokenExchangeLines(lines);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"outcome":"unknown_or_expired_code"');

    // Identified by fingerprint; the raw secrets appear nowhere.
    const codeFp = createHash('sha256').update(rawCode).digest('hex').slice(0, 12);
    expect(events[0]).toContain(`"code":"${codeFp}"`);
    const joined = lines.join('\n');
    expect(joined).not.toContain(rawCode);
    expect(joined).not.toContain(rawClient);
  });

  test('grant_type is reduced to a bounded label, never the request-controlled string', async () => {
    const pii = 'user@example.com/secret-token-value';
    const lines = await capture(() => handleTokenExchange(new URLSearchParams({
      grant_type: pii,
    }).toString()));
    const events = tokenExchangeLines(lines);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"outcome":"unsupported_grant_type"');
    expect(events[0]).toContain('"grant":"other"');
    expect(lines.join('\n')).not.toContain(pii);
  });

  test('redirect_uri is reduced to a bounded label, never the request-controlled host/path', async () => {
    const lines = await capture(() => handleTokenExchange(new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'never-issued',
      redirect_uri: 'https://evil.example/leaked-path-segment-1234?token=abc',
      code_verifier: 'v'.repeat(43),
    }).toString()));
    const events = tokenExchangeLines(lines);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"redirect":"other"');
    const joined = lines.join('\n');
    expect(joined).not.toContain('evil.example');
    expect(joined).not.toContain('leaked-path-segment-1234');
    expect(joined).not.toContain('token=abc');
  });

  test('a throwing logger never breaks the exchange (fail-open)', async () => {
    const original = console.log;
    console.log = () => { throw new Error('logger down'); };
    try {
      const res = await handleTokenExchange(new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'never-issued',
        redirect_uri: 'https://chatgpt.com/connector/oauth/cb_x',
        code_verifier: 'v'.repeat(43),
      }).toString());
      expect(res.status).toBe(400); // the intended response, not a thrown error
      expect(res.body).toContain('invalid_grant');
    } finally {
      console.log = original;
    }
  });

  test('a refresh_token grant logs exactly one refresh_delegated outcome', async () => {
    globalThis.fetch = (async (_url: string | URL | Request) => Response.json({ error: 'no' }, { status: 400 })) as typeof fetch;
    const lines = await capture(() => handleTokenExchange(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'rt-value',
      client_id: 'test-client',
    }).toString()));
    const events = tokenExchangeLines(lines);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"outcome":"refresh_delegated"');
    expect(events[0]).toContain('"grant":"refresh_token"');
    expect(lines.join('\n')).not.toContain('rt-value');
  });

  test('code issuance logs exactly one PII-free code_issued event, by fingerprint', async () => {
    const { code, issueLines } = await issueCode();
    const issued = codeIssuedLines(issueLines);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toContain(`"code":"${fingerprint(code)}"`);
    expect(issued[0]).toContain('"redirect":"chatgpt"');
    expect(issued[0]).toContain('"hasState":true');
    expect(issued[0]).toContain('"pkce":"S256"');
    expect(issued[0]).toContain('"ttlSec":300');
    // The raw code that lands in the browser redirect never appears in a log.
    expect(issueLines.join('\n')).not.toContain(code);
  });

  test('an issued code pairs issuance to exchange by the same fingerprint (client_mismatch)', async () => {
    const { code, issueLines } = await issueCode();
    const lines = await capture(() => handleTokenExchange(new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: 'a-different-client',
      redirect_uri: 'https://chatgpt.com/connector/oauth/cb_abc123',
      code_verifier: 'v'.repeat(43),
    }).toString()));
    const events = tokenExchangeLines(lines);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"outcome":"client_mismatch"');
    // Same fingerprint on both events is what lets support pair a hung connect.
    const fp = fingerprint(code);
    expect(codeIssuedLines(issueLines)[0]).toContain(`"code":"${fp}"`);
    expect(events[0]).toContain(`"code":"${fp}"`);
  });

  test('a PKCE mismatch on an issued code logs exactly one pkce_mismatch', async () => {
    const { code } = await issueCode();
    const lines = await capture(() => handleTokenExchange(new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: 'test-client',
      redirect_uri: 'https://chatgpt.com/connector/oauth/cb_abc123',
      code_verifier: 'wrong-verifier-that-does-not-hash-to-the-challenge',
    }).toString()));
    const events = tokenExchangeLines(lines);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"outcome":"pkce_mismatch"');
  });

  test('a redirect mismatch on an issued code logs exactly one redirect_mismatch', async () => {
    const verifier = 'pkce-verifier-' + 'z'.repeat(40);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const { code } = await issueCode({ code_challenge: challenge });
    const lines = await capture(() => handleTokenExchange(new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: 'test-client',
      redirect_uri: 'https://chatgpt.com/connector/oauth/cb_a_DIFFERENT_path',
      code_verifier: verifier,
    }).toString()));
    const events = tokenExchangeLines(lines);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"outcome":"redirect_mismatch"');
  });

  test('a valid exchange logs exactly one success', async () => {
    const originalSecret = process.env.OAS_TOKEN_SECRET;
    try {
      process.env.OAS_TOKEN_SECRET = 'token-secret-for-tests-0123456789';
      const verifier = 'pkce-verifier-' + 'y'.repeat(40);
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const { code } = await issueCode({ code_challenge: challenge });
      let res: Awaited<ReturnType<typeof handleTokenExchange>> | undefined;
      const lines = await capture(async () => {
        res = await handleTokenExchange(new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: 'test-client',
          redirect_uri: 'https://chatgpt.com/connector/oauth/cb_abc123',
          code_verifier: verifier,
        }).toString());
      });
      expect(res!.status).toBe(200);
      const events = tokenExchangeLines(lines);
      expect(events).toHaveLength(1);
      expect(events[0]).toContain('"outcome":"success"');
    } finally {
      if (originalSecret === undefined) delete process.env.OAS_TOKEN_SECRET;
      else process.env.OAS_TOKEN_SECRET = originalSecret;
    }
  });

  test('an encryption failure logs exactly one encryption_unconfigured', async () => {
    const originalSecret = process.env.OAS_TOKEN_SECRET;
    try {
      delete process.env.OAS_TOKEN_SECRET; // tokenKey() -> null -> encryptToken throws
      const verifier = 'pkce-verifier-' + 'x'.repeat(40);
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const { code } = await issueCode({ code_challenge: challenge });
      let res: Awaited<ReturnType<typeof handleTokenExchange>> | undefined;
      const lines = await capture(async () => {
        res = await handleTokenExchange(new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: 'test-client',
          redirect_uri: 'https://chatgpt.com/connector/oauth/cb_abc123',
          code_verifier: verifier,
        }).toString());
      });
      expect(res!.status).toBe(500);
      const events = tokenExchangeLines(lines);
      expect(events).toHaveLength(1);
      expect(events[0]).toContain('"outcome":"encryption_unconfigured"');
    } finally {
      if (originalSecret === undefined) delete process.env.OAS_TOKEN_SECRET;
      else process.env.OAS_TOKEN_SECRET = originalSecret;
    }
  });
});

// The sign-in page on the website's card: the brand lockup, the website's heading and
// copy, the four provider marks in the website's order, the recovery link, and a policy that admits the logo from
// this origin and nothing else external.
describe('the sign-in page on the website card', () => {
  const LOCKUP = '<div class="lockup"><img src="/logo.webp" alt="" width="40" height="28"><span>Options Analysis Suite</span></div>';
  const REDIRECT = 'https://chatgpt.com/connector/oauth/cb_abc123';

  function signInPage() {
    return handleAuthorizeGet(new URLSearchParams({
      client_id: 'test', redirect_uri: REDIRECT, state: 'xyz', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256',
    }));
  }

  async function withProviders<T>(enabled: boolean, fn: () => T | Promise<T>): Promise<T> {
    const original = process.env.OAS_MCP_HANDOFF_SECRET;
    if (enabled) process.env.OAS_MCP_HANDOFF_SECRET = 'x'.repeat(40); // >= 32 chars enables providers
    else delete process.env.OAS_MCP_HANDOFF_SECRET;
    try {
      return await fn();
    } finally {
      if (original === undefined) delete process.env.OAS_MCP_HANDOFF_SECRET;
      else process.env.OAS_MCP_HANDOFF_SECRET = original;
    }
  }

  test('the card opens with the lockup, then the heading and the subtitle, under the website title', async () => {
    const body = await withProviders(true, () => signInPage().body);
    expect(body.split(LOCKUP).length - 1).toBe(1);
    expect(body).toContain('<h1>Connect your account</h1>');
    expect(body).toContain('<p class="subtitle">Log in to give your AI assistant access to your Options Analysis Suite account.</p>');
    expect(body).toContain('<title>Log in - Options Analysis Suite</title>');
    expect(body.indexOf(LOCKUP)).toBeLessThan(body.indexOf('<h1>'));
    expect(body).not.toContain('class="brand"');
    expect(body).not.toContain('class="hint"');
    expect(body).not.toContain('works only if you created a password');
  });

  test('with provider sign-in enabled, the four buttons carry the website marks in the website order, then the divider', async () => {
    const body = await withProviders(true, () => signInPage().body);
    const buttons = [...body.matchAll(/<a class="provider-btn" href="([^"]+)">([\s\S]*?)<\/a>/g)];
    expect(buttons.map((m) => m[2].replace(/<svg[\s\S]*?<\/svg>/, '').trim()))
      .toEqual(['Continue with Google', 'Continue with Microsoft', 'Continue with Apple', 'Continue with GitHub']);
    expect(buttons.map((m) => new URL(m[1].replace(/&amp;/g, '&'), 'https://mcp.test').searchParams.get('provider')))
      .toEqual(['google', 'azure', 'apple', 'github']);
    const marks = buttons.map((m) => m[2].match(/<svg[^>]*>[\s\S]*?<\/svg>/)?.[0] ?? '');
    expect(marks.every((svg) => svg.includes('aria-hidden="true"'))).toBe(true);
    expect(marks[0]).toContain('viewBox="0 0 18 18"');
    for (const fill of ['#4285F4', '#34A853', '#FBBC05', '#EA4335']) expect(marks[0]).toContain(`fill="${fill}"`);
    expect(marks[1]).toContain('viewBox="0 0 21 21"');
    for (const fill of ['#f25022', '#7fba00', '#00a4ef', '#ffb900']) expect(marks[1]).toContain(`fill="${fill}"`);
    expect(marks[2]).toContain('viewBox="0 0 384 512"');
    expect(marks[2]).toContain('fill="currentColor"');
    expect(marks[3]).toContain('viewBox="0 0 496 512"');
    expect(marks[3]).toContain('fill="currentColor"');
    expect(body).toContain('<div class="divider"><span>or</span></div>');
    expect(body.indexOf('class="provider-btn"')).toBeLessThan(body.indexOf('<div class="divider">'));
    expect(body.indexOf('<div class="divider">')).toBeLessThan(body.indexOf('<form'));
    expect(body).toContain('<p class="aside">Signed up with a provider? Use its button above unless you added a password to your account.</p>');
    expect(body).not.toContain('have no password');
    expect(body.indexOf('</form>')).toBeLessThan(body.indexOf('Signed up with a provider?'));
  });

  test('without provider sign-in, the card holds the lockup, the form and the recovery link alone', async () => {
    const body = await withProviders(false, () => signInPage().body);
    expect(body).toContain(LOCKUP);
    expect(body).not.toContain('class="provider-btn"');
    expect(body).not.toContain('class="divider"');
    expect(body).not.toContain('Signed up with a provider?');
    expect(body).toContain('href="https://optionsanalysissuite.com/forgot-password">Forgot your password?</a>');
  });

  test('the form says Log in and connect and offers password recovery under it', async () => {
    const body = await withProviders(true, () => signInPage().body);
    expect(body).toContain('>Log in and connect</button>');
    expect(body).not.toMatch(/Sign In/);
    expect(body).toContain('autocomplete="email"');
    expect(body).toContain('autocomplete="current-password"');
    expect(body).toContain('placeholder="Enter your password"');
    expect(body).toContain('<p class="aside"><a href="https://optionsanalysissuite.com/forgot-password">Forgot your password?</a></p>');
    expect(body.indexOf('</form>')).toBeLessThan(body.indexOf('Forgot your password?'));
  });

  test('the two-factor page opens with the lockup and says Verify and connect', async () => {
    globalThis.fetch = (async (_url: string | URL | Request) => new Response(JSON.stringify({ requiresMfa: true, code: 'mfa_required', stepUpToken: 'step-token-9' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'gotrueRefreshToken=refresh-9; Path=/api/v1/oauth; HttpOnly; SameSite=Lax' },
    })) as typeof fetch;
    const { body } = await handleAuthorizePost(authorizePostBody().toString());
    expect(body).toContain('<h1>Two-factor verification</h1>');
    expect(body.split(LOCKUP).length - 1).toBe(1);
    expect(body.indexOf(LOCKUP)).toBeLessThan(body.indexOf('<h1>'));
    expect(body).toContain('<title>Two-factor verification - Options Analysis Suite</title>');
    expect(body).toContain('>Verify and connect</button>');
    expect(body).not.toContain('class="brand"');
    expect(body).not.toContain('Authorize');
  });

  test('the pages admit images from this origin and nothing else external', () => {
    const csp = signInPage().headers['Content-Security-Policy'];
    expect(csp.startsWith("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action ")).toBe(true);
  });

  test('a failed password sign-in re-renders the card with the error above the buttons and the email kept', async () => {
    globalThis.fetch = (async (_url: string | URL | Request) => new Response(JSON.stringify({ error: 'Invalid email or password' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
    const body = await withProviders(true, async () => (await handleAuthorizePost(authorizePostBody({ password: 'wrong' }).toString())).body);
    expect(body).toContain(LOCKUP);
    expect(body).toContain('class="error"');
    expect(body.indexOf('<p class="subtitle">')).toBeLessThan(body.indexOf('class="error"'));
    expect(body.indexOf('class="error"')).toBeLessThan(body.indexOf('class="provider-btn"'));
    expect(body).toContain('value="dev@example.com"');
    expect(body).toContain('>Log in and connect</button>');
  });
});

// The connector pages on the auth card: one stylesheet, the website's auth card rules written
// into the pages - paper on the tint, hairlines, the serif lockup and title, one filled button, outlined provider
// buttons, no fills on the notices; no gradient, shadow, transition or radius above 3px; only the register's colours.
describe('the connector pages on the auth card', () => {
  const REDIRECT = 'https://chatgpt.com/connector/oauth/cb_abc123';
  const style = (): string => {
    const body = handleAuthorizeGet(new URLSearchParams({ client_id: 'test', redirect_uri: REDIRECT, state: 'xyz', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' })).body;
    const m = body.match(/<style>([\s\S]*?)<\/style>/);
    expect(m).not.toBeNull();
    return m![1];
  };
  const rule = (css: string, selector: string): string => {
    const line = css.split('\n').find((l) => l.trim().startsWith(`${selector} {`));
    expect(line, selector).toBeDefined();
    return line!.trim();
  };
  const REGISTER = new Set(['#FFFFFF', '#F6F6F4', '#D8D8D4', '#ECECE9', '#1A1A1A', '#5B5B57', '#1F3A60', '#1E40AF', '#991B1B']);

  test('no gradient, shadow, transition, uppercase or !important; radii at most 3px; only the register colours; the 480 breakpoint', () => {
    const css = style();
    expect(css).not.toMatch(/gradient|box-shadow|transition|text-transform|!important/);
    for (const m of css.matchAll(/border-radius:\s*(\d+(?:\.\d+)?)px/g)) expect(Number(m[1])).toBeLessThanOrEqual(3);
    const hexes = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(hexes.length).toBeGreaterThan(10);
    expect(hexes.filter((h) => !REGISTER.has(h))).toEqual([]);
    expect(css).toContain('@media (max-width: 480px)');
    expect(css).not.toContain('640px');
  });

  test('the card, the lockup, the title, the buttons, the notices and the divider take the auth card values', () => {
    const css = style();
    expect(rule(css, '.card')).toBe('.card { width: 100%; max-width: 440px; padding: 24px 28px 22px; background: #FFFFFF; border: 1px solid #D8D8D4; border-radius: 2px; }');
    expect(rule(css, '.lockup')).toMatch(/border-bottom: 1px solid #D8D8D4;.*font-family: Georgia, 'Times New Roman', serif;.*font-size: 20px/);
    expect(rule(css, 'h1')).toMatch(/font-family: Georgia, 'Times New Roman', serif; font-size: 26px; font-weight: 500/);
    expect(rule(css, 'button')).toMatch(/border: 1px solid #1F3A60; border-radius: 3px; background: #1F3A60; color: #FFFFFF/);
    expect(rule(css, '.provider-btn')).toMatch(/height: 38px;.*border: 1px solid #1A1A1A; border-radius: 3px; background: #FFFFFF/);
    expect(rule(css, '.provider-btn')).not.toContain('justify-content');
    expect(rule(css, '.error')).not.toContain('background');
    expect(rule(css, '.warn')).toContain('border-top: 2px solid #1A1A1A');
    expect(rule(css, '.warn')).not.toContain('background');
    expect(rule(css, '.divider::before, .divider::after')).toContain('border-top: 1px solid #ECECE9');
    expect(rule(css, '.aside a')).toContain('text-decoration: underline');
    expect(rule(css, '.cancel')).toMatch(/background: #FFFFFF; color: #1A1A1A; border-color: #1A1A1A/);
  });
});
