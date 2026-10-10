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

export const MAX_RESPONSE_BYTES = 50 * 1024; // 50 KB
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
  _exposures_note: 'exposuresNote',
  _migration_note: 'migrationNote',
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
// Field names are camelCase on every tool. Proxy and database rows carry
// snake_case columns (market_date, iv_rank, stress_score) and several tools
// pass them through on raw and full paths, so this boundary converts every
// PURE lowercase snake_case key. Anything else is data or already a field
// name and is left alone: a date, a tenor (10Y), a ticker, a model or feature
// display name, a form type, a camelCase key. Values are not converted; the
// vendor pass below is the one rewrite a value gets.
const SNAKE_KEY_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
// The yield-curve summary already names these spreads; the raw analysis
// block's columns take the same names.
const WIRE_KEY_OVERRIDES: Record<string, string> = {
  spread_2_10: 'twoTen',
  spread_3m_10y: 'threeMonthTenYear',
};
// Dictionaries keyed by a regime tier: the tier's stored name (fixed_income)
// is data, the same string `symbolTier` carries as a value. Only the direct
// children of an OBJECT under these keys are exempt; a `symbols` array is a
// list of rows.
const DATA_KEYED_PARENTS = new Set(['symbols', 'tiers']);

// No tool output names a data vendor. Rows pass through on raw and full
// paths (a company profile's and a news item's `image` is a URL on the
// equity vendor's image host), and backend error text can quote one. So a
// string value that is a URL on a vendor's host is dropped (a link inside
// text reads "a removed link"), and a vendor name anywhere
// else, in a value, a key or an error, reads "vendor". Broker names are not
// data vendors and stay. Values are walked, never serialized text, so an
// escape sequence can neither hide a name nor be broken by a rewrite. The
// patterns are base64 so this file, which the public mirror ships, names no
// vendor itself.
const decodePattern = (encoded: string) => Buffer.from(encoded, 'base64').toString('utf8');
// The equity vendor's full name and its cloud product, in any case and
// spacing.
const VENDOR_NAME_CI = decodePattern('ZmluYW5jaWFsW1xzXy4tXSptb2RlbGluZ1tcc18uLV0qcHJlcHxmbXBbXHNfLi1dKmNsb3Vk');
// The two short names as a word or a camelCase/snake_case segment (lower
// case with no letter before it, a capitalized form with no capital before
// it), so a word that merely contains one is left alone. The acronym's
// plural is included.
const VENDOR_ACRONYM = decodePattern('KD88IVtBLVphLXpdKSg/OmZtcHM/fG9yYXRzKSg/IVthLXpdKXwoPzwhW0EtWl0pKD86Rk1QW3NTXT98Rm1wcz98T1JBVFN8T3JhdHMpKD8hW2Etel0p');
const VENDOR_NAME_CI_RE = new RegExp(VENDOR_NAME_CI, 'gi');
const VENDOR_ACRONYM_RE = new RegExp(VENDOR_ACRONYM, 'g');
const VENDOR_NAME_TEST_RE = [new RegExp(VENDOR_NAME_CI, 'i'), new RegExp(VENDOR_ACRONYM)];
const URL_RE = /\bhttps?:\/\/[^\s"'<>\\]+/gi;
const BARE_URL_RE = /^\s*https?:\/\/\S+\s*$/i;

// A URL names a vendor as written, percent-decoded, or in the host the URL
// parser resolves (which decodes an encoded host).
/**
 * A URL with its escapes decoded piece by piece, so one malformed or
 * unrelated escape (%FF) cannot leave the rest encoded the way decoding the
 * whole string at once would (it throws). In each run of consecutive
 * escapes, every position takes the longest valid sequence of up to four
 * escapes (one UTF-8 character, so %C2%A0 stays one character), and a byte
 * that starts none stays encoded.
 */
function decodeEscapes(url: string): string {
  return url.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const escapes = run.match(/%[0-9A-Fa-f]{2}/g) ?? [];
    let out = '';
    let index = 0;
    while (index < escapes.length) {
      let decoded: string | null = null;
      let used = 1;
      for (let width = Math.min(4, escapes.length - index); width >= 1; width -= 1) {
        try {
          decoded = decodeURIComponent(escapes.slice(index, index + width).join(''));
          used = width;
          break;
        } catch { /* a shorter sequence */ }
      }
      out += decoded ?? escapes[index];
      index += used;
    }
    return out;
  });
}

