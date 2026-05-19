/**
 * @sisyphus/plugin-base — reference plugin.
 *
 * M0 stub. Real contributions (Sandpack canvas view, jsx card renderer,
 * default agent system prompt, etc.) migrate here from packages/ui in M2.
 */
import type { SisyphusPlugin } from '@sisyphus/kernel';

const plugin: SisyphusPlugin = {
  manifest: {
    id: 'plugin-base',
    displayName: 'Base Plugin',
    version: '0.1.0',
    dependencies: [],
    contributes: {
      views: [],
      cards: [],
      skills: [],
    },
  },
};

export default plugin;
