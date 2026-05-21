/**
 * Plugin loader — resolves which plugin packages live on disk and
 * imports their daemon entry.
 *
 * Resolution order for a given package name:
 *   1. ~/.sisyphus/plugins-node_modules/<scope>/<name>/  (installed via pacote)
 *   2. daemon's own node_modules (monorepo dev mode — workspace symlink)
 *
 * If a name fails to load, callers log and skip; one broken plugin
 * shouldn't take down the daemon.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type { SisyphusPlugin } from '@sisyphus/kernel';
import { pluginInstallDir } from './plugin-installer';

export interface LoadedPlugin {
  packageName: string;
  plugin: SisyphusPlugin;
  /** Absolute filesystem path of the package root. */
  packageRoot: string;
  /** Absolute path of the UI bundle, or null if not built / not declared. */
  uiBundlePath: string | null;
}

const DEFAULT_UI_ENTRY = './dist/ui.mjs';

const requireFromHere = createRequire(import.meta.url);

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

interface ResolvedPackage {
  packageRoot: string;
  /** Absolute path / URL to pass to dynamic import for the daemon entry. */
  daemonEntrySpec: string;
}

async function resolvePackage(pkgName: string): Promise<ResolvedPackage> {
  // 1. Try user-level installed plugin dir.
  const userDir = pluginInstallDir(pkgName);
  if (await fileExists(path.join(userDir, 'package.json'))) {
    const pkg = JSON.parse(
      await fs.readFile(path.join(userDir, 'package.json'), 'utf-8'),
    ) as { main?: string; exports?: unknown };
    const main = resolveDaemonEntry(pkg, userDir);
    return {
      packageRoot: userDir,
      daemonEntrySpec: pathToFileURL(main).href,
    };
  }

  // 2. Fallback: daemon's own node_modules (monorepo workspace symlink).
  try {
    const pkgJsonPath = requireFromHere.resolve(`${pkgName}/package.json`);
    const root = path.dirname(pkgJsonPath);
    return {
      packageRoot: root,
      // Let Node resolve through the bare specifier (exports field etc).
      daemonEntrySpec: pkgName,
    };
  } catch (err) {
    throw new Error(
      `Plugin "${pkgName}" not installed in ${userDir} and not in daemon node_modules. ` +
        (err instanceof Error ? err.message : ''),
    );
  }
}

function resolveDaemonEntry(
  pkg: { main?: string; exports?: unknown },
  root: string,
): string {
  // Prefer exports['.']['default'] / exports['.'] / main / 'index.js'.
  const exp = pkg.exports as
    | string
    | Record<string, unknown>
    | undefined;
  if (typeof exp === 'string') {
    return path.resolve(root, exp);
  }
  if (exp && typeof exp === 'object') {
    const dot = (exp as Record<string, unknown>)['.'];
    if (typeof dot === 'string') return path.resolve(root, dot);
    if (dot && typeof dot === 'object') {
      const conds = dot as Record<string, unknown>;
      for (const key of ['default', 'import', 'node', 'require']) {
        const v = conds[key];
        if (typeof v === 'string') return path.resolve(root, v);
      }
    }
  }
  if (pkg.main) return path.resolve(root, pkg.main);
  return path.resolve(root, 'index.js');
}

export async function loadPlugin(pkgName: string): Promise<LoadedPlugin> {
  const resolved = await resolvePackage(pkgName);

  const mod = (await import(resolved.daemonEntrySpec)) as {
    default?: SisyphusPlugin;
  };
  const plugin = mod.default;
  if (!plugin || typeof plugin !== 'object' || !plugin.manifest?.id) {
    throw new Error(
      `${pkgName} does not export a valid SisyphusPlugin (manifest.id missing)`,
    );
  }

  const uiEntry = plugin.manifest.uiEntry ?? DEFAULT_UI_ENTRY;
  let uiBundlePath: string | null = null;
  if (uiEntry) {
    const candidate = path.resolve(resolved.packageRoot, uiEntry);
    if (await fileExists(candidate)) {
      uiBundlePath = candidate;
    }
  }

  return {
    packageName: pkgName,
    plugin,
    packageRoot: resolved.packageRoot,
    uiBundlePath,
  };
}
