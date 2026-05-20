/**
 * Plugin-local in-memory todo store. Lives in the daemon process; the agent
 * mutates it, and the UI mirrors state via `task-list` cards.
 *
 * Stateless restart: the daemon is the source of truth at runtime; persistence
 * is out of scope for M3 (would land alongside a real KV store in M4+).
 */
import { randomUUID } from 'node:crypto';

export interface Task {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
}

class TodoStore {
  private tasks: Task[] = [];

  add(text: string): Task {
    const task: Task = {
      id: randomUUID(),
      text,
      done: false,
      createdAt: Date.now(),
    };
    this.tasks.push(task);
    return task;
  }

  removeByText(query: string): Task | null {
    const idx = this.findIndex(query);
    if (idx === -1) return null;
    const [removed] = this.tasks.splice(idx, 1);
    return removed;
  }

  toggleByText(query: string): Task | null {
    const idx = this.findIndex(query);
    if (idx === -1) return null;
    this.tasks[idx] = { ...this.tasks[idx], done: !this.tasks[idx].done };
    return this.tasks[idx];
  }

  clear(): void {
    this.tasks = [];
  }

  list(): Task[] {
    return [...this.tasks];
  }

  private findIndex(query: string): number {
    const q = query.toLowerCase().trim();
    return this.tasks.findIndex((t) => t.text.toLowerCase().includes(q));
  }
}

export const store = new TodoStore();
