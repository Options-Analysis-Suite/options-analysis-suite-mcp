/**
 * Live API Client
 *
 * Authenticated HTTP client for the proxy's structured routes: the live
 * broker reads (/live/*), the calibration fit history
 * (/regime/fits/:symbol/history) and the EOD snapshot reads
 * (/scanner/snapshot/:symbol, /scanner/metrics/batch). It shares ProxyClient's
 * base URL and bearer - ONE backend - and differs in one thing: what it does
 * with an error body.
 *
 * WHY NOT REUSE ProxyClient. Its handleResponse flattens every 403 into one
 * "your subscription does not include access to this data" message, turns a
 * 404 into null, and discards the body of everything else. The routes this
 * client reaches answer a structured envelope - `{ error, code, retryable,
 * upgradeUrl | connectUrl | reconnectUrl, availableExpirations, missingFields,
 * warnings }` - and those fields decide what the model does NEXT. `retryable`
 * is the whole mechanism that stops a model retrying a live-broker call that
 * cannot succeed and burning the user's own broker quota; actionUrl says
 * where the human fixes it; availableExpirations is how a wrong guess is
 * corrected without another broker round trip. Every one of them survives
 * here, and helpers.ts renders them.
 *
 * FORMERLY DataApiClient, pointed at the commercial /v1 API on
 * data.optionsanalysissuite.com. That backend distinguished two 403s
 * (API_TIER_REQUIRED, fixed by upgrading; INSUFFICIENT_SCOPE, fixed by a
 * different key) and answered one indistinguishable 401 for four causes. The
 * proxy has no key scopes, and its 401 is read by interpretUnauthorized,
 * shared with ProxyClient: a refused bearer, or one of the two MFA codes
 * enforceAal2 answers on a valid session (mfa_required, a step-up to
 * complete; mfa_check_unavailable, an outage to wait out). So both of the old
 * branches are gone rather than carried. A 403
 * takes the same structured path as everything else: the proxy's tier gate
 * sends `{ error, code: 'PRO_TIER_REQUIRED', retryable: false, upgradeUrl }`,
 * and that envelope already says what a bespoke branch would have said.
 */
import { AuthError, ApiError } from '../types.js';
import { interpretUnauthorized, type AccessTokenProvider } from './proxyClient.js';

/** A structured error from the proxy, with the fields a model needs to act. */
export class LiveApiError extends ApiError {
  constructor(
    message: string,
    status: number,
    readonly code: string | undefined,
    readonly retryable: boolean | undefined,
    readonly actionUrl: string | undefined,
    /** Extra fields the model needs to CORRECT the request, not just report it. */
    readonly details: Record<string, unknown> | undefined,
  ) {
    super(message, status);
    this.name = 'LiveApiError';
    if (Array.isArray(details?.issues)) {
      // Drop the structured carriers of the offending value - Zod issues also
      // ship `input`, `params`, `expected`/`received` and custom metadata - and
      // keep only the field path and the explanation.
      //
      // This is NOT a guarantee that no input-derived text survives, and it
      // cannot be one: a message is backend-authored prose that may legitimately
      // quote what was wrong (`unrecognized_keys` renders as
      // `Unrecognized key: "..."`), and a record key travels in the path because
      // the path is what tells a caller which field to fix. The guarantee is
      // that issue metadata outside `path` and `message` is removed. Preserve
      // even nonstandard paths as received; formatting must not rewrite the
      // machine-readable location. Legacy string issues remain prose.
      this.details = { ...details, issues: sanitizeValidationIssues(details.issues) };
    }
  }
}

type SanitizedValidationIssue = string | { path?: unknown; message: string };

/**
 * A model corrects one call at a time, so fifty issues is already more than it
 * can act on - and this runs in a CONSTRUCTOR, before any budget downstream
 * gets a say. flatMap over the whole array visited a million entries and built
 * a million objects for a payload that was going to be discarded as oversized
 * anyway. Read length, take the head, and say how many were left.
 */
