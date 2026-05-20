/**
 * File-backed per-plugin storage.
 *
 * Each plugin gets its own JSON file at ~/.sisyphus/plugins/<plugin-id>.json.
 * Reads load lazily into an in-memory cache; writes update the cache then
 * persist asynchronously. We don't await disk on every `set` from agent code
 * paths — agents stay synchronous-feeling.
 *
 * Trade-off: a crash between mutation and flush loses the last write. M4+
 * may upgrade to a real KV store (sqlite, level) if we hit durability needs.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { PluginStorage } from '@sisyphus/kernel';

const ROOT = path.join(os.homedir(), '.sisyphus', 'plugins');

interface StorageImpl extends PluginStorage {
  /** Flush any pending writes; called on daemon shutdown. */
  flush(): Promise<void>;
}

export function createPluginStorage(pluginId: string): StorageImpl {
  const filePath = path.join(ROOT, `${pluginId}.json`);
  let cache: Record<string, unknown> | null = null;
  let writePromise: Promise<void> | null = null;

  async function ensureLoaded(): Promise<Record<string, unknown>> {
    if (cache !== null) return cache;
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      cache = JSON.parse(raw);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
      cache = {};
    }
    return cache!;
  }

  function schedulePersist(): Promise<void> {
    // Coalesce concurrent writes: while a flush is in flight, subsequent
    // schedulePersist() calls chain after it so we don't lose updates.
    if (writePromise) {
      writePromise = writePromise.then(() => doWrite());
    } else {
      writePromise = doWrite().finally(() => {
        writePromise = null;
      });
    }
    return writePromise;
  }

  async function doWrite(): Promise<void> {
    if (cache === null) return;
    await fs.mkdir(ROOT, { recursive: true });
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
    await fs.rename(tmp, filePath);
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const data = await ensureLoaded();
      return data[key] as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      const data = await ensureLoaded();
      data[key] = value;
      await schedulePersist();
    },
    async delete(key: string): Promise<void> {
      const data = await ensureLoaded();
      delete data[key];
      await schedulePersist();
    },
    async clear(): Promise<void> {
      await ensureLoaded();
      cache = {};
      await schedulePersist();
    },
    async keys(): Promise<string[]> {
      const data = await ensureLoaded();
      return Object.keys(data);
    },
    async flush(): Promise<void> {
      if (writePromise) await writePromise;
    },
  };
}
