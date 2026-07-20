/**
 * Tool Helpers
 *
 * Shared error handling wrapper for all MCP tool handlers.
 * Converts exceptions into structured MCP error responses.
 */
import { AuthError, SubscriptionError, ApiError } from '../types.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const MAX_RESPONSE_BYTES = 50 * 1024; // 50 KB
const UTF8_ENCODER = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

export function jsonUtf8ByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : utf8ByteLength(json);
}

const SAFE_UNDERSCORE_KEY_RENAMES: Record<string, string> = {
  _count: 'count',
  _preview: 'preview',
  _truncated: 'truncated',
  _aggressive: 'aggressive',
  _error: 'error',
  _omitted: 'omitted',
  _note: 'note',
  _stress_score_note: 'stressScoreNote',
  _symbols_truncation_meta: 'symbolCoverage',
  _venues_note: 'venuesNote',
  _dealers_note: 'dealersNote',
  _otc_note: 'otcNote',
  _ats_note: 'atsNote',
  _rate_meta: 'rateContext',
  _curve_note: 'curveNote',
  _earnings_note: 'earningsNote',
  _filings_note: 'filingsNote',
  _analyst_note: 'analystNote',
  _threshold_note: 'thresholdNote',
};

const INTERNAL_IDENTIFIER_KEYS = new Set([
  'positionId',
  'snapshotId',
  'portfolioSnapshotId',
  'riskSnapshotId',
  'runKey',
  'latestRunKey',
  'positionContributions',
  'position_contributions',
  'executionPath',
  'economicPenalty',
  'seedRejections',
  'portfolioAggregates',
  'byReason',
  'fallbackReason',
  'isFallback',
]);

const READABLE_KEY_RENAMES: Record<string, string> = {
  omittedModelCount: 'modelsNotShown',
  omittedPositionCount: 'positionsNotShown',
};

// Match _<base>_meta where <base> is any non-empty key — including snake_case
// (e.g. _recent_history_meta from marketFlowShaping.ts:162) and the camelCase
// keys emitted by truncateLargeArrays / aggressivelyTrimLargeArrays.
const DYNAMIC_META_KEY_RE = /^_(.+)_meta$/;

function isSyncBackedRow(obj: Record<string, unknown>): boolean {
  return (
    'user_id' in obj
    || 'run_key' in obj
  );
}

function isNestedSyncSnapshotPayload(obj: Record<string, unknown>): boolean {
  return (
    'id' in obj
    && 'timestamp' in obj
    && (
      'totalValue' in obj
      || 'cashBalance' in obj
      || 'positionCount' in obj
      || 'portfolioValue' in obj
      || 'var95' in obj
      || 'var99' in obj
      || 'cvar95' in obj
      || 'beta' in obj
      || 'dollarDelta' in obj
      || 'dollarGamma' in obj
      || 'totalPnL' in obj
      || 'rho' in obj
      || 'vanna' in obj
      || 'charm' in obj
      || 'vomma' in obj
      || 'veta' in obj
    )
  );
}

/**
 * Final MCP wire cleanup. Tool-specific shapers keep useful market fields, but
 * this boundary pass removes backend metadata/plumbing that LLM clients tend to
 * quote verbatim. It preserves useful preview structures by renaming their
 * leading-underscore keys to normal JSON labels.
 */
export function sanitizeMcpWireOutput(data: unknown, depth = 0): unknown {
  if (depth > 20 || data == null || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map((item) => sanitizeMcpWireOutput(item, depth + 1));

  const obj = data as Record<string, unknown>;
  const syncBackedRow = isSyncBackedRow(obj);
  const nestedSyncSnapshotPayload = isNestedSyncSnapshotPayload(obj);
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (key in SAFE_UNDERSCORE_KEY_RENAMES) {
      out[SAFE_UNDERSCORE_KEY_RENAMES[key]] = sanitizeMcpWireOutput(value, depth + 1);
      continue;
    }
    if (key in READABLE_KEY_RENAMES) {
      out[READABLE_KEY_RENAMES[key]] = sanitizeMcpWireOutput(value, depth + 1);
      continue;
    }
    const dynamicMetaMatch = key.match(DYNAMIC_META_KEY_RE);
    if (dynamicMetaMatch) {
      const [, base] = dynamicMetaMatch;
      out[`${base}Meta`] = sanitizeMcpWireOutput(value, depth + 1);
      continue;
    }
    if (key.startsWith('_')) continue;
    if (key === 'user_id' || key === 'created_at' || key === 'updated_at') continue;
    if (key === 'run_key') continue;
    if (INTERNAL_IDENTIFIER_KEYS.has(key)) continue;
    if (key === 'id' && (syncBackedRow || nestedSyncSnapshotPayload)) continue;

    out[key] = sanitizeMcpWireOutput(value, depth + 1);
  }

  return out;
}

/**
 * Truncates large arrays in a data object to maxItems and appends a count note.
 * Recurses one level into plain objects to catch nested arrays (depth-limited to 2).
 * Takes the FIRST N items — which are the newest for sync tools that sort
 * `timestamp DESC` (and the earliest for tools that return oldest-first).
 * Tools that care about which end survives should trim internally before
 * reaching this helper.
 */
