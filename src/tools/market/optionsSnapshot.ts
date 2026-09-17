import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveApiClient } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { shapeOptionsSnapshot, summarizeMetricsBatch } from './optionsSnapshotShaping.js';

const MAX_BATCH_SYMBOLS = 50;

/**
 * The EOD options snapshot, and the multi-symbol comparison, from the proxy's
 * /scanner/snapshot/:symbol and /scanner/metrics/batch. Both are anonymous
 * there, so this tool carries no tier requirement.
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
        + 'Pass several comma-separated symbols (up to 50) to compare their headline metrics in ONE request instead of calling this repeatedly. '
        + 'This is platform data for any symbol - use get_snapshot instead for the GEX, portfolio and risk snapshots synced from the user\'s own browser session, which is a different dataset. '
        + 'Set `curves` to summarize the per-strike payloads: the max-pain curve with its true minimum, per-strike GEX or DEX with totals, or the volatility skew. Curves are omitted by default because they are large. '
        + 'Data is end-of-day from the last completed session, not intraday; use get_live_options_chain for live prices. '
        + 'Any symbol the platform holds an options snapshot for, futures contracts with listed options included. A symbol it holds only a price row for reports that rather than returning empty metrics.',
      inputSchema: {
        symbols: z.string()
          .describe('One ticker for the full snapshot, or a comma-separated list (up to 50) for a headline-metrics comparison.'),
        curves: z.array(z.enum(['maxPain', 'gex', 'dex', 'skew'])).optional()
          .describe('Which per-strike curves to summarize. Single-symbol only; ignored for a multi-symbol request.'),
        curveLimit: z.number().int().min(1).max(40).optional()
          .describe('Rows kept per curve, centred on spot. Default 12.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbols, curves, curveLimit }) => {
      const list = symbols.split(',')
        .map((symbol) => symbol.trim().toUpperCase())
        .filter((symbol) => symbol.length > 0);

      if (list.length === 0) {
        throw new Error('symbols must name at least one ticker');
      }
      if (list.length > MAX_BATCH_SYMBOLS) {
        throw new Error(`symbols accepts at most ${MAX_BATCH_SYMBOLS} tickers; received ${list.length}`);
      }

      if (list.length > 1) {
        const res = await client.get('/scanner/metrics/batch', { symbols: list.join(',') }) as any;
        return {
          ...summarizeMetricsBatch(res, list),
          // Say it rather than dropping it silently: a caller that asked for
          // curves and got a comparison should know why they are absent.
          ...(curves && curves.length > 0
            ? { curvesIgnored: 'curves are single-symbol only; request one symbol to summarize them' }
            : {}),
        };
      }

      const res = await client.get(`/scanner/snapshot/${encodeURIComponent(list[0])}`) as any;
      return shapeOptionsSnapshot(res, { curves, curveLimit });
    }),
  );
}
