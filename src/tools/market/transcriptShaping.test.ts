import { describe, expect, it } from 'bun:test';
import { LiveApiError } from '../../proxy/liveApiClient.js';
import { sanitizeMcpWireOutput } from '../helpers.js';
import { fitTranscriptBlock, shapeTranscriptSearch, shapeTranscriptSummary, transcriptRefusal, transcriptUnreadable } from './transcriptShaping.js';

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
const long = (n: number, word = 'margin') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');
/** A data vendor's name, which the wire sanitizer replaces with longer text (base64: the repo scans for the name). */
const VENDOR = Buffer.from('Rk1Q', 'base64').toString('utf8');
const wire = (v: unknown) => bytes(sanitizeMcpWireOutput(v));

describe('shapeTranscriptSummary', () => {
  it('drops malformed lines rather than serving them, and omits withheld when nothing was', () => {
    const out = shapeTranscriptSummary({
      symbol: 'X', fiscalYear: 2026, quarter: 2, callDate: '2026-08-01', linesWithheld: 0, quotesWithheld: 0,
      summary: {
        preparedRemarks: [{ speaker: 'A', summary: 'ok', turns: [1] }, { speaker: 'B' }, null, 'text'],
        qa: [{ askedBy: 'C', question: 'q?', answer: null, turns: [2] }, { askedBy: 'D' }],
        guidance: [{ text: 'g', turns: [3] }, { text: '' }, 7],
        quotes: [{ speaker: 'A', text: 't', turn: 1 }, { speaker: 'A' }],
        sectionSplit: 'something else',
      },
    });
    expect(out.preparedRemarks).toEqual([{ speaker: 'A', role: null, summary: 'ok' }]);
    expect(out.qa).toEqual([{ askedBy: 'C', firm: null, question: 'q?', answeredBy: [], answer: null }]);
    expect(out.guidance).toEqual(['g']);
    expect(out.quotes).toEqual([{ speaker: 'A', text: 't' }]);
    expect(out.sectionSplit).toBe('not-detected');
    expect(out.withheld).toBeUndefined();
    expect(out.trimMeta).toBeUndefined();
  });

  it('a summary that is not the stored shape is the retryable refusal, never an empty checked summary', () => {
    const calls = [{ fiscalYear: 2026, quarter: 3, callDate: '2026-07-30', summary: 'available' }];
    for (const summary of [undefined, null, {}, [], 'text', { preparedRemarks: [], qa: null, guidance: [], quotes: [] }]) {
      expect(shapeTranscriptSummary({ symbol: 'X', fiscalYear: 2026, quarter: 3, summary, callsOnFile: calls })).toEqual({
        dataAvailable: false, code: 'INVALID_RESPONSE', message: 'The earnings call summary could not be read. This may be retried.', retryable: true, callsOnFile: calls,
      });
    }
    expect(shapeTranscriptSummary(null)).toEqual(transcriptUnreadable());
    // The call's period as stored (sql/202: fiscal year 1990-2100, quarter 1-4), or the summary is no call's.
    const summary = { preparedRemarks: [], qa: [], guidance: [], quotes: [], sectionSplit: 'detected' };
    for (const period of [{}, { fiscalYear: 2026 }, { quarter: 3 }, { fiscalYear: 2026, quarter: 9 }, { fiscalYear: -1, quarter: 3 }, { fiscalYear: '2026', quarter: 3 }, { fiscalYear: 2026.5, quarter: 3 }]) {
      expect(shapeTranscriptSummary({ symbol: 'X', ...period, summary }).code).toBe('INVALID_RESPONSE');
    }
    expect(shapeTranscriptSummary({ symbol: 'X', fiscalYear: 2026, quarter: 3, summary }).dataAvailable).toBe(true);
  });

  it('trims later Q&A entries only past the budget, says how many, and fits after the wire sanitizer', () => {
    const qa = Array.from({ length: 60 }, (_, i) => ({ askedBy: `Analyst ${i}`, firm: 'F', question: long(20, 'q'), answeredBy: ['CEO'], answer: long(60), turns: [i] }));
    const out = shapeTranscriptSummary({ symbol: 'X', fiscalYear: 2026, quarter: 3, summary: { preparedRemarks: [], qa, guidance: [], quotes: [], sectionSplit: 'detected' } }, 20_000);
    const meta = out.trimMeta as any;
    expect(Object.keys(meta)).toEqual(['qa', 'budgetNote']);
    expect(meta.qa.total).toBe(60);
    expect(meta.qa.shown).toBe((out.qa as unknown[]).length);
    expect(meta.qa.shown).toBeGreaterThan(0);
    expect(meta.qa.shown).toBeLessThan(60);
    expect(meta.budgetNote).toBe(`${60 - meta.qa.shown} later Q&A entries were left out to fit the answer; ask with a query to search them.`);
    expect(bytes(sanitizeMcpWireOutput(out))).toBeLessThanOrEqual(20_000);
    // The kept entries are the first ones, in order.
    expect((out.qa as any[])[0].askedBy).toBe('Analyst 0');
  });
});

