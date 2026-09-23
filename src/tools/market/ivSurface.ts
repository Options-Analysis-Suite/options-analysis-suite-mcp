import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeIvSurface } from './ivSurfaceShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_iv_surface',
    {
      title: 'IV Surface',
      description: 'Get the IV surface/skew across strikes and expirations for a symbol. End-of-day data from the most recent session on file by default; `date` in the result is the session it describes and is authoritative (the equity import usually lands in the early hours US Eastern, so in the evening this is usually the previous session, and it can be older when an import is late). Set `date` to read a specific session, as get_options_chain does; for a symbol whose ticker has changed (FB to META), a date before the change reads the history under the ticker of that day here and the requested ticker\'s rows in get_options_chain, so the two need not agree there; a date with no file for the symbol (a weekend, a holiday, a day the import missed) is an error, not the nearest session. '
        + 'Default response returns a compact term-structure and smile summary over six expirations sampled across the curve: one per tenor bucket first, then the earliest remaining up to six, the same rule get_options_chain uses; `expirationCount` and `rowCount` count every expiration and row in the file, the skipped same-day one included. The expiry that ended that session (zero days to expiry) is skipped whenever a later one exists, because at zero time its wings and its smoothed IV are not a surface; `surfaceMeta.sameDaySkipped` says when that happened. '
        + 'Per node, `iv` is the first usable value, in order, of the smoothed surface value, the call mid IV and the put mid IV; `putIV` and `callIV` are the mid implied volatilities of each side, each null where the stored value is outside the usable band (finite, above 0, at most 5, that is 500%), so a stored 0 or 10 reads as absent; `ivSource` beside each `iv` (and `atmIvSource` on the term-structure and skew rows) says which of the three it is: "smoothed", "call-mid", "put-mid", or null. The band rejects stored sentinels, not noise: on a thin name a side mid IV can be in band beside a quote with no bid and disagree severalfold with the next strike, and the stored smoothed value can be one number across every strike of an expiration, which is the stored surface, not a rounding. IVs are rounded to four decimals (the stored smoothed value carries three, so it shows three). `skewSummary[].putCallSkew` is the put-wing mid IV at the strike nearest 95% of spot among strikes below the ATM strike, minus the call-wing mid IV at the strike nearest 105% of spot among strikes above it (the ATM strike, the one nearest spot, is never a wing; ties go to the lower strike); `putRelativeStrike` and `callRelativeStrike` on each skew row say how far from spot each wing actually sits, which on a coarse strike grid can be 76% and 114%. It is null when either wing\'s mid IV is unusable, and an expiration with no strike beyond the ATM on one side has no skew row at all; `putCallSkewBasis` says so beside it; it is NOT the same measure as get_options_chain\'s `putCallSkew`, which is 25-delta wings, and the two can differ severalfold on one expiration. Nothing stands in for an absent side. The smoothed value can sit outside both sides, near expiry and on a thin name at any tenor; that is the smoothing, not an error. Set `full` for the whole grid.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY)'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Optional market date in YYYY-MM-DD format. Defaults to the most recent session on file for this symbol, whatever its date; read `date` in the result. A date with no file for the symbol is an error, not the nearest session.'),
        full: z.boolean().optional().describe('Return the less-summarized IV surface grid (raw shape, still subject to the MCP response budget).'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, date, full }) => {
      // The route has taken ?date all along (proxy/routes/scanner.ts); the
      // tool never passed one, so a surface could only be read for whatever
      // session was newest, and never for the session the chain was read for.
      const params: Record<string, string> = {};
      if (date) params.date = date;
      const res = await client.get(`/scanner/iv-surface/${encodeURIComponent(symbol.toUpperCase())}`, params);
      if (full) return { _skipSizeGuard: true, data: res };
      return summarizeIvSurface(res);
    }),
  );
}
