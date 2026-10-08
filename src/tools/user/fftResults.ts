import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { syncedDataOutputSchema } from '../outputSchemas.js';
import { TRUNCATION_THRESHOLD, shapeRecord, truncateRecord, trimToSizeBudget, humanizeSignalsDeep } from './fftResponseShaping.js';
import { sanitizeFullSyncResponse, stripSyncRecordMetadata } from './syncResponseShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_fft_results',
    {
      title: 'FFT Scanner Results',
      description: 'Get the user\'s FFT (Fast Fourier Transform) scanner results — characteristic function-based option pricing signals across multiple models and expirations. Shows which models detected opportunities, calibration quality, and pricing anomalies. Each position\'s per-model Greeks are the pricer\'s raw output for one share of one contract, not sized by quantity or the 100 multiplier and not signed by long or short: delta and gamma as usual, vega and rho per 1.00 change (100x a per-1% figure), and theta per year in the mathematical direction, the opposite sign of the usual daily decay figure: the web app\'s equity convention divides by 252 trading days and flips the sign, so 141.92 per year is about -0.56 a day (usually positive for a long option, though not always: a deep in-the-money put can be negative). For Heston and Bates, vega is the sensitivity to the starting volatility only, a different quantity from the other models\' vega, so the two are not comparable and either can be the larger. A model marked actionable false (calibrationStatus and qualityReasons say why, e.g. calibration_failed) priced from default parameters after its calibration failed: its price and signal are shown but are not counted in the position\'s agreement or average model price, and its Greeks can be empty. Positions saved before 2026-10-01 carry no such mark, and their agreement and average can include such a model.',
      inputSchema: {
        symbol: z.string().optional().describe('Filter by ticker symbol'),
        limit: z.number().int().min(1).max(50).default(10).describe('Max results (default 10)'),
        since: z.string().optional().describe('Only results after this date (ISO format)'),
        full: z.boolean().default(false).describe('Return less-summarized sanitized data including nested model outputs and calibration parameters, still subject to the MCP response budget'),
      },
      outputSchema: syncedDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, limit, since, full }) => {
      const params: Record<string, string> = { type: 'fft', limit: String(limit) };
      if (symbol) params.symbol = symbol;
      if (since) params.since = since;
      const res = await client.get('/sync/analysis-data', params) as any;
      // Strip camelCase / snake_case enum leaks (signal: 'strongSell',
      // agreement: 'majority_buy', etc.) before either return path runs.
	      humanizeSignalsDeep(res);
	      if (full && res != null) {
	        sanitizeFullSyncResponse(res);
	        return { _skipSizeGuard: true, data: res };
	      }

      if (res && Array.isArray(res.data)) {
        // Pass 1: flatten nested objects, preserving calibration/summary/bestValues
        for (const record of res.data) {
          stripSyncRecordMetadata(record);
          shapeRecord(record);
        }

        // Pass 2: only truncate large arrays if response exceeds size threshold
        if (JSON.stringify(res).length > TRUNCATION_THRESHOLD) {
          for (const record of res.data) truncateRecord(record);
        }

        // Pass 3: if still oversized, drop oldest records via the exported
        // helper. Leaves headroom below the 50 KB hard limit so the generic
        // size guard never silently collapses the response.
        trimToSizeBudget(res);
      }
      return res;
    }, { isSyncTool: true }),
  );
}
