/**
 * @sisyphus/plugin-base — the reference plugin.
 *
 * Contributes:
 *   - react-designer agent (LLM-driven, generates jsx)
 *   - time-helper agent (rule-based, demonstrates skill dispatch)
 *   - current-time skill (read server clock)
 *   - chat + canvas-preview UI views (in ./ui)
 *
 * The daemon entry stays React-free.
 */
import type { SisyphusPlugin } from '@sisyphus/kernel';
import { reactDesignerAgent } from './agents/react-designer';
import { timeHelperAgent } from './agents/time-helper';
import { currentTimeSkill, currentTimeHandler } from './skills/current-time';

const plugin: SisyphusPlugin = {
  manifest: {
    id: 'plugin-base',
    displayName: 'Base Plugin',
    version: '0.1.0',
    dependencies: [],
    contributes: {
      agents: [reactDesignerAgent.descriptor, timeHelperAgent.descriptor],
      views: [],
      cards: [],
      skills: [currentTimeSkill],
    },
  },
  agents: [reactDesignerAgent, timeHelperAgent],
  skillHandlers: {
    [currentTimeSkill.id]: currentTimeHandler,
  },
};

export default plugin;
