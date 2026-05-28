/**
 * todo-manager agent — deliberately rule-based, no LLM call.
 *
 * Why: M3 uses this plugin to compress-test the multi-agent router and the
 * card protocol. Keeping the agent itself off the LLM call path proves the
 * platform tolerates heterogeneous agent implementations (one LLM-driven
 * react-designer, one pure rule-based todo-manager).
 *
 * Parser accepts: `add <text>` / `remove <text>` / `complete <text>` /
 * `done <text>` / `clear` / `list`. Always emits a full task-list card so
 * the UI mirrors the latest state.
 */
import type { AgentImpl } from '@sisylabs/kernel';
import { store } from '../store';

export const todoManagerAgent: AgentImpl = {
  descriptor: {
    id: 'plugin-todo.agent.todo-manager',
    displayName: 'Todo Manager',
    description:
      'Adds, removes, completes, and lists todo items. Maintains a simple in-memory task list.',
    spawnHint:
      'use when the user wants to manage tasks / todos / a checklist: adding items, marking them done, removing them, or listing them. Triggers include "add X", "remove X", "complete X", "done X", "list todos", "clear todos".',
    triggerKeywords: [
      'todo',
      'todos',
      'task',
      'tasks',
      'checklist',
      'add',
      'remove',
      'delete',
      'complete',
      'done',
      'check',
      'list',
      'clear',
    ],
  },

  async run(userMessage, ctx) {
    const msg = userMessage.trim();
    const lower = msg.toLowerCase();
    let reply: string;

    if (lower.startsWith('add ')) {
      const text = msg.slice(4).trim();
      if (text) {
        store.add(text);
        reply = `Added: ${text}`;
      } else {
        reply = 'Add what?';
      }
    } else if (lower.startsWith('remove ') || lower.startsWith('delete ')) {
      const query = msg.split(' ').slice(1).join(' ').trim();
      const removed = store.removeByText(query);
      reply = removed ? `Removed: ${removed.text}` : `Not found: ${query}`;
    } else if (
      lower.startsWith('complete ') ||
      lower.startsWith('done ') ||
      lower.startsWith('check ')
    ) {
      const query = msg.split(' ').slice(1).join(' ').trim();
      const toggled = store.toggleByText(query);
      reply = toggled
        ? `${toggled.done ? 'Marked done' : 'Marked open'}: ${toggled.text}`
        : `Not found: ${query}`;
    } else if (lower === 'clear' || lower.startsWith('clear ')) {
      store.clear();
      reply = 'Cleared all tasks';
    } else if (lower === 'list' || lower.startsWith('list ')) {
      reply = `${store.list().length} task(s) in the list`;
    } else {
      reply =
        'Unrecognized command. Try "add X" / "remove X" / "complete X" / "clear" / "list".';
    }

    ctx.emit({ type: 'token', text: reply });

    // Always re-emit the full current task list as a card so the UI mirror
    // stays in sync regardless of which command ran.
    ctx.emit({
      type: 'card',
      card: {
        type: 'plugin-todo.card.task-list',
        payload: { tasks: store.list() },
        meta: { createdAt: Date.now() },
      },
    });

    ctx.emit({ type: 'done', reason: 'stop' });
  },
};
