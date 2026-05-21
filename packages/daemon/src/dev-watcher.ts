/**
 * Dev-mode plugin UI bundle watcher.
 *
 * Activated by SISYPHUS_DEV=1. Watches each loaded plugin's
 * uiBundlePath for changes; when one fires, broadcasts a
 * `plugin.ui.bundle.changed` WS event with the plugin id and a
 * monotonic version counter so the UI can cache-bust its dynamic
 * import and reload that plugin.
 *
 * The plugin's `pnpm dev` (esbuild --watch) is what writes new bundle
 * files; the daemon just notices and tells the UI.
 *
 * Debounces 100ms because esbuild typically writes the file in
 * multiple chunks during a rebuild.
 */
import { watch, type FSWatcher } from 'node:fs';
import { KernelEvents } from '@sisyphus/kernel';
import type { Registry } from './registry';

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
): DevWatcher {
  const watchers: FSWatcher[] = [];
  const versions = new Map<string, number>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let started = false;

  return {
    start() {
      if (started) return;
      started = true;

      const records = registry.queryPluginRecords();
      for (const record of records) {
        if (!record.uiBundlePath) continue;
        const pluginId = record.manifest.id;
        versions.set(pluginId, 0);
        try {
          const w = watch(record.uiBundlePath, () => {
            const existing = debounceTimers.get(pluginId);
            if (existing) clearTimeout(existing);
            debounceTimers.set(
              pluginId,
              setTimeout(() => {
                const next = (versions.get(pluginId) ?? 0) + 1;
                versions.set(pluginId, next);
                // eslint-disable-next-line no-console
                console.log(
                  `[dev-watcher] ${pluginId} bundle changed → broadcast v${next}`,
                );
                broadcast(KernelEvents.PluginUiBundleChanged, {
                  pluginId,
                  version: next,
                });
              }, DEBOUNCE_MS),
            );
          });
          watchers.push(w);
          // eslint-disable-next-line no-console
          console.log(
            `[dev-watcher] watching ${pluginId} → ${record.uiBundlePath}`,
          );
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[dev-watcher] failed to watch ${record.uiBundlePath}:`,
            err instanceof Error ? err.message : err,
          );
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
