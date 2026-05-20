/**
 * @sisyphus/plugin-todo — the M3 second-plugin probe, with M4 persistence.
 *
 * Daemon entry. The store hooks ctx.storage during onActivate so the task
 * list survives restarts.
 */
import type { SisyphusPlugin } from '@sisyphus/kernel';
import { todoManagerAgent } from './agents/todo-manager';
import { store } from './store';

const plugin: SisyphusPlugin = {
  manifest: {
    id: 'plugin-todo',
    displayName: 'Todo Manager',
    version: '0.1.0',
    dependencies: [],
    contributes: {
      agents: [todoManagerAgent.descriptor],
      views: [
        {
          id: 'plugin-todo.view.task-list',
          region: 'side',
          title: 'Todos',
          icon: 'list-todo',
          defaultVisible: true,
        },
      ],
      cards: [{ type: 'plugin-todo.card.task-list' }],
      skills: [],
    },
  },
  agents: [todoManagerAgent],
  async onActivate(ctx) {
    await store.init(ctx.storage);
    ctx.log('info', 'todo store initialised from persisted state');
  },
};

export default plugin;
