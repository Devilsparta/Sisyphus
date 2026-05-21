/**
 * Build the browser-loadable UI bundle for plugin-todo.
 * See packages/plugin-base/build-ui.mjs for design notes.
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
