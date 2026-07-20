import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MCP_BASE_URL = 'https://mcp.optionsanalysissuite.com';

export const MCP_ICON_PATH = '/mcp-icon.png';
export const MCP_ICON_VERSION = '20260502';
export const MCP_ICON_CONTENT_TYPE = 'image/png';

export function getMcpBaseUrl(baseUrl = process.env.OAS_MCP_BASE_URL || DEFAULT_MCP_BASE_URL): string {
  return baseUrl.replace(/\/+$/, '');
}

export function getMcpIconUrl(baseUrl?: string): string {
  return `${getMcpBaseUrl(baseUrl)}${MCP_ICON_PATH}?v=${MCP_ICON_VERSION}`;
}

export function getBrandingHomeHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Options Analysis Suite MCP</title>
    <link rel="icon" type="image/png" sizes="512x512" href="${MCP_ICON_PATH}">
    <link rel="apple-touch-icon" href="${MCP_ICON_PATH}">
  </head>
  <body>
    <h1>Options Analysis Suite MCP</h1>
    <p>Remote Model Context Protocol server for Options Analysis Suite.</p>
  </body>
</html>`;
}

export function getMcpIconBytes(): Buffer {
  for (const path of iconPathCandidates()) {
    if (existsSync(path)) return readFileSync(path);
  }
  throw new Error('MCP icon asset not found');
}

function iconPathCandidates(): string[] {
  return [
    join(process.cwd(), 'mcp-icon.png'),
    fileURLToPath(new URL('../mcp-icon.png', import.meta.url)),
    fileURLToPath(new URL('./mcp-icon.png', import.meta.url)),
  ];
}
