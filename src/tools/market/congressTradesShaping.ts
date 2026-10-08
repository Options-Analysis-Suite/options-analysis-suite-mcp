/**
 * get_congress_trades: the proxy's /congress-trades/:symbol and
 * /market/congress-trades (the Senate's and the House's periodic transaction
 * reports), shaped for a model. A transaction is one however many reports list
 * it, dated by its first disclosure; amounts stay ranges; the party is the
 * member's on the trade date. Nothing missing reads as zero.
 */

import { MAX_RESPONSE_BYTES, sanitizeMcpWireOutput, utf8ByteLength } from '../helpers.js';
import { RESPONSE_MARGIN_BYTES } from './dealerPositioningShaping.js';

type Row = Record<string, any>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
/** A long free-text field cut to `n` characters (a report's comment runs to ~300, a security's name to ~180), so 50 trades usually fit the response budget. */
const clip = (v: unknown, n: number): string | null => {
  const s = text(v);
  return s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};

export const CONGRESS_NOTE = 'From the periodic transaction reports members of the Senate and the House file under the STOCK Act, for themselves, their spouses and their dependent children, within 45 days of a trade (some file later; `disclosureLagDays` is negative when a report is dated before the trade, as filed). '
  + 'Amounts are the ranges the reports give (`amountRange`: min and max in dollars, max null for an open-ended "Over" range; min equals max when a report gives an exact amount), so counts are of transactions, not dollars. '
  + 'A transaction a later report lists again (the same member, trade date, security, type, amount and owner, with the same note or one added or dropped, as an amended report re-lists its lines) is one transaction, dated by its first disclosure (`alsoInLaterReports` counts the later reports); within one report every line is its own transaction (identical trades in two accounts are two), a line repeated with the same reported details, however it spells the member\'s name, is counted once (on the busiest disclosure days a line the source later corrects or withdraws can stay beside the corrected one), and a later line that differs in any of those fields or carries another note is another transaction. '
  + '`party` is the member\'s on the trade date from public congressional records (`caucus` when an independent caucuses with a party; none when the member held no seat that day). '
  + 'A trade is listed under the company that traded under its ticker on the trade date (`symbol`; `symbolFiled` when the report gave another), so a renamed company keeps its trades and a reused ticker does not take another company\'s; from `tickersDatedFrom` this is matched by the security that traded under the ticker that day, unless the report describes another company of ours (then that company when it once traded under the ticker, else none), before then only when the report\'s description of the security is the company\'s name. A trade in a security without a ticker of ours (bonds, funds, private stock) has `symbol` null and the report\'s `asset`. '
  + '`coverage` gives the disclosures on file per chamber (the House\'s reach back less far than the Senate\'s).';

const NO_RECORD = 'No Congress trades on record for this symbol.';
const NO_DATA = 'No Congress trade data on record yet.';

export function noCongressRecord(symbol: string): Record<string, unknown> {
  return { symbol, congressStatus: NO_RECORD };
}

const PARTY: Record<string, string> = { Democrat: 'D', Republican: 'R', Independent: 'I', Libertarian: 'L' };

function trade(t: Row): Record<string, unknown> {
  const m = t.member && typeof t.member === 'object' ? t.member : {};
  const filings = Array.isArray(t.filings) ? t.filings.filter((f: Row) => typeof f?.url === 'string') : [];
  const party = text(m.party);
  const caucus = text(m.caucus);
  const seat = [text(m.state), t.chamber === 'house' ? text(m.district) : null].filter(Boolean).join('-');
  return {
    member: text(m.name) ?? text(m.id),
    memberId: text(m.id),
    party,
    ...(caucus && caucus !== party ? { caucus } : {}),
    chamber: t.chamber === 'senate' ? 'Senate' : 'House',
    seat: seat || null,
    label: party || seat ? `${PARTY[party ?? ''] ?? party ?? ''}${party && seat ? '-' : ''}${seat}` : null,
    symbol: text(t.symbol),
    ...(text(t.symbolFiled) && t.symbolFiled !== t.symbol ? { symbolFiled: t.symbolFiled } : {}),
    asset: clip(t.asset, 140),
    assetType: text(t.assetType),
    type: t.type === 'receive' ? 'Received' : text(t.type),
    owner: text(t.owner),
    amountRange: { text: text(t.amount?.text), min: num(t.amount?.min), max: num(t.amount?.max) },
    tradeDate: text(t.transactionDate),
    disclosedDate: text(t.disclosedDate),
    disclosureLagDays: num(t.lagDays),
    report: filings[0]?.url ?? null,
    ...(filings.length > 1 ? { alsoInLaterReports: filings.length - 1 } : {}),
    ...(text(t.comment) ? { comment: clip(t.comment, 200) } : {}),
  };
}

function coverageOf(rows: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(rows) ? rows : []).filter((c: Row) => c?.chamber === 'senate' || c?.chamber === 'house').map((c: Row) => ({
    chamber: c.chamber === 'senate' ? 'Senate' : 'House',
    disclosuresFrom: text(c.firstDisclosure),
    disclosuresThrough: text(c.newestDisclosure),
    lastRead: text(c.lastReadAt),
  }));
}

