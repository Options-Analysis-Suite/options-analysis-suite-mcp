/**
 * The two bounds around the provider-start budget that the main provider suite
 * cannot exercise without poisoning its siblings: the global flow cap and the
 * budget map's cardinality cap. Both need thousands of flows, so afterEach
 * advances the clock past every TTL and runs the production sweep - the same
 * one the 60s interval runs - so the maps are empty again whether the test
 * passed, failed early, or ran in any order relative to its siblings.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  handleProviderStart,
  MAX_PROVIDER_FLOWS,
  MAX_PROVIDER_START_SOURCES,
  MAX_PROVIDER_STARTS_PER_SOURCE,
  sweepExpiredOAuthState,
} from './oauth.js';

const ORIGINAL_TOKEN_SECRET = process.env.OAS_TOKEN_SECRET;
const ORIGINAL_HANDOFF_SECRET = process.env.OAS_MCP_HANDOFF_SECRET;
const REDIRECT_URI = 'https://chatgpt.com/connector/oauth/cb_abc123';
const CODE_CHALLENGE = createHash('sha256').update('v'.repeat(43)).digest('base64url');
const FLOW_TTL_MS = 10 * 60 * 1000;

beforeEach(() => {
  process.env.OAS_TOKEN_SECRET = 'test-token-secret';
  process.env.OAS_MCP_HANDOFF_SECRET = 'test-handoff-secret-0123456789abcdef';
});

afterEach(() => {
  // Back to real time, then far enough ahead that everything allocated under
  // any clock this file sets (at most real + FLOW_TTL) has expired, sweep, and
  // return to real time. Runs on failure too, so a test that dies before its
  // own prune cannot leave thousands of flows for the next file.
  setSystemTime();
  sweepExpiredOAuthState(Date.now() + 2 * FLOW_TTL_MS + 1000);
  if (ORIGINAL_TOKEN_SECRET === undefined) delete process.env.OAS_TOKEN_SECRET;
  else process.env.OAS_TOKEN_SECRET = ORIGINAL_TOKEN_SECRET;
  if (ORIGINAL_HANDOFF_SECRET === undefined) delete process.env.OAS_MCP_HANDOFF_SECRET;
  else process.env.OAS_MCP_HANDOFF_SECRET = ORIGINAL_HANDOFF_SECRET;
});

function start(source?: string): number {
  const query = new URLSearchParams({
    provider: 'google',
    client_id: 'test-client',
    redirect_uri: REDIRECT_URI,
    state: 'state-123',
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    scope: 'mcp',
  });
  return handleProviderStart(query, undefined, source).status;
}

const freshSource = () => `src-${randomBytes(6).toString('hex')}`;

function exhaust(source: string): void {
  for (let i = 0; i < MAX_PROVIDER_STARTS_PER_SOURCE; i++) expect(start(source)).toBe(302);
  expect(start(source)).toBe(429);
}

describe('provider-start bounds', () => {
  test('the budget map is capped: past MAX_PROVIDER_START_SOURCES the OLDEST bucket is evicted, and only that one', () => {
    // Fill the map with this test's own sources first, so whatever earlier
    // tests left behind is evicted ahead of them and insertion order is known
    // from here on.
    for (let i = 0; i < MAX_PROVIDER_START_SOURCES; i++) expect(start(freshSource())).toBe(302);

    const oldest = freshSource();
    exhaust(oldest);
    const second = freshSource();
    exhaust(second);
    // Bring the map back to exactly the cap with sources newer than both.
    for (let i = 0; i < MAX_PROVIDER_START_SOURCES - 2; i++) expect(start(freshSource())).toBe(302);
    // At the cap nothing has been evicted since `oldest` was created.
    expect(start(oldest)).toBe(429);
    expect(start(second)).toBe(429);

    // One source past the cap evicts exactly the oldest live bucket: the
    // next-oldest is still exhausted, while the oldest gets a fresh budget.
    // (Checked in that order - re-adding `oldest` at the cap evicts `second`.)
    expect(start(freshSource())).toBe(302);
    expect(start(second)).toBe(429);
    expect(start(oldest)).toBe(302);
  });

  test('a start refused by the global flow cap costs its source nothing', () => {
    const base = Date.now();
    setSystemTime(new Date(base));
    // Fill the flow map to the cap with source-less starts (never budgeted).
    for (let filled = 0; filled <= MAX_PROVIDER_FLOWS; filled++) {
      const status = start();
      if (status === 503) break;
      expect(status).toBe(302);
      expect(filled).toBeLessThan(MAX_PROVIDER_FLOWS);
    }

    // Still inside every flow's TTL, so the cap holds; the budget window this
    // source opens now runs to +19m, past the point the flows expire.
    setSystemTime(new Date(base + 9 * 60 * 1000));
    const source = freshSource();
    // One more than the per-source budget: if refusals were charged, the last
    // of these would be a 429 from the budget instead of the cap's 503.
    for (let i = 0; i <= MAX_PROVIDER_STARTS_PER_SOURCE; i++) expect(start(source)).toBe(503);

    // Past the flow TTL the next start at the cap prunes every expired flow and
    // allocates - and the source still has its whole budget. (afterEach sweeps
    // whatever this leaves; the test itself does not depend on it.)
    setSystemTime(new Date(base + FLOW_TTL_MS + 1000));
    for (let i = 0; i < MAX_PROVIDER_STARTS_PER_SOURCE; i++) expect(start(source)).toBe(302);
    expect(start(source)).toBe(429);
  });
});
