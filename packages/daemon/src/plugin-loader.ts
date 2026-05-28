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
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { SisyphusPlugin } from '@sisylabs/kernel';
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

// In ESM (tsx dev), use import.meta.url. In CJS bundle (SEA build), import.meta.url
// is undefined — fall back to __filename, which esbuild populates with the bundle
// path. Prod doesn't hit the fallback resolve path anyway (plugins live under
// ~/.sisyphus/plugins-node_modules), but tsx dev mode does.
const requireFromHere = createRequire(
  (import.meta as { url?: string }).url ??
    (typeof __filename === 'string' ? __filename : process.execPath),
);

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
  // Resolve through to an absolute path so the broker can pass it to a
  // child process — bare specifiers don't work as spawn args.
  try {
    const pkgJsonPath = requireFromHere.resolve(`${pkgName}/package.json`);
    const root = path.dirname(pkgJsonPath);
    const pkg = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8')) as {
      main?: string;
      exports?: unknown;
    };
    const main = resolveDaemonEntry(pkg, root);
    return {
      packageRoot: root,
      daemonEntrySpec: pathToFileURL(main).href,
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

/**
 * M24: path-only resolution for the plugin broker. Returns absolute
 * filesystem paths the broker can pass to a child process via
 * SISYPHUS_PLUGIN_ENTRY without ever loading the plugin in this process.
 *
 * Unlike `loadPlugin`, this does NOT import the entry — pure path math.
 */
export interface ResolvedPluginPaths {
  packageName: string;
  packageRoot: string;
  daemonEntryPath: string;
  uiBundlePath: string | null;
  /**
   * The plugin's manifest id, pre-read from package.json's `sisyphus.id`
   * field so the broker can route per-plugin storage / log namespacing
   * BEFORE the child process has had a chance to reply to `activate`
   * (which is the only RPC that returns the live manifest). When the
   * package omits the sisyphus block this falls back to the package name.
   */
  pluginId: string;
}

export async function resolvePluginPaths(
  pkgName: string,
): Promise<ResolvedPluginPaths> {
  const resolved = await resolvePackage(pkgName);
  const daemonEntryPath = fileURLToPath(resolved.daemonEntrySpec);

  // We don't know the manifest's uiEntry without loading the module, so
  // probe the default './dist/ui.mjs' location. Plugins with a custom
  // uiEntry will need to declare it in the package.json sisyphus field if
  // they want the broker to pick it up — TODO M24.x: read uiEntry from
  // package.json's "sisyphus" block (it already lives there for the
  // marketplace) without doing a full module load.
  const uiCandidate = path.resolve(resolved.packageRoot, DEFAULT_UI_ENTRY);
  const uiBundlePath = (await fileExists(uiCandidate)) ? uiCandidate : null;

  // Pre-read the manifest id from package.json so the broker can namespace
  // storage / logs from the very first RPC. The full live manifest still
  // travels in the activate reply.
  let pluginId = pkgName;
  try {
    const pkgJson = JSON.parse(
      await fs.readFile(path.join(resolved.packageRoot, 'package.json'), 'utf-8'),
    ) as { sisyphus?: { id?: string } };
    if (pkgJson.sisyphus?.id) pluginId = pkgJson.sisyphus.id;
  } catch {
    // Keep pkgName fallback; broker will warn if activate reply disagrees.
  }

  return {
    packageName: pkgName,
    packageRoot: resolved.packageRoot,
    daemonEntryPath,
    uiBundlePath,
    pluginId,
  };
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
