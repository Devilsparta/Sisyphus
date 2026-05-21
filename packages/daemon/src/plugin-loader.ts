/**
 * Plugin loader — resolves which plugins to activate at boot.
 *
 * Reads ~/.sisyphus/plugins.config.json:
 *   { "enabled": ["@sisyphus/plugin-base", "@sisyphus/plugin-todo", ...] }
 *
 * Falls back to a built-in default list (the two workspace plugins) when:
 *   - the file doesn't exist (typical dev setup)
 *   - or it exists but `enabled` is missing
 *
 * Each enabled name is `await import()`-ed; pnpm symlinks workspace
 * packages into node_modules so workspace plugins resolve naturally. External
 * npm plugins need to be pnpm-added to the daemon package first — we don't
 * shell out to npm at runtime.
 *
 * If a name fails to load, we log and skip it rather than crash, so a broken
 * third-party plugin doesn't take down the daemon for the rest.
 *
 * Also resolves the plugin's package root + UI bundle path so the daemon
 * can later serve <root>/<uiEntry> over HTTP for browser dynamic import.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import type { SisyphusPlugin } from '@sisyphus/kernel';

const CONFIG_PATH = path.join(os.homedir(), '.sisyphus', 'plugins.config.json');

const DEFAULT_PLUGINS: string[] = [
  '@sisyphus/plugin-base',
  '@sisyphus/plugin-todo',
];

const DEFAULT_UI_ENTRY = './dist/ui.mjs';

interface PluginsConfig {
  enabled?: string[];
}

export interface LoadedPlugin {
  packageName: string;
  plugin: SisyphusPlugin;
  /** Absolute filesystem path of the package root (where package.json sits). */
  packageRoot: string;
  /** Absolute path of the UI bundle, or null if not built / not declared. */
  uiBundlePath: string | null;
}

export async function resolveEnabledPlugins(): Promise<string[]> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw) as PluginsConfig;
    if (Array.isArray(cfg.enabled)) return cfg.enabled;
    return DEFAULT_PLUGINS;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // eslint-disable-next-line no-console
      console.error(
        `[plugin-loader] failed to read ${CONFIG_PATH}, using defaults:`,
        err,
      );
    }
    return DEFAULT_PLUGINS;
  }
}

const requireFromHere = createRequire(import.meta.url);

function resolvePackageRoot(pkgName: string): string {
  // require.resolve('@scope/pkg/package.json') is the standard trick for
  // finding a package's directory regardless of where node_modules lives.
  const pkgJson = requireFromHere.resolve(`${pkgName}/package.json`);
  return path.dirname(pkgJson);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function loadPlugin(pkgName: string): Promise<LoadedPlugin> {
  const mod = (await import(pkgName)) as { default?: SisyphusPlugin };
  const plugin = mod.default;
  if (!plugin || typeof plugin !== 'object' || !plugin.manifest?.id) {
    throw new Error(
      `${pkgName} does not export a valid SisyphusPlugin (manifest.id missing)`,
    );
  }

  // Locate package root and check for a UI bundle.
  let packageRoot: string;
  try {
    packageRoot = resolvePackageRoot(pkgName);
  } catch (err) {
    throw new Error(
      `Failed to resolve package root for ${pkgName}: ${err instanceof Error ? err.message : err}`,
    );
  }

  const uiEntry = plugin.manifest.uiEntry ?? DEFAULT_UI_ENTRY;
  let uiBundlePath: string | null = null;
  if (uiEntry) {
    const candidate = path.resolve(packageRoot, uiEntry);
    if (await fileExists(candidate)) {
      uiBundlePath = candidate;
    }
  }

  return { packageName: pkgName, plugin, packageRoot, uiBundlePath };
}
