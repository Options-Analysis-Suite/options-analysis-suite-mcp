/**
 * OAuth 2.0 Authorization Code + PKCE for ChatGPT MCP integration.
 *
 * Flow:
 * 1. ChatGPT redirects user to GET /oauth/authorize
 * 2. User enters OAS credentials on our login page
 * 3. We validate credentials, generate auth code, redirect back to ChatGPT
 * 4. ChatGPT calls POST /oauth/token with code + code_verifier
 * 5. We return a self-contained encrypted access token
 * 6. ChatGPT sends Bearer <token> on MCP requests
 *
 * OAuth tokens are stateless — the API key and expiry are encrypted into the
 * token itself using AES-256-GCM with OAS_TOKEN_SECRET. This means tokens
 * survive server restarts and deploys without requiring persistent storage.
 */
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { loginForOAuth, getProfile, refreshAccessToken } from './auth/authClient.js';
import { AuthError } from './types.js';
import type { AuthTokens } from './types.js';

const AUTH_SERVER_URL = process.env.OAS_AUTH_SERVER_URL || 'https://api.optionsanalysissuite.com';

// Derive a 32-byte AES key from the token secret. Read lazily (memoized on the
// secret value) rather than at module load, so tests can set the env per-case;
// production behavior is unchanged since the env never mutates there.
let cachedTokenKey: { secret: string; key: Buffer } | null = null;
function tokenKey(): Buffer | null {
  const secret = process.env.OAS_TOKEN_SECRET || '';
  if (!secret) return null;
  if (!cachedTokenKey || cachedTokenKey.secret !== secret) {
    cachedTokenKey = { secret, key: createHash('sha256').update(secret).digest() };
  }
  return cachedTokenKey.key;
}

// Allowed redirect URIs — exact origin+path
const ALLOWED_REDIRECTS = [
  // ChatGPT/OpenAI callback endpoints
  'https://chatgpt.com/aip/oauth/callback',
  'https://chat.openai.com/aip/oauth/callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  // Claude Web (exact documented callback paths)
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  // Perplexity custom remote connectors
  'https://www.perplexity.ai/rest/connections/oauth_callback',
  // Grok / x.ai remote MCP connectors (trailing slash is part of the path)
  'https://grok.com/connectors-oauth-exchange-code/',
  // Smithery gateway. INTENTIONAL — DO NOT REMOVE.
  // Smithery (smithery.ai) is a curated MCP marketplace whose gateway uses a
  // single shared callback URL for every server it hosts. Removing this entry
  // breaks the live Smithery listing for this MCP.
  //
  // CORRECTED. PR #141 / mcp PR #8 argued the shared-callback risk was bounded
  // by "PKCE binding the code to the originating browser session". That is
  // WRONG: PKCE binds a code to whoever holds the verifier, and in the lure that
  // matters the attacker chose the challenge and holds it. Per-client_id
  // redirect binding in DCR does not help either - attacker and victim would use
  // the same gateway client and the same callback. The real property is that a
  // callback shared across a gateway's tenants may resolve a pending connection
  // from `state` alone, so the party that RECEIVES a code need not be the party
  // that started the flow.
  //
  // That is why this entry, and any future shared gateway callback, must also
  // appear in SHARED_GATEWAY_REDIRECTS: those targets require an explicit
  // connection confirmation before a code is issued. Keeping the URL listed is
  // now a decision about UX cost, not an unmitigated risk.
  'https://smithery.run/oauth/callback',
  // Cursor MCP
  'https://www.cursor.com/agents/mcp/oauth/callback',
  // Claude Code / local development
  'http://localhost:6274/oauth/callback',
  'http://localhost:6274/oauth/callback/debug',
];

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MFA_FLOW_MAX_FAILED_ATTEMPTS = 3;
export const OAUTH_ACCESS_TOKEN_PREFIX = 'oauth-access:';
export const OAUTH_REFRESH_TOKEN_PREFIX = 'oauth-refresh:';
// Refresh-token wrapper lifetime. Refreshes re-mint the wrapper, but the
// EFFECTIVE connection lifetime is bounded by the auth server's session-ledger
// row, whose 30-day expiry is absolute (refreshes do not extend it) - so
// connections re-authorize at most monthly regardless of wrapper renewal. The
// wrapper TTL only needs to not outlive that bound.
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// --- Provider sign-in (Google/Apple/GitHub/Microsoft via the auth server's BFF) ---
// OAuth-only accounts have no password, so the email/password form can never
// authorize them. The provider buttons round-trip through the auth server's
// existing BFF flow (/api/v1/oauth/start -> provider -> reconcile), which then
// hands the GoTrue session back to THIS server as a short-lived AES-256-GCM blob
// sealed with the shared OAS_MCP_HANDOFF_SECRET. Buttons and both provider
// endpoints self-disable when the secret is not configured, so this ships dark
// until the env is set on both services.
let cachedHandoffKey: { secret: string; key: Buffer } | null = null;
function handoffKey(): Buffer | null {
  const secret = process.env.OAS_MCP_HANDOFF_SECRET || '';
  // Under 32 chars = treated as unconfigured (fail-dark, not fail-weak);
  // mirrors the auth server's MCP_HANDOFF_SECRET gate.
  if (!secret || secret.length < 32) return null;
  if (!cachedHandoffKey || cachedHandoffKey.secret !== secret) {
    cachedHandoffKey = { secret, key: createHash('sha256').update(secret).digest() };
  }
  return cachedHandoffKey.key;
}
export function isProviderSignInEnabled(): boolean {
  return handoffKey() !== null;
}

/** Supabase provider ids the auth server allowlists (Microsoft's id is `azure`). */
const SIGN_IN_PROVIDERS = [
  { id: 'google', label: 'Google' },
  { id: 'apple', label: 'Apple' },
  { id: 'github', label: 'GitHub' },
  { id: 'azure', label: 'Microsoft' },
] as const;
function isSignInProvider(p: string): boolean {
  return SIGN_IN_PROVIDERS.some((x) => x.id === p);
}

// --- Encrypted token helpers ---

/** Encrypt an API key + expiry into a self-contained access token */
function encryptToken(apiKey: string, expiresAt: number): string {
  const key = tokenKey();
  if (!key) throw new Error('OAS_TOKEN_SECRET is not configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const payload = JSON.stringify({ k: apiKey, e: expiresAt });
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64url(iv + ciphertext + authTag)
  return Buffer.concat([iv, encrypted, tag]).toString('base64url');
}

/** AES-256-GCM open with an explicit key (same iv|ciphertext|tag layout as encryptToken). */
function aesGcmOpen(data: string, key: Buffer): string | null {
  try {
    const buf = Buffer.from(data, 'base64url');
    if (buf.length < 29) return null; // 12 iv + 1 min ciphertext + 16 tag
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const encrypted = buf.subarray(12, buf.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch {
    return null;
  }
}

/** Decrypt an access token back to an API key, or null if invalid/expired */
function decryptToken(token: string): string | null {
  const key = tokenKey();
  if (!key) return null;
  const decrypted = aesGcmOpen(token, key);
  if (!decrypted) return null;
  try {
    const { k, e } = JSON.parse(decrypted);
    if (Date.now() > e) return null;
    return k;
  } catch {
    return null;
  }
}

/**
 * Open + validate the auth server's sealed provider-handoff blob. The GCM tag
 * proves it was sealed by the holder of the shared secret; `s` binds it to ONE
 * provider flow and `e` bounds its life to seconds, so a captured blob cannot be
 * replayed against another flow or later.
 */
function openHandoffBlob(blob: string, expectedState: string): { accessToken: string; refreshToken: string } | null {
  const key = handoffKey();
  if (!key) return null;
  const opened = aesGcmOpen(blob, key);
  if (!opened) return null;
  try {
    const { a, r, s, e } = JSON.parse(opened) as { a?: string; r?: string; s?: string; e?: number };
    if (typeof a !== 'string' || !a) return null;
    if (typeof e !== 'number' || Date.now() > e) return null;
    if (typeof s !== 'string' || s !== expectedState) return null;
    return { accessToken: a, refreshToken: typeof r === 'string' ? r : '' };
  } catch {
    return null;
  }
}

function jwtExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function oauthCredentialExpiresAt(credential: string): number {
  if (credential.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
    const accessToken = credential.slice(OAUTH_ACCESS_TOKEN_PREFIX.length);
    const expiresAt = jwtExpiry(accessToken);
    if (expiresAt) return Math.min(expiresAt, Date.now() + TOKEN_TTL_MS);
  }
  return Date.now() + TOKEN_TTL_MS;
}

// --- In-memory stores (auth codes only — tokens are stateless) ---

interface AuthCode {
  apiKey: string;
  /**
   * GoTrue refresh token backing this connection - set ONLY for provider
   * sign-ins (Google/Apple/GitHub/Microsoft). When present, the token exchange
   * also issues an OAuth refresh_token wrapping it, so clients renew hourly
   * bearers instead of re-prompting. Password sign-ins deliberately leave this
   * unset: their base64 credential auto-relogins server-side and keeps a stable
   * owner key, so issuing a refresh_token (which resolves to an oauth-access
   * bearer) would flip the session owner on first refresh.
   */
  refreshCredential?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  clientId: string;
  state: string;
  expiresAt: number;
}

interface MfaFlow {
  stepUpToken: string;
  cookieHeader: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: number;
  failedAttempts: number;
}

/**
 * In-flight provider sign-in: the MCP client's PKCE params, parked while the
 * user round-trips through the auth server + provider. Keyed by the mcp_state
 * id we mint at provider-start and thread through the whole redirect chain.
 */
interface ProviderFlow {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  expiresAt: number;
  /**
   * SHA-256 of the browser-binding secret minted alongside this flow id and set
   * as an HttpOnly cookie at provider-start. Only the hash is kept, so a heap
   * dump or a log of this map cannot yield the secret. See the flow-fixation
   * note above handleProviderStart.
   */
  bindingHash: string;
}

/**
 * An authorization that has been EARNED (the user authenticated) but not yet
 * ISSUED, because its redirect target requires an explicit connection consent.
 * The grant is held here rather than minted as a code: an abandoned consent must
 * leave nothing spendable behind.
 */
interface PendingConsent {
  grant: AuthorizationGrant;
  bindingHash: string;
  expiresAt: number;
}

// PROCESS-LOCAL by design, and the flow/consent maps below with it. An
// authorization code lives here for its 5-minute window between issuance and
// the client's /oauth/token exchange. Two limits this map does NOT paper over:
//   - A restart, crash, or deploy inside that 5-minute window drops every
//     in-flight code. The client's token request then fails `invalid_grant`
//     and it must restart the connect. Accepted as a rare event on one replica.
//   - Scaling past one replica. Production runs ONE MCP replica today; if that
//     changes, Railway load-balances with no session affinity and offers no
//     sticky-session option, so a token request can land on a replica that
//     never saw the code and fail at random. A SHARED store for these maps is
//     the real prerequisite for horizontal scaling here.
const authCodes = new Map<string, AuthCode>();
const mfaFlows = new Map<string, MfaFlow>();
const providerFlows = new Map<string, ProviderFlow>();
const pendingConsents = new Map<string, PendingConsent>();
const CONSENT_TTL_MS = 5 * 60 * 1000;
const PROVIDER_FLOW_TTL_MS = 10 * 60 * 1000; // matches the auth server's flow-cookie TTL
// provider-start is unauthenticated, so bound the map: age is bounded by the
// TTL, cardinality by this cap (with opportunistic pruning at the limit).
const MAX_PROVIDER_FLOWS = 5000;

// Cleanup expired auth codes every 60s
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of authCodes) {
    if (now > data.expiresAt) authCodes.delete(code);
  }
  for (const [id, data] of mfaFlows) {
    if (now > data.expiresAt) mfaFlows.delete(id);
  }
  for (const [id, data] of providerFlows) {
    if (now > data.expiresAt) providerFlows.delete(id);
  }
  for (const [id, data] of pendingConsents) {
    if (now > data.expiresAt) pendingConsents.delete(id);
  }
}, 60_000);

