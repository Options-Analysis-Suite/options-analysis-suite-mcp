/**
 * The MCP server's one exposure calculation, the assumed dealer book (Greek exposure methodology v2): the one MCP shape of a book exposure, from a stored public block
 * (the regime rows) or from the proxy's wire bases through a twin of the shared book().
 *
 * The rules:
 * - every exposure number is the assumed book's, the Long OI view's or the delta balance, or says why there is none;
 * - the gamma-derived levels stay their own computation, in `levels`, each with its own window, none derived from the book;
 * - a storage word never reaches the wire.
 * The proxy's transport still names its calculation (`exposure=v2`, `methodology: 2`); requireBookEnvelope checks that
 * echo and never sends it.
 */
import { LiveApiError } from '../proxy/liveApiClient.js';

/**
 * A proxy answer must say it carries the book: the route's own `methodology: 2` and its book, the assumed dealer
 * book at p = 1. Anything else is refused, never relabeled: the proxy did not answer what was asked.
 */
export function requireBookEnvelope(res: unknown): void {
  const body = res as { methodology?: unknown; exposure?: { view?: unknown; p?: unknown } } | null;
  if (body && typeof body === 'object' && body.methodology === 2 && body.exposure?.view === 'assumedDealerBook' && body.exposure?.p === 1) return;
  throw bookNotCarriedError();
}

/**
 * A proxy answer's `unavailable` list as the MCP sends it: the book's transport name, `exposureV2`,
 * reads as `exposures`; every other source as sent. The partial signal itself is kept.
 */
export function publicUnavailable(list: unknown): unknown {
  return Array.isArray(list) ? list.map((source) => (source === 'exposureV2' ? 'exposures' : source)) : list;
}

/**
 * A proxy history identifier as the MCP sends it: the route appends `:v2` for the book's opt-in and
 * `:v2rev=<n>` for the book publication's revision; sent without the first and as `:rev=<n>`, the same opaque identity.
 */
export function publicSnapshotId(id: unknown): unknown {
  return typeof id === 'string' ? id.replace(/:v2rev=/g, ':rev=').replace(/:v2(?=:|$)/g, '') : id;
}

/** The refusal of a proxy answer that does not carry the assumed dealer book it was asked for */
export function bookNotCarriedError(): LiveApiError {
  return new LiveApiError('The answer did not carry the assumed dealer book, so it was not used.', 502, 'UPSTREAM_INVALID', false, undefined, undefined);
}

// ---------------------------------------------------------------------------------------------------------------
// The book: a twin of packages/shared/src/exposure/book.ts at p = 1, for both views. The MCP server ships alone (the
// public mirror has no packages/shared), so the arithmetic is copied and pinned against the shared function wherever
// the monorepo is present (exposureMethodology.test.ts).

export const COVERAGE_METRICS = ['gamma', 'delta', 'vega', 'vanna', 'charm', 'vomma'] as const;
export type CoverageMetric = (typeof COVERAGE_METRICS)[number];
export type CoverageStatus = 'complete' | 'partial' | 'unavailable';
export interface CoveragePair { included: number; total: number }

/** The proxy's wire bases of the book: each side's resolved values (charm already resolved under the roll), null where unavailable */
export interface WireBases {
  call: Partial<Record<string, number | null>>;
  put: Partial<Record<string, number | null>>;
  coverage: Record<CoverageMetric, CoveragePair>;
  /** The put-minus-call delta balance in the legacy arithmetic; null where delta is unavailable */
  dexBalance: number | null;
}

/** Why a day's values may count what the expiry rule leaves out (shared expiryScope.ts ExpiryQualifier), as prose */
export function qualifierText(q: unknown): string | null {
  const qualifier = q as { kind?: unknown; cause?: unknown; disposition?: unknown; strikes?: unknown } | null;
  if (!qualifier || typeof qualifier !== 'object') return null;
  if (qualifier.kind === 'mayInclude') {
    return qualifier.cause === 'pending'
      ? 'may count contracts expiring that day (their correction is in progress)'
      : 'may count contracts expiring that day (their correction could not be confirmed)';
  }
  if (qualifier.kind === 'affected') {
    return `may count contracts expiring that day or strikes whose expiration could not be read (the repair recorded it and ${qualifier.disposition === 'refused' ? 'refused' : 'deferred'} the correction)`;
  }
  if (qualifier.kind === 'unscoped') {
    return typeof qualifier.strikes === 'number' ? `counts ${qualifier.strikes} strikes whose expiration could not be read` : 'counts strikes whose expiration could not be read';
  }
  return 'its expiry scope is not proven';
}

