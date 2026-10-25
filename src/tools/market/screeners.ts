import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { modelDisplayName } from '../modelLabels.js';
import { humanizeFeature, displayRegimeLabels } from './marketRegimeShaping.js';
import { LiveApiError } from '../../proxy/liveApiClient.js';
import {
  DEFAULT_UNREADABLE,
  methodologyInput,
  methodologyLabel,
  requireMethodology2Envelope,
  resolveMethodology,
  type ResolvedMethodology,
} from '../exposureMethodology.js';

/**
 * One unified tool for every options-market screener the platform
 * exposes through /scanner/*. Keeps the MCP tool count low while still
 * giving the AI access to all 16 screener families (+ market trends).
 * Sub-params (view / metric / side / mode / direction) are ignored
 * when not applicable to the chosen screener, and required when the
 * underlying endpoint mandates them.
 */

export const SCREENER_IDS = [
  // Main OptionsMarketPage tabs — support both ticker and contract views
  'most-active',
  'highest-oi',
  'highest-iv',
  'unusual',
  'gex',
  // Single-view leaderboards
  'model-divergence',
  'regime-stress',
  'term-backwardation',
  'put-skew',
  'delta-exposure',
  'vega-exposure',
  'pre-earnings-iv',
  // Screener families that need a sub-param to disambiguate
  'dod-change',            // metric: gex | iv | put-call | skew | regime
  'vrp',                   // side: high | low
  'max-pain',              // mode: pinning | divergence
  'unusual-directional',   // side: call | put
  // Non-leaderboard views exposed through the same tool for convenience.
  'market-trends',
  'earnings-calendar',
] as const;

const SCREENER_DESCRIPTION = `Run one of the 16 options-market screeners (plus market-trends and an earnings-calendar view). Choose the screener via the \`screener\` enum; pass sub-params only for the screener that needs them. Irrelevant sub-params are ignored.

• most-active / highest-oi / highest-iv / unusual / gex — main tabs. Use \`view\` (ticker|contract, default ticker). Support \`index\` (all|sp500|sp400|sp600|etf). Note: \`index=etf\` returns rows only in \`view=contract\`; ticker view's aggregator does not include ETF rows. For \`unusual\`, the \`threshold\` param's meaning depends on view: contract view = min volume/OI ratio (float, default 1.0); ticker view = min unusual-contract breadth count (integer, default 1).
• dod-change — day-over-day leaderboards. Requires \`metric\` (gex|iv|put-call|skew|regime). Optional \`direction\` (up|down|all) for gex/iv/put-call. To get DoD skew or regime views, use dod-change with \`metric=skew\` or \`metric=regime\` — the \`regime-stress\` / \`put-skew\` screener ids always return the level leaderboard, never the change view.
• vrp — volatility risk premium. Requires \`side\` (high|low).
• max-pain — requires \`mode\` (pinning: spot near max pain + high gamma concentration; divergence: spot vs max pain in implied-move σ units).
• unusual-directional — requires \`side\` (call|put).
• market-trends — market-wide avg IV / volume / P/C time series. Optional \`days\` (passthrough to proxy; proxy default 365, capped at 730). For token-budget reasons, an LLM may want to pass a smaller \`days\` (e.g. 30–90).
• earnings-calendar — upcoming earnings reports. Defaults to the next 14 days from today, matching the Morning Report window. Optional \`symbol\` to filter to a single ticker; optional \`days\` to widen/shorten the window (1..90).
• Everything else takes only \`limit\`.

Returns the raw proxy payload; shape varies by screener. Ranking endpoints typically return \`{ data: Row[], currentDate, priorDate?, metric, ... }\` where Row includes the ranking metric plus supporting fields (spotPrice, totalOi, atmIv30d, label/stress, etc.). Contract-view endpoints return per-contract rows. \`market-trends\` returns time-series aggregates. \`earnings-calendar\` returns a bare array of {symbol, date, epsEstimated, epsActual, revenueEstimated, revenueActual} rows, with no time of day and no fiscal period; the estimates and actuals are null where the source has none. See the per-screener column notes at optionsanalysissuite.com/screeners.`;

