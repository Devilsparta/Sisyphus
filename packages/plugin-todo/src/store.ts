/**
 * Plugin-local todo store with optional persistence.
 *
 * Lifecycle:
 *  - Module-level singleton, populated synchronously in agent.run paths.
 *  - `init(storage)` is called from the plugin's onActivate, replacing the
 *    in-memory list with the persisted snapshot if any.
 *  - Mutations write to disk fire-and-forget; the daemon flushes on shutdown.
 */
import { randomUUID } from 'node:crypto';
import type { PluginStorage } from '@sisylabs/kernel';

export interface Task {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
}

const STORAGE_KEY = 'tasks';

class TodoStore {
  private tasks: Task[] = [];
  private storage: PluginStorage | null = null;

  async init(storage: PluginStorage): Promise<void> {
    this.storage = storage;
    const loaded = await storage.get<Task[]>(STORAGE_KEY);
    if (Array.isArray(loaded)) {
      this.tasks = loaded;
    }
  }

  add(text: string): Task {
    const task: Task = {
      id: randomUUID(),
      text,
      done: false,
      createdAt: Date.now(),
    };
    this.tasks.push(task);
    this.persist();
    return task;
  }

  removeByText(query: string): Task | null {
    const idx = this.findIndex(query);
    if (idx === -1) return null;
    const [removed] = this.tasks.splice(idx, 1);
    this.persist();
    return removed;
  }

  toggleByText(query: string): Task | null {
    const idx = this.findIndex(query);
    if (idx === -1) return null;
    this.tasks[idx] = { ...this.tasks[idx], done: !this.tasks[idx].done };
    this.persist();
    return this.tasks[idx];
  }

  clear(): void {
    this.tasks = [];
    this.persist();
  }

  list(): Task[] {
    return [...this.tasks];
  }

  private findIndex(query: string): number {
    const q = query.toLowerCase().trim();
    return this.tasks.findIndex((t) => t.text.toLowerCase().includes(q));
  }

  private persist(): void {
    if (!this.storage) return;
    this.storage.set(STORAGE_KEY, this.tasks).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[plugin-todo] persist failed:', err);
    });
  }
}

export const store = new TodoStore();
