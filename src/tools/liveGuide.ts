import type { LiveRateLimit } from '../proxy/liveApiClient.js';

/**
 * The live tools' shared guidance.
 *
 * A success response carries its guidance as one top-level `guide` object (a stable camelCase key per rule, one
 * string each, each at most once per response - never per row); this module holds the lines every live tool shares.
 * A live tool's structured error carries `meaning`: what its code means and what to do instead (the code legend),
 * then the budget line keyed on the `rateLimit` FIELD whatever the code, or - on an error without one that is not a
 * verified precheck refusal - the line saying the budget is unknown.
 */
export type Guide = Record<string, string>;

export type LiveTool = 'quote' | 'chain' | 'dealer' | 'scan' | 'ranking' | 'bars';

// The index underlyings (packages/shared/src/data/indexUnderlyings.ts; the MCP server imports nothing outside its own
// directory, so a copy - liveOptionsChain.test.ts pins it equal to the shared list).
export const INDEX_UNDERLYINGS: ReadonlySet<string> = new Set(['SPX', 'NDX', 'DJX', 'RUT', 'VIX', 'VXN', 'OEX', 'XSP', 'SOX', 'XEO', 'VVIX']);

/**
 * A fetch time read on the New York clock (the formula of eodDealerPositioning.ts newYorkDateTime, kept here so this
 * module, which helpers.ts imports, imports no tool): its calendar date, and whether it falls outside the regular
 * session (09:30-16:00 on a weekday; holidays and early closes are not known here). Null for a missing or unreadable time.
 */
export function newYorkSession(asOf: unknown): { date: string; outsideRegularSession: boolean } | null {
  if (typeof asOf !== 'string') return null;
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(t));
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  const minutes = Number(part('hour')) * 60 + Number(part('minute'));
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return { date, outsideRegularSession: day === 0 || day === 6 || minutes < 570 || minutes >= 960 };
}

// The refusals the proxy makes before its limiter and before any broker request: the only codes whose presence
// establishes that nothing was charged (proxy/routes/live-broker.ts, proxy/lib/middleware.ts,
// packages/shared/src/broker/liveBrokerRoute.ts). Every other live error without `rateLimit` leaves the budget unknown.
const COMMON_PRECHECKS = ['INVALID_SYMBOL', 'UNKNOWN_PROVIDER', 'PRO_TIER_REQUIRED', 'BROKER_NOT_CONNECTED'];
export const PRECHECK_CODES: Record<LiveTool, ReadonlySet<string>> = {
  quote: new Set(COMMON_PRECHECKS),
  chain: new Set([...COMMON_PRECHECKS, 'INVALID_EXPIRATION']),
  dealer: new Set([...COMMON_PRECHECKS, 'INVALID_EXPIRATION', 'INVALID_REQUEST']),
  scan: new Set([...COMMON_PRECHECKS, 'INVALID_REQUEST']),
  ranking: new Set([...COMMON_PRECHECKS, 'INVALID_REQUEST']),
  bars: new Set([...COMMON_PRECHECKS, 'INVALID_REQUEST', 'BARS_NOT_SUPPORTED']),
};

const QUOTAS = 'The budgets are the brokers\' own documented quotas: 120 a minute on Tradier and Schwab, 600 on Public '
  + '(10 a second), 120 on tastytrade (which publishes no figure, so a conservative stand-in) and 30 on moomoo (per '
  + 'moomoo account, shared with the user\'s other moomoo apps).';

// An absent budget is never "not charged".
// "a timeout or an unreachable proxy" was echoed as the failure's cause; the line names none.
export const BUDGET_UNKNOWN = 'This error carries no rateLimit, which says nothing about whether broker quota was spent: '
  + 'a request that timed out or did not complete can still have used broker requests (the missing budget alone does not '
  + 'say where it stopped), and details too large for the error are dropped (detailsOmitted). For an error, only a refusal made before '
  + 'the broker is called establishes that nothing was charged.';

/**
 * Emit the budget line whenever the response (or an error's details) carries `rateLimit`.
 * Include the full quota figures here so shortening the quote description does not remove them from the answer.
 */