/** Whether a value reads as the proxy's wire bases (every coverage pair counted) */
export function isWireBases(value: unknown): value is WireBases {
  const w = value as WireBases | null;
  return !!w && typeof w === 'object' && !!w.call && !!w.put && !!w.coverage
    && COVERAGE_METRICS.every((m) => Number.isInteger(w.coverage[m]?.included) && Number.isInteger(w.coverage[m]?.total));
}

export interface BookValues { gex: number | null; vegaExposure: number | null; vanna: number | null; charmFlow: number | null; vomma: number | null }

export interface V2Book {
  /** Dealers long the calls and short the puts, every contract of open interest (share 1) */
  assumedDealerBook: BookValues;
  /** Every contract of open interest held long */
  longOi: BookValues;
  putMinusCallDeltaBalance: number | null;
  coverage: Record<CoverageMetric, CoveragePair & { status: CoverageStatus }>;
}

/** shared sideInput.coverageStatus: every leg included is complete (a known-empty 0 of 0 too), none is unavailable */
export function coverageStatusOf(pair: CoveragePair): CoverageStatus {
  if (pair.included === pair.total) return 'complete';
  return pair.included === 0 ? 'unavailable' : 'partial';
}

export function bookOfWire(wire: WireBases): V2Book {
  const unavailable = (metric: CoverageMetric) => coverageStatusOf(wire.coverage[metric]) === 'unavailable';
  // a null side counts 0 in a partial metric, as book() reads it
  const side = (s: 'call' | 'put', key: string): number => wire[s][key] ?? 0;
  const view = (w: { call: number; put: number }): BookValues => {
    const position = (metric: CoverageMetric, key: string) => (unavailable(metric) ? null : w.call * side('call', key) + w.put * side('put', key));
    return {
      gex: position('gamma', 'gex'),
      vegaExposure: position('vega', 'vega'),
      vanna: position('vanna', 'vanna'),
      // the hedge flow is the negative of the view's resolved delta drift
      charmFlow: unavailable('charm') ? null : -(w.call * side('call', 'charm') + w.put * side('put', 'charm')),
      vomma: position('vomma', 'vomma'),
    };
  };
  const coverage = Object.fromEntries(COVERAGE_METRICS.map((metric) => {
    const pair = wire.coverage[metric];
    return [metric, { included: pair.included, total: pair.total, status: coverageStatusOf(pair) }];
  })) as V2Book['coverage'];
  return {
    assumedDealerBook: view({ call: 1, put: -1 }),
    longOi: view({ call: 1, put: 1 }),
    // the legacy arithmetic's balance, the same in every view: passed through exactly
    putMinusCallDeltaBalance: wire.dexBalance,
    coverage,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The MCP shape

/** Each coverage metric under the name of the number it governs */
const REPORTED_NAME: Record<CoverageMetric, string> = {
  gamma: 'gex', delta: 'putMinusCallDeltaBalance', vega: 'vegaExposure', vanna: 'vanna', charm: 'charmFlow', vomma: 'vomma',
};

const ROLL_WORDS: Record<string, string> = {
  fitted: 'fitted', insufficientData: 'insufficient data', rejectedFit: 'fit rejected', notApplicable: 'not applicable',
};

const REFERENCE_KINDS = new Set(['spot', 'forward', 'future']);

export interface V2Reference {
  referenceKind: string;
  rollStatus: string;
  carry: number | null;
}

/** proxy/lib/screenerExposureV2.ts charmBasisOf: cash on a spot reference or a fitted forward, else the fixed reference */
export function charmBasisOf(referenceKind: string, rollStatus: string): 'cash' | 'fixed reference' {
  return referenceKind === 'spot' || (referenceKind === 'forward' && rollStatus === 'fitted') ? 'cash' : 'fixed reference';
}

/** The coverage of each of `metrics` that is not complete, under the name of the number it governs; null when all are */
export function coverageShortfall(book: V2Book, metrics: ReadonlyArray<CoverageMetric> = COVERAGE_METRICS): Record<string, unknown> | null {
  const coverage: Record<string, unknown> = {};
  for (const metric of metrics) {
    const pair = book.coverage[metric];
    if (pair.status !== 'complete') coverage[REPORTED_NAME[metric]] = { status: pair.status, included: pair.included, total: pair.total };
  }
  return Object.keys(coverage).length > 0 ? coverage : null;
}

/** One book exposure as the MCP sends it: the assumed book's five numbers, Long OI, the delta balance, what is not complete, the reference */
export function mcpExposuresV2(book: V2Book, reference: V2Reference, scope?: string): Record<string, unknown> {
  const coverage = coverageShortfall(book);
  const roll = ROLL_WORDS[reference.rollStatus] ?? reference.rollStatus;
  return {
    ...(scope ? { scope } : {}),
    ...book.assumedDealerBook,
    longOi: book.longOi,
    putMinusCallDeltaBalance: book.putMinusCallDeltaBalance,
    ...(coverage !== null ? { coverage } : {}),
    referenceKind: reference.referenceKind,
    charmBasis: charmBasisOf(reference.referenceKind, reference.rollStatus),
    // the roll matters only off a spot reference: a spot chain never rolls
    ...(reference.referenceKind !== 'spot'
      ? { roll, ...(reference.rollStatus === 'fitted' && reference.carry !== null ? { carry: reference.carry } : {}) }
      : {}),
  };
}

// The fields of a book exposure that every one of several objects shares (the scope, the reference and its
// charm basis): moved out of each and returned once, for the answer's `exposuresCommon`; a field that differs, or is
// missing from one, stays on each. Fewer than two objects share nothing.
export const COMMON_EXPOSURE_KEYS = ['scope', 'referenceKind', 'charmBasis', 'roll', 'carry'] as const;
export function hoistCommonFields(objects: ReadonlyArray<unknown>): Record<string, unknown> | null {
  const sent = objects.filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o));
  if (sent.length < 2) return null;
  const common: Record<string, unknown> = {};
  for (const key of COMMON_EXPOSURE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(sent[0], key)) continue;
    const text = JSON.stringify(sent[0][key]);
    if (!sent.every((o) => Object.prototype.hasOwnProperty.call(o, key) && JSON.stringify(o[key]) === text)) continue;
    common[key] = sent[0][key];
    for (const o of sent) delete o[key];
  }
  return Object.keys(common).length > 0 ? common : null;
}