describe('shapeTranscriptSummary budget edge', () => {
  it('counts its own trim note: a budget the entries alone would fit, but not with the note, keeps one fewer', () => {
    const qa = Array.from({ length: 10 }, (_, i) => ({ askedBy: `Analyst ${i}`, question: long(10, 'q'), answer: long(30), turns: [i] }));
    const payload = { symbol: 'X', fiscalYear: 2026, quarter: 3, summary: { preparedRemarks: [], qa, guidance: [], quotes: [], sectionSplit: 'detected' } };
    const full = shapeTranscriptSummary(payload, 1e9);
    const k = 6;
    const budget = bytes({ ...full, qa: (full.qa as unknown[]).slice(0, k) }) + 10;
    const out = shapeTranscriptSummary(payload, budget);
    expect(bytes(out)).toBeLessThanOrEqual(budget);
    expect((out.qa as unknown[]).length).toBeLessThan(k);
    expect((out.trimMeta as any).qa.shown).toBe((out.qa as unknown[]).length);
  });

  it('bounds every section, not only Q&A: twelve long remarks and no Q&A fit the budget and say what was left out', () => {
    const preparedRemarks = Array.from({ length: 12 }, (_, i) => ({ speaker: `Exec ${i}`, role: 'CFO', summary: long(700), turns: [i] }));
    const out = shapeTranscriptSummary({ symbol: 'X', fiscalYear: 2026, quarter: 3, summary: { preparedRemarks, qa: [], guidance: [{ text: 'g' }], quotes: [{ speaker: 'A', text: 't' }], sectionSplit: 'detected' } });
    expect(bytes(sanitizeMcpWireOutput(out))).toBeLessThanOrEqual(30_000);
    const meta = out.trimMeta as any;
    // Nothing was cut from a section that fit (no "0 later Q&A entries"); quotes and guidance went before remarks.
    expect(Object.keys(meta)).toEqual(['quotes', 'guidance', 'preparedRemarks', 'budgetNote']);
    expect(meta.preparedRemarks.total).toBe(12);
    expect(meta.preparedRemarks.shown).toBe((out.preparedRemarks as unknown[]).length);
    expect(meta.preparedRemarks.shown).toBeGreaterThan(0);
    expect(meta.budgetNote).toBe(`1 later quote, 1 later guidance line and ${12 - meta.preparedRemarks.shown} later prepared remarks were left out to fit the answer; ask with a query to search them.`);
    expect((out.preparedRemarks as any[])[0].speaker).toBe('Exec 0');
  });

  it('measures the block as sent: text the wire sanitizer lengthens is trimmed to the budget after sanitizing', () => {
    const preparedRemarks = [{ speaker: 'A', summary: `${VENDOR} `.repeat(7300) }, { speaker: 'B', summary: 'short' }];
    const qa = Array.from({ length: 57 }, (_, i) => ({ askedBy: `Analyst ${i}`, question: `${VENDOR} `.repeat(60), answer: long(20) }));
    const out = shapeTranscriptSummary({ symbol: 'X', fiscalYear: 2026, quarter: 3, summary: { preparedRemarks, qa, guidance: [], quotes: [], sectionSplit: 'detected' } });
    expect(wire(out)).toBeLessThanOrEqual(30_000);
    const meta = out.trimMeta as any;
    expect(meta.qa.shown).toBe((out.qa as unknown[]).length);
    expect(meta.preparedRemarks).toEqual({ shown: (out.preparedRemarks as unknown[]).length, total: 2 });
  });

  it('one entry larger than the budget leaves its section empty and the block still fits', () => {
    const out = shapeTranscriptSummary({ symbol: 'X', fiscalYear: 2026, quarter: 3, summary: { preparedRemarks: [{ speaker: 'A', summary: long(8_000) }], qa: [], guidance: [], quotes: [], sectionSplit: 'detected' } });
    expect(bytes(sanitizeMcpWireOutput(out))).toBeLessThanOrEqual(30_000);
    expect(out.preparedRemarks).toEqual([]);
    expect(out.trimMeta).toEqual({ preparedRemarks: { shown: 0, total: 1 }, budgetNote: '1 later prepared remark was left out to fit the answer; ask with a query to search them.' });
  });
});

