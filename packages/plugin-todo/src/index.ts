/**
 * @sisyphus/plugin-todo — the M3 second-plugin probe.
 *
 * Daemon entry. Exists to validate the router's multi-agent selection and the
 * card-rendering plug-in protocol, with a rule-based agent (no LLM) so the
 * test surface stays cheap and deterministic.
 */
import type { SisyphusPlugin } from '@sisyphus/kernel';
import { todoManagerAgent } from './agents/todo-manager';

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
};

export default plugin;