// ---------------------------------------------------------------------------------------------------------------
// A proxy day of the book (proxy/lib/historyExposureV2.ts DailyExposureV2, the opt-ins' wire: resolved sides,
// coverage, delta balance, roll, reference kind, definition and expiry qualifier) as the MCP's `exposures` object.

/** Why a proxy answer has no book numbers, in fixed words (the proxy's own reasons, transport text that can name its
 * calculation, dates and runs, are read and never sent) */
export function v2ReasonText(reason: unknown): string {
  const r = typeof reason === 'string' ? reason : '';
  if (r === 'no methodology-2 row' || /^methodology 2 has not been published/.test(r)) return 'the assumed dealer book is not published for this session';
  if (/^(no strike curves|the strike curves are from another session|the strike curves belong to another computation)/.test(r)) return 'the session\'s strike curves are not of its published book';
  if (/^the (snapshot|bases)\b/.test(r) || r === 'the methodology-2 row is not of the session\'s current publication') return 'the stored book is not of the session\'s current publication';
  if (r === 'the methodology-2 rows could not be read' || r === 'the strike curves could not be read' || r === 'the methodology-2 bases could not be read') return 'the stored book could not be read on this call';
  return 'the stored book is unreadable';
}

/** The day's scope from its definition: expiry-scoped, or a legacy-scope row from before the expiry rule */
function definitionScope(definition: unknown, qualifier: unknown): string | undefined {
  if (definition === 'expiry-scoped') return 'every expiration after the session';
  if (definition === 'legacy-scope') {
    return qualifier
      ? 'every expiration on file for the session (stored before the expiry rule was recorded)'
      : 'every expiration on file for the session (stored before the expiry rule was recorded, and proven to hold none expiring that session)';
  }
  return undefined;
}

/** One day's book `exposures` (with exposureStatus.expiryQualifier where the scope is not proven), or why there are none */
export function exposuresFromDaily(daily: unknown): { exposures: Record<string, unknown> | null; exposuresUnavailable?: string } {
  const d = daily as { available?: unknown; reason?: unknown; bases?: unknown; referenceKind?: unknown; roll?: { status?: unknown; carry?: unknown }; definition?: unknown; expiryQualifier?: unknown } | null;
  if (!d || typeof d !== 'object' || d.available !== true) return { exposures: null, exposuresUnavailable: v2ReasonText(d?.reason) };
  if (!isWireBases(d.bases)) return { exposures: null, exposuresUnavailable: 'the stored book is unreadable' };
  const referenceKind = typeof d.referenceKind === 'string' && REFERENCE_KINDS.has(d.referenceKind) ? d.referenceKind : 'unknown';
  const rollStatus = typeof d.roll?.status === 'string' ? d.roll.status : 'notApplicable';
  const carry = typeof d.roll?.carry === 'number' && Number.isFinite(d.roll.carry) ? d.roll.carry : null;
  const exposures = mcpExposuresV2(bookOfWire(d.bases), { referenceKind, rollStatus, carry }, definitionScope(d.definition, d.expiryQualifier));
  const qualifier = qualifierText(d.expiryQualifier);
  return { exposures: qualifier ? { ...exposures, exposureStatus: { expiryQualifier: qualifier } } : exposures };
}

/**
 * Each book number's change between two days' exposures: this minus that where both are numbers, else null;
 * the charm flow's null across a change of charm basis (a cash roll at one end, a fixed reference at the other), which
 * is a change of what is measured, not of the market.
 */