/** Resolve an OAuth Bearer token to an API key (base64 email:password) */
export function resolveOAuthToken(token: string): string | null {
  return decryptToken(token);
}

/** Validate redirect URI against allowlist using parsed URL comparison */
function isRedirectAllowed(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    const normalized = `${parsed.origin}${parsed.pathname}`;

    // ChatGPT/OpenAI legacy developer-mode callbacks allow variable app IDs
    // but require the OAuth callback suffix.
    if ((parsed.origin === 'https://chatgpt.com' || parsed.origin === 'https://chat.openai.com')
      && parsed.pathname.endsWith('/oauth/callback')) {
      return true;
    }

    // Current ChatGPT Apps callbacks use a per-app callback id under
    // /connector/oauth/{callback_id}. Restrict to path-safe id chars and the
    // exact chatgpt.com origin so lookalike domains/paths cannot redirect.
    if (parsed.origin === 'https://chatgpt.com'
      && /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(parsed.pathname)) {
      return true;
    }

    return ALLOWED_REDIRECTS.some((allowed) => normalized === allowed);
  } catch {
    return false;
  }
}

/** Get the server's base URL — prefer configured env var over request host */
function getBaseUrl(host: string | undefined): string {
  const configured = process.env.OAS_MCP_BASE_URL;
  if (configured) return configured;
  const h = host || 'mcp.optionsanalysissuite.com';
  return `https://${h}`;
}

function combineCookieHeaders(...headers: Array<string | undefined>): string {
  const cookies = new Map<string, string>();
  for (const header of headers) {
    for (const part of (header ?? '').split(';')) {
      const cookie = part.trim();
      if (!cookie) continue;
      const equalsIdx = cookie.indexOf('=');
      if (equalsIdx <= 0) continue;
      cookies.set(cookie.slice(0, equalsIdx), cookie);
    }
  }
  return [...cookies.values()].join('; ');
}

