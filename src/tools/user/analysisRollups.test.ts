import { describe, expect, test } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { register } from './analysisRollups.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }> }>;

function createHarness(stubResponse: any) {
  const fakeClient = { get: async () => structuredClone(stubResponse), post: async () => ({}) } as unknown as ProxyClient;
  const captured: { handler: ToolHandler | null } = { handler: null };
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, handler: ToolHandler) => { captured.handler = handler; },
  } as unknown as McpServer;
  register(fakeServer, fakeClient);
  if (!captured.handler) throw new Error('Tool handler not captured');
  return captured.handler;
}

// The time-convention change: the full rollup rows state avgTheta's convention - legacy for a row computed before or a legacy-only
// period - and the units line says what each means
describe('get_analysis_rollups full view time convention', () => {
  test('states each row in place and carries the Theta unit', async () => {
    const row = (period_start: number, extra: Record<string, unknown>) => ({
      symbol: 'SPY', period: 'day', period_start,
      data: { count: 2, avgTheta: -0.04, avgVol: 0.2, minVol: 0.2, maxVol: 0.2, avgSpot: 500, models: ['MonteCarlo'], avgVegaUnit: 'per_vol_point', ...extra },
    });
    const handler = createHarness({
      data: [row(1, { avgThetaConvention: 'time-passing', avgThetaBasis: 'tradingDay', thetaCount: 2, legacyThetaExcluded: 0 }), row(2, {})],
      count: 2,
    });
    const parsed = JSON.parse((await handler({ limit: 2, full: true })).content[0].text);
    expect(parsed.data.map((r: any) => r.data.avgThetaConvention)).toEqual(['time-passing', 'legacy: model-dependent time sign']);
    expect(parsed.data[0].data.avgThetaBasis).toBe('tradingDay');
    expect(parsed.units.avgTheta).toContain('the day avgThetaBasis names');
  });
});