function vendorUrl(url: string): boolean {
  if (namesVendor(url)) return true;
  if (namesVendor(decodeEscapes(url))) return true;
  try {
    return namesVendor(new URL(url.trim()).hostname);
  } catch {
    return false;
  }
}

function namesVendor(text: string): boolean {
  return VENDOR_NAME_TEST_RE.some((re) => re.test(text));
}

function vendorLike(word: string): string {
  if (/[A-Z]/.test(word) && word === word.toUpperCase()) return 'VENDOR';
  return /^[A-Z]/.test(word) ? 'Vendor' : 'vendor';
}

// Full-width ASCII forms (U+FF01-U+FF5E) spell a name as well as ASCII does
// (the ideographic space is already whitespace to the patterns). Each is one code unit, as its ASCII
// counterpart is, so the folded copy lines up with the original index for
// index: names are found in the copy and only those spans change in the
// original. Nothing else in the string is folded.
const FULL_WIDTH_RE = /[\uff01-\uff5e]/;

function foldFullWidth(text: string): string {
  return text.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

// Replaces each match of `re` found in `folded` at the same span of both
// strings; `swap` returns null to leave a match as it is.
function replaceAligned(
  [original, folded]: [string, string],
  re: RegExp,
  swap: (match: string) => string | null,
): [string, string] {
  let outOriginal = '';
  let outFolded = '';
  let last = 0;
  for (const match of folded.matchAll(re)) {
    const start = match.index ?? 0;
    const replacement = swap(match[0]);
    if (replacement === null) continue;
    outOriginal += original.slice(last, start) + replacement;
    outFolded += folded.slice(last, start) + replacement;
    last = start + match[0].length;
  }
  return [outOriginal + original.slice(last), outFolded + folded.slice(last)];
}

// Our own infrastructure, which means nothing to a reader and is not
// public: the database product the proxy names as a provenance `provider`,
// and the tables it names as a `source` (and inside snapshot ids). A field
// whose whole value is the product is dropped by the walk below; anywhere
// else the product reads "the platform database" (platformDatabase in a
// key), a URL on it is removed however it is encoded, and each table reads
// as a neutral label, in a key as well. A table name is matched as a whole
// segment, so a word that merely contains one (rescan_tickers) is left alone.
const INTERNAL_TABLE_LABELS: Record<string, string> = {
  option_ticker_snapshots: 'eod-options-snapshot',
  option_term_structure: 'eod-term-structure',
  ticker_snapshots: 'eod-ticker-snapshot',
  futures_strikes: 'eod-futures-strikes',
  scan_tickers: 'eod-options-summary',
  scan_strikes: 'eod-strike-data',
};
// Longest first, so option_ticker_snapshots is taken whole before
// ticker_snapshots could match inside it.
const INTERNAL_TABLE_RE = new RegExp(`(?<![A-Za-z0-9])(?:${Object.keys(INTERNAL_TABLE_LABELS).join('|')})(?![A-Za-z0-9])`, 'gi');
const tableLabel = (table: string): string => INTERNAL_TABLE_LABELS[table.toLowerCase()];
// The product as a standalone word reads "the platform database"; any other
// occurrence, inside an identifier (supabaseClient), reads platformDatabase.
const DATABASE_PRODUCT_WORD_RE = /(?<![A-Za-z0-9])supabase(?![A-Za-z0-9])/gi;
const DATABASE_PRODUCT_ANY_RE = /supabase/gi;
const DATABASE_PRODUCT_VALUE_RE = /^\s*supabase\s*$/i;

/** A URL on the database product, as written, percent-decoded, or by the host it resolves to. */
function infrastructureUrl(url: string): boolean {
  if (/supabase/i.test(url)) return true;
  if (/supabase/i.test(decodeEscapes(url))) return true;
  try {
    return /supabase/i.test(new URL(url.trim()).hostname);
  } catch {
    return false;
  }
}

function namesInfrastructure(text: string): boolean {
  INTERNAL_TABLE_RE.lastIndex = 0;
  const table = INTERNAL_TABLE_RE.test(text);
  INTERNAL_TABLE_RE.lastIndex = 0;
  return table || /supabase/i.test(text) || /https?:\/\/\S*%/i.test(text);
}

function scrubInfrastructureText(text: string): string {
  if (!namesInfrastructure(text)) return text;
  return text
    .replace(URL_RE, (url) => (infrastructureUrl(url) ? 'a removed link' : url))
    .replace(DATABASE_PRODUCT_WORD_RE, 'the platform database')
    .replace(DATABASE_PRODUCT_ANY_RE, (word) => (word[0] === word[0].toUpperCase() ? 'PlatformDatabase' : 'platformDatabase'))
    .replace(INTERNAL_TABLE_RE, tableLabel);
}

/**
 * A KEY naming our infrastructure, renamed before its camelCase conversion:
 * a table segment becomes its label in snake form (scan_tickers ->
 * eod_options_summary -> eodOptionsSummary) and the product, anywhere in the
 * key, platformDatabase.
 */
function scrubInfrastructureKey(key: string): string {
  if (!namesInfrastructure(key)) return key;
  // A snake_case key takes snake replacements, so its camelCase conversion
  // still applies (supabase_provider -> platform_database_provider ->
  // platformDatabaseProvider).
  const snake = key.includes('_');
  return key
    .replace(INTERNAL_TABLE_RE, (table) => tableLabel(table).replace(/-/g, '_'))
    .replace(DATABASE_PRODUCT_ANY_RE, (word) => (snake ? 'platform_database'
      : word[0] === word[0].toUpperCase() ? 'PlatformDatabase' : 'platformDatabase'));
}

export function scrubVendorText(input: string): string {
  const text = scrubInfrastructureText(stripInvisible(input));
  const folded = FULL_WIDTH_RE.test(text) ? foldFullWidth(text) : text;
  if (!/https?:\/\//i.test(folded) && !namesVendor(folded)) return text;
  let pair: [string, string] = [text, folded];
  pair = replaceAligned(pair, URL_RE, (url) => (vendorUrl(url) ? 'a removed link' : null));
  pair = replaceAligned(pair, VENDOR_NAME_CI_RE, vendorLike);
  // The acronym's plural keeps its s as written.
  pair = replaceAligned(pair, VENDOR_ACRONYM_RE, (word) => (word.length === 4 ? vendorLike(word.slice(0, 3)) + word.slice(3) : vendorLike(word)));
  return pair[0];
}

function isVendorUrl(value: unknown): boolean {
  return typeof value === 'string' && BARE_URL_RE.test(value) && (vendorUrl(value) || infrastructureUrl(value));
}

// An own property whatever its name: assigning "__proto__" into a plain
// object would set its prototype and lose the key.
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

const hasOwn = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);

/**
 * A key renamed for a vendor never lands on a name another key of the same
 * object publishes: it takes the first free numbered form (vendor, vendor2).
 */
function settleVendorKeys(entries: Array<{ outKey: string; vendor: boolean }>): void {
  const taken = new Set(entries.filter((entry) => !entry.vendor).map((entry) => entry.outKey));
  for (const entry of entries) {
    if (!entry.vendor) continue;
    let candidate = entry.outKey;
    for (let n = 2; taken.has(candidate); n += 1) candidate = `${entry.outKey}${n}`;
    taken.add(candidate);
    entry.outKey = candidate;
  }
}

/**
 * The same rules with no depth limit and no recursion, for plain JSON data:
 * what lies past the sanitizer's depth limit, and error details. Nothing
 * else is renamed.
 */
function scrubVendorDeep(source: unknown): unknown {
  if (typeof source === 'string') return scrubVendorText(source);
  if (source == null || typeof source !== 'object') return source;
  const root: unknown = Array.isArray(source) ? [] : {};
  const stack: Array<[unknown, unknown]> = [[source, root]];
  const place = (child: unknown): unknown => {
    if (typeof child === 'string') return scrubVendorText(child);
    if (child == null || typeof child !== 'object') return child;
    const copy: unknown = Array.isArray(child) ? [] : {};
    stack.push([child, copy]);
    return copy;
  };
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    if (Array.isArray(from)) {
      for (const item of from) (to as unknown[]).push(place(item));
      continue;
    }
    const record = from as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((name) => !isVendorUrl(record[name]))
      .map((name) => {
        const outKey = scrubVendorText(scrubInfrastructureKey(stripInvisible(name)));
        return { name, outKey, vendor: outKey !== name };
      });
    settleVendorKeys(entries);
    for (const { name, outKey } of entries) setOwn(to as Record<string, unknown>, outKey, place(record[name]));
  }
  return root;
}

