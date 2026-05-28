/**
 * UI-side plugin loader (M18: unified dev/prod path).
 *
 * Both dev and prod fetch /api/plugins from the daemon and dynamic-import
 * each plugin's UI bundle (dist/ui.mjs) over HTTP. There is no static
 * `import '@sisylabs/plugin-foo/ui'` anywhere in the host UI — plugins
 * are completely decoupled from the host binary.
 *
 * dev workflow:
 *   - Each plugin runs `pnpm dev` (esbuild --watch) → keeps dist/ui.mjs fresh.
 *   - Daemon runs with SISYPHUS_DEV=1 → fs.watch dist/ui.mjs → broadcasts
 *     plugin.ui.bundle.changed.
 *   - main.tsx listens and triggers location.reload() so the next mount
 *     re-fetches the bundle.
 *
 * The importmap on index.html maps `react` / `react-dom` / `react/jsx-runtime`
 * to host-controlled URLs so plugin bundles and the host share a single
 * React instance regardless of where (Vite vs esbuild) they were built.
 *
 * Per-plugin try/catch — a broken bundle skips with a console.error and
 * the rest still load.
 */
import type { ComponentType, ReactNode } from 'react';
import type { CardDescriptor, ViewDescriptor } from '@sisylabs/kernel';
import {
  registerView,
  registerCardRenderer,
  registerProvider,
} from '@sisylabs/kernel/ui';

interface PluginUIModule {
  views?: Array<{ descriptor: ViewDescriptor; Component: ComponentType }>;
  cardRenderers?: Array<{
    descriptor: CardDescriptor;
    Component: ComponentType<{ payload: unknown }>;
  }>;
  providers?: ComponentType<{ children: ReactNode }>[];
}

interface DaemonPluginInfo {
  id: string;
  packageName: string;
  hasUiBundle: boolean;
}

async function fetchPluginList(): Promise<DaemonPluginInfo[]> {
  try {
    const res = await fetch('/api/plugins');
    if (!res.ok) throw new Error(`/api/plugins → ${res.status}`);
    return (await res.json()) as DaemonPluginInfo[];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[plugin-loader] failed to fetch /api/plugins:', err);
    return [];
  }
}

async function importBundle(
  pluginId: string,
): Promise<PluginUIModule | null> {
  try {
    const url = `/api/plugins/${pluginId}/ui.mjs`;
    // @vite-ignore — runtime URL; Vite must not try to pre-bundle it.
    // index.html's importmap handles `react` etc inside the loaded bundle.
    const mod = (await import(/* @vite-ignore */ url)) as PluginUIModule;
    return mod;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[plugin-loader] failed to load plugin "${pluginId}" UI bundle:`,
      err,
    );
    return null;
  }
}

export async function loadAllPluginUI(): Promise<{
  loaded: string[];
  failed: string[];
}> {
  const list = await fetchPluginList();
  const candidates = list.filter((p) => p.hasUiBundle);

  const results = await Promise.all(
    candidates.map(async (p) => {
      const mod = await importBundle(p.id);
      return mod ? { id: p.id, mod } : null;
    }),
  );

  const loaded: string[] = [];
  const failed: string[] = [];
  for (const entry of results) {
    if (!entry) continue;
    const { id, mod } = entry;
    try {
      if (mod.views) {
        for (const v of mod.views) registerView(v.descriptor, v.Component);
      }
      if (mod.cardRenderers) {
        for (const c of mod.cardRenderers) {
          registerCardRenderer(c.descriptor.type, c.Component);
        }
      }
      if (mod.providers) {
        for (const P of mod.providers) registerProvider(P);
      }
      loaded.push(id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[plugin-loader] registration failed for ${id}:`, err);
      failed.push(id);
    }
  }
  return { loaded, failed };
}