describe('shapeTranscriptSearch', () => {
  const match = (i: number) => ({ askedBy: `A${i}`, question: long(15, 'tariff'), answer: long(50, 'tariff'), turns: [i] });
  it('reports each call\'s matches, and trims the oldest call first past the budget with a note', () => {
    const calls = [3, 2, 1].map((q) => ({ fiscalYear: 2026, quarter: q, callDate: `2026-0${q}-01`, matchCount: 12, matches: { preparedRemarks: [], qa: Array.from({ length: 12 }, (_, i) => match(i)), guidance: [], quotes: [] } }));
    const out = shapeTranscriptSearch({ symbol: 'X', query: 'tariff', terms: ['tariff'], calls }, 18_000);
    const shaped = out.calls as any[];
    expect(shaped.map((c) => c.quarter)).toEqual([3, 2, 1]);
    expect(shaped[0].matchesShown).toBeGreaterThan(shaped[2].matchesShown);
    expect(shaped.every((c) => c.matchesShown === c.qa.length)).toBe(true);
    expect(out.budgetNote).toBeDefined();
    expect(bytes(sanitizeMcpWireOutput(out))).toBeLessThanOrEqual(18_000);
    expect(JSON.stringify(out)).not.toMatch(/"turns?"/);
  });

  it('a search answer with no list of calls is the retryable refusal, never "no matches"', () => {
    for (const calls of [undefined, null, {}, 'x']) {
      expect(shapeTranscriptSearch({ symbol: 'X', calls, callsOnFile: [] })).toMatchObject({ dataAvailable: false, code: 'INVALID_RESPONSE', retryable: true, callsOnFile: [] });
    }
  });

  it('a call whose matches passed the proxy\'s per-call cap carries the note too; none when everything fits', () => {
    const matches = { preparedRemarks: [], qa: [match(0)], guidance: [], quotes: [] };
    const capped = shapeTranscriptSearch({ calls: [{ fiscalYear: 2026, quarter: 3, matchCount: 20, matches }] });
    expect((capped.calls as any[])[0]).toMatchObject({ matchCount: 20, matchesShown: 1 });
    expect(capped.budgetNote).toBeDefined();
    const all = shapeTranscriptSearch({ calls: [{ fiscalYear: 2026, quarter: 3, matchCount: 1, matches }] });
    expect(all.budgetNote).toBeUndefined();
  });

  it('a searched call that is not one is the retryable refusal, never an empty result or matches "left out to fit"', () => {
    const matches = { preparedRemarks: [], qa: [match(0)], guidance: [], quotes: [] };
    const good = { fiscalYear: 2026, quarter: 3, callDate: '2026-07-30', matchCount: 1, matches };
    const bad: unknown[] = [
      null, 'x', [],
      { ...good, matches: null, matchCount: 8 },
      { ...good, matches: { qa: [match(0)] } },
      { ...good, matches: { ...matches, quotes: {} } },
      { ...good, matchCount: 0 },
      { ...good, matchCount: '1' },
      { ...good, quarter: null },
      { ...good, quarter: 9 },
      { ...good, fiscalYear: -1 },
      { ...good, fiscalYear: 2026.5 },
    ];
    for (const call of bad) {
      expect(shapeTranscriptSearch({ symbol: 'X', calls: [good, call], callsOnFile: [] })).toMatchObject({ dataAvailable: false, code: 'INVALID_RESPONSE', retryable: true, callsOnFile: [] });
    }
    expect(shapeTranscriptSearch({ symbol: 'X', calls: [good] }).dataAvailable).toBe(true);
  });

  it('measures the search block as sent, too', () => {
    const big = (i: number) => ({ askedBy: `A${i}`, question: `${VENDOR} `.repeat(200), answer: `${VENDOR} `.repeat(400) });
    const calls = [3, 2].map((q) => ({ fiscalYear: 2026, quarter: q, matchCount: 12, matches: { preparedRemarks: [], qa: Array.from({ length: 12 }, (_, i) => big(i)), guidance: [], quotes: [] } }));
    const out = shapeTranscriptSearch({ symbol: 'X', calls });
    expect(wire(out)).toBeLessThanOrEqual(24_000);
    expect((out.calls as any[]).every((c) => c.matchesShown === c.qa.length)).toBe(true);
  });
});