const MAX_VALIDATION_ISSUES = 50;

function sanitizeValidationIssues(issues: unknown[]): SanitizedValidationIssue[] {
  const kept: SanitizedValidationIssue[] = [];
  // `length` comes off a value we did not author. Floor it the way array
  // iteration would, or a fractional length walks an index real Array
  // semantics never reach.
  const rawLength = (issues as { length?: unknown }).length;
  const total = typeof rawLength === 'number' && Number.isFinite(rawLength) && rawLength > 0
    ? Math.floor(rawLength) : 0;
  const limit = Math.min(total, MAX_VALIDATION_ISSUES);
  for (let i = 0; i < limit; i += 1) {
    // This runs in a CONSTRUCTOR. An element that throws on read must not take
    // the whole error with it: losing `code` and `retryable` to a getter would
    // cost the model the one thing telling it not to retry.
    let issue: unknown;
    try { issue = issues[i]; } catch { continue; }
    if (typeof issue === 'string') { kept.push(issue); continue; }
    if (!issue || typeof issue !== 'object' || !('message' in issue) || typeof issue.message !== 'string') continue;
    kept.push('path' in issue
      ? { path: issue.path, message: issue.message }
      : { message: issue.message });
  }
  if (total > MAX_VALIDATION_ISSUES) {
    kept.push(`... ${total - MAX_VALIDATION_ISSUES} further validation issues omitted`);
  }
  return kept;
}

interface ErrorBody {
  error?: unknown;
  code?: unknown;
  message?: unknown;
  retryable?: unknown;
  reconnectUrl?: unknown;
  connectUrl?: unknown;
  upgradeUrl?: unknown;
  availableExpirations?: unknown;
  availableExpirationsTruncated?: unknown;
  /** The live-broker limiter's name for it; the proxy has no `retryAfter`. */
  retryAfterSeconds?: unknown;
  issues?: unknown;
  missingFields?: unknown;
  warnings?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const BODY_TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT',
]);

export class LiveApiClient {
  constructor(
    private baseUrl: string,
    private tokenManager: AccessTokenProvider,
  ) {}