export function rateLimitGuide(rateLimit: LiveRateLimit | null | undefined, opts: { quotas?: boolean } = {}): string | undefined {
  if (rateLimit === undefined) return undefined;
  if (rateLimit === null) {
    return 'rateLimit is null: the proxy reported no budget for this call, so how much of the broker\'s quota is left is '
      + 'unknown.';
  }
  // "the proxy's meter": an evaluation found the line read as a figure the broker reports (the
  // description's "as the proxy reported it" had not come along)
  return 'rateLimit is the platform\'s own count of this broker\'s budget after this call (the proxy\'s meter, not a '
    + 'figure the broker reports), in the broker\'s own requests: remaining of limit on the broker named by provider, '
    + 'resetting in resetSeconds. It tracks broker requests and outstanding reservations across this account\'s calls '
    + 'in the window. Cache-only calls send no broker requests. limit minus remaining is not a per-call spend report.'
    + `${opts.quotas === false ? '' : ` ${QUOTAS}`}`;
}

/** What `resolved.S.asOf` and `resolved.S.stale` mean, stated here rather than by pointer to another tool. */
export function spotClockGuide(provider: string | null | undefined): string {
  const line = 'resolved.S.asOf is the spot\'s print time and resolved.S.stale is true when that time predates the '
    + '09:30 New York open of the last session that has started (the live-quote staleness rule); both are null when '
    + 'the spot has no print time (a close or a mark standing in for the last, or none given), and stale is also null when no '
    + 'session is on file: null is unknown, never fresh.';
  return provider === 'moomoo'
    ? `${line} On moomoo asOf is the underlying snapshot's update time, when its quote last changed, not a print time.`
    : line;
}

type Details = Record<string, unknown>;

/**
 * A refusal the MCP server makes itself, before any request is sent (an empty symbol list, a ranking on a metric not
 * asked for): nothing can have been charged, so a live tool's text says nothing about the budget.
 */
export class RefusedBeforeRequest extends Error {}

interface LegendContext { tool: LiveTool; omitted: boolean }

// A broker's wait outlives a switch: an evaluation found deferred runs switching brokers after a rate limit (the budget
// line names every broker's quota) and some dropping the first broker's wait from the answer. An evaluation found
// "switching does not lift this broker's wait" read as "switching brokers won't help": another broker does answer.
// An evaluation found switchers answering from another broker and dropping this one's refusal and wait (switching is
// wanted, and the answer still reports this broker's refusal with its wait). An evaluation found that line,
// worded as a description, dropped by more switchers: an order again, with
// this refusal's figure in it.
const HOLDS = ' Another stored broker has its own budget and is not held by this wait.';
// remaining 0 is also the wire shape of a saturated shared bucket map: another broker may need a slot in that map.
const CAPACITY = ' Another stored broker has its own budget and may answer; a broker-specific wait does not hold it, but '
  + 'shared limiter capacity can refuse it too.';

const seconds = (n: number): string => `${n} second${n === 1 ? '' : 's'}`;
const finiteWait = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const brokerName = (d: Details): string | null => {
  const provider = (d.rateLimit as LiveRateLimit | null | undefined)?.provider;
  return typeof provider === 'string' && provider !== '' ? provider : null;
};

// RATE_LIMITED waits retryAfterSeconds, otherwise until the budget resets.
function platformSwitch(d: Details): string {
  const budget = d.rateLimit as LiveRateLimit;
  const wait = finiteWait(d.retryAfterSeconds) ? d.retryAfterSeconds
    : finiteWait(budget.resetSeconds) ? budget.resetSeconds : null;
  const name = brokerName(d);
  const refusal = `the platform's limiter, not the broker, refused the ${name === null ? '' : `${name} `}request`;
  return (budget.remaining === 0 ? CAPACITY : HOLDS) + (wait === null
    ? ` If one answers, still say in the answer that ${refusal} and this refusal's wait is unknown here.`
    : ` If one answers, still give this refusal's wait (${seconds(wait)}) in the answer and say ${refusal}.`);
}

