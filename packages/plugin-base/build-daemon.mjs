#!/usr/bin/env node
/**
 * Bundle plugin-base's daemon entry for npm publish.
 *
 * Output: dist/index.mjs — a single ESM file the daemon's plugin host
 * runtime dynamic-imports as the plugin's daemon-side entry. The SEA
 * Node runtime has no TypeScript loader, so this MUST be pre-compiled.
 *
 * External (treated as runtime deps by the consumer):
 *   - @sisylabs/kernel: type-only, but kept external in case anything
 *     leaks through. Listed as peer + dev dep in package.json.
 *   - openai: runtime dep used by react-designer + assistant agents.
 *   - node:* built-ins: auto-external via platform=node.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const esbuildBin = resolve(repoRoot, 'node_modules/.bin/esbuild');

const args = [
  resolve(__dirname, 'src/index.ts'),
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--target=node22',
  `--outfile=${resolve(__dirname, 'dist/index.mjs')}`,
  '--external:@sisylabs/kernel',
  '--external:openai',
  '--legal-comments=none',
];

const r = spawnSync(esbuildBin, args, { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
