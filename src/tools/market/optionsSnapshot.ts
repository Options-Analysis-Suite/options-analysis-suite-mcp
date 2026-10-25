import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LiveApiError, type LiveApiClient } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { BATCH_RANK_METRICS, BATCH_V2_NOTE, SNAPSHOT_V2_NOTE, shapeOptionsSnapshot, summarizeMetricsBatch } from './optionsSnapshotShaping.js';
import {
  DEFAULT_UNREADABLE, METHODOLOGY_2_NOTE, defaultUnavailableError, methodologyInput, methodologyLabel, requireMethodology2Envelope, resolveMethodology,
} from '../exposureMethodology.js';

const MAX_BATCH_SYMBOLS = 50;

/**
 * The EOD options snapshot, and the multi-symbol comparison, from the proxy's
 * /scanner/snapshot/:symbol and /scanner/metrics/batch. The snapshot route is
 * public; the batch route needs a signed-in user (this client always sends the
 * user's bearer) and allows 60 requests a minute per account. Neither checks
 * the plan, so this tool carries no tier requirement.
 *
 * NOT get_snapshot. That reads snapshots the WEB APP synced from a browser
 * session - the user's own GEX, portfolio and risk views. This reads the
 * platform's own EOD options snapshot for any symbol, whether or not the user
 * has ever opened it, and it is the only tool that can reach the max-pain
 * curve and the per-strike exposure curves.
 *
 * One symbol takes the snapshot path; several take the metrics batch, which is
 * one request rather than N.
 */
