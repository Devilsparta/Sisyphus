/**
 * Plugin installer — pacote-driven extraction into the user-level
 * plugins directory.
 *
 *   ~/.sisyphus/plugins-node_modules/<scope>/<pkg>/  ← extracted plugin
 *   ~/.sisyphus/plugins-node_modules/<pkg>/          ← unscoped variant
 *
 * Scope: M19 only handles the plugin's own tarball, not its npm dep tree.
 * Plugins are expected to ship with their daemon entry bundled (e.g.
 * esbuild bundle that inlines openai etc), or to depend only on packages
 * already in the daemon binary's dependency closure (kernel, hono, openai,
 * ws). Documented as a publishing requirement.
 *
 * A proper recursive installer (Arborist) is on the roadmap for the day
 * plugins start having heavy independent dep trees.
 */
import pacote from 'pacote';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const PLUGINS_ROOT = path.join(
  os.homedir(),
  '.sisyphus',
  'plugins-node_modules',
);

/**
 * Where a plugin's extracted root lives. Mirrors npm convention so
 * `import('@scope/foo')` resolves naturally when this dir is on the
 * module path.
 */
export function pluginInstallDir(packageName: string): string {
  // @scope/name → ['@scope', 'name'];  bare-name → ['name']
  return path.join(PLUGINS_ROOT, ...packageName.split('/'));
}

export async function ensurePluginsRoot(): Promise<void> {
  await fs.mkdir(PLUGINS_ROOT, { recursive: true });
}

export async function isInstalled(packageName: string): Promise<boolean> {
  try {
    await fs.access(path.join(pluginInstallDir(packageName), 'package.json'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Download + extract a plugin tarball from the configured npm registry.
 * Resolves to the on-disk install dir on success.
 */
export async function installPackage(
  packageName: string,
  version: string = 'latest',
): Promise<string> {
  await ensurePluginsRoot();
  const target = pluginInstallDir(packageName);
  // pacote.extract handles tmp + atomic-ish rename + manifests resolve.
  await pacote.extract(`${packageName}@${version}`, target);
  return target;
}

/**
 * Recursively remove a plugin's install dir. Best-effort; missing dir
 * is treated as success.
 */
export async function uninstallPackage(packageName: string): Promise<void> {
  const target = pluginInstallDir(packageName);
  await fs.rm(target, { recursive: true, force: true });
  // Clean up empty parent (scope dir) if the package was scoped.
  if (packageName.startsWith('@')) {
    const scopeDir = path.dirname(target);
    try {
      const remaining = await fs.readdir(scopeDir);
      if (remaining.length === 0) {
        await fs.rmdir(scopeDir);
      }
    } catch {
      // ignore
    }
  }
}