export function exposuresChange(current: Record<string, unknown>, prior: Record<string, unknown>): Record<string, unknown> {
  const delta = (key: string) => (typeof current[key] === 'number' && typeof prior[key] === 'number' ? (current[key] as number) - (prior[key] as number) : null);
  const basisChanged = current.charmBasis !== prior.charmBasis;
  return {
    gex: delta('gex'), putMinusCallDeltaBalance: delta('putMinusCallDeltaBalance'), vegaExposure: delta('vegaExposure'),
    vanna: delta('vanna'), charmFlow: basisChanged ? null : delta('charmFlow'), vomma: delta('vomma'),
    ...(basisChanged ? { charmBasisChanged: true } : {}),
  };
}

const finiteOrNull = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value));
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const BOOK_KEYS = ['gex', 'vegaExposure', 'vanna', 'charmFlow', 'vomma'] as const;

function bookValuesOf(value: unknown): BookValues | null {
  if (!isRecord(value)) return null;
  const out: Partial<BookValues> = {};
  for (const key of BOOK_KEYS) {
    const v = value[key];
    if (!finiteOrNull(v)) return null;
    out[key] = v;
  }
  return out as BookValues;
}

export interface StoredBlock {
  book: V2Book;
  reference: V2Reference;
  /** The producer's chain word (a storage word: never sent) */
  source: string | null;
  /** The expiry rule the producer applied, where it stated one */
  expiryScope: string | null;
}

/** A stored public block (packages/shared/src/exposure/publicBlock.ts ExposureV2Block, as the regime worker writes it), or null when it does not read as one */
export function readStoredBlock(block: unknown): StoredBlock | null {
  if (!isRecord(block) || block.methodology !== 2) return null;
  const assumedDealerBook = bookValuesOf(block.assumedDealerBook);
  const longOi = bookValuesOf(block.longOi);
  if (!assumedDealerBook || !longOi || !finiteOrNull(block.putMinusCallDeltaBalance) || !isRecord(block.coverage)) return null;
  const coverage: Partial<V2Book['coverage']> = {};
  for (const metric of COVERAGE_METRICS) {
    const pair = block.coverage[metric];
    if (!isRecord(pair)) return null;
    const { included, total } = pair;
    if (!Number.isInteger(included) || !Number.isInteger(total) || (included as number) < 0 || (included as number) > (total as number)) return null;
    // the counts decide the status, as everywhere else (a stored word that disagreed would be the producer's error)
    coverage[metric] = { included: included as number, total: total as number, status: coverageStatusOf({ included: included as number, total: total as number }) };
  }
  if (typeof block.referenceKind !== 'string' || !REFERENCE_KINDS.has(block.referenceKind)) return null;
  if (typeof block.rollStatus !== 'string' || !Object.hasOwn(ROLL_WORDS, block.rollStatus)) return null;
  if (!finiteOrNull(block.carry ?? null)) return null;
  return {
    book: { assumedDealerBook, longOi, putMinusCallDeltaBalance: block.putMinusCallDeltaBalance as number | null, coverage: coverage as V2Book['coverage'] },
    reference: { referenceKind: block.referenceKind, rollStatus: block.rollStatus, carry: (block.carry ?? null) as number | null },
    source: typeof block.source === 'string' ? block.source : null,
    expiryScope: typeof block.expiryScope === 'string' ? block.expiryScope : null,
  };
}

/** The assumed dealer book and its five numbers' units, the words every book note uses */
export const V2_BOOK_TEXT = 'the assumed dealer book - dealers long the calls and short the puts, '
  + 'every contract of open interest (share 1): gex (USD of delta per 1% move), vegaExposure (USD per vol point), '
  + 'vanna (USD of delta per vol point; + means the book\'s delta hedger sells when IV rises), charmFlow (USD of the '
  + 'underlying the book\'s hedger trades per calendar day to stay delta-neutral; + is buying) and vomma (USD per (vol point)^2)';

/** The note every answer carrying book exposures sends once, as `bookNote` (a plain key: the wire drops an unknown underscore key) */
export const BOOK_NOTE = '`exposures` is ' + V2_BOOK_TEXT + '; '
  + '`longOi` is the same five with every contract held long; putMinusCallDeltaBalance (USD, underlying-equivalent) is the '
  + 'same in every view. `coverage` lists only the numbers that are not complete: partial is the sum of the legs included '
  + '(legs short, not an error bound), unavailable is null. charmBasis "cash" is charm on the cash price, "fixed reference" '
  + 'on the forward or future held fixed. `exposuresCommon`, where sent, holds the exposure fields every entry shares, sent once. '
  + '`levels`, where sent, are the gamma-derived levels, each with its own window, none derived from this book.';
