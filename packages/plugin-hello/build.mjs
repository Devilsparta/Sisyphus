#!/usr/bin/env node
// Bundle plugin-hello as a single ESM file the daemon can load without
// tsx. The SEA daemon binary has no TypeScript loader, so prod-style
// plugins must ship pre-compiled JS — this script mirrors what an npm
// publish would produce.
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
  // @sisyphus/kernel is a types-only dep for this plugin; the `import type`
  // declarations are erased by esbuild, but keep the external in case
  // some runtime usage gets added later.
  '--external:@sisyphus/kernel',
  '--legal-comments=none',
];

const r = spawnSync(esbuildBin, args, { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
