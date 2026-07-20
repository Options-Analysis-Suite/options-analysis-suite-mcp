/**
 * Build script for MCP server.
 *
 * Modes:
 *   (default)   Bundles src/index.ts → dist/index.js (stdio, Claude Desktop)
 *   --remote    Bundles src/remote.ts → dist-remote/remote.js (HTTP, Perplexity)
 *   --pack      Also packages dist/ as .mcpb
 */
import { mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const isRemote = process.argv.includes('--remote');
const pack = process.argv.includes('--pack');

if (isRemote) {
  // --- Remote (Streamable HTTP) build ---
  const DIST = './dist-remote';
  await mkdir(DIST, { recursive: true });

  const result = await Bun.build({
    entrypoints: ['./src/remote.ts'],
    outdir: DIST,
    target: 'node',
    format: 'esm',
    minify: true,
    sourcemap: 'external',
  });

  if (!result.success) {
    console.error('Remote build failed:');
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  await copyFile('./mcp-icon.png', `${DIST}/mcp-icon.png`);

  console.log('✓ Bundle: dist-remote/remote.js');
  console.log('✓ Copied mcp-icon.png to dist-remote/');
  console.log('\nRemote build complete. Deploy dist-remote/ to Railway.');
} else {
  // --- Stdio (Claude Desktop) build ---
  const DIST = './dist';
  await mkdir(DIST, { recursive: true });

  const result = await Bun.build({
    entrypoints: ['./src/index.ts'],
    outdir: DIST,
    target: 'node',
    format: 'esm',
    minify: true,
    sourcemap: 'external',
  });

  if (!result.success) {
    console.error('Build failed:');
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  console.log('✓ Bundle: dist/index.js');

  // Copy assets for .mcpb
  await copyFile('./manifest.json', `${DIST}/manifest.json`);
  await copyFile('./README.md', `${DIST}/README.md`);
  for (const icon of ['icon-512.png', 'icon-96.png', 'icon-180.png']) {
    if (existsSync(`./${icon}`)) {
      await copyFile(`./${icon}`, `${DIST}/${icon}`);
    }
  }
  console.log('✓ Copied manifest.json, README.md, and icons to dist/');

  if (pack) {
    console.log('\nPackaging .mcpb...');
    const proc = Bun.spawn(['npx', '@anthropic-ai/mcpb', 'pack', DIST, './options-analysis-suite.mcpb'], {
      stdout: 'inherit',
      stderr: 'inherit',
      cwd: process.cwd(),
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error('mcpb pack failed. Install with: npm install -g @anthropic-ai/mcpb');
      process.exit(1);
    }
    console.log('✓ Package: options-analysis-suite.mcpb');
  } else {
    console.log('\nBuild complete. Run with --pack to create .mcpb package.');
  }
}
