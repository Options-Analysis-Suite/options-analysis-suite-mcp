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

export function createMcpServer(
  proxyClient: ProxyClient,
  tokenManager: AccessTokenProvider,
): McpServer {
  const server = new McpServer(getMcpServerInfo());

  registerAllTools(server, proxyClient, tokenManager);

  return server;
}