// BROKER_RATE_LIMITED: the wait is the broker's own retryAfterSeconds; the platform meter resets on its own clock.
function brokerSwitch(d: Details, wait: unknown): string {
  // The refusing broker is details.provider (liveApiClient); a rateLimit beside it is that broker's meter.
  const who = (typeof d.provider === 'string' && d.provider !== '' ? d.provider : null) ?? brokerName(d) ?? 'the broker';
  return HOLDS + (finiteWait(wait)
    ? ` If one answers, still give this refusal's wait (${seconds(wait)}) in the answer and say ${who} itself refused.`
    : wait === null
      ? ` If one answers, still say in the answer that ${who} itself refused and did not say how long to wait.`
      : ` If one answers, still say in the answer that ${who} itself refused and its wait is unknown here.`);
}

// The code legend: what each code means and what to do instead.
const LEGEND: Record<string, (details: Details, ctx: LegendContext) => string> = {
  RATE_LIMITED: (d, ctx) => (ctx.tool === 'quote' || ctx.tool === 'bars'
    // get_live_quote: one request, no batch extension - every refusal comes before it is sent.
    ? 'RATE_LIMITED: a platform limiter refused the request before it was sent, so nothing was charged.'
    : ctx.omitted
      ? 'RATE_LIMITED: a platform limiter refused the request: either the live-broker limiter (a refused fresh reservation '
        + 'charges nothing, but a tastytrade or moomoo chain refused part way comes after charged requests) or the platform\'s '
        + 'general per-minute limit; the details that would say which were dropped.'
      : 'RATE_LIMITED: a platform limiter refused the request. ' + (d.rateLimit !== undefined
    ? 'This was the live-broker limiter: a refused fresh reservation charges nothing, but a tastytrade or moomoo '
      + 'chain refused part way, once its quote-batch count was known, comes after requests were already sent and '
      + 'charged, so this code does not mean nothing reached the broker.'
    : 'This one carries no live budget: the platform\'s general per-minute limit.'))
    + ' Wait a finite, non-negative retryAfterSeconds when given, otherwise until the budget resets.'
    + (!ctx.omitted && d.rateLimit !== undefined && d.rateLimit !== null ? platformSwitch(d) : '')
    // A full shared bucket map also publishes remaining 0, without a bucket for this account and broker.
    + (!ctx.omitted && (d.rateLimit as LiveRateLimit | null | undefined)?.remaining === 0
      ? ' rateLimit.remaining 0 can also mean the proxy\'s shared limiter capacity is unavailable, without this account '
        + 'exhausting its broker quota. In that case resetSeconds and retryAfterSeconds are advisory retry delays, not '
        + 'this broker\'s budget reset.'
      : ''),
  BROKER_UNAVAILABLE: (_d, ctx) => 'BROKER_UNAVAILABLE: the broker did not answer usably; brokerFailure says how: "http-status" '
    + '(with the broker\'s brokerStatus), "timeout", "unreadable-response", "no-usable-answer" (it answered with no '
    + (ctx.tool === 'quote'
      ? 'finite number in last, bid, ask, mark or previousClose'
      : 'price, strikes or spot to use')
    + ') or "other".'
    + (ctx.tool === 'quote' ? ' An answer with no item for the symbol is classified as "other".' : '')
    + ' No broker text is passed on. It may be retried.',
  BROKER_REJECTED: () => 'BROKER_REJECTED: the broker refused the request itself (an HTTP 4xx other than 408, 409, 425 '
    + 'and 429; not a credential refusal or a failed sign-in - Public, for one, answers a symbol it does not list with '
    + 'a 400). Retrying the same request on the same broker will not help; check that broker\'s account for the symbol '
    + 'or the permission; another stored broker may answer it.',
  BROKER_ENTITLEMENT_MISSING: () => 'BROKER_ENTITLEMENT_MISSING: moomoo refused because the account lacks real-time '
    + 'permission for that market, or moomoo does not serve that market or instrument. Not retryable; another stored '
    + 'broker may answer it.',
  BROKER_RATE_LIMITED: (d, ctx) => {
    // Explicit null means the broker supplied no wait. Missing, invalid or omitted details do not establish that.
    const wait = ctx.omitted ? undefined : d.retryAfterSeconds;
    return 'BROKER_RATE_LIMITED: the broker\'s own rate limit, not the platform\'s. '
      + (!ctx.omitted && d.rateLimit !== undefined && d.rateLimit !== null
        ? 'rateLimit is the platform\'s meter, so it can show requests left while the broker itself refuses. ' : '')
      + (finiteWait(wait) ? 'Wait retryAfterSeconds before retrying.'
        : wait === null ? 'The broker did not say how long, so back off before retrying.'
          : 'No usable broker wait is available here; back off before retrying.')
      + brokerSwitch(ctx.omitted ? {} : d, wait);
  },
};

