import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { modelDisplayName } from '../modelLabels.js';
import { humanizeFeature } from './marketRegimeShaping.js';

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

Returns the raw proxy payload; shape varies by screener. Ranking endpoints typically return \`{ data: Row[], currentDate, priorDate?, metric, ... }\` where Row includes the ranking metric plus supporting fields (spotPrice, totalOi, atmIv30d, label/stress, etc.). Contract-view endpoints return per-contract rows. \`market-trends\` returns time-series aggregates. \`earnings-calendar\` returns a bare array of {symbol, date, time, ...} rows. See the per-screener column notes at optionsanalysissuite.com/screeners.`;

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
      const res = await client.get(route.path, route.query) as any;

      // Proxy responses standardize on { data: [...], ... }. Normalize the
      // few enum-like labels LLMs tend to quote verbatim, then let the shared
      // size guard handle any unusually large payload.
      return humanizeScreenerOutput(res);
    }),
  );
}