type Sub = {
  view?: 'ticker' | 'contract';
  index?: 'all' | 'sp500' | 'sp400' | 'sp600' | 'etf';
  metric?: 'gex' | 'iv' | 'put-call' | 'skew' | 'regime';
  side?: 'high' | 'low' | 'call' | 'put';
  mode?: 'pinning' | 'divergence';
  direction?: 'all' | 'up' | 'down';
  threshold?: number;
  days?: number;
  symbol?: string;
};

interface ScreenerRoute {
  path: string;
  query?: Record<string, string>;
}

/**
 * The proxy marks a screener whose enrichment read failed (partial, unavailable): its rows
 * were read, the named fields were not. The note says what is missing, so a model never reads the nulls as values.
 */
const UNAVAILABLE_SOURCE_NOTES: Record<string, string> = {
  tickerTypes: 'The asset type of each row could not be read, so the rows carry no type (ETFs and stocks are not told apart).',
  termStructure: 'The term-structure IVs could not be read, so the front and back IV columns are missing, not zero.',
  regimeLabels: 'The regime labels could not be read, so the regime and stress columns are missing.',
};

function withPartialNote(res: unknown): unknown {
  if (!res || typeof res !== 'object' || Array.isArray(res)) return res;
  const r = res as Record<string, unknown>;
  if (r.partial !== true || !Array.isArray(r.unavailable)) return res;
  const notes = (r.unavailable as unknown[]).map((u) => UNAVAILABLE_SOURCE_NOTES[String(u)] ?? `Part of this answer (${String(u)}) could not be read.`);
  return { ...r, partialNote: notes.join(' ') };
}

function humanizeScreenerOutput(value: unknown, depth = 0): unknown {
  if (depth > 20 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) humanizeScreenerOutput(item, depth + 1);
    return value;
  }

  const obj = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(obj)) {
    if (key === 'topDriver' && typeof child === 'string') {
      obj[key] = humanizeFeature(child);
      continue;
    }
    if ((key === 'bestModel' || key === 'worstModel') && typeof child === 'string') {
      obj[key] = modelDisplayName(child);
      continue;
    }
    humanizeScreenerOutput(child, depth + 1);
  }

  return value;
}

// Greek exposure methodology v2: the screens whose
// rows carry exposure figures, by what the figure is to them. U8's routes take `exposure=v2` (proxy/routes/scanner.ts):
// a ranking by the figure ('ranked') answers methodology 2 or refuses; a shown column ('column') is the book's under 2;
// contract views have no methodology-2 figure (the routes refuse them under 2), so a ranked contract view is refused and
// a shown contract column is withheld. Every other screen carries no exposure figure and takes no methodology.
type ExposureRole = 'ranked' | 'column' | 'ranked-contract' | 'contract-column';
function exposureRole(screener: typeof SCREENER_IDS[number], sub: Sub): ExposureRole | null {
  const contract = (sub.view ?? 'ticker') === 'contract';
  switch (screener) {
    case 'gex': return contract ? 'ranked-contract' : 'ranked';
    case 'most-active': case 'highest-oi': case 'highest-iv': case 'unusual': return contract ? 'contract-column' : 'column';
    case 'dod-change': return sub.metric === 'gex' ? 'ranked' : null;
    case 'delta-exposure': case 'vega-exposure': return 'ranked';
    case 'max-pain': return sub.mode === 'pinning' ? 'ranked' : null;
    default: return null;
  }
}

/** Every exposure figure a row of these screens can carry, under either methodology's row names */
const ROW_EXPOSURE_KEYS = ['netGex', 'netDex', 'netVex', 'netVanna', 'netCharm', 'netVomma', 'normalizedDex', 'gammaConcentration', 'exposureStatus', 'charmBasis'] as const;
function withoutExposureFields(res: any): void {
  if (!res || !Array.isArray(res.data)) return;
  for (const row of res.data) {
    if (row && typeof row === 'object') for (const key of ROW_EXPOSURE_KEYS) delete row[key];
  }
}

