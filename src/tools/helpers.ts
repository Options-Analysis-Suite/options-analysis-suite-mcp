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
/**
 * Render a validation path so a model edits the field the path actually names.
 *
 * Joining the segments with '.' is ambiguous in two ways a reader cannot undo:
 * a record key that itself contains a dot ("a.b") renders identically to the
 * nested field a -> b, and an array index renders as though it were a field
 * name. Bracket the indices, and quote anything that is not a plain identifier.
 */
const PLAIN_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Serialize a value we did not author, under a HARD byte budget, aborting the
 * traversal as soon as it is exceeded.
 *
 * Two separate hazards, both of which have bitten this code:
 *
 * DEPTH. JSON.stringify recurses, so a deeply nested value throws RangeError -
 * and this runs inside the catch that is supposed to be REPORTING a failure.
 * The model then gets "Maximum call stack size exceeded" in place of the
 * message, the code and `retryable`, and a model that cannot see
 * `retryable: false` retries a call that can never succeed, on the user's own
 * broker quota. This walker recurses at most MAX_DETAIL_DEPTH levels itself, so
 * it cannot overflow on the input it exists to defend against.
 *
 * WORK. Measuring by building the whole string first bounds the OUTPUT and not
 * the COST: a quarter of a million issues were cloned, serialized, and only
 * then discarded for being over budget. So the budget is checked as the output
 * is produced, and traversal stops at the first chunk that crosses it, having
 * visited a few hundred entries rather than every one.
 */
const MAX_DETAIL_DEPTH = 8;
// Emitted bytes alone do not bound the COST. A property that serializes to
// nothing still costs a read: a hundred thousand getters returning undefined
// were every one visited and produced an empty object, entirely within budget.
// So visits are counted separately from bytes, and every candidate counts,
// including the ones that emit nothing.
const MAX_DETAIL_VISITS = 5_000;
const OVER_BUDGET = Symbol('over-budget');

function budgetedJson(value: unknown, maxBytes: number): { json: string; exceeded: boolean } {
  const parts: string[] = [];
  let used = 0;
  let visits = 0;
  let exceeded = false;
  const push = (chunk: string): void => {
    used += utf8ByteLength(chunk);
    if (used > maxBytes) { exceeded = true; throw OVER_BUDGET; }
    parts.push(chunk);
  };
  const visit = (): void => {
    visits += 1;
    if (visits > MAX_DETAIL_VISITS) { exceeded = true; throw OVER_BUDGET; }
  };
  const walk = (node: unknown, depth: number): void => {
    if (node === null || typeof node !== 'object') {
      // One scalar can exceed the whole budget by itself, so refuse it before
      // JSON.stringify materialises a copy of it.
      if (typeof node === 'string' && node.length > maxBytes) { exceeded = true; throw OVER_BUDGET; }
      push(JSON.stringify(node) ?? 'null');
      return;
    }
    if (depth >= MAX_DETAIL_DEPTH) { push(Array.isArray(node) ? '"[...]"' : '"{...}"'); return; }
    if (Array.isArray(node)) {
      push('[');
      // Indexed, not Object.keys: never materialise a key array for a length we
      // have already decided we will not finish reading.
      for (let i = 0; i < node.length; i += 1) {
        visit();
        if (i > 0) push(',');
        walk(node[i], depth + 1);
      }
      push(']');
      return;
    }
    push('{');
    let first = true;
    for (const key in node as Record<string, unknown>) {
      // Counted BEFORE the skips, or a property that emits nothing is free.
      visit();
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      // A key can exceed the whole budget on its own, and JSON.stringify would
      // materialise a copy of it before a single byte was ever measured.
      if (key.length > maxBytes) { exceeded = true; throw OVER_BUDGET; }
      const item = (node as Record<string, unknown>)[key];
      if (item === undefined || typeof item === 'function') continue;
      if (!first) push(',');
      first = false;
      push(`${JSON.stringify(key)}:`);
      walk(item, depth + 1);
    }
    push('}');
  };
  try {
    walk(value, 0);
  } catch (err) {
    if (err !== OVER_BUDGET) return { json: '', exceeded: true };
  }
  return { json: parts.join(''), exceeded };
}

