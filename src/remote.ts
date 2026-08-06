/**
 * Remote MCP Server Entry Point
 *
 * Runs as an HTTP service for ChatGPT, Perplexity, Grok, and other remote MCP clients.
 * Supports API key auth (base64 email:password) and OAuth 2.0 + PKCE (ChatGPT, Claude Web, Grok).
 */
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { TokenManager } from './auth/tokenManager.js';
import { ProxyClient } from './proxy/proxyClient.js';
import { createMcpServer } from './server.js';
import {
  MCP_ICON_CONTENT_TYPE,
  MCP_ICON_PATH,
  getBrandingHomeHtml,
  getMcpIconBytes,
} from './branding.js';
import { AuthError, SubscriptionError } from './types.js';
import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  resolveOAuthToken,
  handleProtectedResourceMetadata,
  handleAuthServerMetadata,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleProviderStart,
  handleFlowProof,
  handleProviderCallbackGet,
  handleProviderCallbackPost,
  handleConsentPost,
  handleTokenExchange,
  handleClientRegistration,
} from './oauth.js';

const PROXY_URL = process.env.OAS_PROXY_URL || 'https://proxy.optionsanalysissuite.com';
const AUTH_SERVER_URL = process.env.OAS_AUTH_SERVER_URL || 'https://api.optionsanalysissuite.com';
const PUBLIC_BASE_URL = process.env.OAS_MCP_BASE_URL || 'https://mcp.optionsanalysissuite.com';
const PORT = parseInt(process.env.PORT || '8080', 10);

/** WWW-Authenticate challenge header for OAuth discovery */
function wwwAuthChallenge(error?: string): string {
  const resource = `${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource`;
  let value = `Bearer resource_metadata="${resource}", scope="mcp"`;
  if (error) value += `, error="${error}"`;
  return value;
}

// --- Session & auth caching ---

interface Session {
  transport: StreamableHTTPServerTransport;
  /** Stable credential identity (see ownerKeyFor) - NOT the raw bearer string. */
  ownerKey: string;
  lastUsed: number;
}

interface AuthEntry {
  tokenManager: { getAccessToken(): Promise<string>; destroy(): void };
  proxyClient: ProxyClient;
  /** For OAuth-token entries: the mutable holder the tokenManager reads from. */
  oauthToken?: { token: string; expiresAt: number };
}

const sessions = new Map<string, Session>();
const authCache = new Map<string, AuthEntry>();

/** Parse an unverified JWT payload (callers only pass tokens our own AES-GCM wrapper authenticated). */
function jwtClaims(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function jwtExpiryMs(token: string): number {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === 'number' ? exp * 1000 : 0;
}

/**
 * Stable owner identity for a credential. The refresh grant rotates OAuth
 * bearers hourly, so sessions and auth entries must NOT be keyed by the raw
 * credential string - successive bearers for the same GoTrue session share its
 * session_id claim, which is the identity that actually owns the MCP session.
 * Password keys are already stable; hash them so raw credentials never become
 * map keys. Tokens without a session_id fall back to a hash of themselves
 * (those connections cannot survive rotation, matching pre-refresh behavior).
 */
export function ownerKeyFor(apiKey: string): string {
  if (apiKey.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
    const sid = jwtClaims(apiKey.slice(OAUTH_ACCESS_TOKEN_PREFIX.length))?.session_id;
    if (typeof sid === 'string' && sid) return `sid:${sid}`;
    return `tok:${createHash('sha256').update(apiKey).digest('hex')}`;
  }
  return `key:${createHash('sha256').update(apiKey).digest('hex')}`;
}

/**
 * Keep a long-lived MCP session's proxy calls on the NEWEST bearer for its
 * GoTrue session: after an hourly refresh the client presents a fresh JWT while
 * the cached tokenManager still holds the old (soon-expired) one.
 */
function adoptNewerOauthToken(entry: AuthEntry, apiKey: string): void {
  if (!entry.oauthToken || !apiKey.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) return;
  const token = apiKey.slice(OAUTH_ACCESS_TOKEN_PREFIX.length);
  if (!token || token === entry.oauthToken.token) return;
  const expiresAt = jwtExpiryMs(token);
  if (expiresAt > entry.oauthToken.expiresAt) {
    entry.oauthToken.token = token;
    entry.oauthToken.expiresAt = expiresAt;
  }
}

/** On existing-session requests (which skip getAuth), still adopt newer bearers. */
function adoptTokenForSession(session: Session, apiKey: string): void {
  const entry = authCache.get(session.ownerKey);
  if (entry) adoptNewerOauthToken(entry, apiKey);
}

/** Decode base64(email:password) API key with strict validation */
function decodeApiKey(apiKey: string): { email: string; password: string } | null {
  try {
    const decoded = Buffer.from(apiKey, 'base64').toString('utf-8');
    // Strict round-trip: re-encode and compare to reject malformed base64
    if (Buffer.from(decoded).toString('base64') !== apiKey) return null;
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) return null;
    const email = decoded.substring(0, colonIdx);
    const password = decoded.substring(colonIdx + 1);
    if (!email || !password) return null;
    return { email, password };
  } catch {
    return null;
  }
}