// What a code adds for ONE tool.
const TOOL_LEGEND: Partial<Record<LiveTool, Record<string, string>>> = {
  // get_live_dealer_positioning: the refusal and wait part of its cost mechanics.
  dealer: {
    RATE_LIMITED: 'On this tool a tastytrade or moomoo chain longer than its reservation reserves the rest once its '
      + 'count is known, before its quote batches, and is refused RATE_LIMITED with the wait when the budget cannot hold '
      + 'them; a call bigger than the whole budget (four very large tastytrade chains) runs alone on an empty window, '
      + 'charged in full, waiting for a reset only while something else is in it.',
  },
  // rank_live_skew_gex explains cached results after a credential refusal and how to select another broker.
  ranking: {
    BROKER_CREDENTIAL_INVALID: 'On this tool nothing more was sent once it occurred; the symbols computed before it stay '
      + 'cached for the next call.',
    BROKER_REJECTED: 'Here another broker is named with this tool\'s provider parameter.',
  },
  // scan_option_strategies: what a too-large scan already spent, and the free retry. The refusal also comes from
  // a cached chain, which sent nothing and reserved nothing (review).
  scan: {
    SCAN_TOO_LARGE: 'The chain was obtained before the pairs were counted: a fresh fetch from the broker was charged, a '
      + 'chain from the 15-second cache was not. A narrower deltaMin and deltaMax band for the same expiration within 15 '
      + 'seconds can re-scan the cached chain uncharged (the cache is per proxy instance, so the retry can also be read '
      + 'afresh).',
  },
  // get_live_options_chain: the reservation mechanics behind its RATE_LIMITED.
  chain: {
    RATE_LIMITED: 'On this tool a tastytrade or moomoo chain longer than its reservation (12 requests on tastytrade, 2 '
      + 'on moomoo) reserves the rest once its count is known, before its quote batches, and is refused RATE_LIMITED '
      + 'when the budget cannot hold them; a call bigger than the whole budget runs alone on a window holding nothing '
      + 'else, charged in full, and waits for the reset only while something else is in the window.',
  },
};

/**
 * The code legend alone (no budget line): what a code means on this tool, for a legend inside a SUCCESS answer (the
 * ranking's per-symbol errors). Undefined for a code with no entry.
 */
export function codeLegend(tool: LiveTool, code: string, details: Details = {}): string | undefined {
  const lines = [LEGEND[code]?.(details, { tool, omitted: false }), TOOL_LEGEND[tool]?.[code]].filter((x): x is string => x !== undefined);
  return lines.length ? lines.join(' ') : undefined;
}

/**
 * `meaning` for a live tool's structured error: the code's legend entry, or that a precheck refusal charged nothing;
 * then the budget line when the details carry `rateLimit` (any code or none), else the budget-unknown line unless the
 * code is one of THIS tool's verified precheck refusals. Details dropped for size (`detailsOmitted`) took any budget
 * with them. Undefined when there is nothing to say.
 */
export function liveErrorMeaning(tool: LiveTool, code: string | undefined, details: Details, detailsOmitted: boolean): string | undefined {
  const lines: string[] = [];
  const precheck = code !== undefined && PRECHECK_CODES[tool].has(code);
  const legend = code !== undefined ? LEGEND[code] : undefined;
  if (legend) lines.push(legend(details, { tool, omitted: detailsOmitted }));
  const extra = code !== undefined ? TOOL_LEGEND[tool]?.[code] : undefined;
  if (extra) lines.push(extra);
  if (precheck) lines.push(`${code} is refused before the broker is called, so nothing was charged.`);
  if (!detailsOmitted && details.rateLimit !== undefined) {
    const budget = rateLimitGuide(details.rateLimit as LiveRateLimit | null);
    if (budget) lines.push(budget);
  } else if (!precheck) {
    lines.push(BUDGET_UNKNOWN);
  }
  return lines.length ? lines.join(' ') : undefined;
}
