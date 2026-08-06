/**
 * /oauth/flow-proof - the connector half of the early-refusal change.
 *
 * provider-callback already refuses to spend a handoff into a flow this browser
 * cannot prove it started, which denies an attacker the code. The residual is
 * that a lured victim's browser completes a REAL sign-in first, leaving a session
 * and ledger row on the auth server that nobody uses - occupying one of the
 * account's MAX_ACTIVE_SESSIONS slots, whose eviction is oldest-inactive-first,
 * so repeated lures push the victim's genuine sessions out.
 *
 * The auth server cannot check the binding itself (it cannot read this origin's
 * cookie), so it bounces the browser here. This endpoint reads the cookie and
 * returns a signed statement. A lured victim never visited provider-start, holds
 * no binding, gets no proof, and is refused BEFORE authenticating.
 *
 * INERT until the auth server calls it - that is what makes it deployable first,
 * with no ordering window in which sign-in is broken.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { handleProviderStart, handleFlowProof, signFlowProof } from './oauth.js';

const ORIGINAL_HANDOFF_SECRET = process.env.OAS_MCP_HANDOFF_SECRET;
const HANDOFF_SECRET = 'test-handoff-secret-0123456789abcdef';
const REDIRECT_URI = 'https://chatgpt.com/connector/oauth/cb_abc123';
const CODE_VERIFIER = 'v'.repeat(43);
const CODE_CHALLENGE = createHash('sha256').update(CODE_VERIFIER).digest('base64url');
const NONCE = 'a'.repeat(32);

beforeEach(() => { process.env.OAS_MCP_HANDOFF_SECRET = HANDOFF_SECRET; });
afterEach(() => {
  if (ORIGINAL_HANDOFF_SECRET === undefined) delete process.env.OAS_MCP_HANDOFF_SECRET;
  else process.env.OAS_MCP_HANDOFF_SECRET = ORIGINAL_HANDOFF_SECRET;
});

function providerStartQuery(): URLSearchParams {
  return new URLSearchParams({
    provider: 'google',
    client_id: 'client-abc',
    redirect_uri: REDIRECT_URI,
    state: 'state-xyz',
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    scope: 'openid',
  });
}

function cookieHeaderFrom(setCookie: string | undefined): string {
  return (setCookie ?? '').split(';')[0] ?? '';
}

/** Start a real flow, returning the public id and the browser's binding cookie. */
function startFlow(): { mcpState: string; cookie: string } {
  const result = handleProviderStart(providerStartQuery());
  const location = new URL(result.headers.Location);
  return {
    mcpState: location.searchParams.get('mcp_state') as string,
    cookie: cookieHeaderFrom(result.headers['Set-Cookie']),
  };
}

const proofQuery = (mcpState: string, nonce = NONCE) =>
  new URLSearchParams({ mcp_state: mcpState, nonce });