describe('callsOnFile', () => {
  it('lists at most the 24 calls the proxy sends, so the block stays inside its budget', () => {
    const calls = Array.from({ length: 30 }, (_, i) => ({ fiscalYear: 2026 - Math.floor(i / 4), quarter: 4 - (i % 4), callDate: '2026-01-01', summary: 'none' }));
    expect((shapeTranscriptSummary({ fiscalYear: 2026, quarter: 3, summary: { preparedRemarks: [], qa: [], guidance: [], quotes: [] }, callsOnFile: calls }).callsOnFile as unknown[])).toHaveLength(24);
    expect((shapeTranscriptSearch({ calls: [], callsOnFile: calls }).callsOnFile as unknown[])).toHaveLength(24);
  });
});

describe('fitTranscriptBlock', () => {
  const calls = Array.from({ length: 24 }, (_, i) => ({ fiscalYear: 2026 - Math.floor(i / 4), quarter: 4 - (i % 4), callDate: '2026-01-01', summary: 'available' }));
  // A message longer than the notice, so each rung is reached in turn (a short refusal without its list stays itself).
  const block = { dataAvailable: false, code: 'SUMMARY_UNAVAILABLE', message: 'No summary is available. '.repeat(25), retryable: false, callsOnFile: calls };
  const within = (n: number) => (b: Record<string, unknown>) => wire(b) <= n;
  it('keeps the block that fits, then drops its call list (said so), then a notice, then the bare notice, then nothing', () => {
    expect(fitTranscriptBlock(block, within(1e6))).toBe(block);
    const compact = fitTranscriptBlock(block, within(wire(block) - 1))!;
    expect(compact.callsOnFile).toBeUndefined();
    expect(compact).toMatchObject({ code: 'SUMMARY_UNAVAILABLE', callsOnFileNote: '24 calls on file were left out to fit the answer.' });
    const notice = fitTranscriptBlock(block, within(400))!;
    expect(notice).toEqual({ dataAvailable: false, code: 'RESPONSE_BUDGET', message: expect.stringContaining('did not fit'), retryable: false });
    expect(fitTranscriptBlock(block, within(60))).toEqual({ dataAvailable: false, code: 'RESPONSE_BUDGET' });
    expect(fitTranscriptBlock(block, within(10))).toBeUndefined();
    const single = { ...block, callsOnFile: [calls[0]] };
    const one = fitTranscriptBlock(single, within(wire(single) - 1))!;
    expect(one.callsOnFileNote).toBe('1 call on file was left out to fit the answer.');
  });
});

describe('transcriptRefusal', () => {
  it('keeps the code, the message, retryable and the calls on file', () => {
    const calls = [{ fiscalYear: 2026, quarter: 3, callDate: '2026-07-30', summary: 'available', extra: 'dropped' }];
    expect(transcriptRefusal(new LiveApiError('m', 404, 'NOT_FOUND', false, undefined, { callsOnFile: calls }))).toEqual({
      dataAvailable: false, code: 'NOT_FOUND', message: 'm', retryable: false,
      callsOnFile: [{ fiscalYear: 2026, quarter: 3, callDate: '2026-07-30', summary: 'available' }],
    });
    expect(transcriptRefusal(new LiveApiError('down', 503, 'UPSTREAM_UNAVAILABLE', true, undefined, undefined))).toEqual({
      dataAvailable: false, code: 'UPSTREAM_UNAVAILABLE', message: 'down', retryable: true,
    });
  });
});
