/**
 * MCP Server Setup
 *
 * Creates the McpServer instance and registers all tools.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import type { ProxyClient } from './proxy/proxyClient.js';
import type { AccessTokenProvider } from './proxy/proxyClient.js';
import { getMcpIconUrl } from './branding.js';
import { registerAllTools } from './tools/registry.js';
import { LiveApiClient } from './proxy/liveApiClient.js';

export function getMcpServerInfo(): Implementation {
  return {
    name: 'options-analysis-suite',
    title: 'Options Analysis Suite',
    version: '1.0.0',
    description: 'Options Analysis Suite MCP server for options analytics and market data tools.',
    websiteUrl: 'https://www.optionsanalysissuite.com',
    icons: [
      {
        src: getMcpIconUrl(),
        mimeType: 'image/png',
        sizes: ['512x512'],
      },
    ],
  };
}

/**
 * Both clients are built against the ProxyClient's own base URL, so they
 * cannot name different backends: this process talks to one service, and the
 * tier gate for the live tools lives there. The live client differs only in
 * keeping the structured error envelope those routes answer.
 *
 * Formerly a second client against OAS_DATA_API_URL, registered only when that
 * variable was set; the four tools it served were dark in production. There is
 * no such switch now - the tools exist wherever the proxy does.
 */
export function createMcpServer(
  proxyClient: ProxyClient,
  tokenManager: AccessTokenProvider,
): McpServer {
  const server = new McpServer(getMcpServerInfo());

  registerAllTools(server, proxyClient, tokenManager, new LiveApiClient(proxyClient.proxyUrl, tokenManager));

  return server;
}
