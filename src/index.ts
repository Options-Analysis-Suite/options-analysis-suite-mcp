/**
 * MCP Server Entry Point
 *
 * Runs as a stdio process for Claude Desktop extension.
 * Reads config from environment variables (set by Claude Desktop from manifest).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TokenManager } from './auth/tokenManager.js';
import { ProxyClient } from './proxy/proxyClient.js';
import { createMcpServer } from './server.js';
import type { McpConfig } from './types.js';

function getConfig(): McpConfig {
  // Env vars are set by Claude Desktop via manifest.json server.mcp_config.env
  // which maps user_config fields to OAS_* prefixed env vars.
  return {
    email: process.env.OAS_EMAIL || '',
    password: process.env.OAS_PASSWORD || '',
    proxyUrl: process.env.OAS_PROXY_URL || 'https://proxy.optionsanalysissuite.com',
    authServerUrl: process.env.OAS_AUTH_SERVER_URL || 'https://api.optionsanalysissuite.com',
  };
}

async function main(): Promise<void> {
  const config = getConfig();

  process.stderr.write(`[OAS MCP] Config: email=${config.email ? 'set' : 'MISSING'}, authUrl=${config.authServerUrl}, proxyUrl=${config.proxyUrl}\n`);

  if (!config.email || !config.password) {
    process.stderr.write('[OAS MCP] ERROR: Missing email or password. Configure in Claude Desktop extension settings.\n');
    process.exit(1);
  }

  // Authenticate
  const tokenManager = new TokenManager(config.authServerUrl, config.email, config.password);
  try {
    process.stderr.write(`[OAS MCP] Authenticating as ${config.email}...\n`);
    await tokenManager.initialize();
    process.stderr.write('[OAS MCP] Authenticated successfully.\n');
  } catch (err: any) {
    process.stderr.write(`[OAS MCP] Authentication failed: ${err.message}\n`);
    process.exit(1);
  }

  // Create proxy client
  const proxyClient = new ProxyClient(config.proxyUrl, tokenManager);

  // Create and start MCP server
  const server = createMcpServer(proxyClient, tokenManager);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  process.on('SIGINT', () => {
    tokenManager.destroy();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    tokenManager.destroy();
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`[OAS MCP] FATAL: ${err.message}\n`);
  process.exit(1);
});