function camelWireKey(key: string): string {
  if (!SNAKE_KEY_RE.test(key)) return key;
  if (key in WIRE_KEY_OVERRIDES) return WIRE_KEY_OVERRIDES[key];
  const parts = key.split('_');
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    // Two adjacent number segments would glue (net_gex_0_60d -> netGex060d).
    if (/^[0-9]/.test(part) && /[0-9]$/.test(parts[i - 1])) out += `to${part}`;
    else out += part.charAt(0).toUpperCase() + part.slice(1);
  }
  return out;
}

// Characters that print as nothing and carry no meaning in published text:
// the zero-width space, the word joiner and the byte-order mark, which feeds
// leave between words (a news summary in the thirty-third run). The
// zero-width joiner and non-joiner stay: they shape some scripts and emoji.
const INVISIBLE_RE = /[\u200B\u2060\uFEFF]/g;

function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_RE, '');
}

export function sanitizeMcpWireOutput(data: unknown, depth = 0, dataKeyed = false): unknown {
  // What is published is what JSON.stringify makes of the value, so that is
  // what is sanitized: toJSON methods, functions, boxed primitives and
  // getters are settled once, natively, before anything is renamed or
  // scrubbed, and a value that serializes to nothing stays nothing.
  if (depth === 0 && data != null && (typeof data === 'object' || typeof data === 'function')) {
    const serialized = JSON.stringify(data);
    if (serialized === undefined) return undefined;
    data = JSON.parse(serialized) as unknown;
  }
  if (typeof data === 'string') return scrubVendorText(data);
  if (data == null || typeof data !== 'object') return data;
  // Past the depth limit nothing is renamed or dropped, but no vendor name
  // gets through.
  if (depth > 20) return scrubVendorDeep(data);
  if (Array.isArray(data)) return data.map((item) => sanitizeMcpWireOutput(item, depth + 1));

  const obj = data as Record<string, unknown>;
  // The keys as they will be read and published, invisible characters
  // removed, for every rule that looks at the object's keys as a whole.
  const rawKeys = Object.keys(obj);
  const view: Record<string, unknown> = rawKeys.some((key) => stripInvisible(key) !== key)
    ? Object.fromEntries(Object.entries(obj).map(([key, value]) => [stripInvisible(key), value]))
    : obj;
  const syncBackedRow = isSyncBackedRow(view);
  const nestedSyncSnapshotPayload = isNestedSyncSnapshotPayload(view);
  const entries: Array<{ outKey: string; value: unknown; vendor: boolean; keyedParent: boolean }> = [];

  for (const [rawKey, value] of Object.entries(obj)) {
    // Invisible characters leave a key before anything reads it, or a name
    // they split would pass every rule below and be joined again after.
    const key = stripInvisible(rawKey);
    // A key that lost a character is a renamed key: it never overwrites one
    // that arrived under that name.
    const cleaned = key !== rawKey;
    if (hasOwn(SAFE_UNDERSCORE_KEY_RENAMES, key)) {
      entries.push({ outKey: SAFE_UNDERSCORE_KEY_RENAMES[key], value, vendor: cleaned, keyedParent: false });
      continue;
    }
    if (hasOwn(READABLE_KEY_RENAMES, key)) {
      entries.push({ outKey: READABLE_KEY_RENAMES[key], value, vendor: cleaned, keyedParent: false });
      continue;
    }
    const dynamicMetaMatch = key.match(DYNAMIC_META_KEY_RE);
    if (dynamicMetaMatch) {
      const [, base] = dynamicMetaMatch;
      const plain = `${camelWireKey(base)}Meta`;
      const outKey = scrubVendorText(`${camelWireKey(scrubInfrastructureKey(base))}Meta`);
      entries.push({ outKey, value, vendor: outKey !== plain || cleaned, keyedParent: false });
      continue;
    }
    if (key.startsWith('_')) continue;
    if (isVendorUrl(value)) continue;
    // A field that only names our database (provenance `provider`) says nothing.
    if (typeof value === 'string' && DATABASE_PRODUCT_VALUE_RE.test(value)) continue;
    if (key === 'user_id' || key === 'created_at' || key === 'updated_at') continue;
    if (key === 'run_key') continue;
    if (INTERNAL_IDENTIFIER_KEYS.has(key)) continue;
    if (key === 'id' && (syncBackedRow || nestedSyncSnapshotPayload)) continue;

    // A key naming our infrastructure is renamed first, so its camelCase
    // form is built from the label (scan_tickers -> eodOptionsSummary).
    const infraKey = scrubInfrastructureKey(key);
    const camel = dataKeyed ? infraKey : camelWireKey(infraKey);
    // Never overwrite: a snake key whose camelCase twin is already present
    // stays as it is rather than replace a value.
    const plain = camel !== infraKey && hasOwn(view, camel) ? infraKey : camel;
    // Renamed is whatever the scrub changed, however the name came to hold
    // a vendor's (a camelCase conversion can assemble one).
    const outKey = scrubVendorText(plain);
    entries.push({ outKey, value, vendor: outKey !== plain || infraKey !== rawKey, keyedParent: true });
  }

  settleVendorKeys(entries);
  const out: Record<string, unknown> = {};
  for (const { outKey, value, keyedParent } of entries) {
    out[outKey] = sanitizeMcpWireOutput(value, depth + 1, keyedParent && DATA_KEYED_PARENTS.has(outKey));
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

/**
 * A computed number at 15 significant digits, the most a double carries for
 * every decimal: a sum of published Greeks times open interest comes out of
 * binary arithmetic as -27496.350000000002, and this drops that noise. A
 * whole number has none and passes exactly: an open-interest count of
 * 1000000000000001 is not 1e15, and the largest double is not Infinity.
 */
export function significant(value: number, digits = 15): number {
  return Number.isInteger(value) ? value : Number(value.toPrecision(digits));
}

/**
 * Every number in a published payload through significant(): the one
 * rounding every tool's answer goes through (toolHandler), so a ratio, mid or spread computed anywhere upstream goes out
 * at 15 significant digits at most. A decimal printed with 15 or fewer
 * digits, and a whole number, pass unchanged; nothing but numbers changes.
 */
export function significantDeep<T>(value: T): T {
  if (typeof value === 'number') return significant(value) as T;
  if (Array.isArray(value)) return value.map(significantDeep) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, significantDeep(entry)])) as T;
  }
  return value;
}

