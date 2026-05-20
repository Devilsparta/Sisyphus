import { PanelLayout } from './layout';
import { PluginBaseProvider } from '@sisyphus/plugin-base/ui';

export default function App() {
  return (
    <PluginBaseProvider>
      <PanelLayout />
    </PluginBaseProvider>
  );
}
