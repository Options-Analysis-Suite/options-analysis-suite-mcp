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
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
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
  // breaks the live Smithery listing for this MCP. Auditors flag this as a
  // "multi-tenant shared callback" widening the trust boundary; that is true
  // in the abstract, but the risk is bounded by (a) PKCE binding the code to
  // the originating browser session and (b) any leaked code only granting the
  // attacker the *victim's* MCP entitlements via Smithery (it does not expose
  // the auth server's master credentials). This is the standard tradeoff every
  // Smithery-listed MCP accepts; the hardening path is per-client_id redirect
  // binding in DCR, not removing the URL. See closed PR #141 / mcp PR #8.
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
}

const authCodes = new Map<string, AuthCode>();
const mfaFlows = new Map<string, MfaFlow>();
const providerFlows = new Map<string, ProviderFlow>();
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

function issueAuthorizationRedirect(input: {
  apiKey: string;
  refreshCredential?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  clientId: string;
  state: string;
}): { status: number; headers: Record<string, string>; body: string } {
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

  const redirectUrl = new URL(input.redirectUri);
  redirectUrl.searchParams.set('code', code);
  if (input.state) redirectUrl.searchParams.set('state', input.state);

  return {
    status: 302,
    headers: { Location: redirectUrl.toString() },
    body: '',
  };
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
    ? `${SIGN_IN_PROVIDERS.map((prov) =>
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
  return { status, headers: { 'Content-Type': 'text/html' }, body: html };
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
  return { status: 200, headers: { 'Content-Type': 'text/html' }, body: html };
}

/** POST /oauth/authorize — validate credentials, issue code, redirect */
export async function handleAuthorizePost(body: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
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
      mfaFlows.delete(mfaFlowId);
      return issueAuthorizationRedirect({ ...flow, apiKey: `${OAUTH_ACCESS_TOKEN_PREFIX}${accessToken}` });
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

  return issueAuthorizationRedirect({
    apiKey,
    codeChallenge,
    codeChallengeMethod,
    redirectUri,
    clientId,
    state,
  });
}

// --- Provider sign-in endpoints ---

const PROVIDER_ERROR_MESSAGES: Record<string, string> = {
  provider: 'The provider could not sign you in. Please try again, or use your email and password.',
  state: 'The sign-in attempt expired. Please try again.',
  exchange: 'Sign-in could not be completed. Please try again.',
};

/** The provider flow outlived our 10-minute window (or was already consumed). */
function expiredFlowPage(): { status: number; headers: Record<string, string>; body: string } {
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
    <h1>Sign-in session expired</h1>
    <p>This sign-in attempt is no longer valid. Return to your AI client (ChatGPT, Claude, etc.) and start the connection again.</p>
  </div>
</body>
</html>`;
  return { status: 400, headers: { 'Content-Type': 'text/html' }, body: html };
}

/** GET /oauth/provider-start — park the MCP client's PKCE params, bounce to the auth server's BFF */
export function handleProviderStart(query: URLSearchParams): { status: number; headers: Record<string, string>; body: string } {
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
  providerFlows.set(flowId, {
    clientId,
    redirectUri,
    state,
    codeChallenge,
    codeChallengeMethod,
    scope,
    expiresAt: Date.now() + PROVIDER_FLOW_TTL_MS,
  });

  const target = new URL(`${AUTH_SERVER_URL}/api/v1/oauth/start`);
  target.searchParams.set('provider', provider);
  target.searchParams.set('flow', 'mcp');
  target.searchParams.set('mcp_state', flowId);
  return { status: 302, headers: { Location: target.toString(), 'Cache-Control': 'no-store' }, body: '' };
}

/** GET /oauth/provider-callback — error bounce from the auth server (no tokens) */
export function handleProviderCallbackGet(query: URLSearchParams): { status: number; headers: Record<string, string>; body: string } {
  const flowId = query.get('mcp_state') || '';
  const error = query.get('error') || 'provider';
  const flow = providerFlows.get(flowId);
  providerFlows.delete(flowId); // single-use: retries mint a fresh flow from the re-rendered page
  if (!flow || Date.now() > flow.expiresAt) return expiredFlowPage();
  const errorMsg = PROVIDER_ERROR_MESSAGES[error] ?? PROVIDER_ERROR_MESSAGES.provider;
  return renderLoginPage({ ...flow, errorMsg });
}

/** POST /oauth/provider-callback — auth server's interstitial posts the sealed session handoff */
export async function handleProviderCallbackPost(body: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const params = new URLSearchParams(body);
  const flowId = params.get('mcp_state') || '';
  const blob = params.get('handoff') || '';
  const flow = providerFlows.get(flowId);
  if (!flow || Date.now() > flow.expiresAt) {
    providerFlows.delete(flowId);
    return expiredFlowPage();
  }

  const opened = openHandoffBlob(blob, flowId);
  if (!opened) {
    // Keep the flow: the transfer on the auth-server side is already
    // irreversible by the time this POST arrives, so a garbled/expired blob
    // must not ALSO burn the flow - the re-rendered page (TTL-bounded) lets
    // the user retry. Replay of a valid blob is prevented below.
    return renderLoginPage({ ...flow, errorMsg: 'Sign-in expired or could not be verified. Please try again.' });
  }
  // Consume the flow only once a cryptographically valid handoff arrived.
  providerFlows.delete(flowId);

  // NO subscription check here: the auth server verifies an active subscription
  // BEFORE sealing the handoff (and 403s otherwise, so no blob is ever produced
  // for an inactive account). A duplicate profile fetch on this side would add
  // no security but WOULD reintroduce a durability hole - the session is already
  // transferred + the browser cookie cleared, so a transient profile 5xx here
  // would strand it with no retry. Trust the sealed blob's provenance.
  return issueAuthorizationRedirect({
    apiKey: `${OAUTH_ACCESS_TOKEN_PREFIX}${opened.accessToken}`,
    refreshCredential: opened.refreshToken || undefined,
    codeChallenge: flow.codeChallenge,
    codeChallengeMethod: flow.codeChallengeMethod,
    redirectUri: flow.redirectUri,
    clientId: flow.clientId,
    state: flow.state,
  });
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

  if (grantType === 'refresh_token') {
    return handleRefreshGrant(params);
  }

  if (grantType !== 'authorization_code') {
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'unsupported_grant_type' }),
    };
  }

  const authCode = authCodes.get(code);
  if (!authCode || Date.now() > authCode.expiresAt) {
    authCodes.delete(code);
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'Code expired or invalid' }),
    };
  }

  // Verify client_id matches the original authorization request
  if (clientId !== authCode.clientId) {
    authCodes.delete(code);
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'Client ID mismatch' }),
    };
  }

  // Verify PKCE — S256 only (code_challenge enforced at authorize time)
  if (authCode.codeChallengeMethod !== 'S256') {
    authCodes.delete(code);
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
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE verification failed' }),
    };
  }

  // Verify redirect_uri matches the original authorization request (RFC 6749 Section 4.1.3)
  if (authCode.redirectUri && redirectUri !== authCode.redirectUri) {
    authCodes.delete(code);
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