  async get<T = any>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value != null && value !== '') url.searchParams.set(key, value);
      }
    }
    return this.send<T>(url, path, { method: 'GET' });
  }

  /** JSON body in; the same envelope handling out. Used by the compute route. */
  async post<T = any>(path: string, body: unknown): Promise<T> {
    return this.send<T>(new URL(path, this.baseUrl), path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async send<T>(url: URL, path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<T> {
    const token = await this.tokenManager.getAccessToken();

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        ...init,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.headers ?? {}) },
        // Longer than ProxyClient's 30s: a live chain is a broker round trip
        // behind our own hop, and a timeout here costs the user a request from
        // their own broker quota with nothing to show for it.
        signal: AbortSignal.timeout(45_000),
      });
    } catch (err: any) {
      throw new LiveApiError(
        err.name === 'TimeoutError'
          ? 'The request timed out. This may be retried.'
          : `The proxy is unreachable: ${err.message}`,
        503, 'UPSTREAM_UNAVAILABLE', true, undefined, undefined,
      );
    }

    return this.handleResponse<T>(response, path);
  }

  private async handleResponse<T>(response: Response, path: string): Promise<T> {
    let body: ErrorBody | null = null;
    let parsed: unknown;
    try {
      parsed = await response.json();
      body = (parsed && typeof parsed === 'object') ? parsed as ErrorBody : null;
    } catch (err: any) {
      // A body that never finishes arriving is a TRANSPORT failure, not a
      // malformed response. The status line already said 200, so reporting
      // "Invalid JSON, HTTP 200, retryable unknown" describes a server bug that
      // did not happen and hides the one that did.
      // A mid-body disconnect surfaces as a TypeError (ECONNRESET under Bun),
      // NOT as an abort - so matching only the abort names left the common case
      // reported as "Invalid JSON, HTTP 200". Genuine malformed JSON is a
      // SyntaxError and stays on the branch below, where it belongs.
      const transportFailure = !(err instanceof SyntaxError) && err?.name !== 'SyntaxError'
        && (err?.name === 'TimeoutError'
          || err?.name === 'AbortError'
          || err instanceof TypeError
          || err?.name === 'TypeError'
          || BODY_TRANSPORT_ERROR_CODES.has(err?.code));
      if (transportFailure) {
        throw new LiveApiError(
          'The response was cut off in transit. This may be retried.',
          504, 'UPSTREAM_TRUNCATED', true, undefined, undefined,
        );
      }
      if (response.ok) throw new ApiError(`Invalid JSON response from ${path}`, response.status);
    }

    if (response.ok) return parsed as T;

    const status = response.status;
    const code = str(body?.code);
    const detail = str(body?.message) ?? str(body?.error);
    const retryable = typeof body?.retryable === 'boolean' ? body.retryable : undefined;
    const actionUrl = str(body?.reconnectUrl) ?? str(body?.connectUrl) ?? str(body?.upgradeUrl);

    if (status === 401) {
      // The SAME reading ProxyClient gives, from the same function: a bearer
      // refused is re-authentication; the two MFA codes on a valid session are
      // not, and here they keep their code and `retryable` so the model can
      // tell a step-up it must complete from an outage it may wait out.
      const meaning = interpretUnauthorized(body);
      if (meaning.code) {
        throw new LiveApiError(meaning.message, 401, meaning.code, meaning.retryable, undefined, undefined);
      }
      throw new AuthError(meaning.message);
    }

    if (status === 429) {
      const after = typeof body?.retryAfterSeconds === 'number' ? body.retryAfterSeconds : undefined;
      throw new LiveApiError(
        after != null
          ? `Rate limit exceeded. Retry in ${after} seconds.`
          : 'Rate limit exceeded. Please wait a moment and try again.',
        429, code ?? 'RATE_LIMITED', true, undefined,
        after != null ? { retryAfterSeconds: after } : undefined,
      );
    }

    // Everything else - the tier gate, the live-broker errors, validation -
    // keeps its structure. `retryable` reaching the model verbatim is what
    // stops it retrying a call that cannot succeed - there is no end-of-day
    // fallback behind the live routes. UNKNOWN_EXPIRATION carries the dates
    // that WOULD work. Dropping them left the model with "that expiration is
    // not listed" and no way to fix the call - so it guesses again, and each
    // guess is another broker round trip.
    const details: Record<string, unknown> = {};
    // A validation failure that explains WHICH input was wrong. The proxy's
    // zod hook answers only the first message, so this is usually absent;
    // kept for a body that does carry it, and sanitised in the constructor.
    if (Array.isArray(body?.issues)) {
      details.issues = body.issues;
    }
    if (Array.isArray(body?.availableExpirations)) {
      details.availableExpirations = body.availableExpirations;
      if (body.availableExpirationsTruncated === true) details.availableExpirationsTruncated = true;
    }
    // A RESOLUTION_FAILED says which market input could not be used and why,
    // and the why is often not a data gap: a liquidating issuer's trailing
    // yield is withheld deliberately and the caller is meant to supply q. Drop
    // these and the model is told only "Failed to resolve required market
    // parameters. Retrying will not succeed." - which is true, unactionable,
    // and indistinguishable from an outage. The explanation is the whole point
    // of refusing rather than publishing a number nobody can question.
    if (Array.isArray(body?.missingFields)) details.missingFields = body.missingFields;
    if (Array.isArray(body?.warnings) && body.warnings.length > 0) details.warnings = body.warnings;

    throw new LiveApiError(
      detail ?? `Request to ${path} failed (HTTP ${status})`,
      status,
      code,
      retryable,
      actionUrl,
      Object.keys(details).length > 0 ? details : undefined,
    );
  }
}
