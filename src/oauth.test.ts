import { afterEach, describe, expect, test } from 'bun:test';
import { handleAuthorizeGet, handleAuthorizePost } from './oauth.js';

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