describe('flow-proof issues a proof only to the browser that started the flow', () => {
  test('the starting browser gets a proof, redirected to the auth server', () => {
    const { mcpState, cookie } = startFlow();
    const result = handleFlowProof(proofQuery(mcpState), cookie);

    expect(result.status).toBe(302);
    const location = new URL(result.headers.Location);
    expect(location.pathname).toBe('/api/v1/oauth/start');
    expect(location.searchParams.get('mcp_state')).toBe(mcpState);
    expect(location.searchParams.get('flow_nonce')).toBe(NONCE);
    expect(location.searchParams.get('flow_proof')).toMatch(/^[a-f0-9]{64}$/);
  });

  test('REGRESSION: a LURED browser - no binding cookie - gets no proof', () => {
    // The whole point. The attacker minted (or observed) the flow id and sent the
    // victim at the auth server; the victim never visited provider-start, so
    // holds no binding. Without a proof the auth server refuses before any
    // sign-in happens, and no session is created to evict anything.
    const { mcpState } = startFlow();
    const result = handleFlowProof(proofQuery(mcpState), undefined);
    // 400 + the same "started in a different browser" page provider-callback
    // already shows, so a legitimate user who lost the cookie sees one message,
    // not two dialects of refusal.
    expect(result.status).toBe(400);
    expect(result.body).toContain('could not be verified');
    expect(result.headers.Location).toBeUndefined();
  });

  test("a DIFFERENT browser's binding does not prove this flow", () => {
    const victim = startFlow();
    const attacker = startFlow();
    const result = handleFlowProof(proofQuery(victim.mcpState), attacker.cookie);
    expect(result.status).toBe(400);
    expect(result.headers.Location).toBeUndefined();
  });

  test('an unknown or expired flow gets no proof', () => {
    const result = handleFlowProof(proofQuery('f'.repeat(32)), 'oas_mcp_flow=whatever');
    expect(result.status).toBe(400);
    expect(result.headers.Location).toBeUndefined();
  });

  test('malformed ids and nonces are refused before any lookup', () => {
    const { mcpState, cookie } = startFlow();
    expect(handleFlowProof(proofQuery('not-hex'), cookie).headers.Location).toBeUndefined();
    expect(handleFlowProof(proofQuery(mcpState, 'zz'), cookie).headers.Location).toBeUndefined();
    expect(handleFlowProof(proofQuery(mcpState, ''), cookie).headers.Location).toBeUndefined();
    // Over the 64-char ceiling: bounded so the signed message cannot be padded.
    expect(handleFlowProof(proofQuery(mcpState, 'a'.repeat(65)), cookie).headers.Location).toBeUndefined();
  });

  test('self-disables when the handoff secret is not configured', () => {
    const { mcpState, cookie } = startFlow();
    delete process.env.OAS_MCP_HANDOFF_SECRET;
    expect(handleFlowProof(proofQuery(mcpState), cookie).status).toBe(404);
  });

  test('does NOT consume the flow - it stays usable for the real callback', () => {
    // Same reasoning as provider-callback GET: the flow id travels in URLs, so a
    // cross-site navigation in the bound browser could otherwise burn a sign-in
    // the user is midway through.
    const { mcpState, cookie } = startFlow();
    expect(handleFlowProof(proofQuery(mcpState), cookie).status).toBe(302);
    expect(handleFlowProof(proofQuery(mcpState), cookie).status).toBe(302);
  });

  test('does not redirect anywhere the QUERY asks it to', () => {
    // The return target comes from our own env, never the request. A caller-supplied
    // one would make this an open redirect that also hands out a signature.
    const { mcpState, cookie } = startFlow();
    const query = proofQuery(mcpState);
    query.set('return_to', 'https://evil.example/steal');
    query.set('redirect_uri', 'https://evil.example/steal');
    const location = new URL(handleFlowProof(query, cookie).headers.Location);
    expect(location.host).not.toBe('evil.example');
    expect(location.pathname).toBe('/api/v1/oauth/start');
  });
});

describe('the proof key is domain-separated from the handoff key', () => {
  test('REGRESSION: it is NOT the handoff key, so a proof can never open a session blob', () => {
    // The handoff key is sha256(secret) and seals an AES-GCM blob carrying a real
    // GoTrue session. If the proof reused it, a signing oracle here would be an
    // oracle on that.
    const handoffKey = createHash('sha256').update(HANDOFF_SECRET).digest();
    const proofKey = createHmac('sha256', HANDOFF_SECRET).update('oas.mcp.flow-proof.v1').digest();
    expect(proofKey.equals(handoffKey)).toBe(false);

    const proof = signFlowProof('a'.repeat(32), NONCE) as string;
    const forgedWithHandoffKey = createHmac('sha256', handoffKey)
      .update(`32:${'a'.repeat(32)}.${NONCE.length}:${NONCE}`).digest('hex');
    expect(proof).not.toBe(forgedWithHandoffKey);
  });

  test('the signature is bound to BOTH the flow id and the nonce', () => {
    const a = signFlowProof('a'.repeat(32), NONCE);
    expect(signFlowProof('b'.repeat(32), NONCE)).not.toBe(a);
    expect(signFlowProof('a'.repeat(32), 'b'.repeat(32))).not.toBe(a);
  });

  test('REGRESSION: length-prefixed, so field boundaries cannot be shifted', () => {
    // Signed with inputs CONTAINING the separator, which is the only way the
    // ambiguity is reachable. A first attempt used two hex-shaped arguments and
    // proved nothing: with a '.' between them, "aa…a" + "." + "bb" and
    // "aa…b" + "." + "b" already differ, so plain concatenation passed it.
    //
    // signFlowProof does not validate its inputs - handleFlowProof does, via
    // FLOW_ID_RE/FLOW_NONCE_RE - so today the hex charset is what actually rules
    // this out and the length prefix is defence in depth. It is what keeps the
    // signature unambiguous if that charset is ever widened, which is exactly
    // the change that would otherwise reintroduce it silently.
    expect(signFlowProof('a.b', 'c')).not.toBe(signFlowProof('a', 'b.c'));
    expect(signFlowProof('ab', 'c')).not.toBe(signFlowProof('a', 'bc'));
  });

  test('returns null rather than an unkeyed signature when unconfigured', () => {
    delete process.env.OAS_MCP_HANDOFF_SECRET;
    expect(signFlowProof('a'.repeat(32), NONCE)).toBeNull();
  });
});