/** The proxy's charm basis word as prose (its other values pass as they came) */
function proseCharmBasis(res: any): void {
  if (!res || !Array.isArray(res.data)) return;
  for (const row of res.data) if (row && typeof row === 'object' && row.charmBasis === 'fixedReference') row.charmBasis = 'fixed reference';
}

const SCREENER_V2_NOTE = 'Methodology 2: every exposure figure is the assumed dealer book - dealers long the calls and short the puts, '
  + 'every contract of open interest (share 1) - over every expiration after the session where the expiry rule is proven (a figure '
  + 'whose exposureStatus says qualified may count contracts expiring that session). The row names stay and follow the book: '
  + 'netGex its GEX (USD of delta per 1% move), netDex the put-minus-call delta balance (USD, underlying-equivalent), netVex its vega '
  + 'exposure (USD per vol point), netVanna its vanna (USD of delta per vol point), netCharm its charm flow (USD of the underlying '
  + 'traded per calendar day, + is buying), netVomma its vomma (USD per (vol point)^2), gammaConcentration the concentration of its '
  + 'per-strike GEX, and current, previous and delta its GEX on each date. exposureStatus says how complete a shown figure is '
  + '(partial: the sum of the legs included; qualified: its expiry scope is not proven; null: unavailable). A ranking BY an exposure figure (the gex screen, the GEX change, '
  + 'the delta and vega leaders, max-pain pinning) takes only complete books whose expiry scope is proven, and `excluded` counts '
  + 'the rows it left out by reason; the volume, open-interest, IV and unusual tabs keep their own rankings and show each row\'s GEX '
  + 'as it stands. charmBasis "cash" is charm on the cash price, "fixed reference" on the forward or future held fixed. transient: '
  + 'part of the answer may still change (it was not cached), so a later call can differ.';
const CONTRACT_V2_NOTE = 'Contract-level GEX is not published under methodology 2, so the contract rows carry no netGex.';