/** Deduplicate concurrent auth initialization for the same API key */
const pendingAuth = new Map<string, Promise<AuthEntry>>();

/** Get or create an authenticated client for an API key (cached by stable owner identity) */
async function getAuth(apiKey: string): Promise<AuthEntry> {
  const ownerKey = ownerKeyFor(apiKey);
  const cached = authCache.get(ownerKey);
  if (cached) {
    adoptNewerOauthToken(cached, apiKey);
    return cached;
  }

  // Return existing in-flight init if another request already started one
  const pending = pendingAuth.get(ownerKey);
  if (pending) {
    return pending.then((entry) => {
      adoptNewerOauthToken(entry, apiKey);
      return entry;
    });
  }

  const promise = (async () => {
    if (apiKey.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
      const accessToken = apiKey.slice(OAUTH_ACCESS_TOKEN_PREFIX.length);
      if (!accessToken) throw new AuthError('Invalid OAuth access token credential.');
      // Mutable holder: adoptNewerOauthToken swaps in fresher bearers for the
      // same GoTrue session, so proxy calls never ride an expired JWT.
      const holder = { token: accessToken, expiresAt: jwtExpiryMs(accessToken) };
      const tokenManager = {
        async getAccessToken() { return holder.token; },
        destroy() {},
      };
      const proxyClient = new ProxyClient(PROXY_URL, tokenManager);
      const entry: AuthEntry = { tokenManager, proxyClient, oauthToken: holder };
      authCache.set(ownerKey, entry);
      return entry;
    }

    const creds = decodeApiKey(apiKey);
    if (!creds) throw new AuthError('Invalid API key format. Expected base64(email:password).');

    const tokenManager = new TokenManager(AUTH_SERVER_URL, creds.email, creds.password);
    await tokenManager.initialize();

    const proxyClient = new ProxyClient(PROXY_URL, tokenManager);
    const entry: AuthEntry = { tokenManager, proxyClient };
    authCache.set(ownerKey, entry);
    return entry;
  })();

  pendingAuth.set(ownerKey, promise);
  promise.finally(() => pendingAuth.delete(ownerKey)).catch(e => console.error('[OAS MCP] Auth init error:', e.message));
  return promise;
}

function directApiKeyOrNull(apiKey: string): string | null {
  return apiKey.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) ? null : apiKey;
}

/** Extract API key from Authorization header (supports direct API key and OAuth Bearer tokens) */
export function extractApiKey(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers['authorization'] as string | undefined;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    // Check if this is an OAuth access token
    const oauthKey = resolveOAuthToken(token);
    if (oauthKey) return oauthKey;
    // Only fall back to direct API key if token decodes to valid email:password format
    const decoded = decodeApiKey(token);
    return decoded ? token : null;
  }
  if (auth?.startsWith('Api-Key ')) return directApiKeyOrNull(auth.slice(8));
  const xKey = headers['x-api-key'] as string | undefined;
  if (xKey) return directApiKeyOrNull(xKey);
  return null;
}

