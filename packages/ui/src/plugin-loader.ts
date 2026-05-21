/**
 * UI-side plugin loader.
 *
 * Dev mode (import.meta.env.DEV):
 *   Hardcoded static imports of @sisyphus/plugin-base/ui and
 *   @sisyphus/plugin-todo/ui. Keeps Vite HMR working and avoids the
 *   dual-React-instance hazard you'd hit if Vite-internal React met
 *   esbuild-external React in the same page.
 *
 * Prod mode:
 *   1. Fetch /api/plugins for the daemon's list of loaded plugins.
 *   2. For each `hasUiBundle: true`, dynamic-import /api/plugins/<id>/ui.mjs.
 *   3. Index.html's importmap maps `react`, `react-dom`, `react/jsx-runtime`
 *      etc to host-controlled URLs so plugin bundles and the host share a
 *      single React instance.
 *   4. Per-plugin try/catch — a broken bundle skips with a console.error
 *      and the rest still load.
 */
import type { ComponentType, ReactNode } from 'react';
import type { CardDescriptor, ViewDescriptor } from '@sisyphus/kernel';
import {
  registerView,
  registerCardRenderer,
  registerProvider,
} from '@sisyphus/kernel/ui';

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

async function loadDev(): Promise<Array<{ id: string; mod: PluginUIModule }>> {
  // Static imports so Vite's dev-server resolves through normal module
  // graph (and React stays a single Vite-internal instance).
  const [base, todo] = await Promise.all([
    import('@sisyphus/plugin-base/ui'),
    import('@sisyphus/plugin-todo/ui'),
  ]);
  return [
    { id: 'plugin-base', mod: base as unknown as PluginUIModule },
    { id: 'plugin-todo', mod: todo as unknown as PluginUIModule },
  ];
}

async function loadProd(): Promise<Array<{ id: string; mod: PluginUIModule }>> {
  let list: DaemonPluginInfo[];
  try {
    const res = await fetch('/api/plugins');
    if (!res.ok) throw new Error(`/api/plugins → ${res.status}`);
    list = (await res.json()) as DaemonPluginInfo[];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[plugin-loader] failed to fetch /api/plugins:', err);
    return [];
  }

  const results = await Promise.all(
    list
      .filter((p) => p.hasUiBundle)
      .map(async (p) => {
        try {
          const url = `/api/plugins/${p.id}/ui.mjs`;
          // @vite-ignore — dynamic import URL is runtime-only; Vite must
          // not try to pre-bundle it. The importmap on index.html
          // handles `react` / `react-dom` resolution in the loaded bundle.
          const mod = (await import(/* @vite-ignore */ url)) as PluginUIModule;
          return { id: p.id, mod };
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `[plugin-loader] failed to load plugin "${p.id}" UI bundle:`,
            err,
          );
          return null;
        }
      }),
  );
  return results.filter(
    (r): r is { id: string; mod: PluginUIModule } => r !== null,
  );
}

export async function loadAllPluginUI(): Promise<{
  loaded: string[];
  failed: string[];
}> {
  const entries = import.meta.env.DEV ? await loadDev() : await loadProd();
  const loaded: string[] = [];
  const failed: string[] = [];
  for (const { id, mod } of entries) {
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
