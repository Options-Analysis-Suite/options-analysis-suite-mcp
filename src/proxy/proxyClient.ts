/**
 * Proxy Client
 *
 * Authenticated HTTP client for the platform's proxy server.
 * Automatically injects Bearer token from TokenManager.
 * Handles common error patterns (auth, subscription, not found).
 */
import { AuthError, SubscriptionError, ApiError } from '../types.js';

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

/** What a 401 from the proxy means, for both clients that talk to it. */
export const AUTH_EXPIRED_MESSAGE = 'Authentication expired. Please restart the MCP extension to re-authenticate.';

export interface UnauthorizedMeaning {
  /** The proxy's structured code, when the 401 was not the bearer being refused. */
  code?: 'mfa_required' | 'mfa_check_unavailable';
  message: string;
  retryable: boolean;
}

/**
 * ONE reading of the proxy's 401, for both clients.
 *
 * The proxy answers 401 for three things, and only one of them is fixed by
 * re-authenticating. A bearer that was refused (missing, expired, revoked)
 * carries no code. Two structured codes come from enforceAal2 in
 * proxy/lib/middleware.ts on a VALID session: `mfa_required`, when the
 * account has a verified factor and this session never completed the TOTP
 * step-up, and `mfa_check_unavailable`, when the factor lookup itself failed
 * (it fails closed). Telling either of those users their session expired sends
 * them to restart the extension, which changes nothing for the first and
 * hides an outage for the second.
 */
export function interpretUnauthorized(body: unknown): UnauthorizedMeaning {
  const code = body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string'
    ? (body as { code: string }).code : undefined;
  if (code === 'mfa_required') {
    return {
      code,
      retryable: false,
      message: 'Multi-factor authentication is required for this account, and this session has not completed the TOTP step-up. '
        + 'Re-authorize the Options Analysis Suite connection to complete it; retrying the call without that will not succeed.',
    };
  }
  if (code === 'mfa_check_unavailable') {
    return {
      code,
      retryable: true,
      message: 'The proxy could not verify this account\'s MFA status; the check is temporarily unavailable. '
        + 'The session itself was accepted. This may be retried.',
    };
  }
  return { retryable: false, message: AUTH_EXPIRED_MESSAGE };
}

/** The error body, or null when there is none or it is not JSON. */
async function errorBody(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

/**
 * The most of a proxy error body's reason that travels in an ApiError
 * message. The proxy's own reasons are a sentence; anything longer is not
 * a reason, and a caller that embeds the message elsewhere than the tool
 * helpers' error branch (which truncates) must still be safe.
 */
export const MAX_REASON_BYTES = 512;
const REASON_SUFFIX = '...';
const UTF8 = { encode: new TextEncoder(), decode: new TextDecoder() };

function boundReason(text: string): string {
  const encoded = UTF8.encode.encode(text);
  if (encoded.byteLength <= MAX_REASON_BYTES) return text;
  // Back off to a character boundary so a multi-byte sequence is never cut.
  let end = MAX_REASON_BYTES - REASON_SUFFIX.length;
  while (end > 0 && (encoded[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return `${UTF8.decode.decode(encoded.subarray(0, end))}${REASON_SUFFIX}`;
}

export class ProxyClient {
  constructor(
    /** Readable so a second client can be built against the SAME backend. */
    readonly proxyUrl: string,
    private tokenManager: AccessTokenProvider,
  ) {}

  /**
   * GET request to the proxy.
   */
  async get<T = any>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.proxyUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value != null && value !== '') url.searchParams.set(key, value);
      }
    }

    const token = await this.tokenManager.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err: any) {
      throw new ApiError(
        err.name === 'TimeoutError' ? 'Proxy request timed out' : `Proxy unavailable: ${err.message}`,
        503,
      );
    }

    return this.handleResponse<T>(response, path);
  }

  /**
   * POST request to the proxy.
   */
  async post<T = any>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.proxyUrl);
    const token = await this.tokenManager.getAccessToken();

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err: any) {
      throw new ApiError(
        err.name === 'TimeoutError' ? 'Proxy request timed out' : `Proxy unavailable: ${err.message}`,
        503,
      );
    }

    return this.handleResponse<T>(response, path);
  }

  private async handleResponse<T>(response: Response, path: string): Promise<T> {
    if (response.ok) {
      try {
        return await response.json() as T;
      } catch {
        throw new ApiError(`Invalid JSON response from ${path}`, response.status);
      }
    }

    const status = response.status;

    if (status === 401) {
      // Text only: this client has no structured error class, so `retryable`
      // travels in the words. LiveApiClient carries the same reading as a code.
      throw new AuthError(interpretUnauthorized(await errorBody(response)).message);
    }

    if (status === 403) {
      throw new SubscriptionError('Your subscription does not include access to this data. Visit optionsanalysissuite.com/pricing.');
    }

    if (status === 404) {
      // Not found is normal for some queries (no data for symbol)
      return null as T;
    }

    if (status === 429) {
      throw new ApiError('Rate limit exceeded. Please wait a moment and try again.', 429);
    }

    // The reason the proxy sent, where it sent one. A surface read for a
    // date with no file answers 500 { error: 'No data for this date' }, and
    // without the body that read the same as an outage. The same two keys
    // LiveApiClient reads, message first. Bounded here, not only in the
    // tool helpers: get_dark_pool_data embeds err.message in a
    // partial-failure note that the helpers' truncation never sees, so an
    // unbounded body reached the model whole or tripped the size guard and
    // discarded the healthy half of the response beside it.
    const body = await errorBody(response) as { message?: unknown; error?: unknown } | null;
    const reason = [body?.message, body?.error].find((v): v is string => typeof v === 'string' && v !== '');
    throw new ApiError(`Request to ${path} failed (HTTP ${status})${reason ? `: ${boundReason(reason)}` : ''}`, status);
  }
}
