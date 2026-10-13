import { LiveApiError } from '../../proxy/liveApiClient.js';
import { sanitizeMcpWireOutput, utf8ByteLength } from '../helpers.js';

/**
 * get_earnings `transcript`: the proxy's earnings call summary routes, shaped for a model. A summary is generated
 * from the call and checked against it, never the call's text; the answer says so on every path. Turn numbers (the
 * summary's links into the call) are dropped: the call itself is never served, so they point at nothing the
 * caller can read.
 */

export const SUMMARY_NOTE = 'A generated summary of the earnings call, not the transcript. It was checked against the call: every quote is word for word with its speaker, and every figure in it appears in the call. Each qa entry is one analyst question with the gist of the answers to it.';
export const WITHHELD_NOTE = 'Lines whose figures could not be found in the call, and quotes that were not word for word or whose speaker could not be confirmed, were left out.';
export const SEARCH_NOTE = 'Searches the generated summaries of the calls, not the transcripts: each entry is a summary line (or quote) that contains every query word. Ask without a query for a call\'s full summary.';
const SEARCH_BUDGET_NOTE = 'Where matchesShown is below matchCount, the remaining matches were left out to fit the answer; narrow the query or name one call with fiscalYear and quarter.';
const UNREADABLE_MESSAGE = 'The earnings call summary could not be read. This may be retried.';
const BUDGET_MESSAGE = 'The earnings call summary did not fit beside the rest of this answer. Ask for it again on its own (without includeMoves), or name one call with fiscalYear and quarter.';
/** The proxy lists at most this many calls; a longer list is cut so the block stays inside its budget. */
const MAX_CALLS_ON_FILE = 24;
/** Byte budgets for the block, inside the 50 KB answer beside the earnings history (and the moves); the handler lowers them to what is left. */
export const SUMMARY_BUDGET_BYTES = 30_000;
export const SEARCH_BUDGET_BYTES = 24_000;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
/** Measured as sent: the wire sanitizer can lengthen text (a vendor's name is replaced), so the budget counts its output. */
const bytes = (v: unknown) => utf8ByteLength(JSON.stringify(sanitizeMcpWireOutput(v)));

function remark(item: any) {
  const summary = str(item?.summary);
  return summary ? { speaker: str(item?.speaker), role: str(item?.role), summary } : null;
}
function exchange(item: any) {
  const question = str(item?.question);
  const answer = str(item?.answer);
  if (!question && !answer) return null;
  return {
    askedBy: str(item?.askedBy),
    firm: str(item?.firm),
    question,
    answeredBy: Array.isArray(item?.answeredBy) ? item.answeredBy.map(str).filter(Boolean) : [],
    answer,
  };
}
const guidanceLine = (item: any) => str(item?.text);
function quote(item: any) {
  const text = str(item?.text);
  return text ? { speaker: str(item?.speaker), text } : null;
}
const present = <T>(list: unknown, shape: (item: any) => T | null): T[] => (Array.isArray(list) ? list.map(shape).filter((x): x is T => x !== null) : []);

function callsOnFile(list: unknown) {
  return Array.isArray(list)
    ? list.filter((c) => c && typeof c === 'object').slice(0, MAX_CALLS_ON_FILE).map((c: any) => ({ fiscalYear: c.fiscalYear ?? null, quarter: c.quarter ?? null, callDate: c.callDate ?? null, summary: c.summary ?? null }))
    : [];
}

/** A read of the summary routes that answered no usable body: the retryable refusal, never an empty summary. */
export function transcriptUnreadable(callsOnFileList?: unknown): Record<string, unknown> {
  return {
    dataAvailable: false,
    code: 'INVALID_RESPONSE',
    message: UNREADABLE_MESSAGE,
    retryable: true,
    ...(Array.isArray(callsOnFileList) ? { callsOnFile: callsOnFile(callsOnFileList) } : {}),
  };
}

const SECTIONS = ['preparedRemarks', 'qa', 'guidance', 'quotes'] as const;
type Section = (typeof SECTIONS)[number];
/** A call's fiscal period as sql/202 stores it. */
const isPeriod = (fiscalYear: unknown, quarter: unknown) =>
  Number.isInteger(fiscalYear) && (fiscalYear as number) >= 1990 && (fiscalYear as number) <= 2100
  && Number.isInteger(quarter) && (quarter as number) >= 1 && (quarter as number) <= 4;
