/**
 * Dev-mode plugin watcher.
 *
 * Activated by SISYPHUS_DEV=1. Two things are watched per activated
 * plugin:
 *
 *   1. uiBundlePath — when this file changes, broadcast a
 *      `plugin.ui.bundle.changed` WS event so the UI cache-busts its
 *      dynamic import. Daemon stays running; the React side hot-reloads
 *      just that plugin.
 *
 *   2. daemonEntryPath (M24.5) — when the bundled daemon-side code
 *      changes, call respawn(packageName). Plugin-manager deactivates +
 *      activates so a fresh child process picks up the new code. UI
 *      stays connected.
 *
 * Each path debounces 100 ms because esbuild typically writes a rebuild
 * in multiple chunks.
 */
import { watch, type FSWatcher } from 'node:fs';
import { KernelEvents } from '@sisylabs/kernel';
import type { Registry } from './registry';
import type { PluginManager } from './plugin-manager';

const DEBOUNCE_MS = 100;

export interface DevWatcher {
  start(): void;
  stop(): void;
}

export function isDevModeEnabled(): boolean {
  return process.env.SISYPHUS_DEV === '1' || process.env.SISYPHUS_DEV === 'true';
}

export function createDevWatcher(
  registry: Registry,
  broadcast: <T>(event: string, data: T) => void,
  pluginManager: PluginManager,
): DevWatcher {
  const watchers: FSWatcher[] = [];
  const uiVersions = new Map<string, number>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let started = false;

  const debounce = (key: string, fn: () => void): void => {
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      key,
      setTimeout(() => {
        debounceTimers.delete(key);
        fn();
      }, DEBOUNCE_MS),
    );
  };

  return {
    start() {
      if (started) return;
      started = true;

      const records = registry.queryPluginRecords();
      const activated = new Map(
        pluginManager.listActivated().map((r) => [r.manifest.id, r]),
      );

      for (const record of records) {
        const pluginId = record.manifest.id;

        // 1. UI bundle — broadcast cache-bust to the browser.
        if (record.uiBundlePath) {
          uiVersions.set(pluginId, 0);
          try {
            const w = watch(record.uiBundlePath, () => {
              debounce(`ui:${pluginId}`, () => {
                const next = (uiVersions.get(pluginId) ?? 0) + 1;
                uiVersions.set(pluginId, next);
                // eslint-disable-next-line no-console
                console.log(
                  `[dev-watcher] ${pluginId} UI bundle changed → broadcast v${next}`,
                );
                broadcast(KernelEvents.PluginUiBundleChanged, {
                  pluginId,
                  version: next,
                });
              });
            });
            watchers.push(w);
            // eslint-disable-next-line no-console
            console.log(
              `[dev-watcher] watching ${pluginId} UI → ${record.uiBundlePath}`,
            );
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              `[dev-watcher] failed to watch ${record.uiBundlePath}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }

        // 2. Daemon entry — kill + respawn the plugin child (M24.5).
        const active = activated.get(pluginId);
        if (active?.daemonEntryPath) {
          const entry = active.daemonEntryPath;
          const pkg = active.packageName;
          try {
            const w = watch(entry, () => {
              debounce(`entry:${pkg}`, async () => {
                // eslint-disable-next-line no-console
                console.log(
                  `[dev-watcher] ${pluginId} daemon entry changed → respawn`,
                );
                try {
                  await pluginManager.respawn(pkg);
                  // eslint-disable-next-line no-console
                  console.log(`[dev-watcher] respawn ok: ${pluginId}`);
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.error(
                    `[dev-watcher] respawn failed for ${pluginId}:`,
                    err instanceof Error ? err.message : err,
                  );
                }
              });
            });
            watchers.push(w);
            // eslint-disable-next-line no-console
            console.log(
              `[dev-watcher] watching ${pluginId} daemon entry → ${entry}`,
            );
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              `[dev-watcher] failed to watch ${entry}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      }
    },
    stop() {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // ignore
        }
      }
      watchers.length = 0;
      for (const t of debounceTimers.values()) clearTimeout(t);
      debounceTimers.clear();
      started = false;
    },
  };
}
