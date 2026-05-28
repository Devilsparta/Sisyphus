#!/usr/bin/env node
/**
 * Bundle plugin-todo's daemon entry for npm publish.
 *
 * Output: dist/index.mjs — single ESM file the daemon plugin-host
 * runtime dynamic-imports. The SEA Node runtime has no tsx loader, so
 * this MUST be pre-compiled.
 *
 * External:
 *   - @sisylabs/kernel: type-only.
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
  '--legal-comments=none',
];

const r = spawnSync(esbuildBin, args, { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
