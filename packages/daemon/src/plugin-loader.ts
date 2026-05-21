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
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SisyphusPlugin } from '@sisyphus/kernel';

const CONFIG_PATH = path.join(os.homedir(), '.sisyphus', 'plugins.config.json');

const DEFAULT_PLUGINS: string[] = [
  '@sisyphus/plugin-base',
  '@sisyphus/plugin-todo',
];

interface PluginsConfig {
  enabled?: string[];
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

export async function loadPlugin(pkgName: string): Promise<SisyphusPlugin> {
  const mod = (await import(pkgName)) as { default?: SisyphusPlugin };
  const plugin = mod.default;
  if (!plugin || typeof plugin !== 'object' || !plugin.manifest?.id) {
    throw new Error(
      `${pkgName} does not export a valid SisyphusPlugin (manifest.id missing)`,
    );
  }
  return plugin;
}