function truncateLargeArrays(data: unknown, maxItems = 50, depth = 0): unknown {
  if (data === null || typeof data !== 'object' || depth > 2) return data;
  // Handle root-level arrays
  if (Array.isArray(data) && data.length > maxItems) {
    return [...data.slice(0, maxItems), { _truncated: true, originalLength: data.length, returned: maxItems }];
  }
  if (Array.isArray(data)) return data;
  const obj = data as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value) && value.length > maxItems) {
      result[key] = value.slice(0, maxItems);
      result[`_${key}_meta`] = { truncated: true, originalLength: value.length, returned: maxItems };
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value) && depth < 2) {
      result[key] = truncateLargeArrays(value, maxItems, depth + 1);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function aggressivelyTrimLargeArrays(data: unknown, maxItems = 5): unknown {
  if (Array.isArray(data) && data.length > maxItems) {
    return [
      ...data.slice(0, maxItems),
      { _truncated: true, _aggressive: true, originalLength: data.length, returned: maxItems },
    ];
  }
  if (data === null || typeof data !== 'object') return data;
  const obj = data as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value) && value.length > maxItems) {
      obj[key] = value.slice(0, maxItems);
      obj[`_${key}_meta`] = { truncated: true, aggressive: true, originalLength: value.length, returned: maxItems };
    }
  }
  return obj;
}

// Intentionally stringify first, then measure the exact UTF-8 wire bytes. A
// pre-stringify estimator (PR #52) over-counted some ASCII payloads and
// under-counted other strings. The shaped data is already capped per tool, so
// exact TextEncoder measurement is both simpler and correct for multibyte text.
// Do not reintroduce an estimator without validating it against encoded JSON.
export function applyResponseSizeGuard(data: unknown, maxResponseBytes = MAX_RESPONSE_BYTES): string {
  data = sanitizeMcpWireOutput(data);
  let json = JSON.stringify(data);
  if (utf8ByteLength(json) <= maxResponseBytes) return json;

  let processed = truncateLargeArrays(data);
  json = JSON.stringify(sanitizeMcpWireOutput(processed));

  if (utf8ByteLength(json) > maxResponseBytes) {
    processed = aggressivelyTrimLargeArrays(processed);
    json = JSON.stringify(sanitizeMcpWireOutput(processed));
  }

  const processedBytes = utf8ByteLength(json);
  if (processedBytes > maxResponseBytes) {
    json = JSON.stringify({
      error: 'Response too large for MCP response budget.',
      responseBudget: { tooLarge: true, sizeKb: Math.round(processedBytes / 1024) },
    });
  }

  return json;
}

function structuredContentFromJson(json: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as unknown;
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return { data: parsed };
}

/**
 * Wraps a tool handler function with standard error handling.
 * Returns JSON data on success, human-readable error on failure.
 * Applies response size guard to all tool responses.
 */
export function toolHandler<T extends Record<string, unknown>>(
  fn: (args: T) => Promise<unknown>,
  opts?: { isSyncTool?: boolean },
): (args: T) => Promise<ToolResult> {
  return async (args: T): Promise<ToolResult> => {
    try {
      let data = await fn(args);
      if (data == null) {
        const message = 'No data available for this query.';
        return {
          content: [{ type: 'text', text: message }],
          structuredContent: { dataAvailable: false, message },
        };
      }

      // Backward-compat: unwrap legacy full-mode shape from tool handlers.
      if (typeof data === 'object' && data !== null && (data as any)?._skipSizeGuard === true) {
        data = (data as any).data;
      }

      // Handle empty response — sync tools get a specific message
      if (typeof data === 'object' && 'data' in (data as any) && Array.isArray((data as any).data) && (data as any).data.length === 0) {
        const response = data as Record<string, unknown>;
        const requestedLimit = typeof response.requestedLimit === 'number'
          && Number.isSafeInteger(response.requestedLimit)
          && response.requestedLimit >= 0
          ? response.requestedLimit
          : undefined;
        const matchedCount = typeof response.matchedCount === 'number'
          && Number.isSafeInteger(response.matchedCount)
          && response.matchedCount >= 0
          ? response.matchedCount
          : undefined;
        const hasMore = typeof response.hasMore === 'boolean' ? response.hasMore : undefined;
        const hasSelectionMetadata = requestedLimit !== undefined || matchedCount !== undefined || hasMore !== undefined;
        if (hasSelectionMetadata) {
          const emptyPayload = {
            dataAvailable: false,
            data: [],
            count: 0,
            message: 'No data matched the requested filters.',
            requestedLimit,
            matchedCount,
            hasMore,
          };
          const json = applyResponseSizeGuard(emptyPayload);
          return {
            content: [{ type: 'text', text: json }],
            structuredContent: structuredContentFromJson(json),
          };
        }
        const msg = opts?.isSyncTool
          ? 'No data found. Make sure MCP sync is enabled in the platform\'s Account Settings. Data syncs automatically as you use the platform.'
          : 'No data available for this query.';
        return {
          content: [{ type: 'text', text: msg }],
          structuredContent: { dataAvailable: false, data: [], message: msg },
        };
      }

      const json = applyResponseSizeGuard(data);

      return {
        content: [{ type: 'text', text: json }],
        structuredContent: structuredContentFromJson(json),
      };
    } catch (err: any) {
      if (err instanceof AuthError) {
        return {
          content: [{ type: 'text', text: err.message }],
          isError: true,
        };
      }
      if (err instanceof SubscriptionError) {
        return {
          content: [{ type: 'text', text: err.message }],
          isError: true,
        };
      }
      if (err instanceof ApiError) {
        return {
          content: [{ type: 'text', text: `API error: ${err.message}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: `Error: ${err.message || 'Unknown error'}` }],
        isError: true,
      };
    }
  };
}
