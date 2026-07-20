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
      description: 'Get the user\'s FFT (Fast Fourier Transform) scanner results — characteristic function-based option pricing signals across multiple models and expirations. Shows which models detected opportunities, calibration quality, and pricing anomalies.',
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
