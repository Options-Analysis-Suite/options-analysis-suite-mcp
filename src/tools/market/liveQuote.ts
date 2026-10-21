import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveApiClient, LiveRateLimit } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { rateLimitGuide, type Guide } from '../liveGuide.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { significantDeep } from './dealerPositioningShaping.js';

/**
 * The underlying's quote now, from the proxy's /live/quote route: the one
 * tool that answers "what is SPY trading at right now" with the session's
 * open, high and low beside it. The live chain carries a spot at fetch time
 * and no session range; this carries the broker's own quote clocks.
 */
export function register(server: McpServer, client: LiveApiClient): void {
  server.registerTool(
    'get_live_quote',
    {
      title: 'Live Quote',
      description:
        'Get a LIVE quote for one underlying (a stock, ETF or index such as SPX or VIX), fetched in real time from the broker credential stored on your Options Analysis Suite account (`provider` names the broker): last, bid, ask, bid and ask sizes, mid, the broker\'s mark, the session\'s open, high and low, the previous close, volume, the broker\'s quote and trade times, and the day change (`change` and `changePercent`: the broker\'s own, or computed against the previous close; `changeBasis` says which). '
        + 'This is the only tool with the underlying\'s current quote and session range; get_live_options_chain reports a spot at fetch time with no range, and get_stock_prices is end-of-day bars with the prior close. '
        + 'Requires a broker credential saved to the account under Account -> Broker -> Stored broker credentials; a broker connected only in the browser on the website is not visible to this tool. '
        + 'No end-of-day fallback: a failed fetch returns an error; read `code` and `retryable` when present. No broker error text is passed on. '
        + '`asOf` is when the quote was FETCHED, not a quote time; the broker\'s own clocks are `quoteTime` and `tradeTime`, and on tastytrade `quoteTime` is a market-data clock that moves without new prices, so it does not date the bid, ask or last; on moomoo `quoteTime` is its snapshot\'s update time and it gives no `tradeTime`. '
        + 'Cold-call estimate, not actual spend or an upper bound: 1 request on every broker, against your broker\'s own quota, which the live tools share; a repeat for the same symbol and broker by the same account within 5 seconds can be answered from a short cache, uncharged, with the same `asOf`. '
        + 'A RATE_LIMITED refusal comes from the platform\'s limiter before any broker request is sent: with `rateLimit`, `rateLimit.provider` names the broker whose request was refused; another stored broker has its own budget, though shared limiter capacity can also cause refusal.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY, SPX, VIX)'),
        // Every provider a stored credential may name. It must match the
        // server's list: automatic selection can pick any of them, so a
        // narrower enum here refuses by name the very broker the same call
        // would have chosen on its own.
        provider: z.enum(['tradier', 'tastytrade', 'public', 'schwab', 'moomoo']).optional()
          .describe('Which stored broker credential to use. Defaults to the first one stored, in the order Tradier, tastytrade, Public, Schwab, moomoo.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    toolHandler(async ({ symbol, provider }) => {
      const params: Record<string, string> = {};
      if (provider) params.provider = provider;
      const budget: { rateLimit: LiveRateLimit | null } = { rateLimit: null };
      const res = await client.get(
        `/live/quote/${encodeURIComponent(symbol.toUpperCase())}`,
        params,
        (rateLimit) => { budget.rateLimit = rateLimit; },
      ) as Record<string, unknown>;
      return significantDeep({ ...res, rateLimit: budget.rateLimit, guide: quoteGuide(res, budget.rateLimit) });
    }, { liveTool: 'quote' }),
  );
}

/**
 * The quote's guide emits each applicable reading rule under a stable key beside the fields the answer carries.
 * Provider-keyed rules go by the provider's identity, never a detected value.
 */