function routeForScreener(screener: typeof SCREENER_IDS[number], sub: Sub, limit: number): ScreenerRoute {
  const limitStr = String(limit);

  switch (screener) {
    case 'most-active':
    case 'highest-oi':
    case 'highest-iv':
    case 'gex': {
      const endpoint = screener === 'most-active'
        ? '/scanner/most-active'
        : screener === 'highest-oi'
          ? '/scanner/high-oi'
          : screener === 'highest-iv'
            ? '/scanner/high-iv'
            : '/scanner/gex';
      return {
        path: endpoint,
        query: {
          limit: limitStr,
          type: sub.view ?? 'ticker',
          index: sub.index ?? 'all',
        },
      };
    }
    case 'unusual':
      return {
        path: '/scanner/unusual',
        query: {
          limit: limitStr,
          type: sub.view ?? 'ticker',
          index: sub.index ?? 'all',
          threshold: sub.threshold != null ? String(sub.threshold) : '1',
        },
      };
    case 'model-divergence':
      return { path: '/scanner/model-divergence', query: { limit: limitStr } };
    case 'term-backwardation':
      return { path: '/scanner/term-structure-backwardation', query: { limit: limitStr } };
    case 'delta-exposure':
      return { path: '/scanner/delta-exposure-leaders', query: { limit: limitStr } };
    case 'vega-exposure':
      return { path: '/scanner/vega-exposure-leaders', query: { limit: limitStr } };
    case 'pre-earnings-iv':
      return { path: '/scanner/pre-earnings-iv-expansion', query: { limit: limitStr } };
    case 'regime-stress': {
      // Always level mode. To get the DoD-change view, callers must use
      // screener='dod-change' with metric='regime'. Silently flipping on
      // a stray `metric` arg made the tool return a different leaderboard
      // than its name promised.
      return { path: '/scanner/regime-stress', query: { limit: limitStr, mode: 'level' } };
    }
    case 'put-skew': {
      // Always level mode. DoD skew change lives at
      // screener='dod-change' with metric='skew'.
      return { path: '/scanner/skew', query: { limit: limitStr, mode: 'level' } };
    }
    case 'dod-change': {
      const metric = sub.metric;
      if (metric === 'skew') {
        return { path: '/scanner/skew', query: { limit: limitStr, mode: 'change' } };
      }
      if (metric === 'regime') {
        return { path: '/scanner/regime-stress', query: { limit: limitStr, mode: 'change' } };
      }
      if (metric !== 'gex' && metric !== 'iv' && metric !== 'put-call') {
        throw new Error("dod-change requires metric: 'gex' | 'iv' | 'put-call' | 'skew' | 'regime'");
      }
      const query: Record<string, string> = { limit: limitStr };
      if (sub.direction && sub.direction !== 'all') query.direction = sub.direction;
      return { path: `/scanner/changes/${metric}`, query };
    }
    case 'vrp': {
      if (sub.side !== 'high' && sub.side !== 'low') {
        throw new Error("vrp requires side: 'high' | 'low'");
      }
      return { path: '/scanner/vrp', query: { limit: limitStr, direction: sub.side } };
    }
    case 'max-pain': {
      if (sub.mode === 'pinning') {
        return { path: '/scanner/max-pain-pinning', query: { limit: limitStr } };
      }
      if (sub.mode === 'divergence') {
        return { path: '/scanner/max-pain-divergence', query: { limit: limitStr } };
      }
      throw new Error("max-pain requires mode: 'pinning' | 'divergence'");
    }
    case 'unusual-directional': {
      if (sub.side !== 'call' && sub.side !== 'put') {
        throw new Error("unusual-directional requires side: 'call' | 'put'");
      }
      return { path: '/scanner/unusual-directional', query: { limit: limitStr, side: sub.side } };
    }
    case 'market-trends': {
      // Pass days through if provided; otherwise let the proxy apply its
      // own default (365). Caps match the proxy (1..730).
      const query: Record<string, string> = {};
      if (sub.days != null) query.days = String(sub.days);
      return { path: '/scanner/market-trends', query };
    }
    case 'earnings-calendar': {
      // Default to the next 14 days from today — same window the Morning
      // Report uses. `days` overrides the window size; `symbol` filters.
      // Cap at 90 days: earnings calendars get noisy past the next
      // quarter and the Morning Report UI never widens beyond that.
      const windowDays = sub.days ?? 14;
      if (windowDays > 90) {
        throw new Error("earnings-calendar 'days' must be between 1 and 90");
      }
      // All-UTC arithmetic: mixing local setDate with UTC toISOString
      // would flip `today` to tomorrow during US evening hours.
      const today = new Date();
      const from = today.toISOString().slice(0, 10);
      const toDate = new Date(today);
      toDate.setUTCDate(toDate.getUTCDate() + windowDays);
      const to = toDate.toISOString().slice(0, 10);
      const query: Record<string, string> = {
        from,
        to,
        limit: limitStr,
      };
      if (sub.symbol) query.symbol = sub.symbol.toUpperCase();
      return { path: '/earnings-calendar', query };
    }
    default: {
      const exhaustive: never = screener;
      throw new Error(`Unknown screener: ${String(exhaustive)}`);
    }
  }
}

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'run_screener',
    {
      title: 'Options Screener',
      description: SCREENER_DESCRIPTION,
      inputSchema: {
        screener: z.enum(SCREENER_IDS).describe('Which screener to run.'),
        limit: z.number().int().min(1).max(100).default(15).describe('Max rows (default 15, cap 100).'),
        view: z.enum(['ticker', 'contract']).optional().describe('Only for most-active/highest-oi/highest-iv/unusual/gex. Default ticker.'),
        index: z.enum(['all', 'sp500', 'sp400', 'sp600', 'etf']).optional().describe('Index bucket for main-tab screeners. Default all.'),
        metric: z.enum(['gex', 'iv', 'put-call', 'skew', 'regime']).optional().describe('Required for dod-change: which day-over-day metric to rank by.'),
        side: z.enum(['high', 'low', 'call', 'put']).optional().describe('Required for vrp (high|low) and unusual-directional (call|put).'),
        mode: z.enum(['pinning', 'divergence']).optional().describe('Required for max-pain.'),
        direction: z.enum(['all', 'up', 'down']).optional().describe('Optional direction filter for dod-change on gex/iv/put-call metrics.'),
        threshold: z.number().min(0).optional().describe('Only for unusual: min volume-to-open-interest ratio. Default 1.0.'),
        days: z.number().int().min(1).max(730).optional().describe('For market-trends: history length in days (1..730). For earnings-calendar: forward window size in days (1..90, default 14). Earnings-calendar enforces the 90-day cap at runtime.'),
        symbol: z.string().optional().describe('Only for earnings-calendar: filter to a single ticker.'),
        methodology: methodologyInput('For the screens with exposure figures (gex, the main tabs\' net GEX, dod-change gex, delta-exposure, vega-exposure, max-pain pinning). '),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async (args) => {
      const screener = args.screener as typeof SCREENER_IDS[number];
      const sub: Sub = {
        view: args.view as Sub['view'],
        index: args.index as Sub['index'],
        metric: args.metric as Sub['metric'],
        side: args.side as Sub['side'],
        mode: args.mode as Sub['mode'],
        direction: args.direction as Sub['direction'],
        threshold: args.threshold as number | undefined,
        days: args.days as number | undefined,
        symbol: args.symbol as string | undefined,
      };
      const limit = (args.limit as number) ?? 15;

      const route = routeForScreener(screener, sub, limit);
      // The methodology, for a screen whose rows carry exposure figures: named, else the platform default. A
      // ranking by the figure cannot be answered without one; a shown column is withheld instead.
      const role = exposureRole(screener, sub);
      let resolved: ResolvedMethodology | null = null;
      if (role !== null) {
        resolved = await resolveMethodology(client, args.methodology);
        if (resolved === null && (role === 'ranked' || role === 'ranked-contract')) {
          throw new LiveApiError(DEFAULT_UNREADABLE, 503, 'DEFAULT_METHODOLOGY_UNAVAILABLE', true, undefined, undefined);
        }
      }
      const v2 = resolved?.methodology === 2;
      if (v2 && role === 'ranked-contract') {
        throw new LiveApiError('Contract-level GEX is not published under methodology 2, so the gex screen\'s contract view has no ranking there: use view=ticker, or methodology 1.', 400, 'INVALID_REQUEST', false, undefined, undefined);
      }
      const asksV2 = v2 && (role === 'ranked' || role === 'column');
      const res = await client.get(route.path, asksV2 ? { ...route.query, exposure: 'v2' } : route.query) as any;
      if (asksV2) {
        requireMethodology2Envelope(res);
        // checked, so the definition is the note's; the route's own words (the expiry rule's id) stay off the wire
        delete res.exposure;
        proseCharmBasis(res);
      }
      // no figure is sent that the answer's methodology cannot stand behind
      const withheld = role !== null && resolved === null;
      if (withheld || (v2 && role === 'contract-column')) withoutExposureFields(res);

      // Proxy responses standardize on { data: [...], ... }. Normalize the
      // few enum-like labels LLMs tend to quote verbatim, then let the shared
      // size guard handle any unusually large payload.
      const shaped = withPartialNote(displayRegimeLabels(humanizeScreenerOutput(res)));   // a regime state reads as its word, the stored key beside it (2026-10-11)
      if (role === null || !shaped || typeof shaped !== 'object' || Array.isArray(shaped)) return shaped;
      if (withheld) return { exposuresWithheld: DEFAULT_UNREADABLE, ...shaped };
      return {
        ...methodologyLabel(resolved!),
        ...shaped,
        ...(asksV2 ? { methodologyNote: SCREENER_V2_NOTE } : v2 ? { methodologyNote: CONTRACT_V2_NOTE } : {}),
      };
    }),
  );
}
