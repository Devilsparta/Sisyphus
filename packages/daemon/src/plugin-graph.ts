/**
 * Topological sort + validation for plugin dependencies.
 *
 * Each plugin declares `manifest.dependencies: string[]` (other plugin
 * ids). Activation order must respect that graph — a plugin's onActivate
 * runs after its deps' onActivate, so when it queries the registry the
 * dependency's contributions are already there.
 *
 * Errors thrown:
 *   - missing dep (a listed dependency isn't in the loaded set)
 *   - cycle (transitive self-dependency)
 *
 * The loader catches these per-plugin so a misconfigured plugin is skipped
 * without poisoning the rest.
 */
import type { SisyphusPlugin } from '@sisylabs/kernel';

export function topoSortPlugins(plugins: SisyphusPlugin[]): SisyphusPlugin[] {
  const byId = new Map<string, SisyphusPlugin>();
  for (const p of plugins) {
    if (byId.has(p.manifest.id)) {
      throw new Error(`Duplicate plugin id: "${p.manifest.id}"`);
    }
    byId.set(p.manifest.id, p);
  }

  const sorted: SisyphusPlugin[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(id: string, path: string[]): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(
        `Circular plugin dependency: ${[...path, id].join(' → ')}`,
      );
    }
    const p = byId.get(id);
    if (!p) {
      throw new Error(
        `Plugin "${path[path.length - 1] ?? '?'}" depends on missing plugin "${id}"`,
      );
    }
    visiting.add(id);
    for (const dep of p.manifest.dependencies ?? []) {
      visit(dep, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
    sorted.push(p);
  }

  for (const p of plugins) {
    visit(p.manifest.id, []);
  }

  return sorted;
}
