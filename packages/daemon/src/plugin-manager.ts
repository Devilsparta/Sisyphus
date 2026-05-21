/**
 * Plugin lifecycle manager.
 *
 * Holds the runtime side of "what is currently activated":
 *   - activate(packageName): load module, build PluginContext, register
 *     declared agents + skills via a ScopedRegistry, call onActivate.
 *     Records the resulting disposers so deactivate() can revoke them.
 *   - deactivate(packageName): dispose all registrations + call
 *     onDeactivate. Plugin module stays in the ESM cache (Node can't
 *     unload), but its contributions vanish from the registry.
 *   - re-activate of same package: cached module is reused; the
 *     plugin's onActivate runs again — plugin authors should make it
 *     idempotent (state init reads from ctx.storage, not module
 *     top-level).
 */
import type {
  Disposable,
  PluginContext,
  SisyphusPlugin,
} from '@sisyphus/kernel';
import type { Registry } from './registry';
import { ScopedRegistry } from './scoped-registry';
import { createPluginStorage } from './storage';
import { loadPlugin, type LoadedPlugin } from './plugin-loader';

interface ActivatedPlugin {
  packageName: string;
  loaded: LoadedPlugin;
  disposers: Disposable[];
}

export class PluginManager {
  private activated = new Map<string, ActivatedPlugin>();

  constructor(private registry: Registry) {}

  isActivated(packageName: string): boolean {
    return this.activated.has(packageName);
  }

  listActivated(): ActivatedPlugin[] {
    return Array.from(this.activated.values());
  }

  async activate(packageName: string): Promise<LoadedPlugin> {
    if (this.activated.has(packageName)) {
      return this.activated.get(packageName)!.loaded;
    }

    const loaded = await loadPlugin(packageName);
    const { plugin } = loaded;

    // Manifest first so ACL lookups during onActivate see it, and UI
    // bundle endpoint resolves the path immediately.
    this.registry.registerPluginRecord({
      manifest: plugin.manifest,
      packageName,
      uiBundlePath: loaded.uiBundlePath,
    });

    const scoped = new ScopedRegistry(this.registry, plugin.manifest.id);
    const ctx: PluginContext = {
      registry: scoped,
      storage: createPluginStorage(plugin.manifest.id),
      log: (level, msg, meta) => {
        // eslint-disable-next-line no-console
        console.log(`[plugin:${plugin.manifest.id}][${level}] ${msg}`, meta ?? '');
      },
    };

    const disposers: Disposable[] = [];

    try {
      await plugin.onActivate?.(ctx);

      for (const agent of plugin.agents ?? []) {
        disposers.push(scoped.registerAgent(agent));
      }
      const skillDescs = plugin.manifest.contributes?.skills ?? [];
      for (const desc of skillDescs) {
        const handler = plugin.skillHandlers?.[desc.id];
        if (handler) {
          disposers.push(scoped.registerSkill(desc, handler));
        }
      }
    } catch (err) {
      // Activation failed mid-way — roll back whatever did register.
      for (const d of disposers) {
        try {
          d.dispose();
        } catch {
          /* ignore */
        }
      }
      throw err;
    }

    this.activated.set(packageName, { packageName, loaded, disposers });

    // eslint-disable-next-line no-console
    console.log(
      `[plugin-manager] activated "${plugin.manifest.id}" (${packageName})`,
      {
        agents: (plugin.agents ?? []).map((a) => a.descriptor.id),
        skills: Object.keys(plugin.skillHandlers ?? {}),
        hasUI: loaded.uiBundlePath !== null,
      },
    );

    return loaded;
  }

  async deactivate(packageName: string): Promise<void> {
    const entry = this.activated.get(packageName);
    if (!entry) return;

    for (const d of entry.disposers) {
      try {
        d.dispose();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[plugin-manager] disposer for "${packageName}" threw:`,
          err,
        );
      }
    }
    entry.disposers.length = 0;

    try {
      await entry.loaded.plugin.onDeactivate?.({
        registry: new ScopedRegistry(this.registry, entry.loaded.plugin.manifest.id),
        storage: createPluginStorage(entry.loaded.plugin.manifest.id),
        log: (level, msg, meta) => {
          // eslint-disable-next-line no-console
          console.log(
            `[plugin:${entry.loaded.plugin.manifest.id}][${level}] ${msg}`,
            meta ?? '',
          );
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[plugin-manager] onDeactivate for "${packageName}" threw:`,
        err,
      );
    }

    this.activated.delete(packageName);

    // eslint-disable-next-line no-console
    console.log(`[plugin-manager] deactivated "${packageName}"`);
  }
}