export function register(server: McpServer, client: LiveApiClient): void {
  server.registerTool(
    'get_options_snapshot',
    {
      title: 'EOD Options Snapshot',
      description:
        'Get the end-of-day options snapshot for a symbol: spot, max pain, net GEX and DEX, the ATM IV term structure (7/30/90 day), IV rank and percentile, historical vol, put-call ratio, volume and open interest. '
        + 'Pass several comma-separated symbols (up to 50) to compare their headline metrics in ONE request instead of calling this repeatedly: each row carries spot, ATM IV, IV rank and percentile, 20- and 60-day realized vol, IV minus each realized vol (`ivMinusHv20d`, `ivMinusHv60d`, the raw volatility risk premium), the 30-day expected move, net GEX and DEX, the 25-delta skew, put/call ratio, volume and open interest. With `rankBy` the rows come sorted by that metric (largest first unless `order` is "asc"), a symbol without the metric last and named in `rankMeta.unrankedSymbols`; without it they stay in the order asked for. '
        + 'This is platform data for any symbol - use get_snapshot instead for the GEX, portfolio and risk snapshots synced from the user\'s own browser session, which is a different dataset. '
        + 'Set `curves` to summarize the per-strike payloads: the max-pain curve with its true minimum, per-strike GEX or DEX with totals, or the volatility skew. Curves are omitted by default because they are large. '
        + 'The net GEX and DEX here are over ALL expirations on file; get_dealer_positioning reports the 0-60 day window, so the two differ for the same session and neither is wrong. Long-dated contracts carry large delta, so the two can differ even in sign (SPY 2026-09-29: net DEX -16,795,316,756 over all expirations against +16,246,461,968 over 0-60 days). Under methodology 2 (`methodology`) one symbol\'s net GEX and DEX give way to `exposures`, and several symbols\' netGex and netDex are the assumed dealer book\'s GEX and delta balance: the one stored book get_options_analytics_history and get_dealer_positioning report under 2, over the scope each answer states. `chainExpiry` is, for a stock, ETF or index, the nearest expiration at least a day after the session (the snapshot is stored after that session\'s own expirations settle; null, with no chain, when none is that far out); a futures contract\'s snapshot is taken intraday and can name the session\'s own expiration. `analyticsExpiry` is the expiration max pain and the probability analytics are computed on: the monthly nearest to 30 days out among those at least 7 days out, a non-monthly nearest to 30 days out when no monthly is that far out, and the first listed expiration when nothing is (so on 2026-09-16 with 09-18 and 10-16 listed it is 10-16, and with only 09-18 listed it is 09-18, two days out). '
        + 'Data is end-of-day from the most recent session on file, not intraday. `date` in the result is the session it describes and is authoritative: the equity import usually lands in the early hours US Eastern, so in the evening the most recent on file is usually the previous session, and it can be older when an import is late; futures snapshots are written at the close and can already be the current day\'s. Use get_live_options_chain for live prices. '
        + 'Any symbol the platform holds an options snapshot for, futures contracts with listed options included. A symbol it holds only a price row for reports that rather than returning empty metrics.',
      inputSchema: {
        symbols: z.string()
          .describe('One ticker for the full snapshot, or a comma-separated list (up to 50) for a headline-metrics comparison.'),
        curves: z.array(z.enum(['maxPain', 'gex', 'dex', 'skew'])).optional()
          .describe('Which per-strike curves to summarize. Single-symbol only; ignored for a multi-symbol request.'),
        curveLimit: z.number().int().min(1).max(40).optional()
          .describe('Rows kept per curve, centred on spot. Default 12.'),
        rankBy: z.enum(BATCH_RANK_METRICS).optional()
          .describe('Multi-symbol only: sort the comparison by this metric (ivRank, ivPercentile, atmIv, ivMinusHv20d, ivMinusHv60d, hv20d, hv60d, expectedMove30dFraction, netGex, netDex, ivSkew25d, putCallRatio, totalOi, totalVolume). A symbol without the metric sorts last and is counted in rankMeta. Absent keeps the order asked for.'),
        order: z.enum(['asc', 'desc']).optional()
          .describe('With rankBy: largest first (desc, default) or smallest first (asc).'),
        methodology: methodologyInput('For the net GEX and DEX and the gex and dex curves. '),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbols, curves, curveLimit, rankBy, order, methodology }) => {
      const list = symbols.split(',')
        .map((symbol) => symbol.trim().toUpperCase())
        .filter((symbol) => symbol.length > 0);

      if (list.length === 0) {
        throw new Error('symbols must name at least one ticker');
      }
      if (list.length > MAX_BATCH_SYMBOLS) {
        throw new Error(`symbols accepts at most ${MAX_BATCH_SYMBOLS} tickers; received ${list.length}`);
      }

      // The exposure figures' methodology: named, else the platform default. The snapshot answers more than
      // exposure, so an unreadable default withholds only its exposure figures - except a ranking BY one of
      // them, which cannot be answered without its methodology.
      const resolved = await resolveMethodology(client, methodology);
      if (resolved === null && list.length > 1 && (rankBy === 'netGex' || rankBy === 'netDex')) throw defaultUnavailableError();
      const mode = resolved === null ? null : resolved.methodology;
      const answerFields = resolved === null ? { exposuresWithheld: DEFAULT_UNREADABLE } : methodologyLabel(resolved);

      if (list.length > 1) {
        const res = await client.get('/scanner/metrics/batch', { symbols: list.join(','), ...(mode === 2 ? { exposure: 'v2' } : {}) }) as any;
        if (mode === 2) requireMethodology2Envelope(res);
        return {
          ...answerFields,
          ...summarizeMetricsBatch(res, list, { rankBy, order, methodology: mode }),
          ...(mode === 2 ? { methodologyNote: BATCH_V2_NOTE } : {}),
          // Say it rather than dropping it silently: a caller that asked for
          // curves and got a comparison should know why they are absent.
          ...(curves && curves.length > 0
            ? { curvesIgnored: 'curves are single-symbol only; request one symbol to summarize them' }
            : {}),
        };
      }

      const res = await client.get(`/scanner/snapshot/${encodeURIComponent(list[0])}`) as any;
      // the route always sends its methodology-2 block; an available one that does not say methodology 2 is refused
      const block = res && typeof res === 'object' ? (res as Record<string, any>).exposureV2 : undefined;
      if (mode === 2 && block && typeof block === 'object' && block.available === true && block.methodology !== 2) {
        throw new LiveApiError('The answer asked for methodology 2 did not say it was one, so it was not used.', 502, 'UPSTREAM_INVALID', false, undefined, undefined);
      }
      const shaped = shapeOptionsSnapshot(res, { curves, curveLimit, methodology: mode });
      // a price-only or unread-chain answer carries no exposure figure, so nothing to label
      if (!shaped || typeof shaped !== 'object' || !('metrics' in shaped)) return shaped;
      return { ...answerFields, ...shaped, ...(mode === 2 ? { methodologyNote: `${METHODOLOGY_2_NOTE} ${SNAPSHOT_V2_NOTE}` } : {}) };
    }),
  );
}