/**
 * An error carries advisory detail, not a payload, so it gets a far smaller
 * budget than a successful response. Without one, a single oversized field name
 * in a validation body reached the client as a 200KB error: it never passed
 * through applyResponseSizeGuard, which only ever saw success paths. The
 * message, code and actionUrl are backend-authored too, and are capped for the
 * same reason - an upstream that echoes a 100,000-character symbol is not a
 * reason to hand the model a 100KB error.
 */
const MAX_ERROR_DETAIL_BYTES = 4 * 1024;
const MAX_ERROR_TEXT_BYTES = 8 * 1024;
const MAX_ERROR_MESSAGE_BYTES = 2 * 1024;
const MAX_ERROR_FIELD_BYTES = 512;
const UTF8_DECODER = new TextDecoder();
const TRUNCATION_SUFFIX = '... [truncated]';
const TRUNCATION_SUFFIX_BYTES = UTF8_ENCODER.encode(TRUNCATION_SUFFIX).byteLength;

/**
 * Truncate to a UTF-8 BYTE budget, the suffix counted inside it.
 *
 * slice() counts CHARACTERS. Slicing at the byte budget let a multibyte message
 * out at up to three times the limit, and appending the suffix afterwards
 * overshot even in ASCII. Cutting on a byte index instead risks splitting a
 * character, so walk back off any continuation byte (10xxxxxx) rather than
 * emitting U+FFFD.
 */
