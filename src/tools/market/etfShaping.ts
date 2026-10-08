/**
 * The `etf` block of get_company_profile (phase C): fund facts, the latest holdings file as reported, weights, with
 * the server's notes. A withheld group (its stored identity no longer the fund's) omits its fields and says why. Key
 * names are camelCase; values carry no vendor name. The paged `holdings` list trims ITSELF to the byte budget and
 * sets its meta from what it keeps, so the response guard never cuts a list behind a meta that still says 100.
 */
import { MAX_RESPONSE_BYTES, sanitizeMcpWireOutput, utf8ByteLength } from '../helpers.js';
import { RESPONSE_MARGIN_BYTES } from './dealerPositioningShaping.js';

export const ETF_READ_FAILED = Symbol('etf read failed');
const BASIS: Record<string, string> = { direct: 'direct', count_mismatch: 'countMismatch', unknown: 'unknown' };
const ETF_NOTE = "Holdings, shares, value and weight are as reported in the fund's latest file; holdingsUpdated is the data source's update of that file, not the date of the positions. shares is null where the file gives no count (it writes 0 beside a value there). matchKind 'security' means the line reports a position in that ticker's listed security; 'unconfirmed' means the line names the company but the security could not be confirmed.";

export function holdingRow(l: any): Record<string, unknown> {
  const row: Record<string, unknown> = {
    rank: l.rank, name: l.name ?? null, symbol: l.symbol ?? null, reportedTicker: l.reportedTicker ?? null,
    linkBasis: l.linkBasis ?? null, matchKind: l.matchKind ?? null, weightPct: l.weightPct ?? null, shares: l.shares ?? null, marketValue: l.marketValue ?? null,
  };
  if (Array.isArray(l.splitWarnings) && l.splitWarnings.length > 0) row.splitWarnings = l.splitWarnings.map((w: any) => ({ date: w.date, ratio: w.ratio }));
  if (l.linkWithheld) { row.linkWithheld = true; row.withheldNote = l.withheldNote ?? null; }
  return row;
}

export function shapeEtfBlock(view: unknown): Record<string, unknown> {
  if (view === ETF_READ_FAILED) return { etf: null, etfStatus: 'Fund data could not be read right now.' };
  if (!view || typeof view !== 'object') return {};
  const v = view as any;
  const h = v.holdings ?? {};
  const etf: Record<string, unknown> = {};
  if (v.facts) {
    const f = v.facts;
    etf.facts = { expenseRatioPct: f.expenseRatioPct ?? null, aum: f.aum ?? null, nav: f.nav ?? null, navCurrency: f.navCurrency ?? null, factsSourceUpdatedAt: v.factsSourceUpdatedAt ?? null, inceptionDate: f.inceptionDate ?? null, issuer: f.issuer ?? null, assetClass: f.assetClass ?? null, domicile: f.domicile ?? null };
    if (v.sectorWeights) etf.sectorWeights = v.sectorWeights;
  } else if (v.notes?.factsWithheld) { etf.factsStatus = 'withheld'; etf.factsNote = v.notes.factsWithheld; }
  if (v.countryWeights) etf.countryWeights = v.countryWeights;
  else if (v.notes?.countryWithheld) { etf.countryStatus = 'withheld'; etf.countryNote = v.notes.countryWithheld; }
  if (h.status === 'ok') {
    Object.assign(etf, {
      holdingsInFile: h.total ?? null, holdingsBasis: BASIS[h.basis] ?? null,
      basisEvidence: { fundReportedHoldings: h.basisCount ?? null, countReadOn: h.basisCountReadOn ?? null, inherited: h.basisInherited === true, anchorLines: h.basisAnchorLines ?? null },
      basisNote: v.notes?.basis ?? null, holdingsUpdated: h.updatedOn ?? null, holdingsReadAt: h.fetchedAt ?? null,
      topHoldings: (Array.isArray(v.lines) ? v.lines : []).slice(0, 10).map(holdingRow), quantitiesNote: v.notes?.asReported ?? null,
    });
    if (v.notes?.overdue) etf.overdueNote = v.notes.overdue;
    if (v.notes?.sourceStale) etf.sourceStaleNote = v.notes.sourceStale;
  } else if (h.status === 'withheld') { etf.holdingsStatus = 'withheld'; etf.holdingsNote = v.notes?.fileWithheld ?? null; }
  else etf.holdingsStatus = 'No holdings file on record.';
  etf.etfNote = ETF_NOTE;
  return { etf };
}

