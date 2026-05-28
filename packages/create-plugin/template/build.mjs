#!/usr/bin/env node
/**
 * Bundle src/index.ts → dist/index.mjs for npm publish.
 *
 * The Sisyphus daemon runs your plugin in a child process with a SEA
 * Node runtime that has no TypeScript loader — production plugins must
 * ship pre-compiled JavaScript. esbuild does that in ~20ms.
 *
 * External:
 *   - @sisylabs/kernel: types only at compile time, peer-dep'd at runtime
 *     so the host doesn't ship a duplicate copy. (Actually erased
 *     entirely if you only use type imports.)
 *   - node:* built-ins: auto-external on --platform=node.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const esbuildBin = resolve(
  __dirname,
  'node_modules/.bin/esbuild',
);

const r = spawnSync(
  esbuildBin,
  [
    resolve(__dirname, 'src/index.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node22',
    `--outfile=${resolve(__dirname, 'dist/index.mjs')}`,
    '--external:@sisylabs/kernel',
    '--legal-comments=none',
  ],
  { stdio: 'inherit' },
);
if (r.status !== 0) process.exit(r.status ?? 1);
