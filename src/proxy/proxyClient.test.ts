/**
 * One reading of the proxy's 401, shared by both clients.
 *
 * ProxyClient answered every 401 with "Authentication expired, restart the
 * extension". The proxy's enforceAal2 answers 401 on a VALID session with two
 * structured codes - mfa_required (a TOTP step-up this session never
 * completed) and mfa_check_unavailable (the factor lookup failed, and it fails
 * closed) - and for both of those the advice was wrong: restarting changes
 * nothing for the first and hides an outage for the second. The reading lives
 * in interpretUnauthorized so LiveApiClient cannot drift from it.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { AUTH_EXPIRED_MESSAGE, ProxyClient, interpretUnauthorized } from './proxyClient.js';
import { AuthError } from '../types.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function client(status: number, body: unknown, raw = false) {
  globalThis.fetch = (async () => new Response(raw ? String(body) : JSON.stringify(body), {
    status, headers: { 'content-type': raw ? 'text/plain' : 'application/json' },
  })) as unknown as typeof fetch;
  return new ProxyClient('https://proxy.example.com', { getAccessToken: async () => 'DUMMY' });
}
const caught = (p: Promise<unknown>) => p.then(() => null, (e) => e);

describe('interpretUnauthorized', () => {
  it('reads a code-less body, a non-JSON body and an unknown code as the bearer being refused', () => {
    for (const body of [null, {}, { error: 'Unauthorized', message: 'Invalid or expired JWT token' }, { code: 'something_else' }, 'text']) {
      const meaning = interpretUnauthorized(body);
      expect(meaning.code, JSON.stringify(body)).toBeUndefined();
      expect(meaning.retryable).toBe(false);
      expect(meaning.message).toBe(AUTH_EXPIRED_MESSAGE);
    }
  });

  it('reads the two MFA codes as what they are', () => {
    const stepUp = interpretUnauthorized({ error: 'Multi-factor authentication required', code: 'mfa_required' });
    expect(stepUp.code).toBe('mfa_required');
    expect(stepUp.retryable).toBe(false);
    expect(stepUp.message).toMatch(/step-up/i);
    expect(stepUp.message).not.toMatch(/expired/i);

    const outage = interpretUnauthorized({ error: 'Could not verify MFA status', code: 'mfa_check_unavailable' });
    expect(outage.code).toBe('mfa_check_unavailable');
    expect(outage.retryable).toBe(true);
    expect(outage.message).toMatch(/temporarily unavailable/i);
    expect(outage.message).toMatch(/may be retried/i);
    expect(outage.message).not.toMatch(/expired/i);
  });
});

describe('ProxyClient on a 401', () => {
  it('reads the body before deciding what the 401 means', async () => {
    const err = await caught(client(401, { error: 'Multi-factor authentication required', code: 'mfa_required' }).get('/x')) as Error;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toMatch(/step-up/i);
    expect(err.message).not.toMatch(/expired/i);
  });

  it('still says re-authenticate for a refused bearer, JSON or not', async () => {
    const json = await caught(client(401, { error: 'Unauthorized', message: 'Invalid or expired JWT token' }).get('/x')) as Error;
    expect(json).toBeInstanceOf(AuthError);
    expect(json.message).toBe(AUTH_EXPIRED_MESSAGE);
    const text = await caught(client(401, 'Unauthorized', true).get('/x')) as Error;
    expect(text).toBeInstanceOf(AuthError);
    expect(text.message).toBe(AUTH_EXPIRED_MESSAGE);
  });
});