const fits = (payload: unknown) => utf8ByteLength(JSON.stringify(sanitizeMcpWireOutput(payload))) <= MAX_RESPONSE_BYTES - RESPONSE_MARGIN_BYTES;

/** The etf block's file fields: what a later read that finds the file withheld or gone takes out. */
const FILE_GROUP = ['holdingsInFile', 'holdingsBasis', 'basisEvidence', 'basisNote', 'holdingsUpdated', 'holdingsReadAt', 'topHoldings', 'quantitiesNote', 'overdueNote', 'sourceStaleNote'];

/** The etf block without its file group, with the status (and note) a later read gave the file; facts and country
 * weights - groups of their own - stay. */
export function withoutFileGroup(block: Record<string, unknown>, status: string, note?: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(block)) if (!FILE_GROUP.includes(k)) out[k] = v;
  out.holdingsStatus = status;
  if (note !== undefined) out.holdingsNote = note;
  return out;
}

/** `base` plus a page of the latest file (`holdings`) and `holdingsMeta`, trimmed to the byte budget (a budgetNote says
 * so). `etfReadAt`: the etf block's file read time; a page from another read says which is newer. When not one row fits
 * beside `base`, nextOffset stays where it was. */
export function fitHoldingsPage(base: Record<string, unknown>, page: any, req: { offset: number; limit: number }, etfReadAt?: string | null): Record<string, unknown> {
  const all = (Array.isArray(page?.lines) ? page.lines : []).map(holdingRow);
  const h = page?.holdings ?? {};
  const kept = typeof h.kept === 'number' ? h.kept : null;
  const end = Math.min(kept ?? 100, 100);
  const readAt = page?.holdingsFetchedAt ?? null;
  let fileNote: string | null = null;
  if (etfReadAt && readAt && etfReadAt !== readAt) {
    const pa = Date.parse(readAt);
    const ea = Date.parse(etfReadAt);
    const rel = pa > ea ? 'a newer' : pa < ea ? 'an older' : 'a different';
    fileNote = `This page was read from ${rel} holdings file than \`etf\` (this page's file read at ${readAt}, etf's at ${etfReadAt}); totalInFile and holdingsReadAt here describe this page's file.`;
  }
  const shape = (b: Record<string, unknown>, rows: Record<string, unknown>[], budgetNote?: string) => ({
    ...b,
    holdings: rows,
    holdingsMeta: {
      offset: req.offset, limit: req.limit, returned: rows.length, kept, totalInFile: h.total ?? null,
      holdingsReadAt: readAt, order: 'by weight',
      nextOffset: req.offset + rows.length < end ? req.offset + rows.length : null,
      ...(fileNote ? { fileNote } : {}),
      ...(budgetNote ? { budgetNote } : {}),
    },
  });
  let rows = all;
  let payload = shape(base, rows);
  while (rows.length > 0 && !fits(payload)) { rows = rows.slice(0, rows.length > 20 ? rows.length - Math.ceil(rows.length / 10) : rows.length - 1); payload = shape(base, rows); }
  // Any trim says so. No row fitting keeps nextOffset at the offset asked (shape's rule with no rows).
  if (rows.length === 0 && all.length > 0) payload = shape(base, [], 'No holdings row fits beside the rest of this answer; ask again without full=true.');
  else if (rows.length < all.length) payload = shape(base, rows, 'Fewer rows than asked, to fit the response; continue from nextOffset.');
  return payload;
}
