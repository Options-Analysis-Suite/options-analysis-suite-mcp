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
import { AUTH_EXPIRED_MESSAGE, MAX_REASON_BYTES, ProxyClient, interpretUnauthorized } from './proxyClient.js';
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

describe('ProxyClient on any other failure', () => {
  it('carries the reason the proxy sent', async () => {
    // Sixth live run: get_iv_surface on a Sunday came back "Request to
    // /scanner/iv-surface/APT failed (HTTP 500)". The proxy had answered
    // { error: 'No data for this date' } (getIVSurface; scannerReadErrorStatus
    // maps it to 500) and the client dropped the body, so a date with no
    // file read the same as an outage. LiveApiClient has carried
    // message ?? error all along; this client reads the same two keys.
    const noFile = await caught(client(500, { error: 'No data for this date' }).get('/scanner/iv-surface/APT')) as Error;
    expect(noFile.message).toBe('Request to /scanner/iv-surface/APT failed (HTTP 500): No data for this date');
    const tooLarge = await caught(client(400, { error: 'Options chain too large; please request a specific expiration (max 8000 rows)', code: 'options_chain_too_large' }).get('/scanner/options-chain')) as Error;
    expect(tooLarge.message).toBe('Request to /scanner/options-chain failed (HTTP 400): Options chain too large; please request a specific expiration (max 8000 rows)');
    // message wins over error where both are strings, as in LiveApiClient.
    const both = await caught(client(503, { error: 'archive_manifest_missing', message: 'Archived options history is temporarily unavailable.' }).get('/x')) as Error;
    expect(both.message).toBe('Request to /x failed (HTTP 503): Archived options history is temporarily unavailable.');
  });

  it('bounds the reason, because a tool may embed the message outside the helpers\' truncation', async () => {
    // review: get_dark_pool_data catches ApiError and puts
    // err.message into a partial-failure note, which the helpers' 2 KiB
    // error truncation never sees. A 9,000-byte reason reached the model
    // whole, and a 60,000-byte one beside healthy ATS data tripped the
    // size guard and replaced the whole response with "Response too
    // large". The client bounds the reason itself, UTF-8 safe.
    const prefix = 'Request to /x failed (HTTP 500): ';
    const long = await caught(client(500, { error: 'y'.repeat(9_000) }).get('/x')) as Error;
    expect(long.message.startsWith(prefix)).toBe(true);
    expect(new TextEncoder().encode(long.message).byteLength).toBeLessThanOrEqual(new TextEncoder().encode(prefix).byteLength + MAX_REASON_BYTES);
    expect(long.message.endsWith('...')).toBe(true);
    // Cut on a character boundary: no mojibake from the cut. (A lone
    // surrogate the proxy itself sent is another matter: short, it passes
    // through as JSON.parse produced it; long, TextEncoder replaces it with
    // U+FFFD on the way in, as it would anywhere. The bound adds neither.)
    const multi = await caught(client(500, { error: 'é'.repeat(9_000) }).get('/x')) as Error;
    expect(multi.message).toMatch(/^Request to \/x failed \(HTTP 500\): é+\.\.\.$/);
    expect(new TextEncoder().encode(multi.message).byteLength).toBeLessThanOrEqual(new TextEncoder().encode(prefix).byteLength + MAX_REASON_BYTES);
    // A reason inside the bound is carried whole.
    const short = await caught(client(500, { error: 'z'.repeat(MAX_REASON_BYTES) }).get('/x')) as Error;
    expect(short.message).toBe(prefix + 'z'.repeat(MAX_REASON_BYTES));
  });

  it('says only the status when the body carries no reason', async () => {
    for (const [status, body, raw] of [[500, '<html>edge error</html>', true], [502, {}, false], [500, { error: '' }, false], [500, { error: 42 }, false]] as const) {
      const err = await caught(client(status, body, raw).get('/x')) as Error;
      expect(err.message, JSON.stringify(body)).toBe(`Request to /x failed (HTTP ${status})`);
    }
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