const datedFrom = (rows: unknown): string | null => (Array.isArray(rows) ? rows : [])
  .map((c: Row) => text(c?.tickersDatedFrom)).filter((d): d is string => !!d).sort()[0] ?? null;

function summaryOf(s: Row | null | undefined): Record<string, unknown> | null {
  if (!s || typeof s !== 'object') return null;
  return {
    transactions: num(s.transactions) ?? 0,
    purchases: num(s.purchases) ?? 0,
    sales: num(s.sales) ?? 0,
    other: num(s.other) ?? 0,
    members: num(s.members) ?? 0,
    senate: num(s.senate) ?? 0,
    house: num(s.house) ?? 0,
    ...(s.firstTrade !== undefined ? { firstTrade: text(s.firstTrade) } : {}),
    ...(s.lastTrade !== undefined ? { lastTrade: text(s.lastTrade) } : {}),
    ...(s.lastDisclosed !== undefined ? { lastDisclosed: text(s.lastDisclosed) } : {}),
    ...(s.matched !== undefined ? { matchedToCompanies: num(s.matched) ?? 0 } : {}),
  };
}

const TRIMMED_NOTE = 'The trades asked for did not all fit the response size: these are the newest `returned` of them (a smaller `limit` gives fewer of the same; there is no paging), and the totals in `summary` count every transaction.';

/**
 * The shared size guard trims a long list to five and replaces tradesMeta with
 * its own, losing the totals and the order: the last trades listed go here
 * instead, until the published answer fits (long names, comments and links
 * can outgrow the cuts above).
 */
function fitted(trades: Array<Record<string, unknown>>, shape: (trades: Array<Record<string, unknown>>, trimmed: boolean) => Record<string, unknown>): Record<string, unknown> {
  const fits = (out: unknown) => utf8ByteLength(JSON.stringify(sanitizeMcpWireOutput(out))) <= MAX_RESPONSE_BYTES - RESPONSE_MARGIN_BYTES;
  let kept = trades;
  let out = shape(kept, false);
  while (kept.length > 0 && !fits(out)) {
    kept = kept.slice(0, -1);
    out = shape(kept, true);
  }
  return out;
}

/** One company's transactions: totals over all of them, the newest `limit`. */
export function shapeCongressTrades(payload: unknown, opts: { limit?: number } = {}): Record<string, unknown> {
  const data = payload && typeof payload === 'object' ? payload as Row : null;
  const trades = (Array.isArray(data?.trades) ? data!.trades as Row[] : []).filter(t => t && typeof t === 'object' && typeof t.disclosedDate === 'string');
  const symbol = text(data?.symbol);
  if (!data || trades.length === 0) return { symbol, congressStatus: NO_RECORD };
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 50));
  const summary = summaryOf(data.summary);
  const onFile = num(summary?.transactions) ?? trades.length;
  return fitted(trades.slice(0, limit).map(trade), (shown, trimmed) => ({
    symbol,
    summary,
    trades: shown,
    tradesMeta: {
      returned: shown.length,
      onFile,
      order: 'newest trade first',
      ...(trimmed ? { trimmedForSize: true, note: TRIMMED_NOTE }
        : shown.length < onFile ? { note: 'The totals in `summary` count every transaction on file; ask for more with `limit` (up to 50).' } : {}),
    },
    coverage: coverageOf(data.coverage),
    tickersDatedFrom: datedFrom(data.coverage),
    congressNote: CONGRESS_NOTE,
  }));
}

/** Trades first disclosed in a window across companies: totals, the companies traded most, the newest disclosures. */
export function shapeMarketCongressTrades(payload: unknown, opts: { limit?: number } = {}): Record<string, unknown> {
  const data = payload && typeof payload === 'object' ? payload as Row : null;
  if (!data) return { scope: 'market', congressStatus: NO_DATA };
  const trades = (Array.isArray(data.trades) ? data.trades as Row[] : []).filter(t => t && typeof t === 'object' && typeof t.disclosedDate === 'string');
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 50));
  const summary = summaryOf(data.summary);
  const inWindow = num(summary?.transactions) ?? trades.length;
  return fitted(trades.slice(0, limit).map(trade), (shown, trimmed) => ({
    scope: 'market',
    window: { days: num(data.days), from: text(data.from), through: text(data.asOf), firstDisclosedOnly: true },
    chamber: data.chamber === 'senate' ? 'Senate' : data.chamber === 'house' ? 'House' : 'both',
    kind: text(data.kind),
    summary,
    topCompanies: (Array.isArray(data.topSymbols) ? data.topSymbols : []).filter((r: Row) => typeof r?.symbol === 'string').map((r: Row) => ({
      symbol: r.symbol, transactions: num(r.transactions), purchases: num(r.purchases), sales: num(r.sales), members: num(r.members),
    })),
    trades: shown,
    tradesMeta: {
      returned: shown.length,
      inWindow,
      order: 'newest disclosure first',
      ...(trimmed ? { trimmedForSize: true, note: TRIMMED_NOTE }
        : shown.length < inWindow ? { note: 'The totals in `summary` count every transaction first disclosed in the window; ask for more with `limit` (up to 50), or narrow `days`, `chamber` or `kind`.' } : {}),
    },
    coverage: coverageOf(data.coverage),
    tickersDatedFrom: datedFrom(data.coverage),
    congressNote: CONGRESS_NOTE,
  }));
}