/** Read request body as string (capped at 1 MB to prevent memory exhaustion) */
function readBody(req: import('node:http').IncomingMessage, maxBytes = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        rejected = true;
        reject(new Error('Request body too large'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => { if (!rejected) resolve(data); });
    req.on('error', reject);
  });
}

/** Send JSON-RPC error response */
function jsonRpcError(res: import('node:http').ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/**
 * Validate session ownership by stable credential identity, so hourly-rotated
 * bearers for the same GoTrue session keep their MCP session. A mismatch is
 * answered as 404 Session-not-found (NOT 403): the MCP spec has clients start a
 * fresh session on 404, so a genuinely re-credentialed client recovers
 * transparently, and strangers get no oracle that the session id exists.
 */
function validateSessionOwnership(session: Session, ownerKey: string, res: import('node:http').ServerResponse): boolean {
  if (session.ownerKey !== ownerKey) {
    jsonRpcError(res, 404, -32000, 'Session not found');
    return false;
  }
  return true;
}

// --- HTTP server ---

export function parseRequestUrl(rawUrl: string | undefined, baseUrl: string): URL | null {
  try {
    return new URL(rawUrl || '/', baseUrl);
  } catch (err) {
    console.warn('[OAS MCP Remote] invalid request target', { url: rawUrl, err: String(err) });
    return null;
  }
}

/**
 * The HTTP dispatcher. Exported so tests can drive real requests through it -
 * the seam that hands each handler the request's cookie header is only as good
 * as the wiring, and asserting on source text would not catch a rewire.
 */
export const handleHttpRequest = async (
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> => {
  const requestUrl = parseRequestUrl(req.url, PUBLIC_BASE_URL);
  if (!requestUrl) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request: invalid request target');
    return;
  }
  const pathname = requestUrl.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, Mcp-Session-Id, Last-Event-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
    const body = getBrandingHomeHtml();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
    return;
  }

  // --- Same-origin icon routes (Google favicon API and MCP serverInfo.icons consume these) ---

  if (
    (pathname === MCP_ICON_PATH || pathname === '/favicon.ico' || pathname === '/favicon.svg')
    && (req.method === 'GET' || req.method === 'HEAD')
  ) {
    const icon = getMcpIconBytes();
    res.writeHead(200, {
      'Content-Type': MCP_ICON_CONTENT_TYPE,
      'Cache-Control': 'public, max-age=3600',
      'Content-Length': icon.byteLength,
    });
    res.end(req.method === 'HEAD' ? undefined : icon);
    return;
  }

  // --- OAuth & .well-known routes ---

  if (pathname === '/.well-known/oauth-protected-resource') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(handleProtectedResourceMetadata(req.headers.host));
    return;
  }

  if (pathname === '/.well-known/oauth-authorization-server') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(handleAuthServerMetadata(req.headers.host));
    return;
  }

  // ChatGPT Apps directory domain-verification challenge.
  if (pathname === '/.well-known/openai-apps-challenge') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('9Sq_BWC7kLCtJwo1sVOcjkt6WkCeVw6zTXz0Xt6RzVo');
    return;
  }

  // Glama AI MCP catalog domain-verification proof.
  if (pathname === '/.well-known/glama.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      $schema: 'https://glama.ai/mcp/schemas/connector.json',
      maintainers: [{ email: 'support@optionsanalysissuite.com' }],
    }));
    return;
  }

  if (pathname === '/oauth/authorize') {
    if (req.method === 'GET') {
      const result = handleAuthorizeGet(requestUrl.searchParams);
      res.writeHead(result.status, result.headers);
      res.end(result.body);
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const result = await handleAuthorizePost(body, req.headers.cookie);
        res.writeHead(result.status, result.headers);
        res.end(result.body);
      } catch {
        if (!res.headersSent) { res.writeHead(413); res.end('Request body too large'); }
      }
      return;
    }
  }

  // Provider sign-in: park the client's PKCE params, bounce through the auth
  // server's BFF, and accept the sealed session handoff on the way back.
  if (pathname === '/oauth/provider-start' && req.method === 'GET') {
    const result = handleProviderStart(requestUrl.searchParams, req.headers.cookie);
    res.writeHead(result.status, result.headers);
    res.end(result.body);
    return;
  }

  // Flow proof: the auth server bounces the browser here so it can refuse a
  // LURED sign-in before it happens. Only this origin can read the binding
  // cookie. INERT until the auth server starts calling it.
  if (pathname === '/oauth/flow-proof' && req.method === 'GET') {
    const result = handleFlowProof(requestUrl.searchParams, req.headers.cookie);
    res.writeHead(result.status, result.headers);
    res.end(result.body);
    return;
  }

  if (pathname === '/oauth/provider-callback') {
    if (req.method === 'GET') {
      const result = handleProviderCallbackGet(requestUrl.searchParams, req.headers.cookie);
      res.writeHead(result.status, result.headers);
      res.end(result.body);
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const result = await handleProviderCallbackPost(body, req.headers.cookie);
        res.writeHead(result.status, result.headers);
        res.end(result.body);
      } catch {
        if (!res.headersSent) { res.writeHead(413); res.end('Request body too large'); }
      }
      return;
    }
  }

  if (pathname === '/oauth/consent' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const result = handleConsentPost(body, req.headers.cookie);
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch {
      if (!res.headersSent) { res.writeHead(413); res.end('Request body too large'); }
    }
    return;
  }

  if (pathname === '/oauth/token' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const result = await handleTokenExchange(body);
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch {
      if (!res.headersSent) { res.writeHead(413); res.end('Request body too large'); }
    }
    return;
  }

  if (pathname === '/oauth/register' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const result = handleClientRegistration(body);
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch {
      if (!res.headersSent) { res.writeHead(413); res.end('Request body too large'); }
    }
    return;
  }

  // --- MCP endpoint ---

  if (pathname !== '/mcp') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  // Auth — include WWW-Authenticate header for OAuth discovery (MCP spec requirement)
  const apiKey = extractApiKey(req.headers as Record<string, string | string[] | undefined>);
  if (!apiKey) {
    res.setHeader('WWW-Authenticate', wwwAuthChallenge());
    jsonRpcError(res, 401, -32001, 'Authentication required');
    return;
  }
  const ownerKey = ownerKeyFor(apiKey);

  try {
    if (req.method === 'POST') {
      // Parse body — catch size and JSON errors separately
      let body: string;
      try {
        body = await readBody(req);
      } catch {
        if (!res.headersSent) jsonRpcError(res, 413, -32600, 'Request body too large');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        jsonRpcError(res, 400, -32700, 'Parse error: invalid JSON');
        return;
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        // Existing session — verify ownership, adopt a fresher bearer if presented
        const session = sessions.get(sessionId)!;
        if (!validateSessionOwnership(session, ownerKey, res)) return;
        adoptTokenForSession(session, apiKey);
        session.lastUsed = Date.now();
        await session.transport.handleRequest(req, res, parsed);
      } else if (sessionId && !sessions.has(sessionId)) {
        // Invalid session ID → 404 per MCP spec
        jsonRpcError(res, 404, -32000, 'Session not found');
      } else if (!sessionId && isInitializeRequest(parsed)) {
        // New session — authenticate and create
        const { proxyClient, tokenManager } = await getAuth(apiKey);

        let transportRef: StreamableHTTPServerTransport;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, { transport: transportRef, ownerKey, lastUsed: Date.now() });
            console.log(`[OAS MCP] Session created: ${sid}`);
          },
        });
        transportRef = transport;

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            sessions.delete(sid);
            console.log(`[OAS MCP] Session closed: ${sid}`);
          }
        };

        const mcpServer = createMcpServer(proxyClient, tokenManager);
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, parsed);
      } else {
        // No session ID and not an init request → 400 per MCP spec
        jsonRpcError(res, 400, -32600, 'Bad Request: missing session ID or not an initialization request');
      }
    } else if (req.method === 'GET') {
      // SSE stream
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId) {
        jsonRpcError(res, 400, -32000, 'Missing Mcp-Session-Id header');
        return;
      }
      if (!sessions.has(sessionId)) {
        jsonRpcError(res, 404, -32000, 'Session not found');
        return;
      }
      const session = sessions.get(sessionId)!;
      if (!validateSessionOwnership(session, ownerKey, res)) return;
      adoptTokenForSession(session, apiKey);
      session.lastUsed = Date.now();
      await session.transport.handleRequest(req, res);
    } else if (req.method === 'DELETE') {
      // Session termination
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId) {
        jsonRpcError(res, 400, -32000, 'Missing Mcp-Session-Id header');
        return;
      }
      if (!sessions.has(sessionId)) {
        jsonRpcError(res, 404, -32000, 'Session not found');
        return;
      }
      const session = sessions.get(sessionId)!;
      if (!validateSessionOwnership(session, ownerKey, res)) return;
      await session.transport.handleRequest(req, res);
    } else if (req.method === 'HEAD') {
      // HEAD /mcp — used by some clients for OAuth discovery probing
      res.setHeader('WWW-Authenticate', wwwAuthChallenge());
      res.writeHead(401);
      res.end();
    } else {
      res.writeHead(405);
      res.end('Method Not Allowed');
    }
  } catch (err: any) {
    console.error('[OAS MCP Remote] Error:', err.message);
    if (!res.headersSent) {
      if (err instanceof SubscriptionError) {
        jsonRpcError(res, 403, -32001, err.message);
      } else if (err instanceof AuthError) {
        res.setHeader('WWW-Authenticate', wwwAuthChallenge('invalid_token'));
        jsonRpcError(res, 401, -32001, err.message);
      } else {
        jsonRpcError(res, 500, -32603, err.message);
      }
    }
  }
};