export function quoteGuide(res: Record<string, unknown>, rateLimit: LiveRateLimit | null): Guide {
  const quote = (res.quote ?? {}) as Record<string, unknown>;
  const provider = res.provider;
  const index = res.midReason === 'index-not-executable';
  const g: Guide = {};
  // The rule governs zeros as well as nulls, so it is on every answer.
  g.nullIsUnknown = 'A null field is one the broker did not publish, never a stand-in or a zero-fill, except nulls this '
    + 'tool sets and names (mid, an index\'s sizes and volume, moomoo\'s index bid and ask, a withheld change); '
    + 'a last of 0 or below is no trade and goes out null; a zero bid or ask is kept.';
  // The general definition, a numeric mid included.
  g.mid = 'mid is (bid + ask) / 2 only when both sides are above zero and the ask is not below the bid; never last or mark.';
  if (quote.mid == null || res.midReason != null) {
    g.midNull = index
      ? 'mid is null for an index (midReason "index-not-executable") even with both sides quoted: an index\'s bid and '
        + 'ask are indicative published figures, not an executable market. The bid and ask beside it are kept.'
      : 'mid is null with midReason null: a side missing or zero, or a crossed market. The bid and ask beside it are kept.';
  }
  if (quote.mark != null) {
    g.mark = 'mark is the broker\'s own valuation (tastytrade, and Schwab for a stock or fund), not an executable quote.';
  }
  // The change legend, per case.
  const change: string[] = [];
  if (res.changeBasis === 'broker') {
    change.push('changeBasis "broker": change and changePercent are the broker\'s own day change, kept whatever last, '
      + 'previousClose or stale say.');
    if (provider === 'schwab') {
      change.push('On Schwab it comes from its regular-session figures where its quote carries them, so an after-hours '
        + 'trade does not move it, else from its netChange.');
    }
  } else if (res.changeBasis === 'previous-close') {
    change.push('changeBasis "previous-close": change is last minus previousClose, computed here, and changePercent is '
      + 'that change against previousClose.');
  }
  if (res.change == null && res.changeReason == null) {
    change.push('change is null with changeReason null: the broker published no change and last or previousClose is '
      + 'missing, so it is never computed from a stand-in.');
  }
  if (res.changePercent == null && res.change != null) {
    change.push('changePercent can be null beside a change: the broker published no percent, or previousClose is 0.');
  }
  if (change.length) g.change = change.join(' ');
  if (res.changeReason === 'previous-close-rolled') {
    g.previousCloseRolled = provider === 'moomoo'
      ? 'changeReason "previous-close-rolled": outside the regular session last equalled previousClose with no '
        + 'broker change. moomoo\'s previous close does not roll after the session, so this can only mean last '
        + 'equalled the earlier close; the change is withheld, never shown as 0.'
      : 'changeReason "previous-close-rolled": outside the regular session (09:30 New York to the proxy\'s close for '
        + 'that date, 16:00 on a regular day) previousClose equalled last (or the regular session\'s last, where the broker keeps an extended-hours '
        // evaluation: "absent or 0" was still read as "the broker published no change"
        + 'last apart) and the broker sent either no change of its own or a change of 0 (this answer cannot tell which, so it '
        + 'does not show that the broker published no change). On a broker that rolls it, previousClose is then the '
        + 'session\'s own close, so the day\'s change cannot be read from this quote and is withheld, never shown as 0; '
        + 'a session that genuinely closed flat reads the same and is withheld the same. A broker\'s own non-zero change '
        + 'is published whatever the previous close.';
  }
  if (res.changeReason === 'stale-quote') {
    g.staleChange = 'changeReason "stale-quote": this tool withheld the change it computed: the quote\'s clocks predate '
      + 'the last session\'s open, so last minus previousClose is the move from the prior close to that early snapshot, '
      + 'not the day\'s.';
  } else if (res.stale === true && res.changeBasis === 'broker') {
    g.staleChange = 'The quote is stale, but the broker\'s own change beside it is kept: it is the broker\'s statement, '
      + 'not computed from the stale snapshot.';
  }
  // The canonical stale rule, on every answer (its false and null cases need it as much as true).
  g.stale = 'lastSessionOpen is the 09:30 New York open of the latest NYSE session that has started: today from 09:30 '
    + 'on a trading day, otherwise the previous trading day (before 09:30, weekends or holidays; searched back 14 days). '
    + 'stale compares the later of the clocks present (quoteTime, tradeTime; one alone decides if the other is null): '
    + 'true before that open, false at or after it, null with no clock (staleReason "no-timestamps") or no session '
    + 'in those 14 days ("no-session-on-file"): unknown, never fresh. False says only a clock moved at or after the '
    + 'open, not that the quote is current or a new price printed; true says only that every available broker clock '
    + 'predates that open, not that nothing traded since or that fields without a clock stayed unchanged. '
    + 'Computed when this answer is built; a cached repeat '
    + 'keeps it for 5 seconds.';
  if (provider === 'tastytrade') {
    g.tastytrade = 'On tastytrade quoteTime is its market-data clock, which moves on a bid or ask update and can move '
      + 'with no new price, so stale cannot catch a frozen tastytrade quote; tradeTime is its last trade\'s time, null '
      + 'where tastytrade gives none.';
  }
  if (index) {
    g.indexQuote = 'An index does not trade: bidSize, askSize and volume are null (any zero-fill replaced), never 0; '
      + 'its bid and ask stay as published.';
  }
  // tastytrade and moomoo retain their own quote clocks; these are not necessarily bid or ask update clocks.
  g.clocks = provider === 'tastytrade' || provider === 'moomoo'
    ? `quoteTime is ${provider}'s own quote clock (see ${provider}) and tradeTime its last trade print, null where none `
      + 'was given, never filled from asOf.'
    : 'quoteTime is the broker\'s last bid or ask update and tradeTime its last trade print, null where none was '
      + 'given, never filled from asOf.';
  if (provider === 'schwab') {
    g.schwab = 'On Schwab previousClose is its close field: the previous regular session\'s close during the session '
      + 'and that session\'s own close once it ends, so outside the session last minus previousClose is not the day\'s '
      + 'change (its broker change from the regular-session figures is).'
      + (res.midReason != null ? ' A Schwab index quote there has no bid, ask, mark or quote time.' : '');
  }
  if (provider === 'tradier') {
    g.tradier = 'On Tradier previousClose is its prevclose field, never its current-session close field.';
  }
  const ohlMissing = quote.open == null || quote.high == null || quote.low == null;
  if (provider === 'public' && ohlMissing) {
    g.absences = 'Public publishes no open, high or low, so those are null there.';
  } else if (provider === 'tradier' && res.midReason != null && ohlMissing) {
    g.absences = 'Tradier publishes none for an index quote, so open, high and low are null there.';
  }
  if (provider === 'moomoo') {
    g.moomoo = 'On moomoo previousClose does not roll after the session ends (it stays the earlier close, so a '
      + 'computed change still reads the day\'s move); last is the regular session\'s; it publishes no mark and no '
      + 'change; quoteTime is its snapshot\'s update time (when the quote last changed, not a print) and it gives no '
      + 'tradeTime; an index quote there has no bid or ask (moomoo zero-fills them; null here).';
  }
  // No emitted field says whether the answer was taken in session, so on every answer.
  g.session = provider === 'moomoo'
    ? 'Outside regular hours open, high and low describe the session the broker is in.'
    : 'Outside regular hours last can be an extended-hours trade, and open, high and low describe the session the broker is in.';
  g.asOf = 'asOf is when the answer was fetched (a cached repeat keeps it), not a quote or trade time.';
  g.cache = 'A repeat for the same symbol and broker by the same account within 5 seconds may be this answer from cache '
    + '(same asOf, no broker request, not charged, served on a spent budget) or fetched afresh.';
  // The description cut drops the quota figures from the description; their full form lives in this response line.
  const budget = rateLimitGuide(rateLimit);
  if (budget) g.rateLimit = budget;
  return g;
}

