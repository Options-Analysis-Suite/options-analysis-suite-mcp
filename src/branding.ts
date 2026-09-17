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
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: radial-gradient(1200px 600px at 50% -10%, rgba(59, 130, 246, 0.07) 0%, transparent 60%), linear-gradient(180deg, #ffffff 0%, #fbfcfd 100%); color: #111827; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; padding: 48px 16px; line-height: 1.5; }
      .card { width: 100%; max-width: 440px; padding: 32px 32px 28px; background: linear-gradient(165deg, #ffffff 0%, #fbfcfd 100%); border: 1px solid rgba(59, 130, 246, 0.12); border-radius: 14px; box-shadow: 0 1px 2px -1px rgba(15, 23, 42, 0.04), 0 8px 24px -12px rgba(15, 23, 42, 0.08); }
      .brand { font-size: 0.72rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 12px; }
      h1 { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.25; color: #111827; margin-bottom: 8px; }
      p { font-size: 0.95rem; color: #6b7280; }
      @media (max-width: 480px) { body { padding: 24px 12px; } .card { padding: 24px 20px 22px; border-radius: 12px; } h1 { font-size: 1.35rem; } }
    </style>
  </head>
  <body>
    <div class="card">
      <p class="brand">Options Analysis Suite</p>
      <h1>Options Analysis Suite MCP</h1>
      <p>Remote Model Context Protocol server for Options Analysis Suite.</p>
    </div>
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