const server = createServer(handleHttpRequest);

async function shutdownRemoteServer(): Promise<void> {
  console.log('[OAS MCP] Shutting down...');
  for (const [sid, session] of sessions) {
    await session.transport.close().catch(() => {});
    sessions.delete(sid);
  }
  for (const [, entry] of authCache) {
    entry.tokenManager.destroy();
  }
  authCache.clear();
  process.exit(0);
}

function startRemoteServer(): void {
  // Cleanup idle sessions every 5 min. Keep lifecycle hooks inside the main
  // entrypoint so parser-focused tests can import this module without side
  // effects.
  setInterval(() => {
    const now = Date.now();
    for (const [sid, session] of sessions) {
      if (now - session.lastUsed > 30 * 60 * 1000) {
        console.log(`[OAS MCP] Cleaning up idle session: ${sid}`);
        session.transport.close();
        sessions.delete(sid);
      }
    }
    // Clean up auth entries with no active sessions
    for (const [key] of authCache) {
      const hasSession = [...sessions.values()].some((s) => s.ownerKey === key);
      if (!hasSession) {
        const entry = authCache.get(key);
        entry?.tokenManager.destroy();
        authCache.delete(key);
      }
    }
  }, 5 * 60 * 1000);

  process.on('SIGINT', () => {
    void shutdownRemoteServer();
  });
  process.on('SIGTERM', () => {
    void shutdownRemoteServer();
  });

  // Warn if OAuth token encryption is not configured (ChatGPT OAuth will fail)
  if (!process.env.OAS_TOKEN_SECRET) {
    console.warn('[OAS MCP Remote] WARNING: OAS_TOKEN_SECRET is not set. OAuth integrations (ChatGPT, Claude Web, Grok) will not work. API key auth (Perplexity) is unaffected.');
  }

  server.listen(PORT, () => {
    console.log(`[OAS MCP Remote] Streamable HTTP server listening on port ${PORT}`);
    console.log(`[OAS MCP Remote] Proxy: ${PROXY_URL}`);
    console.log(`[OAS MCP Remote] Auth: ${AUTH_SERVER_URL}`);
  });
}

if (import.meta.main) {
  startRemoteServer();
}
