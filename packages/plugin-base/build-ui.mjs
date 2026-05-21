/**
 * Build the browser-loadable UI bundle for this plugin.
 *
 * Output: dist/ui.mjs — a single ESM file the daemon serves at
 *   GET /api/plugins/<id>/ui.mjs
 * and the host UI dynamically imports at runtime.
 *
 * Externals (importmap-resolved on the host):
 *   - react, react-dom, react-dom/client
 *     The host owns the React instance; we must not bundle our own or
 *     hooks break across the module boundary.
 *   - @sisyphus/kernel, @sisyphus/kernel/ui
 *     Shared contracts + UI runtime registries — the host already has
 *     them, no point duplicating.
 *
 * Everything else (sandpack, lucide bits, clsx, tailwind-merge, shadcn
 * components) is bundled in.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(__dirname, 'src/ui/index.tsx')],
  outfile: path.join(__dirname, 'dist/ui.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: [
    'react',
    'react-dom',
    'react-dom/client',
    'react/jsx-runtime',
    '@sisyphus/kernel',
    '@sisyphus/kernel/ui',
  ],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});