/** The value at a dot path, and whether it exists. */
function atPath(root: unknown, path: string[]): { found: boolean; value: unknown } {
  let node = root;
  for (const key of path) {
    if (node == null || typeof node !== 'object' || !hasOwn(node as object, key)) return { found: false, value: undefined };
    node = (node as Record<string, unknown>)[key];
  }
  return { found: true, value: node };
}

/** Put back, at each dot path, the value the tool computed before rounding. */
function restoreExactPaths(rounded: unknown, raw: unknown, paths: readonly string[]): void {
  for (const dotted of paths) {
    const path = dotted.split('.');
    const source = atPath(raw, path);
    const parent = atPath(rounded, path.slice(0, -1));
    if (!source.found || !parent.found || parent.value == null || typeof parent.value !== 'object') continue;
    setOwn(parent.value as Record<string, unknown>, path[path.length - 1], source.value);
  }
}

export function toolHandler<T extends Record<string, unknown>>(
  fn: (args: T) => Promise<unknown>,
  /**
   * keepOnEmpty: fields of an empty result that still say something (a
   * stock's history state beside no rows) and are kept on the generic
   * no-data response instead of being dropped.
   *
   * exactPaths: dot paths the tool publishes exactly as it computed them,
   * past the 15-significant-digit rounding every other number gets (an echo
   * of the value rows were chosen with, which rounded would name a
   * different one).
   */
  opts?: { isSyncTool?: boolean; keepOnEmpty?: readonly string[]; exactPaths?: readonly string[] },
): (args: T) => Promise<ToolResult> {
  return async (args: T): Promise<ToolResult> => {
    try {
      let data = await fn(args);
      // What JSON makes of the result, settled first: a Date is its ISO
      // string, a boxed number its value, and a value that serializes to
      // null is no data like a null result.
      const serialized = typeof data === 'object' && data !== null ? JSON.stringify(data) : undefined;
      if (serialized !== undefined) data = JSON.parse(serialized) as unknown;
      const noData = (): ToolResult => {
        const message = 'No data available for this query.';
        return {
          content: [{ type: 'text', text: message }],
          structuredContent: { dataAvailable: false, message },
        };
      };
      if (data == null) return noData();

      // Backward-compat: unwrap legacy full-mode shape from tool handlers.
      if (typeof data === 'object' && data !== null && (data as any)?._skipSizeGuard === true) {
        data = (data as any).data;
        // A full-mode wrapper around an absent answer (the proxy client's null for a 404) is no data too, never an
        // internal error from reading the null below.
        if (data == null) return noData();
      }

      // Every number at 15 significant digits: binary noise such as
      // 4.4399999999999995 in a computed mid goes, whole numbers and
      // decimals already that short pass unchanged (on the settled value).
      const computed = data;
      data = significantDeep(data);
      if (opts?.exactPaths?.length) restoreExactPaths(data, computed, opts.exactPaths);

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
        const kept = Object.fromEntries((opts?.keepOnEmpty ?? [])
          .filter((key) => response[key] !== undefined)
          .map((key) => [key, response[key]]));
        if (Object.keys(kept).length > 0) {
          const json = applyResponseSizeGuard({ dataAvailable: false, data: [], message: msg, ...kept });
          return {
            content: [{ type: 'text', text: json }],
            structuredContent: structuredContentFromJson(json),
          };
        }
        // JSON in the text too, like every other answer.
        const empty = { dataAvailable: false, data: [], message: msg };
        return {
          content: [{ type: 'text', text: JSON.stringify(empty) }],
          structuredContent: empty,
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
          content: [{ type: 'text', text: truncateToBytes(scrubVendorText(String(err.message ?? '')), MAX_ERROR_MESSAGE_BYTES) }],
          isError: true,
        };
      }
      if (err instanceof SubscriptionError) {
        return {
          content: [{ type: 'text', text: truncateToBytes(scrubVendorText(String(err.message ?? '')), MAX_ERROR_MESSAGE_BYTES) }],
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
          const message = truncateToBytes(scrubVendorText(String(err.message ?? '')), MAX_ERROR_MESSAGE_BYTES);
          const code = structured.code === undefined
            ? undefined : truncateToBytes(scrubVendorText(String(structured.code)), MAX_ERROR_FIELD_BYTES);
          // A vendor's own page is no place to send the user.
          const actionUrl = structured.actionUrl && !isVendorUrl(String(structured.actionUrl))
            ? truncateToBytes(scrubVendorText(String(structured.actionUrl)), MAX_ERROR_FIELD_BYTES) : undefined;
          const hint = structured.retryable === false
            ? ' Retrying the same request will not succeed.'
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
          let detailsFit = !budgeted.exceeded;
          // Reparsed from the budgeted JSON rather than cloned a second time:
          // one traversal produces both the measurement and the depth-bounded
          // value, and reparsing proves it survives the serialization the MCP
          // SDK performs OUTSIDE this catch, where a throw is unrecoverable.
          let details: Record<string, unknown> = {};
          if (detailsFit) {
            try { details = JSON.parse(budgeted.json) as Record<string, unknown>; } catch { details = {}; }
            // Scrubbed within the budget: a longer word in place of a vendor's
            // name must not carry the details past it.
            details = scrubVendorDeep(details) as Record<string, unknown>;
            if (jsonUtf8ByteLength(details) > MAX_ERROR_DETAIL_BYTES) { detailsFit = false; details = {}; }
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
                }).join(', ') : value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
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
          // The CODE is in the text too, in the prefix, where truncation
          // cannot reach it: a text-only client was shown the prose and the
          // guidance and never UNKNOWN_EXPIRATION, which is the one token a
          // model can match on. And a full stop between the upstream message
          // and the guidance where the message brought none: "not listed for
          // SPY Retrying will not succeed" read as one sentence.
          const prefix = code ? `API error (${code}): ` : 'API error: ';
          const guidance = `${hint}${action}`;
          const reserved = utf8ByteLength(prefix) + utf8ByteLength(guidance) + 1;
          const shownMessage = truncateToBytes(message, Math.max(0, MAX_ERROR_TEXT_BYTES - reserved));
          const separator = shownMessage && guidance && !/[.!?:;]$/.test(shownMessage) && !shownMessage.endsWith(TRUNCATION_SUFFIX) ? '.' : '';
          const shownDetails = truncateToBytes(
            detailText,
            Math.max(0, MAX_ERROR_TEXT_BYTES - reserved - utf8ByteLength(shownMessage)),
          );
          return {
            content: [{ type: 'text', text: `${prefix}${shownMessage}${separator}${guidance}${shownDetails}` }],
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
          content: [{ type: 'text', text: `API error: ${truncateToBytes(scrubVendorText(String(err.message ?? '')), MAX_ERROR_MESSAGE_BYTES)}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: `Error: ${truncateToBytes(scrubVendorText(String(err.message || 'Unknown error')), MAX_ERROR_MESSAGE_BYTES)}` }],
        isError: true,
      };
    }
  };
}
