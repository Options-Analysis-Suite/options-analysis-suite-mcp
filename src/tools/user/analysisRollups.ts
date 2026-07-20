import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { syncedDataOutputSchema } from '../outputSchemas.js';
import { humanizeAnalysisWireOutput, sanitizeFullSyncResponse, stripSyncRecordMetadata } from './syncResponseShaping.js';
import { summarizeAnalysisRollupsResponse } from './analysisRollupsShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_analysis_rollups',
    {
      title: 'Analysis Rollups',
      description: 'Get pre-computed daily or weekly aggregates of the user\'s analysis activity per symbol. Default response returns compact rollup rows plus a cross-period summary of volatility, spot, and model usage trends.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol'),
        period: z.enum(['day', 'week']).default('day').describe('Aggregation period'),
        limit: z.number().int().min(1).max(90).default(10).describe('Max periods (default 10). Increase up to 90 for longer trends.'),
        full: z.boolean().default(false).describe('Return less-summarized sanitized synced rollup rows instead of the compact summary view.'),
      },
      outputSchema: syncedDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, period, limit, full }) => {
      const res = await client.get('/sync/analysis-data', { type: 'rollups', symbol, period, limit: String(limit) }) as any;
	      if (full && res != null) {
	        humanizeAnalysisWireOutput(res);
	        sanitizeFullSyncResponse(res, { topLevelKeys: ['id', 'user_id', 'created_at', 'key'], dataKeys: ['id', 'user_id', 'key'] });
	        return { _skipSizeGuard: true, data: res };
	      }
      if (res && Array.isArray(res.data)) {
        for (const record of res.data) {
          stripSyncRecordMetadata(record, { topLevelKeys: ['id', 'user_id', 'created_at', 'key'], dataKeys: ['id', 'user_id', 'key'] });
        }
      }
      return summarizeAnalysisRollupsResponse(res);
    }, { isSyncTool: true }),
  );
}
