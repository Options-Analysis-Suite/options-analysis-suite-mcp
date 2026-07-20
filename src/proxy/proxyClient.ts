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

export class ProxyClient {
  constructor(
    private proxyUrl: string,
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
      throw new AuthError('Authentication expired. Please restart the MCP extension to re-authenticate.');
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

    throw new ApiError(`Request to ${path} failed (HTTP ${status})`, status);
  }
}