async function fetchCsrfToken(authServerUrl: string, cookieHeader: string): Promise<{ csrfToken: string; cookieHeader: string }> {
  const response = await fetch(`${authServerUrl}/api/csrf-token`, {
    headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new AuthError('Could not start two-factor verification.');
  const json = await response.json().catch(() => ({})) as { csrfToken?: string };
  if (!json.csrfToken) throw new AuthError('Could not start two-factor verification.');
  const setCookie = cookieHeaderFromResponse(response.headers);
  return { csrfToken: json.csrfToken, cookieHeader: combineCookieHeaders(cookieHeader, setCookie) };
}

function setCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const values = withGetSetCookie.getSetCookie?.();
  if (values?.length) return values;
  const single = headers.get('set-cookie');
  if (!single) return [];
  return single.split(/,(?=\s*[^;,\s]+=)/g);
}

function cookieHeaderFromResponse(headers: Headers): string {
  return setCookieHeaders(headers)
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

type MfaFactor = { id: string; status?: string; factor_type?: string };

async function fetchVerifiedMfaFactors(authServerUrl: string, flow: MfaFlow): Promise<MfaFactor[]> {
  const response = await fetch(`${authServerUrl}/api/v1/oauth/mfa/factors`, {
    headers: {
      Authorization: `Bearer ${flow.stepUpToken}`,
      Cookie: flow.cookieHeader,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new AuthError('Could not load two-factor authenticators.');
  const json = await response.json().catch(() => ({})) as { factors?: MfaFactor[] };
  return (json.factors ?? []).filter((factor) => factor.status === 'verified' && factor.factor_type === 'totp');
}

async function challengeMfaFactor(
  authServerUrl: string,
  flow: MfaFlow,
  factorId: string,
  csrfToken: string,
  cookieHeader: string,
): Promise<string | null> {
  const response = await fetch(`${authServerUrl}/api/v1/oauth/mfa/challenge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${flow.stepUpToken}`,
      Cookie: cookieHeader,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({ factorId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const json = await response.json().catch(() => ({})) as { challengeId?: string };
  return typeof json.challengeId === 'string' ? json.challengeId : null;
}

async function verifyMfaFactor(
  authServerUrl: string,
  flow: MfaFlow,
  factorId: string,
  challengeId: string,
  code: string,
  csrfToken: string,
  cookieHeader: string,
): Promise<string | null> {
  const response = await fetch(`${authServerUrl}/api/v1/oauth/mfa/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${flow.stepUpToken}`,
      Cookie: cookieHeader,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({ factorId, challengeId, code }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const json = await response.json().catch(() => ({})) as { accessToken?: string };
  return typeof json.accessToken === 'string' ? json.accessToken : null;
}

async function completeMfaFlow(flow: MfaFlow, code: string): Promise<string> {
  const trimmed = code.trim();
  if (!/^[0-9]{6,8}$/.test(trimmed)) throw new AuthError('Enter the code from your authenticator app.');

  const csrf = await fetchCsrfToken(AUTH_SERVER_URL, flow.cookieHeader);
  const factors = await fetchVerifiedMfaFactors(AUTH_SERVER_URL, flow);
  if (factors.length === 0) throw new AuthError('No verified authenticator was found for this account.');

  for (const factor of factors) {
    const challengeId = await challengeMfaFactor(AUTH_SERVER_URL, flow, factor.id, csrf.csrfToken, csrf.cookieHeader);
    if (!challengeId) continue;
    const accessToken = await verifyMfaFactor(AUTH_SERVER_URL, flow, factor.id, challengeId, trimmed, csrf.csrfToken, csrf.cookieHeader);
    if (accessToken) return accessToken;
  }

  throw new AuthError("That code didn't match. Try again.");
}

function hasActiveSubscription(accessToken: string): Promise<boolean> {
  return getProfile(AUTH_SERVER_URL, accessToken).then((profile) => {
    const sub = profile.subscription;
    return Boolean(profile.user.isDeveloper
      || profile.user.bypassSubscription
      || (sub && (sub.status === 'active' || sub.status === 'trialing')));
  });
}

/**
 * Headers every OAuth HTML page carries. These pages ARE the security boundary -
 * the consent click is what stands between a crafted authorization link and a
 * connected account, and the login and MFA forms take credentials - so none of
 * them may be framed, none may post anywhere but back here, and none may be
 * cached. RFC 9700 requires an authorization server to prevent clickjacking;
 * X-Frame-Options rides along for anything that does not honour frame-ancestors.
 *
 * `style-src 'unsafe-inline'` is required by the inline <style> blocks and style
 * attributes these pages use. Nothing else loads: no scripts, no images, no
 * fonts, no network calls - hence `default-src 'none'`.
 *
 * Referrer-Policy is not incidental here. Flow ids and consent ids ride in URLs
 * and form targets, and a leaked flow id is the premise of the attack this file
 * exists to stop; no-referrer keeps them out of other origins' logs.
 */
function htmlPageHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

interface AuthorizationGrant {
  apiKey: string;
  refreshCredential?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  clientId: string;
  state: string;
}

// ── Connector OAuth telemetry (PII-free) ────────────────────────────────────
//
// Code issuance and token exchange logged NOTHING, so a connect that reached
// our final 302 and then never came back for a token was invisible from our
// side, which is exactly the failure a support case surfaced. These one-line
// JSON events close that gap and change no behavior. They never carry a raw
// code, token, email, state, verifier, or handoff blob. A code is identified
// only by a truncated hash; grant and redirect collapse to a fixed category
// label (see grantCategory / redirectCategory), never the request-controlled
// string; the remaining fields are bounded too (hasState is a boolean, pkce is
// the already-validated S256 constant, ttlSec is fixed). A `code_issued` with
// no later `token_exchange` for the same code fingerprint is the signal that a
// client abandoned the exchange after we handed it the code.
function oauthFingerprint(value: string): string {
  if (!value) return 'none';
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

// BOUNDED CATEGORY LABELS, never the raw value. `grant_type` and `redirect_uri`
// on the token endpoint are request-controlled and reach the telemetry before
// any allowlist check, so logging them verbatim could print an email, token,
// or arbitrary string someone stuffed into the field. These collapse to a
// fixed, finite set of labels instead.
function grantCategory(grant: string | null): string {
  if (grant === 'authorization_code' || grant === 'refresh_token') return grant;
  if (!grant) return 'none';
  return 'other';
}

function redirectCategory(uri: string): string {
  if (!uri) return 'none';
  let host: string;
  try {
    host = new URL(uri).hostname.toLowerCase();
  } catch {
    return 'unparseable';
  }
  if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com' || host.endsWith('.openai.com')) return 'chatgpt';
  if (host === 'claude.ai' || host.endsWith('.claude.ai') || host === 'claude.com' || host.endsWith('.claude.com')) return 'claude';
  if (host === 'localhost' || host === '127.0.0.1') return 'localhost';
  return 'other';
}

// Best-effort: telemetry must NEVER break a request. A throwing logger or a
// JSON.stringify failure is swallowed here rather than propagating into the
// OAuth response path (which would strand a code or drop a valid response).
function logOAuthEvent(event: string, fields: Record<string, string | number | boolean>): void {
  try {
    console.log(`[OAS MCP OAuth] ${JSON.stringify({ event, ...fields })}`);
  } catch {
    // ignore
  }
}

function issueAuthorizationRedirect(input: AuthorizationGrant): { status: number; headers: Record<string, string>; body: string } {
  const code = randomBytes(32).toString('hex');
  authCodes.set(code, {
    apiKey: input.apiKey,
    refreshCredential: input.refreshCredential,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    redirectUri: input.redirectUri,
    clientId: input.clientId,
    state: input.state,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  logOAuthEvent('code_issued', {
    code: oauthFingerprint(code),
    client: oauthFingerprint(input.clientId),
    redirect: redirectCategory(input.redirectUri),
    hasState: Boolean(input.state),
    pkce: input.codeChallengeMethod,
    ttlSec: 300,
  });

  const redirectUrl = new URL(input.redirectUri);
  redirectUrl.searchParams.set('code', code);
  if (input.state) redirectUrl.searchParams.set('state', input.state);

  return {
    status: 302,
    headers: { Location: redirectUrl.toString() },
    body: '',
  };
}

// ── Connection consent for shared-gateway redirect targets ──────────────────
//
// Browser-binding the provider flow stops an attacker from having someone else's
// sign-in delivered into an authorization they parked. It cannot stop the sibling
// lure: the attacker copies their OWN /oauth/authorize URL - their client_id,
// redirect_uri, state and code_challenge - and sends it to a victim. The victim's
// own browser starts that flow, so every binding in the chain is satisfied by
// construction, and the code is issued to the attacker's pending authorization.
//
// For most redirect targets the code still cannot be collected: it lands in the
// VICTIM's browser at the client, whose `state` was minted for the attacker's own
// session there, so the client rejects it (RFC 6749 Section 10.12 puts that
// binding on the client). The exception is a callback shared by every tenant of a
// gateway, where a pending connection may be resolved from `state` alone and the
// recipient need not be the initiator. There the lure completes.
//
// EXTERNAL ASSUMPTION, STATED PLAINLY: that the non-gateway clients here -
// chatgpt.com, claude.ai, cursor.com, perplexity.ai, grok.com - bind `state` to
// the browser session that started the authorization. It is what the RFC
// requires of them and it is not something tests in this repository can prove.
// Any client whose behaviour is unverified, or any future callback shared across
// tenants, belongs in SHARED_GATEWAY_REDIRECTS below. Loopback/native callbacks
// (localhost:6274) need no gate: the code is delivered to the victim's own
// machine, where the attacker is not listening.
//
// PKCE is not a defence here, and the earlier note on the Smithery entry in
// ALLOWED_REDIRECTS was wrong to imply it is: PKCE binds the code to whoever
// holds the verifier, and in this attack that is the attacker.
//
// So those targets - and ONLY those, to leave the common path a click lighter -
// get an explicit confirmation naming the destination, after authentication and
// before any code exists. A lured victim is asked whether they meant to connect
// their account to a service they have never used.
const CONSENT_COOKIE = 'oas_mcp_consent';

/**
 * Redirect targets whose recipient need not be the party that started the flow.
 * Keyed on origin+path, matching isRedirectAllowed's own comparison. Any future
 * marketplace or gateway callback shared across tenants belongs here.
 */
const SHARED_GATEWAY_REDIRECTS = new Set([
  'https://smithery.run/oauth/callback',
]);

/**
 * One budget for every state an authorization can be waiting in: a challenge
 * awaiting a second factor, a grant parked behind a consent, and a minted code
 * not yet exchanged. They are stages of the same object, so capping them
 * separately would let any one of them starve the box on its own.
 *
 * MFA flows count for the sharpest reason: reaching one needs only a valid
 * PASSWORD - the subscription check has not run yet - and the auth server's login
 * limiter does not count successful sign-ins. Neither does authenticating bound
 * cardinality anywhere else here: one legitimate subscriber can open these
 * five-minute reservations as fast as they can post.
 *
 * Prune first, refuse second, and refuse retryably. What a 503 costs depends on
 * where it lands, and the difference is worth stating rather than glossing:
 *
 *   - Spending a provider handoff refuses with the flow INTACT (the reservation
 *     runs before the flow is consumed), so the same attempt succeeds once there
 *     is room.
 *   - Parking an MFA challenge at capacity DOES discard the first factor the
 *     user just passed: there is nothing to hold it in, since holding it is the
 *     allocation being refused. They sign in again. No failure counter, lockout,
 *     or account state is touched - this is overload behaviour, not a lockout.
 *   - Completing a second factor and approving a consent are net-zero and are
 *     never refused at all.
 */
export const MAX_OUTSTANDING_AUTHORIZATIONS = 5000;

function outstandingAuthorizations(): number {
  return authCodes.size + pendingConsents.size + mfaFlows.size;
}

function reserveOutstandingAuthorization(): boolean {
  if (outstandingAuthorizations() < MAX_OUTSTANDING_AUTHORIZATIONS) return true;
  const now = Date.now();
  for (const [code, data] of authCodes) {
    if (now > data.expiresAt) authCodes.delete(code);
  }
  for (const [id, data] of pendingConsents) {
    if (now > data.expiresAt) pendingConsents.delete(id);
  }
  for (const [id, data] of mfaFlows) {
    if (now > data.expiresAt) mfaFlows.delete(id);
  }
  return outstandingAuthorizations() < MAX_OUTSTANDING_AUTHORIZATIONS;
}

/**
 * The 503 every full-budget refusal renders. Retryable on purpose: the caller
 * has already proved who they are, so nothing about the refusal should cost them
 * their sign-in.
 */
function budgetExhaustedPage(): { status: number; headers: Record<string, string>; body: string } {
  return {
    ...noticePage(
      'Too many sign-ins in progress',
      'Too many connections are being set up right now. Wait a minute and start the connection again from your AI client.',
      503,
    ),
    headers: { ...htmlPageHeaders(), 'Retry-After': '60' },
  };
}

function requiresConnectionConsent(redirectUri: string): boolean {
  try {
    const parsed = new URL(redirectUri);
    return SHARED_GATEWAY_REDIRECTS.has(`${parsed.origin}${parsed.pathname}`);
  } catch {
    return false;
  }
}

/**
 * The consent bindings this request presents that authenticate against a live
 * pending consent. Same jar discipline as the flow bindings, and for the same
 * reason: a single-valued cookie would let a second confirmation page evict the
 * first, so a user holding two connections open would find the older tab
 * unapprovable. Authenticating before re-serializing also drops answered and
 * expired consents, and keeps forged entries from evicting real ones.
 */
function liveConsentsFrom(cookieHeader: string | undefined): CookieBinding[] {
  const now = Date.now();
  return parseBindingJar(readCookieValues(cookieHeader, CONSENT_COOKIE)).filter((entry) => {
    const pending = pendingConsents.get(entry.id);
    if (!pending || now > pending.expiresAt) return false;
    return digestsEqual(sha256Hex(entry.secret), pending.bindingHash);
  });
}

function consentCookieHeader(jar: CookieBinding[]): string {
  return jarCookieHeader(CONSENT_COOKIE, jar, 'Lax', CONSENT_TTL_MS);
}

/**
 * Issue the authorization, or park it behind a confirmation when the redirect
 * target is a shared gateway.
 *
 * `onIssueCookie` is applied ONLY when a code is issued right now. The provider
 * path uses it to refresh its binding jar; on the consent path that refresh is
 * skipped so the consent cookie can take the single Set-Cookie slot, which costs
 * nothing because a spent flow's binding no longer authenticates and is dropped
 * from the jar on the next request that touches it.
 */
function issueAuthorizationOrConsent(
  grant: AuthorizationGrant,
  cookieHeader?: string,
  onIssueCookie?: string,
): { status: number; headers: Record<string, string>; body: string } {
  if (!reserveOutstandingAuthorization()) return budgetExhaustedPage();
  if (!requiresConnectionConsent(grant.redirectUri)) {
    const redirect = issueAuthorizationRedirect(grant);
    if (!onIssueCookie) return redirect;
    return { ...redirect, headers: { ...redirect.headers, 'Set-Cookie': onIssueCookie } };
  }

  const consentId = randomBytes(16).toString('hex');
  const secret = randomBytes(32).toString('hex');
  pendingConsents.set(consentId, {
    grant,
    bindingHash: sha256Hex(secret),
    expiresAt: Date.now() + CONSENT_TTL_MS,
  });
  const page = consentPage(consentId, new URL(grant.redirectUri).host);
  return {
    ...page,
    headers: {
      ...page.headers,
      'Set-Cookie': consentCookieHeader([{ id: consentId, secret }, ...liveConsentsFrom(cookieHeader)]),
    },
  };
}

/** POST /oauth/consent — the user's answer to the confirmation above. */
export function handleConsentPost(
  body: string,
  cookieHeader?: string,
): { status: number; headers: Record<string, string>; body: string } {
  const params = new URLSearchParams(body);
  const consentId = params.get('consent_id') || '';
  const pending = pendingConsents.get(consentId);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingConsents.delete(consentId);
    return expiredFlowPage();
  }
  // Same browser as the one that authenticated. Without this the consent id -
  // which the page carries in a form field - would be the whole authority.
  const authenticated = liveConsentsFrom(cookieHeader).some((entry) => entry.id === consentId);
  if (!authenticated) return unboundFlowPage();

  pendingConsents.delete(consentId);
  if (params.get('decision') !== 'approve') {
    const cancelled = noticePage(
      'Connection cancelled',
      'Your account was not connected. You can close this window.',
    );
    return { ...cancelled, headers: { ...cancelled.headers, 'Set-Cookie': consentCookieHeader(liveConsentsFrom(cookieHeader)) } };
  }
  const redirect = issueAuthorizationRedirect(pending.grant);
  return { ...redirect, headers: { ...redirect.headers, 'Set-Cookie': consentCookieHeader(liveConsentsFrom(cookieHeader)) } };
}

/** The confirmation page. Names the DESTINATION HOST, never the client-supplied
 * client_id: the host is allowlist-constrained, a client_id is not, and a
 * free-text name rendered here would be a phishing surface of its own. */
function consentPage(consentId: string, destinationHost: string): { status: number; headers: Record<string, string>; body: string } {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Options Analysis Suite — Confirm connection</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #1e293b; border-radius: 12px; padding: 40px; max-width: 420px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
    h1 { font-size: 1.4rem; margin-bottom: 8px; color: #f8fafc; }
    p { font-size: 0.9rem; color: #94a3b8; line-height: 1.5; margin-bottom: 16px; }
    .dest { color: #f8fafc; font-weight: 600; }
    .warn { background: #78350f; color: #fcd34d; padding: 10px; border-radius: 6px; font-size: 0.85rem; margin-bottom: 20px; }
    .row { display: flex; gap: 10px; }
    button { flex: 1; padding: 12px; border-radius: 6px; border: none; font-size: 0.95rem; font-weight: 600; cursor: pointer; }
    .approve { background: #0d9488; color: #fff; }
    .cancel { background: #0f172a; color: #e2e8f0; border: 1px solid #334155; }
    .logo { font-size: 1.8rem; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">&#10022;</div>
    <h1>Confirm this connection</h1>
    <p>You are about to give <span class="dest">${escapeHtml(destinationHost)}</span> access to your Options Analysis Suite account.</p>
    <div class="warn">Only continue if you started this yourself from ${escapeHtml(destinationHost)}. If you arrived here from a link someone sent you, cancel.</div>
    <form method="POST" action="/oauth/consent">
      <input type="hidden" name="consent_id" value="${escapeHtml(consentId)}">
      <div class="row">
        <button class="cancel" type="submit" name="decision" value="cancel">Cancel</button>
        <button class="approve" type="submit" name="decision" value="approve">Connect</button>
      </div>
    </form>
  </div>
</body>
</html>`;
  return { status: 200, headers: htmlPageHeaders(), body: html };
}

// --- Route handlers ---

/** GET /.well-known/oauth-protected-resource */
export function handleProtectedResourceMetadata(host: string | undefined): string {
  const base = getBaseUrl(host);
  return JSON.stringify({
    resource: base,
    authorization_servers: [base],
    scopes_supported: ['mcp'],
  });
}

/** GET /.well-known/oauth-authorization-server */
export function handleAuthServerMetadata(host: string | undefined): string {
  const base = getBaseUrl(host);
  return JSON.stringify({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  });
}

interface LoginPageParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  email?: string;
  errorMsg?: string;
}

/** Build the /oauth/provider-start URL carrying the MCP client's PKCE params. */
function providerStartUrl(provider: string, p: LoginPageParams): string {
  const q = new URLSearchParams({
    provider,
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: p.codeChallengeMethod,
    scope: p.scope,
  });
  return `/oauth/provider-start?${q.toString()}`;
}

/**
 * The sign-in page shown by GET /oauth/authorize, re-rendered with an error by
 * the POST handler and the provider-callback handlers. One source of truth for
 * the markup so the three paths cannot drift.
 */
function renderLoginPage(p: LoginPageParams, status = 200): { status: number; headers: Record<string, string>; body: string } {
  const errorHtml = p.errorMsg ? `<div class="error">${escapeHtml(p.errorMsg)}</div>\n    ` : '';
  const providersHtml = isProviderSignInEnabled()
    ? `<p class="hint">Use the button for the account you signed up with. The email and password form below works only if you created a password for your account.</p>
      ${SIGN_IN_PROVIDERS.map((prov) =>
      `<a class="provider-btn" href="${escapeHtml(providerStartUrl(prov.id, p))}">Continue with ${prov.label}</a>`).join('\n      ')}
      <div class="divider"><span>or use your email and password</span></div>
      `
    : '';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Options Analysis Suite — Sign In</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #1e293b; border-radius: 12px; padding: 40px; max-width: 400px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
    h1 { font-size: 1.4rem; margin-bottom: 8px; color: #f8fafc; }
    .subtitle { font-size: 0.85rem; color: #94a3b8; margin-bottom: 24px; }
    label { display: block; font-size: 0.85rem; color: #94a3b8; margin-bottom: 4px; }
    input[type="email"], input[type="password"] { width: 100%; padding: 10px 12px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; font-size: 0.95rem; margin-bottom: 16px; }
    input:focus { outline: none; border-color: #0d9488; }
    button { width: 100%; padding: 12px; border-radius: 6px; border: none; background: #0d9488; color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer; }
    button:hover { background: #0f766e; }
    .error { background: #7f1d1d; color: #fca5a5; padding: 10px; border-radius: 6px; margin-bottom: 16px; font-size: 0.85rem; }
    .logo { font-size: 1.8rem; margin-bottom: 16px; }
    .provider-btn { display: block; text-align: center; padding: 10px 12px; border: 1px solid #334155; border-radius: 6px; background: #0f172a; color: #e2e8f0; text-decoration: none; font-size: 0.95rem; margin-bottom: 10px; }
    .provider-btn:hover { border-color: #0d9488; }
    .divider { display: flex; align-items: center; gap: 10px; color: #64748b; font-size: 0.8rem; margin: 16px 0; }
    .divider::before, .divider::after { content: ''; flex: 1; border-top: 1px solid #334155; }
    .hint { font-size: 0.8rem; color: #94a3b8; background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 10px 12px; margin-bottom: 16px; line-height: 1.45; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">&#10022;</div>
    <h1>Options Analysis Suite</h1>
    <p class="subtitle">Sign in to connect your account to ChatGPT</p>
    ${errorHtml}${providersHtml}<form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(p.clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(p.redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(p.state)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(p.codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(p.codeChallengeMethod)}">
      <input type="hidden" name="scope" value="${escapeHtml(p.scope)}">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required placeholder="you@example.com"${p.email !== undefined ? ` value="${escapeHtml(p.email)}"` : ''}>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required placeholder="Your password">
      <button type="submit">Sign In & Authorize</button>
    </form>
  </div>
</body>
</html>`;
  return { status, headers: htmlPageHeaders(), body: html };
}

/** GET /oauth/authorize — render login page */
export function handleAuthorizeGet(query: URLSearchParams): { status: number; headers: Record<string, string>; body: string } {
  const clientId = query.get('client_id') || '';
  const redirectUri = query.get('redirect_uri') || '';
  const state = query.get('state') || '';
  const codeChallenge = query.get('code_challenge') || '';
  const codeChallengeMethod = query.get('code_challenge_method') || 'S256';
  const scope = query.get('scope') || '';

  // Validate redirect URI before showing login form
  if (redirectUri && !isRedirectAllowed(redirectUri)) {
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_request', error_description: 'Redirect URI not allowed' }),
    };
  }

  // Reject non-S256 PKCE before showing login form
  if (codeChallengeMethod !== 'S256') {
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_request', error_description: 'Only S256 code_challenge_method is supported' }),
    };
  }

  return renderLoginPage({ clientId, redirectUri, state, codeChallenge, codeChallengeMethod, scope });
}

function renderMfaForm(flowId: string, flow: MfaFlow, errorMsg = ''): { status: number; headers: Record<string, string>; body: string } {
  const errorHtml = errorMsg
    ? `<div class="error">${escapeHtml(errorMsg)}</div>`
    : '';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Options Analysis Suite — Two-Factor Verification</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #1e293b; border-radius: 12px; padding: 40px; max-width: 400px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
    h1 { font-size: 1.4rem; margin-bottom: 8px; color: #f8fafc; }
    .subtitle { font-size: 0.85rem; color: #94a3b8; margin-bottom: 24px; line-height: 1.4; }
    label { display: block; font-size: 0.85rem; color: #94a3b8; margin-bottom: 4px; }
    input[type="text"] { width: 100%; padding: 10px 12px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; font-size: 0.95rem; margin-bottom: 16px; letter-spacing: 0.08em; }
    input:focus { outline: none; border-color: #0d9488; }
    button { width: 100%; padding: 12px; border-radius: 6px; border: none; background: #0d9488; color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer; }
    button:hover { background: #0f766e; }
    .error { background: #7f1d1d; color: #fca5a5; padding: 10px; border-radius: 6px; margin-bottom: 16px; font-size: 0.85rem; }
    .logo { font-size: 1.8rem; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">&#10022;</div>
    <h1>Two-factor verification</h1>
    <p class="subtitle">Enter the code from your authenticator app to finish connecting Options Analysis Suite.</p>
    ${errorHtml}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(flow.clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(flow.redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(flow.state)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(flow.codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(flow.codeChallengeMethod)}">
      <input type="hidden" name="mfa_flow_id" value="${escapeHtml(flowId)}">
      <label for="mfa_code">Authenticator code</label>
      <input type="text" id="mfa_code" name="mfa_code" inputmode="numeric" autocomplete="one-time-code" required placeholder="123456">
      <button type="submit">Verify & Authorize</button>
    </form>
  </div>
</body>
</html>`;
  return { status: 200, headers: htmlPageHeaders(), body: html };
}

/** POST /oauth/authorize — validate credentials, issue code, redirect */
export async function handleAuthorizePost(
  body: string,
  cookieHeader?: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const params = new URLSearchParams(body);
  const email = params.get('email') || '';
  const password = params.get('password') || '';
  const clientId = params.get('client_id') || '';
  const redirectUri = params.get('redirect_uri') || '';
  const state = params.get('state') || '';
  const codeChallenge = params.get('code_challenge') || '';
  const codeChallengeMethod = params.get('code_challenge_method') || 'S256';
  const scope = params.get('scope') || '';
  const mfaFlowId = params.get('mfa_flow_id') || '';
  const mfaCode = params.get('mfa_code') || '';

  // Validate redirect URI
  if (!isRedirectAllowed(redirectUri)) {
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_request', error_description: 'Redirect URI not allowed' }),
    };
  }

  // PKCE is required — reject requests without a code challenge
  if (!codeChallenge) {
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_request', error_description: 'PKCE code_challenge is required' }),
    };
  }

  // Only S256 is supported — reject early before credential validation
  if (codeChallengeMethod !== 'S256') {
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_request', error_description: 'Only S256 code_challenge_method is supported' }),
    };
  }

  if (mfaFlowId) {
    const flow = mfaFlows.get(mfaFlowId);
    if (!flow || Date.now() > flow.expiresAt) {
      if (flow) mfaFlows.delete(mfaFlowId);
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'invalid_request', error_description: 'Two-factor verification expired. Start sign-in again.' }),
      };
    }
    if (
      flow.clientId !== clientId ||
      flow.redirectUri !== redirectUri ||
      flow.state !== state ||
      flow.codeChallenge !== codeChallenge ||
      flow.codeChallengeMethod !== codeChallengeMethod
    ) {
      mfaFlows.delete(mfaFlowId);
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'invalid_request', error_description: 'Two-factor verification state mismatch' }),
      };
    }

    try {
      const accessToken = await completeMfaFlow(flow, mfaCode);
      if (!(await hasActiveSubscription(accessToken))) {
        mfaFlows.delete(mfaFlowId);
        return renderMfaForm(mfaFlowId, flow, 'Your subscription is not active. Please visit optionsanalysissuite.com/pricing to subscribe.');
      }
      // NET ZERO, and deliberately unguarded: releasing the MFA flow before
      // issuing means completing a second factor never raises the outstanding
      // count, so a full budget can never strand a user who has already passed
      // it. Do not reorder these two lines.
      mfaFlows.delete(mfaFlowId);
      return issueAuthorizationOrConsent({ ...flow, apiKey: `${OAUTH_ACCESS_TOKEN_PREFIX}${accessToken}` }, cookieHeader);
    } catch (err) {
      flow.failedAttempts += 1;
      if (flow.failedAttempts >= MFA_FLOW_MAX_FAILED_ATTEMPTS) {
        mfaFlows.delete(mfaFlowId);
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'invalid_request', error_description: 'Too many invalid two-factor codes. Start sign-in again.' }),
        };
      }
      const message = err instanceof AuthError
        ? err.message
        : 'Two-factor verification failed. Please try again.';
      return renderMfaForm(mfaFlowId, flow, message);
    }
  }

  // Validate credentials and subscription
  let errorMsg = '';
  let apiKey = '';
  try {
    const result = await loginForOAuth(AUTH_SERVER_URL, email, password);
    if (result.kind === 'mfa_required') {
      if (result.code !== 'mfa_required' || !result.stepUpToken || !result.cookieHeader) {
        errorMsg = 'Two-factor verification is temporarily unavailable. Please try again later.';
      } else if (!reserveOutstandingAuthorization()) {
        return budgetExhaustedPage();
      } else {
        const flowId = randomBytes(32).toString('hex');
        const flow: MfaFlow = {
          stepUpToken: result.stepUpToken,
          cookieHeader: result.cookieHeader,
          clientId,
          redirectUri,
          state,
          codeChallenge,
          codeChallengeMethod,
          expiresAt: Date.now() + 5 * 60 * 1000,
          failedAttempts: 0,
        };
        mfaFlows.set(flowId, flow);
        return renderMfaForm(flowId, flow);
      }
    } else {
      // Password sign-ins keep the base64(email:password) credential and get NO
      // refresh_token. Two reasons: (1) that credential auto-relogins server-side
      // via TokenManager, so it renews without a refresh grant; (2) a
      // refresh_token here would resolve to an oauth-access:<JWT> bearer on
      // refresh, flipping the MCP session's owner identity from key:<hash> to
      // sid:<session_id> and locking the client out of its own session. Provider
      // sign-ins (which have no password to embed) are the refresh_token case,
      // and their owner is sid:<session_id> from issuance through every refresh.
      apiKey = Buffer.from(`${email}:${password}`).toString('base64');
      if (!(await hasActiveSubscription(result.tokens.accessToken))) {
        errorMsg = 'Your subscription is not active. Please visit optionsanalysissuite.com/pricing to subscribe.';
      }
    }
  } catch (err) {
    // AuthError with "Invalid email" is a credential failure (401/403);
    // all other errors (timeouts, 5xx, JSON parse) are service issues
    const isCredentialError = err instanceof AuthError
      && /invalid email/i.test(err.message);
    errorMsg = isCredentialError
      ? 'Invalid email or password. Please try again.'
      : 'Login service unavailable. Please try again later.';
  }

  if (errorMsg) {
    // Return login page with error
    return renderLoginPage({ clientId, redirectUri, state, codeChallenge, codeChallengeMethod, scope, email, errorMsg });
  }

  return issueAuthorizationOrConsent({
    apiKey,
    codeChallenge,
    codeChallengeMethod,
    redirectUri,
    clientId,
    state,
  }, cookieHeader);
}

// --- Provider sign-in endpoints ---

const PROVIDER_ERROR_MESSAGES: Record<string, string> = {
  provider: 'The provider could not sign you in. Please try again, or use your email and password.',
  state: 'The sign-in attempt expired. Please try again.',
  exchange: 'Sign-in could not be completed. Please try again.',
};

/** Dead-end notice page: one markup source for every "this flow cannot continue" answer. */
function noticePage(heading: string, message: string, status = 400): { status: number; headers: Record<string, string>; body: string } {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Options Analysis Suite — Sign In</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #1e293b; border-radius: 12px; padding: 40px; max-width: 400px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
    h1 { font-size: 1.4rem; margin-bottom: 8px; color: #f8fafc; }
    p { font-size: 0.9rem; color: #94a3b8; line-height: 1.5; }
    .logo { font-size: 1.8rem; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">&#10022;</div>
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
  return { status, headers: htmlPageHeaders(), body: html };
}

/** The provider flow outlived our 10-minute window (or was already consumed). */
function expiredFlowPage(): { status: number; headers: Record<string, string>; body: string } {
  return noticePage(
    'Sign-in session expired',
    'This sign-in attempt is no longer valid. Return to your AI client (ChatGPT, Claude, etc.) and start the connection again.',
  );
}

/** The flow is live, but this browser is not the one that started it. */
function unboundFlowPage(): { status: number; headers: Record<string, string>; body: string } {
  return noticePage(
    'Sign-in could not be verified',
    'This sign-in was started in a different browser or session, so it cannot be completed here. '
    + 'Return to your AI client (ChatGPT, Claude, etc.) and start the connection again from this browser.',
  );
}

// ── Browser binding for the provider flow ───────────────────────────────────
//
// The mcp_state flow id travels in URLs the whole way round (this server's
// redirect, the auth server's /start, the provider's callback, the finish page's
// form), so it is NOT secret: it shows up in address bars, Referer headers and
// logs. On its own it is a bearer capability, and the thing it bears is "deliver
// the next completed sign-in into the MCP client params parked under this id".
//
// THE ATTACK. An attacker calls /oauth/provider-start with THEIR OWN client_id /
// redirect_uri / state / code_challenge, keeps the flow id it mints, and lures a
// victim to <auth server>/api/v1/oauth/start?flow=mcp&mcp_state=<that id>. The
// victim's browser runs a real provider sign-in - zero clicks if their provider
// session is live - and the sealed handoff is posted back here, so an
// authorization code for the VICTIM's account is issued against the ATTACKER's
// pending authorization. PKCE does not help: the attacker minted the challenge
// and holds the verifier. Whether the attacker can then SPEND that code depends
// on the redirect target, and ALLOWED_REDIRECTS deliberately includes a shared
// multi-tenant gateway callback (see the Smithery entry) where a code delivered
// for someone else's pending connection can land in the attacker's.
//
// THE FIX. Pair the public flow id with a high-entropy secret that never leaves
// the browser that started the flow: provider-start sets it in an HttpOnly
// cookie and keeps only its SHA-256, and both provider-callback entry points
// require the pair before anything is spent. A flow started in one browser
// cannot be finished in another.
//
// WHY THE CHECK LANDS HERE. The attacker routes the victim straight at the auth
// server, so a pre-flight endpoint on this side would simply be skipped, and the
// auth server cannot make the check itself - it cannot read this origin's cookie,
// and the two services are independently deployed behind separate env-configured
// hostnames, so a shared-domain cookie would be a silent coupling. The last hop
// is therefore the first place the check can be enforced with no new protocol,
// and it is sufficient: nothing is spent before it runs. The auth server's own
// leg is already browser-bound by the signed finish cookie it mints at /callback.
//
// AN EARLIER REFUSAL IS POSSIBLE and is deliberately not built here: the auth
// server could mint a nonce at /start, bounce the browser through an endpoint on
// THIS origin that checks the cookie and signs (mcp_state, nonce) with the shared
// handoff secret, and refuse without a valid proof. That needs no cross-origin
// cookie read. It buys no additional protection against the fixation itself -
// this check already denies the attacker the code - but it would remove the
// residual below. Tracked as a follow-up, not a gap in this fix.
//
// RESIDUAL. A lured victim's browser still completes a real sign-in before the
// handoff is refused here, leaving a session + ledger row on the auth server that
// nobody uses. It holds one of the account's MAX_ACTIVE_SESSIONS (default 5)
// slots, so repeated lures can push a user's older inactive sessions out.
//
// WHAT THIS DOES NOT COVER: an attacker who lures the victim to /oauth/authorize
// or /oauth/provider-start directly, carrying the attacker's client params. The
// victim's own browser starts that flow, so the binding is satisfied and the code
// is issued to the attacker's pending authorization. Flow binding cannot reach
// it; the defence is client identification at consent time, and it matters most
// for redirect targets where the recipient is not the initiator (see the
// multi-tenant gateway entry in ALLOWED_REDIRECTS).

const PROVIDER_FLOW_COOKIE = 'oas_mcp_flow';

/**
 * How many bindings one browser may hold in a single binding cookie, for either
 * jar. A single-valued cookie would let each new sign-in evict the previous
 * one's binding, so a user connecting two AI clients at once - or one who backs
 * out of Google, picks GitHub, then finishes the first tab - would find the older
 * tab unfinishable. Binding must not introduce that regression, so each cookie is
 * a small newest-first jar.
 */
const MAX_BINDINGS_PER_COOKIE = 3;

/**
 * EVERY value sent under `name`, not just the first. A browser sends one cookie
 * line per (name, domain, path), so a same-named cookie scoped to a parent domain
 * - which any sibling subdomain can set - would otherwise be able to shadow ours
 * and make a legitimate browser look unbound. Reading all of them means such a
 * cookie can add junk entries but never hide the real binding. It cannot forge
 * one: the secret behind the stored hash is not knowable.
 */
function readCookieValues(cookieHeader: string | undefined, name: string): string[] {
  const values: string[] = [];
  for (const part of (cookieHeader ?? '').split(';')) {
    const cookie = part.trim();
    const equalsIdx = cookie.indexOf('=');
    if (equalsIdx <= 0) continue;
    if (cookie.slice(0, equalsIdx) === name) values.push(cookie.slice(equalsIdx + 1));
  }
  return values;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time compare of two hex digests. */
function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * One `<id>.<secret>` pair from a binding cookie. Both the provider-flow jar and
 * the consent jar use this shape: an id that also travels in the clear, plus a
 * secret that only ever lives in the cookie.
 */
interface CookieBinding {
  id: string;
  secret: string;
}

/** Cookie value format: `<flowId>.<secret>` entries, newest first, `~`-separated. */
function parseBindingJar(values: string[]): CookieBinding[] {
  const jar: CookieBinding[] = [];
  for (const entry of values.join('~').split('~')) {
    const dotIdx = entry.indexOf('.');
    if (dotIdx <= 0) continue;
    jar.push({ id: entry.slice(0, dotIdx), secret: entry.slice(dotIdx + 1) });
  }
  return jar;
}

/**
 * Serialize a jar back into a Set-Cookie. Callers pass only entries that have
 * ALREADY authenticated against live server state, so every byte written here is
 * provably one we minted.
 */
function jarCookieHeader(name: string, jar: CookieBinding[], sameSite: 'None' | 'Lax', ttlMs: number): string {
  if (!jar.length) return `${name}=; ${cookieAttributes(sameSite)}; Max-Age=0`;
  const value = jar
    .slice(0, MAX_BINDINGS_PER_COOKIE)
    .map((entry) => `${entry.id}.${entry.secret}`)
    .join('~');
  return `${name}=${value}; ${cookieAttributes(sameSite)}; Max-Age=${Math.floor(ttlMs / 1000)}`;
}

/** The bindings this request presents, across every cookie line carrying them. */
function bindingJarFrom(cookieHeader: string | undefined): CookieBinding[] {
  return parseBindingJar(readCookieValues(cookieHeader, PROVIDER_FLOW_COOKIE));
}

/**
 * The presented bindings that AUTHENTICATE against a live parked flow.
 *
 * This is the gate for every write of the jar back to the browser, and shape
 * checks are not a substitute for it. A sibling subdomain can set a same-named
 * cookie at a wider scope carrying syntactically perfect but forged entries;
 * re-serializing those would let it push the browser's real bindings out of a
 * capped jar - eviction, not injection, is the reachable harm. Requiring the
 * secret to hash to a live flow's stored digest means a forged entry can neither
 * survive a round trip nor displace a genuine one, and it also drops spent and
 * expired flows for free. It is why nothing unauthenticated is ever written into
 * a Set-Cookie header: every entry we echo is provably one we minted.
 */
function liveBindingsFrom(cookieHeader: string | undefined): CookieBinding[] {
  const now = Date.now();
  return bindingJarFrom(cookieHeader).filter((entry) => {
    const flow = providerFlows.get(entry.id);
    if (!flow || now > flow.expiresAt) return false;
    return digestsEqual(sha256Hex(entry.secret), flow.bindingHash);
  });
}

/**
 * SameSite=None over https, deliberately. The sealed handoff arrives as a
 * CROSS-ORIGIN top-level form POST from the auth server's finish page, so a Lax
 * cookie is withheld unless the two services happen to be same-site - and they
 * are separate deployments behind independent env-configured hostnames, so
 * depending on a shared registrable domain would mean provider sign-in breaking
 * outright, with no code change, the day either host moves. None is safe here
 * because the cookie carries no authority on its own: spending it also requires a
 * handoff blob sealed by the auth server for a completed sign-in, which no
 * third-party site can produce, and the flow id it must be presented with is
 * unguessable. Local http development falls back to Lax, since None requires
 * Secure and Secure cannot be set over plain http.
 */
function cookieAttributes(sameSite: 'None' | 'Lax'): string {
  const https = getBaseUrl(undefined).startsWith('https:');
  // None requires Secure, which cannot be set over plain http, so local
  // development degrades to Lax - where it is also correct, since a dev auth
  // server and MCP server on localhost are same-site anyway.
  const effective = sameSite === 'None' && !https ? 'Lax' : sameSite;
  return `Path=/oauth; HttpOnly; SameSite=${effective}${https ? '; Secure' : ''}`;
}

function bindingCookieHeader(jar: CookieBinding[]): string {
  return jarCookieHeader(PROVIDER_FLOW_COOKIE, jar, 'None', PROVIDER_FLOW_TTL_MS);
}

/** The client-params half of a parked flow. Never the binding material. */
function loginParamsFor(flow: ProviderFlow): LoginPageParams {
  return {
    clientId: flow.clientId,
    redirectUri: flow.redirectUri,
    state: flow.state,
    codeChallenge: flow.codeChallenge,
    codeChallengeMethod: flow.codeChallengeMethod,
    scope: flow.scope,
  };
}

/**
 * True when this browser presents the secret minted alongside `flowId`. EVERY
 * entry for the id is considered, not the first: a same-named cookie from a wider
 * scope would otherwise be able to sit ahead of the real one and deny a browser
 * that does hold the binding.
 */
function browserHoldsFlowBinding(cookieHeader: string | undefined, flowId: string, flow: ProviderFlow): boolean {
  return bindingJarFrom(cookieHeader)
    .filter((candidate) => candidate.id === flowId)
    .some((candidate) => digestsEqual(sha256Hex(candidate.secret), flow.bindingHash));
}

// ── Flow proof: let the AUTH SERVER refuse a lured sign-in BEFORE it happens ──
//
// THE RESIDUAL THIS EXISTS FOR. provider-callback already refuses to spend a
// handoff into a flow this browser cannot prove it started, which is what denies
// an attacker the code. But by then the victim's browser has completed a REAL
// sign-in, so the auth server holds a session and a ledger row nobody will use.
// That row occupies one of the account's MAX_ACTIVE_SESSIONS slots, and the auth
// server's enforceSessionLimit evicts OLDEST-INACTIVE - so repeated lures push a
// user's genuine older sessions out. No access is granted; the harm is that a
// targeted user gets logged out of their real devices.
//
// The auth server cannot check the binding itself: it cannot read this origin's
// cookie, and the two run on independent hostnames. So it bounces the browser
// here instead, and this endpoint - which CAN read the cookie - returns a signed
// statement that the browser holds the binding. No cross-origin cookie read is
// needed anywhere.
//
// A lured victim never visited provider-start, holds no binding for that flow id,
// and so cannot obtain a proof: they are turned away before authenticating, and
// no session is ever created.
const FLOW_PROOF_LABEL = 'oas.mcp.flow-proof.v1';

/**
 * The proof key: HMAC(handoff secret, label), NEVER the handoff secret itself.
 *
 * DOMAIN SEPARATION IS THE POINT. The handoff key is `sha256(secret)` and seals
 * the AES-GCM blob carrying a real GoTrue session. Deriving the proof key through
 * a different construction with a distinct label makes the two values unrelated,
 * so a proof can never be opened, replayed or mistaken for a session handoff, and
 * a signing oracle on one is not an oracle on the other.
 *
 * Derived rather than a second env var on purpose: both services already hold
 * this secret, so there is nothing to provision and no rotation window in which
 * the two sides disagree and connector sign-in breaks. The security difference is
 * nil - both keys would live in the same two environments.
 */
let cachedFlowProofKey: { secret: string; key: Buffer } | null = null;
function flowProofKey(): Buffer | null {
  const secret = process.env.OAS_MCP_HANDOFF_SECRET || '';
  if (!secret || secret.length < 32) return null; // fail-dark, mirroring handoffKey
  if (!cachedFlowProofKey || cachedFlowProofKey.secret !== secret) {
    cachedFlowProofKey = {
      secret,
      key: createHmac('sha256', secret).update(FLOW_PROOF_LABEL).digest(),
    };
  }
  return cachedFlowProofKey.key;
}

/** The signed statement: "this browser holds the binding for <flowId>, for challenge <nonce>". */
export function signFlowProof(flowId: string, nonce: string): string | null {
  const key = flowProofKey();
  if (!key) return null;
  // Length-prefixed rather than concatenated: `a.b` from ("a", "b") and ("a.b", "")
  // must not produce the same signed bytes, or a crafted flow id could borrow
  // another flow's proof.
  const message = `${flowId.length}:${flowId}.${nonce.length}:${nonce}`;
  return createHmac('sha256', key).update(message).digest('hex');
}

const FLOW_ID_RE = /^[a-f0-9]{32}$/;
const FLOW_NONCE_RE = /^[a-f0-9]{16,64}$/;

/**
 * GET /oauth/flow-proof?mcp_state=<flowId>&nonce=<nonce>
 *
 * Answers only for a browser that holds this flow's binding cookie, and redirects
 * back to a FIXED auth-server URL taken from our own env - never a target from
 * the query string, which would make this an open redirect wearing a proof.
 *
 * INERT until the auth server calls it. Shipping it first is what lets that
 * change deploy without an ordering window in which sign-in is broken.
 */
export function handleFlowProof(
  query: URLSearchParams,
  cookieHeader?: string,
): { status: number; headers: Record<string, string>; body: string } {
  if (!isProviderSignInEnabled()) {
    return {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_request', error_description: 'Provider sign-in is not enabled' }),
    };
  }

  const flowId = query.get('mcp_state') || '';
  const nonce = query.get('nonce') || '';
  if (!FLOW_ID_RE.test(flowId) || !FLOW_NONCE_RE.test(nonce)) return unboundFlowPage();

  const flow = providerFlows.get(flowId);
  if (!flow || Date.now() > flow.expiresAt) {
    providerFlows.delete(flowId);
    return unboundFlowPage();
  }

  // THE CHECK. Everything else here is plumbing.
  if (!browserHoldsFlowBinding(cookieHeader, flowId, flow)) return unboundFlowPage();

  // NOT CONSUMED, for the reason handleProviderCallbackGet gives: the flow id
  // travels in URLs, so any cross-site navigation made in the bound browser could
  // reach this endpoint with the cookie attached and burn a sign-in the user is
  // midway through. It stays spendable only by this browser, and ages out.
  const proof = signFlowProof(flowId, nonce);
  if (!proof) return unboundFlowPage();

  const target = new URL(`${AUTH_SERVER_URL}/api/v1/oauth/start`);
  target.searchParams.set('mcp_state', flowId);
  target.searchParams.set('flow_nonce', nonce);
  target.searchParams.set('flow_proof', proof);
  return {
    status: 302,
    headers: { Location: target.toString(), 'Cache-Control': 'no-store' },
    body: '',
  };
}

/** GET /oauth/provider-start — park the MCP client's PKCE params, bounce to the auth server's BFF */
export function handleProviderStart(
  query: URLSearchParams,
  cookieHeader?: string,
): { status: number; headers: Record<string, string>; body: string } {
  if (!isProviderSignInEnabled()) {
    return {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_request', error_description: 'Provider sign-in is not enabled' }),
    };
  }
  const provider = (query.get('provider') || '').toLowerCase();
  const clientId = query.get('client_id') || '';
  const redirectUri = query.get('redirect_uri') || '';
  const state = query.get('state') || '';
  const codeChallenge = query.get('code_challenge') || '';
  const codeChallengeMethod = query.get('code_challenge_method') || 'S256';
  const scope = query.get('scope') || '';

  const invalid = (description: string) => ({
    status: 400,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'invalid_request', error_description: description }),
  });
  // Mirror handleAuthorizeGet/Post gates: nothing gets parked in a flow that the
  // authorize endpoints themselves would reject.
  if (!isSignInProvider(provider)) return invalid('Unsupported provider');
  if (!redirectUri || !isRedirectAllowed(redirectUri)) return invalid('Redirect URI not allowed');
  if (!codeChallenge) return invalid('PKCE code_challenge is required');
  if (codeChallengeMethod !== 'S256') return invalid('Only S256 code_challenge_method is supported');

  if (providerFlows.size >= MAX_PROVIDER_FLOWS) {
    const now = Date.now();
    for (const [id, f] of providerFlows) {
      if (now > f.expiresAt) providerFlows.delete(id);
    }
    if (providerFlows.size >= MAX_PROVIDER_FLOWS) {
      return {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        body: JSON.stringify({ error: 'temporarily_unavailable', error_description: 'Too many sign-in attempts in progress. Try again shortly.' }),
      };
    }
  }

  const flowId = randomBytes(16).toString('hex');
  const bindingSecret = randomBytes(32).toString('hex');
  providerFlows.set(flowId, {
    clientId,
    redirectUri,
    state,
    codeChallenge,
    codeChallengeMethod,
    scope,
    expiresAt: Date.now() + PROVIDER_FLOW_TTL_MS,
    bindingHash: sha256Hex(bindingSecret),
  });
  // Newest first; bindingCookieHeader trims to the cap, evicting the oldest.
  const jar: CookieBinding[] = [
    { id: flowId, secret: bindingSecret },
    ...liveBindingsFrom(cookieHeader),
  ];

  const target = new URL(`${AUTH_SERVER_URL}/api/v1/oauth/start`);
  target.searchParams.set('provider', provider);
  target.searchParams.set('flow', 'mcp');
  target.searchParams.set('mcp_state', flowId);
  return {
    status: 302,
    headers: {
      Location: target.toString(),
      'Cache-Control': 'no-store',
      'Set-Cookie': bindingCookieHeader(jar),
    },
    body: '',
  };
}

/** GET /oauth/provider-callback — error bounce from the auth server (no tokens) */
export function handleProviderCallbackGet(
  query: URLSearchParams,
  cookieHeader?: string,
): { status: number; headers: Record<string, string>; body: string } {
  const flowId = query.get('mcp_state') || '';
  const error = query.get('error') || 'provider';
  const flow = providerFlows.get(flowId);
  if (!flow || Date.now() > flow.expiresAt) {
    providerFlows.delete(flowId);
    return expiredFlowPage();
  }
  if (!browserHoldsFlowBinding(cookieHeader, flowId, flow)) return unboundFlowPage();
  // THE FLOW IS NOT CONSUMED HERE, deliberately. This endpoint authenticates the
  // browser but not the AUTH SERVER: it is a plain GET carrying a flow id that
  // travels in URLs, so any cross-site navigation made in the bound browser -
  // an <img>, a link, a redirect from a page the user is reading - could reach it
  // with the cookie attached and burn a sign-in the user is midway through.
  // Deleting bought nothing anyway: retries come from the re-rendered page's
  // provider buttons, which mint a fresh flow at provider-start. The flow is
  // still spendable only by this browser with a handoff only the auth server can
  // seal, so leaving it to age out of its 10-minute TTL costs one map entry and
  // removes a denial-of-service vector.
  const errorMsg = PROVIDER_ERROR_MESSAGES[error] ?? PROVIDER_ERROR_MESSAGES.provider;
  return renderLoginPage({ ...loginParamsFor(flow), errorMsg });
}

/** POST /oauth/provider-callback — auth server's interstitial posts the sealed session handoff */
export async function handleProviderCallbackPost(
  body: string,
  cookieHeader?: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const params = new URLSearchParams(body);
  const flowId = params.get('mcp_state') || '';
  const blob = params.get('handoff') || '';
  const flow = providerFlows.get(flowId);
  if (!flow || Date.now() > flow.expiresAt) {
    providerFlows.delete(flowId);
    return expiredFlowPage();
  }
  // Checked before the blob is even opened: the handoff is only spendable by the
  // browser that started this flow, so an unbound POST gets no authorization code
  // and does not consume the flow.
  if (!browserHoldsFlowBinding(cookieHeader, flowId, flow)) return unboundFlowPage();

  const opened = openHandoffBlob(blob, flowId);
  if (!opened) {
    // Keep the flow: the transfer on the auth-server side is already
    // irreversible by the time this POST arrives, so a garbled/expired blob
    // must not ALSO burn the flow - the re-rendered page (TTL-bounded) lets
    // the user retry. Replay of a valid blob is prevented below.
    return renderLoginPage({ ...loginParamsFor(flow), errorMsg: 'Sign-in expired or could not be verified. Please try again.' });
  }
  // CAPACITY BEFORE CONSUMPTION. Spending this flow is a net-NEW outstanding
  // authorization (a provider flow is bounded by its own cap, not by the
  // authorization budget), so a full budget must be discovered while the flow is
  // still intact. Refusing after the delete would turn a retryable 503 into a
  // destroyed sign-in: the same POST would come back "expired" and the user
  // would have to start over at their client.
  if (!reserveOutstandingAuthorization()) return budgetExhaustedPage();

  // Consume the flow only once a cryptographically valid handoff arrived.
  providerFlows.delete(flowId);

  // NO subscription check here: the auth server verifies an active subscription
  // BEFORE sealing the handoff (and 403s otherwise, so no blob is ever produced
  // for an inactive account). A duplicate profile fetch on this side would add
  // no security but WOULD reintroduce a durability hole - the session is already
  // transferred + the browser cookie cleared, so a transient profile 5xx here
  // would strand it with no retry. Trust the sealed blob's provenance.
  // The spent flow is already deleted, so re-serializing the live bindings drops
  // it and keeps any other connection this browser has in flight. That refresh
  // rides along only when a code is issued now; a consent page needs the cookie
  // slot for itself.
  return issueAuthorizationOrConsent(
    {
      apiKey: `${OAUTH_ACCESS_TOKEN_PREFIX}${opened.accessToken}`,
      refreshCredential: opened.refreshToken || undefined,
      codeChallenge: flow.codeChallenge,
      codeChallengeMethod: flow.codeChallengeMethod,
      redirectUri: flow.redirectUri,
      clientId: flow.clientId,
      state: flow.state,
    },
    cookieHeader,
    bindingCookieHeader(liveBindingsFrom(cookieHeader)),
  );
}

/** Wrap a GoTrue refresh token (bound to the client) into a stateless OAuth refresh_token. */
function mintRefreshToken(clientId: string, gotrueRefreshToken: string): string {
  return encryptToken(
    `${OAUTH_REFRESH_TOKEN_PREFIX}${JSON.stringify({ c: clientId, r: gotrueRefreshToken })}`,
    Date.now() + REFRESH_TOKEN_TTL_MS,
  );
}

/**
 * grant_type=refresh_token — unwrap the GoTrue refresh token and rotate it via
 * the auth server's /oauth/refresh (which owns GoTrue rotation AND keeps the
 * session-ledger row in sync). Returns a fresh bearer + a re-wrapped refresh
 * token holding the rotated GoTrue token. Failures split by cause: a REJECTED
 * session (AuthError - explicit 401/403, no_session, MFA) becomes invalid_grant
 * so the client re-authorizes; a TRANSIENT failure (429/5xx, timeout, malformed
 * 2xx) becomes a retryable 503 so the client keeps its still-valid refresh token.
 */
async function handleRefreshGrant(params: URLSearchParams): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const refreshTokenParam = params.get('refresh_token') || '';
  const clientId = params.get('client_id') || '';

  const invalidGrant = (description: string) => ({
    status: 400,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'invalid_grant', error_description: description }),
  });

  const wrapped = decryptToken(refreshTokenParam);
  if (!wrapped || !wrapped.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)) {
    return invalidGrant('Refresh token expired or invalid');
  }
  let parsed: { c?: string; r?: string };
  try {
    parsed = JSON.parse(wrapped.slice(OAUTH_REFRESH_TOKEN_PREFIX.length));
  } catch {
    return invalidGrant('Refresh token expired or invalid');
  }
  if (typeof parsed.r !== 'string' || !parsed.r) return invalidGrant('Refresh token expired or invalid');
  // The wrapper is bound to the client it was issued to (mirrors the code
  // exchange's client_id check; RFC 6749 Section 6).
  if ((parsed.c ?? '') !== clientId) return invalidGrant('Client ID mismatch');

  let tokens: AuthTokens;
  try {
    tokens = await refreshAccessToken(AUTH_SERVER_URL, parsed.r);
  } catch (err) {
    // AuthError = the session itself was rejected -> invalid_grant (client
    // re-authorizes). Anything else (429/5xx/network) is transient: 503 so the
    // client retries with the SAME still-valid refresh token instead of
    // discarding it and re-prompting the user.
    if (err instanceof AuthError) return invalidGrant('Session expired. Please sign in again.');
    return {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '10' },
      body: JSON.stringify({ error: 'temporarily_unavailable', error_description: 'Login service unavailable. Retry with the same refresh token.' }),
    };
  }

  const apiKey = `${OAUTH_ACCESS_TOKEN_PREFIX}${tokens.accessToken}`;
  const expiresAt = oauthCredentialExpiresAt(apiKey);
  try {
    const accessToken = encryptToken(apiKey, expiresAt);
    // refreshAccessToken already falls back to the prior GoTrue token when the
    // rotation returned no new cookie, so tokens.refreshToken is always spendable.
    const refreshToken = mintRefreshToken(clientId, tokens.refreshToken);
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
      body: JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'bearer',
        expires_in: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
        scope: 'mcp',
      }),
    };
  } catch {
    return {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'server_error', error_description: 'Token encryption not configured' }),
    };
  }
}

/** POST /oauth/token — exchange code (or refresh token) for an access token */
export async function handleTokenExchange(body: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const params = new URLSearchParams(body);
  const grantType = params.get('grant_type');
  const code = params.get('code') || '';
  const codeVerifier = params.get('code_verifier') || '';
  const redirectUri = params.get('redirect_uri') || '';
  const clientId = params.get('client_id') || '';

  // One outcome line per token POST, paired to `code_issued` by code
  // fingerprint. See the telemetry note above issueAuthorizationRedirect.
  const logExchange = (outcome: string) =>
    logOAuthEvent('token_exchange', {
      grant: grantCategory(grantType),
      code: oauthFingerprint(code),
      client: oauthFingerprint(clientId),
      redirect: redirectCategory(redirectUri),
      outcome,
    });

  if (grantType === 'refresh_token') {
    logOAuthEvent('token_exchange', { grant: 'refresh_token', client: oauthFingerprint(clientId), outcome: 'refresh_delegated' });
    return handleRefreshGrant(params);
  }

  if (grantType !== 'authorization_code') {
    logExchange('unsupported_grant_type');
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'unsupported_grant_type' }),
    };
  }

  const authCode = authCodes.get(code);
  if (!authCode || Date.now() > authCode.expiresAt) {
    authCodes.delete(code);
    logExchange('unknown_or_expired_code');
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'Code expired or invalid' }),
    };
  }

  // Verify client_id matches the original authorization request
  if (clientId !== authCode.clientId) {
    authCodes.delete(code);
    logExchange('client_mismatch');
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'Client ID mismatch' }),
    };
  }

  // Verify PKCE. Every authorize entry rejects a non-S256 method before a code
  // is stored, so authCode.codeChallengeMethod is always 'S256' here. This
  // branch is unreachable defense-in-depth, which is why pkce_method_unsupported
  // is the one token_exchange outcome without a test: the public flow cannot
  // mint a non-S256 code to exercise it.
  if (authCode.codeChallengeMethod !== 'S256') {
    authCodes.delete(code);
    logExchange('pkce_method_unsupported');
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'Only S256 code_challenge_method is supported' }),
    };
  }
  const computedChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  if (computedChallenge !== authCode.codeChallenge) {
    authCodes.delete(code);
    logExchange('pkce_mismatch');
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE verification failed' }),
    };
  }

  // Verify redirect_uri matches the original authorization request (RFC 6749 Section 4.1.3)
  if (authCode.redirectUri && redirectUri !== authCode.redirectUri) {
    authCodes.delete(code);
    logExchange('redirect_mismatch');
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'Redirect URI mismatch' }),
    };
  }

  // Consume the code
  authCodes.delete(code);

  // Generate self-contained encrypted access token (survives server restarts)
  const expiresAt = oauthCredentialExpiresAt(authCode.apiKey);
  let accessToken: string;
  try {
    accessToken = encryptToken(authCode.apiKey, expiresAt);
  } catch {
    logExchange('encryption_unconfigured');
    return {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'server_error', error_description: 'Token encryption not configured' }),
    };
  }

  // A GoTrue-backed connection also gets a refresh_token so the client renews
  // silently instead of re-prompting at bearer expiry. Best-effort: the bearer
  // above already encrypted, so a wrapper failure just means re-auth at expiry.
  let refreshToken: string | undefined;
  if (authCode.refreshCredential) {
    try {
      refreshToken = mintRefreshToken(authCode.clientId, authCode.refreshCredential);
    } catch {
      refreshToken = undefined;
    }
  }

  logExchange('success');
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
    body: JSON.stringify({
      access_token: accessToken,
      token_type: 'bearer',
      // Actual bearer lifetime: 24h for credential-backed keys, the GoTrue JWT
      // expiry (~1h) for token-backed ones (previously hardcoded to 24h, which
      // overstated the latter).
      expires_in: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
      scope: 'mcp',
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    }),
  };
}

/** POST /oauth/register — Dynamic Client Registration (RFC 7591) */
export function handleClientRegistration(body: string): { status: number; headers: Record<string, string>; body: string } {
  try {
    const req = JSON.parse(body);

    // Per RFC 7591, the server filters requested metadata to what it supports
    // and returns the actual values in the response. Rejecting clients that ask
    // for refresh_token alongside authorization_code (as ChatGPT does) breaks
    // DCR for those clients with no benefit.
    if (req.grant_types !== undefined) {
      if (!Array.isArray(req.grant_types)) {
        return { status: 400, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'invalid_client_metadata', error_description: 'grant_types must be an array' }) };
      }
      if (!req.grant_types.includes('authorization_code')) {
        return { status: 400, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'invalid_client_metadata', error_description: 'authorization_code grant type must be requested' }) };
      }
    }
    if (req.response_types !== undefined) {
      if (!Array.isArray(req.response_types)) {
        return { status: 400, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'invalid_client_metadata', error_description: 'response_types must be an array' }) };
      }
      if (!req.response_types.includes('code')) {
        return { status: 400, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'invalid_client_metadata', error_description: 'code response type must be requested' }) };
      }
    }
    if (req.token_endpoint_auth_method && req.token_endpoint_auth_method !== 'none') {
      return { status: 400, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'invalid_client_metadata', error_description: 'Only none token_endpoint_auth_method is supported' }) };
    }
    // Validate redirect_uris: allow HTTPS, loopback for dev, and custom URI schemes
    // (e.g. cursor://, vscode://) for native apps per OAuth 2.0 RFC 8252.
    // Native apps commonly register multiple URIs (HTTPS for web + custom scheme
    // for deep-linking) in a single DCR call. The /oauth/authorize endpoint still
    // gates the actually-used redirect_uri against ALLOWED_REDIRECTS, so this is
    // safe defense-in-depth. Only insecure http:// (non-loopback) is rejected.
    //
    // DO NOT tighten this to isRedirectAllowed() — that breaks Cursor, which
    // sends both its HTTPS callback AND a `cursor://` custom scheme in a single
    // DCR payload. Rejecting the registration on the custom scheme rejects the
    // whole client. The authorization-time allowlist check is the real gate.
    // See closed mcp PR #9.
    if (req.redirect_uris !== undefined) {
      if (!Array.isArray(req.redirect_uris)) {
        return { status: 400, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be an array' }) };
      }
      for (const uri of req.redirect_uris) {
        try {
          const parsed = new URL(uri);
          const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
          if (parsed.protocol === 'http:' && !isLoopback) {
            return { status: 400, headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ error: 'invalid_redirect_uri', error_description: 'Insecure http:// redirect URIs are not allowed (use https:// or a custom URI scheme for native apps)' }) };
          }
        } catch {
          return { status: 400, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'invalid_redirect_uri', error_description: 'Invalid redirect URI format' }) };
        }
      }
    }

    // Always generate client_id server-side (don't let caller choose)
    const clientId = `oas_${randomBytes(16).toString('hex')}`;
    return {
      status: 201,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
      body: JSON.stringify({
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: req.client_name || 'MCP Client',
        redirect_uris: req.redirect_uris || [],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'mcp',
      }),
    };
  } catch {
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_client_metadata' }),
    };
  }
}

/** Escape HTML to prevent XSS in login form */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
