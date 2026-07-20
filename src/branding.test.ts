import { describe, expect, test } from 'bun:test';
import {
  MCP_ICON_PATH,
  MCP_ICON_VERSION,
  getBrandingHomeHtml,
  getMcpIconBytes,
  getMcpIconUrl,
} from './branding.js';
import { getMcpServerInfo } from './server.js';

describe('MCP branding metadata', () => {
  test('serverInfo advertises a same-origin PNG icon', () => {
    const info = getMcpServerInfo();
    const icon = info.icons?.[0];

    expect(info.title).toBe('Options Analysis Suite');
    expect(info.websiteUrl).toBe('https://www.optionsanalysissuite.com');
    expect(icon).toBeDefined();
    expect(icon?.src).toBe(`https://mcp.optionsanalysissuite.com${MCP_ICON_PATH}?v=${MCP_ICON_VERSION}`);
    expect(icon?.mimeType).toBe('image/png');
    expect(icon?.sizes).toContain('512x512');
  });

  test('home HTML exposes same-origin favicon discovery links', () => {
    const html = getBrandingHomeHtml();

    expect(html).toContain(`href="${MCP_ICON_PATH}"`);
    expect(html).toContain('rel="icon"');
    expect(html).toContain('rel="apple-touch-icon"');
  });

  test('icon bytes are the intended opaque 512px PNG', () => {
    const icon = getMcpIconBytes();

    expect(icon.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(icon.readUInt32BE(16)).toBe(512);
    expect(icon.readUInt32BE(20)).toBe(512);
    // PNG IHDR color type 2 is truecolor RGB; color type 6 would include alpha.
    expect(icon[25]).toBe(2);
  });

  test('icon URL follows configured MCP base URL', () => {
    const url = getMcpIconUrl('https://example.test/mcp-root/');

    expect(url).toBe(`https://example.test/mcp-root${MCP_ICON_PATH}?v=${MCP_ICON_VERSION}`);
  });
});
