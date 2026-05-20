/**
 * @sisyphus/plugin-base — the reference plugin.
 *
 * M2: provides the react-designer agent (verbatim port of the original
 * Next.js chat behaviour). Card / view contributions for the UI side ship
 * from a separate `./ui` entry — daemon doesn't need React.
 */
import type { SisyphusPlugin } from '@sisyphus/kernel';
import { reactDesignerAgent } from './agents/react-designer';

const plugin: SisyphusPlugin = {
  manifest: {
    id: 'plugin-base',
    displayName: 'Base Plugin',
    version: '0.1.0',
    dependencies: [],
    contributes: {
      agents: [reactDesignerAgent.descriptor],
      views: [],
      cards: [],
      skills: [],
    },
  },
  agents: [reactDesignerAgent],
};

export default plugin;