/** Trimmed in this order when the block passes its budget, each from its end: Q&A first, prepared remarks last. */
const TRIM_ORDER: readonly Section[] = ['qa', 'quotes', 'guidance', 'preparedRemarks'];
const SECTION_LABEL: Record<Section, [string, string]> = {
  preparedRemarks: ['prepared remark', 'prepared remarks'],
  qa: ['Q&A entry', 'Q&A entries'],
  guidance: ['guidance line', 'guidance lines'],
  quotes: ['quote', 'quotes'],
};

function trimNote(cut: Array<[Section, number]>): string {
  const parts = cut.map(([section, n]) => `${n} later ${SECTION_LABEL[section][n === 1 ? 0 : 1]}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `${list} ${cut.length === 1 && cut[0][1] === 1 ? 'was' : 'were'} left out to fit the answer; ask with a query to search them.`;
}

/**
 * One call's summary. Only if the block would pass its budget, entries are trimmed from the end of each section in
 * TRIM_ORDER, and `trimMeta` says how many of each were kept and left out.
 */
export function shapeTranscriptSummary(payload: unknown, budget = SUMMARY_BUDGET_BYTES): Record<string, unknown> {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, any>;
  const s = p.summary;
  // The stored shape (the call's period, every section a list): anything else is a malformed answer, never an empty
  // checked summary.
  if (!isPeriod(p.fiscalYear, p.quarter) || !s || typeof s !== 'object' || Array.isArray(s) || !SECTIONS.every((section) => Array.isArray(s[section]))) {
    return transcriptUnreadable(p.callsOnFile);
  }
  const full: Record<Section, unknown[]> = {
    preparedRemarks: present(s.preparedRemarks, remark),
    qa: present(s.qa, exchange),
    guidance: present(s.guidance, guidanceLine),
    quotes: present(s.quotes, quote),
  };
  const linesWithheld = Number(p.linesWithheld) || 0;
  const quotesWithheld = Number(p.quotesWithheld) || 0;
  const block: Record<string, unknown> = {
    dataAvailable: true,
    kind: 'summary',
    symbol: p.symbol ?? null,
    fiscalYear: p.fiscalYear ?? null,
    quarter: p.quarter ?? null,
    callDate: p.callDate ?? null,
    note: SUMMARY_NOTE,
    sectionSplit: s.sectionSplit === 'detected' ? 'detected' : 'not-detected',
    ...full,
    ...(linesWithheld || quotesWithheld ? { withheld: { lines: linesWithheld, quotes: quotesWithheld, note: WITHHELD_NOTE } } : {}),
    generatedAt: p.generatedAt ?? null,
    callsOnFile: callsOnFile(p.callsOnFile),
  };
  if (bytes(block) <= budget) return block;
  const shown: Record<Section, unknown[]> = { ...full };
  // Measured with the meta it carries, so the answer fits as sent.
  const trimmed = (): Record<string, unknown> => {
    const cut = TRIM_ORDER.filter((section) => shown[section].length < full[section].length);
    if (cut.length === 0) return block;
    return {
      ...block,
      ...shown,
      trimMeta: {
        ...Object.fromEntries(cut.map((section) => [section, { shown: shown[section].length, total: full[section].length }])),
        budgetNote: trimNote(cut.map((section) => [section, full[section].length - shown[section].length])),
      },
    };
  };
  for (const section of TRIM_ORDER) {
    while (shown[section].length > 0 && bytes(trimmed()) > budget) shown[section] = shown[section].slice(0, -1);
    // A section emptied by the trim is cut, and the meta that says so can push the block over again: keep going.
    if (bytes(trimmed()) <= budget) break;
  }
  return trimmed();
}

/** One searched call as the proxy sends it: its quarter, every section a list, and a match count covering the list. */
function isSearchedCall(c: any): boolean {
  const m = c?.matches;
  if (!c || typeof c !== 'object' || Array.isArray(c) || !m || typeof m !== 'object' || Array.isArray(m)) return false;
  if (!SECTIONS.every((section) => Array.isArray(m[section]))) return false;
  const listed = SECTIONS.reduce((n, section) => n + m[section].length, 0);
  return isPeriod(c.fiscalYear, c.quarter) && Number.isInteger(c.matchCount) && c.matchCount >= listed;
}

/** Matching summary lines per call. Matches are trimmed from the oldest call's end first if over budget, and counted. */
export function shapeTranscriptSearch(payload: unknown, budget = SEARCH_BUDGET_BYTES): Record<string, unknown> {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, any>;
  // A search that answered no list of calls searched, or a call that is not one, is a malformed answer, never
  // "no matches" (nor matches "left out to fit").
  if (!Array.isArray(p.calls) || !p.calls.every(isSearchedCall)) return transcriptUnreadable(p.callsOnFile);
  const calls = p.calls.map((c: any) => ({
    fiscalYear: c?.fiscalYear ?? null,
    quarter: c?.quarter ?? null,
    callDate: c?.callDate ?? null,
    matchCount: Number(c?.matchCount) || 0,
    preparedRemarks: present(c?.matches?.preparedRemarks, remark),
    qa: present(c?.matches?.qa, exchange),
    guidance: present(c?.matches?.guidance, guidanceLine),
    quotes: present(c?.matches?.quotes, quote),
  }));
  const shownOf = (c: (typeof calls)[number]) => c.preparedRemarks.length + c.qa.length + c.guidance.length + c.quotes.length;
  const block = (note: boolean): Record<string, unknown> => ({
    dataAvailable: true,
    kind: 'search',
    symbol: p.symbol ?? null,
    query: p.query ?? null,
    terms: Array.isArray(p.terms) ? p.terms : [],
    note: SEARCH_NOTE,
    callsSearched: calls.length,
    calls: calls.map((c: (typeof calls)[number]) => ({ ...c, matchesShown: shownOf(c) })),
    callsOnFile: callsOnFile(p.callsOnFile),
    ...(note ? { budgetNote: SEARCH_BUDGET_NOTE } : {}),
  });
  // Measured with the note it will carry once anything is left out, so the answer fits as sent.
  for (let i = calls.length - 1; i >= 0 && bytes(block(true)) > budget; ) {
    const c = calls[i];
    const section = (['quotes', 'guidance', 'qa', 'preparedRemarks'] as const).find((k) => c[k].length > 0);
    if (!section) { i -= 1; continue; }
    (c[section] as unknown[]).pop();
  }
  return block(calls.some((c: (typeof calls)[number]) => shownOf(c) < c.matchCount));
}

/**
 * The block (a summary, a search or a refusal) as the answer can carry it, `fits` measuring the whole answer as the
 * 50 KB guard does: the block; else the block without its call list, said so; else a notice that it did not fit;
 * else the bare notice. Undefined only when even the bare notice would not fit - the history and the moves alone
 * then fill the answer, and they are what is kept (the guard would otherwise replace the whole answer).
 */
export function fitTranscriptBlock(block: Record<string, unknown>, fits: (block: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  if (fits(block)) return block;
  if (Array.isArray(block.callsOnFile) && block.callsOnFile.length > 0) {
    const { callsOnFile: list, ...rest } = block;
    const n = (list as unknown[]).length;
    // Shorter than any one entry it replaces, so dropping the list always saves room.
    const compact = { ...rest, callsOnFileNote: `${n} ${n === 1 ? 'call on file was' : 'calls on file were'} left out to fit the answer.` };
    if (fits(compact)) return compact;
  }
  const notices: Array<Record<string, unknown>> = [
    { dataAvailable: false, code: 'RESPONSE_BUDGET', message: BUDGET_MESSAGE, retryable: false },
    { dataAvailable: false, code: 'RESPONSE_BUDGET' },
  ];
  return notices.find(fits);
}

/**
 * A refusal of the summary routes, reported in the answer beside the earnings history (never in place of it). A plan
 * without the summaries (PRO_TIER_REQUIRED) keeps the upgrade link as `actionUrl`, the key every other Pro refusal
 * carries; the wire sanitizer drops a vendor's page, as the error path does.
 */
export function transcriptRefusal(error: LiveApiError): Record<string, unknown> {
  const calls = error.details?.callsOnFile;
  return {
    dataAvailable: false,
    code: error.code ?? null,
    message: error.message,
    retryable: error.retryable ?? null,
    ...(error.actionUrl ? { actionUrl: error.actionUrl } : {}),
    ...(Array.isArray(calls) ? { callsOnFile: callsOnFile(calls) } : {}),
  };
}
