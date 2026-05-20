import { PanelLayout } from './layout';
import { PluginBaseProvider } from '@sisyphus/plugin-base/ui';
import { PluginTodoProvider } from '@sisyphus/plugin-todo/ui';

/**
 * Provider nesting is hardcoded for M3 (one provider per loaded plugin). M4+
 * will replace this with a kernel-driven provider stack so adding a plugin
 * doesn't require editing the host App.
 */
export default function App() {
  return (
    <PluginBaseProvider>
      <PluginTodoProvider>
        <PanelLayout />
      </PluginTodoProvider>
    </PluginBaseProvider>
  );
}