function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const encoded = UTF8_ENCODER.encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  if (maxBytes <= TRUNCATION_SUFFIX_BYTES) return '';
  let end = maxBytes - TRUNCATION_SUFFIX_BYTES;
  while (end > 0 && (encoded[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return `${UTF8_DECODER.decode(encoded.subarray(0, end))}${TRUNCATION_SUFFIX}`;
}

/** JSON for a value we did not author. Bounded, and never throws. */
function safeDetailJson(value: unknown): string {
  const { json, exceeded } = budgetedJson(value, MAX_ERROR_DETAIL_BYTES);
  return exceeded ? '"[omitted]"' : json;
}

function renderIssuePath(path: unknown): string {
  if (path === undefined) return '';
  if (!Array.isArray(path) || !path.every((part) =>
    typeof part === 'string' || (typeof part === 'number' && Number.isSafeInteger(part)))) {
    // An unfamiliar path is not a different field name. Show its JSON shape
    // without coercing booleans, objects or nested arrays into string keys.
    return `path ${safeDetailJson(path)}`;
  }
  let rendered = '';
  for (const part of path) {
    if (typeof part === 'number') rendered += `[${part}]`;
    else if (typeof part === 'string' && PLAIN_IDENTIFIER.test(part)) rendered += rendered ? `.${part}` : part;
    else rendered += `[${JSON.stringify(part)}]`;
  }
  return rendered;
}

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
      // Every branch is bounded, not only the structured one. These messages
      // are backend-authored and can quote what the caller sent, so an upstream
      // that echoes a 100,000-character symbol was reaching the client whole.
      if (err instanceof AuthError) {
        return {
          content: [{ type: 'text', text: truncateToBytes(String(err.message ?? ''), MAX_ERROR_MESSAGE_BYTES) }],
          isError: true,
        };
      }
      if (err instanceof SubscriptionError) {
        return {
          content: [{ type: 'text', text: truncateToBytes(String(err.message ?? ''), MAX_ERROR_MESSAGE_BYTES) }],
          isError: true,
        };
      }
      if (err instanceof ApiError) {
        // A structured proxy error carries the fields that decide what the model
        // does NEXT: `retryable` says whether trying again can possibly work,
        // and actionUrl says where the human fixes it. Collapsing to the
        // message threw all of that away, so a model faced with a dead broker
        // credential retried - spending the user's own broker quota on a call
        // that could never succeed, which is precisely what the flag exists to
        // prevent. Emitted as structuredContent so it is machine-readable, and
        // repeated in the text because not every client reads both.
        const structured = err as { code?: string; retryable?: boolean; actionUrl?: string; details?: Record<string, unknown> };
        if (structured.code !== undefined || structured.retryable !== undefined || structured.details !== undefined) {
          const message = truncateToBytes(String(err.message ?? ''), MAX_ERROR_MESSAGE_BYTES);
          const code = structured.code === undefined
            ? undefined : truncateToBytes(String(structured.code), MAX_ERROR_FIELD_BYTES);
          const actionUrl = structured.actionUrl
            ? truncateToBytes(String(structured.actionUrl), MAX_ERROR_FIELD_BYTES) : undefined;
          const hint = structured.retryable === false
            ? ' Retrying will not succeed.'
            : structured.retryable === true ? ' This may be retried.' : '';
          const action = actionUrl ? ` Fix it at ${actionUrl}` : '';
          // Repeated IN THE TEXT, not only in structuredContent: a client that
          // renders text alone would otherwise be told its expiration was wrong
          // and never told which ones are right, so it guesses again - and each
          // guess is another round trip against the user's broker.
          // Details are advisory; `error`, `code`, `retryable` and `actionUrl`
          // decide what the model does next. So when the details do not fit,
          // the details are what goes - and their absence is stated, because a
          // silent drop leaves a model believing it was told everything.
          const budgeted = budgetedJson(structured.details ?? {}, MAX_ERROR_DETAIL_BYTES);
          const detailsFit = !budgeted.exceeded;
          // Reparsed from the budgeted JSON rather than cloned a second time:
          // one traversal produces both the measurement and the depth-bounded
          // value, and reparsing proves it survives the serialization the MCP
          // SDK performs OUTSIDE this catch, where a throw is unrecoverable.
          let details: Record<string, unknown> = {};
          if (detailsFit) {
            try { details = JSON.parse(budgeted.json) as Record<string, unknown>; } catch { details = {}; }
          }
          // Repeated IN THE TEXT, not only in structuredContent: a client that
          // renders text alone would otherwise be told its expiration was wrong
          // and never told which ones are right, so it guesses again - and each
          // guess is another round trip against the user's broker.
          const detailText = detailsFit
            ? Object.entries(details)
              .map(([key, value]) => {
                const rendered = Array.isArray(value) ? value.map((item) => {
                  if (key === 'issues' && item && typeof item === 'object' && typeof item.message === 'string') {
                    const path = renderIssuePath(item.path);
                    return path ? `${path}: ${item.message}` : item.message;
                  }
                  return item;
                }).join(', ') : String(value);
                return ` ${key}: ${rendered}.`;
              })
              .join('')
            : ` Details omitted: they exceed the ${MAX_ERROR_DETAIL_BYTES}-byte error budget.`;

          // GUIDANCE IS RESERVED, and is never what truncation takes. The hint
          // and the action URL are the part that says whether to retry and
          // where a human fixes it; they were appended AFTER the message and
          // the whole string cut, so a long upstream message removed exactly
          // the instruction not to retry. A client rendering text alone has
          // nowhere else to learn it. Message first, then details, then never
          // this.
          const prefix = 'API error: ';
          const guidance = `${hint}${action}`;
          const reserved = utf8ByteLength(prefix) + utf8ByteLength(guidance);
          const shownMessage = truncateToBytes(message, Math.max(0, MAX_ERROR_TEXT_BYTES - reserved));
          const shownDetails = truncateToBytes(
            detailText,
            Math.max(0, MAX_ERROR_TEXT_BYTES - reserved - utf8ByteLength(shownMessage)),
          );
          return {
            content: [{ type: 'text', text: `${prefix}${shownMessage}${guidance}${shownDetails}` }],
            structuredContent: {
              dataAvailable: false,
              error: message,
              code,
              retryable: structured.retryable,
              actionUrl,
              ...(detailsFit ? details : { detailsOmitted: true }),
            },
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: `API error: ${truncateToBytes(String(err.message ?? ''), MAX_ERROR_MESSAGE_BYTES)}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: `Error: ${truncateToBytes(String(err.message || 'Unknown error'), MAX_ERROR_MESSAGE_BYTES)}` }],
        isError: true,
      };
    }
  };
}
