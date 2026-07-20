import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
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
