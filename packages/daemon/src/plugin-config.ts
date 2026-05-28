/**
 * Persisted plugin config at ~/.sisyphus/plugins.config.json.
 *
 * Schema (M19):
 *   {
 *     "installed": ["@sisylabs/plugin-base", "..."],
 *     "enabled":   ["@sisylabs/plugin-base"]
 *   }
 *
 * Legacy schema (M9, M10):
 *   { "enabled": ["..."] }       // implicit installed === enabled
 *
 * On read we auto-migrate the legacy shape (treat enabled as both
 * installed and enabled). Writes always use the new shape.
 *
 * `enabled` is a subset of `installed`. UI manages both independently:
 *   install → adds to installed (default activated unless caller opts out)
 *   enable  → adds to enabled
 *   disable → removes from enabled (stays installed)
 *   uninstall → removes from both
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CONFIG_PATH = path.join(
  os.homedir(),
  '.sisyphus',
  'plugins.config.json',
);

export interface PluginsConfig {
  installed: string[];
  enabled: string[];
}

interface LegacyConfig {
  enabled?: string[];
  installed?: string[];
}

const EMPTY: PluginsConfig = { installed: [], enabled: [] };

export async function readPluginsConfig(): Promise<PluginsConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as LegacyConfig;
    if (Array.isArray(parsed.installed)) {
      // New schema present.
      return {
        installed: [...parsed.installed],
        enabled: Array.isArray(parsed.enabled) ? [...parsed.enabled] : [],
      };
    }
    if (Array.isArray(parsed.enabled)) {
      // Legacy: enabled implies installed.
      return {
        installed: [...parsed.enabled],
        enabled: [...parsed.enabled],
      };
    }
    return { ...EMPTY };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ...EMPTY };
    // eslint-disable-next-line no-console
    console.warn(`[plugin-config] failed to read ${CONFIG_PATH}:`, err);
    return { ...EMPTY };
  }
}

export async function writePluginsConfig(cfg: PluginsConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  // Dedup + stable order so the file diff stays minimal.
  const normalized: PluginsConfig = {
    installed: [...new Set(cfg.installed)].sort(),
    enabled: [...new Set(cfg.enabled)].sort(),
  };
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2));
  await fs.rename(tmp, CONFIG_PATH);
}

export function addInstalled(
  cfg: PluginsConfig,
  packageName: string,
  alsoEnable = true,
): PluginsConfig {
  const installed = cfg.installed.includes(packageName)
    ? cfg.installed
    : [...cfg.installed, packageName];
  const enabled = alsoEnable && !cfg.enabled.includes(packageName)
    ? [...cfg.enabled, packageName]
    : cfg.enabled;
  return { installed, enabled };
}

export function removeInstalled(
  cfg: PluginsConfig,
  packageName: string,
): PluginsConfig {
  return {
    installed: cfg.installed.filter((n) => n !== packageName),
    enabled: cfg.enabled.filter((n) => n !== packageName),
  };
}

export function setEnabled(
  cfg: PluginsConfig,
  packageName: string,
  enabled: boolean,
): PluginsConfig {
  if (enabled) {
    if (!cfg.installed.includes(packageName)) {
      throw new Error(`Cannot enable "${packageName}" — not installed`);
    }
    return cfg.enabled.includes(packageName)
      ? cfg
      : { ...cfg, enabled: [...cfg.enabled, packageName] };
  }
  return { ...cfg, enabled: cfg.enabled.filter((n) => n !== packageName) };
}
