import React from 'react';
import ReactDOM from 'react-dom/client';
import { KernelEvents } from '@sisyphus/kernel';
import { registerView, registerCardRenderer } from '@sisyphus/kernel/ui';
import {
  views as pluginBaseViews,
  cardRenderers as pluginBaseCards,
} from '@sisyphus/plugin-base/ui';
import {
  views as pluginTodoViews,
  cardRenderers as pluginTodoCards,
} from '@sisyphus/plugin-todo/ui';
import App from './App';
import { ws } from './services/ws-client';
import './index.css';

// Register all plugin-contributed views + card renderers. M4+ will iterate
// dynamically; today both plugins are hardcoded the same way the daemon
// hardcodes its plugin imports.
for (const v of [...pluginBaseViews, ...pluginTodoViews]) {
  registerView(v.descriptor, v.Component);
}
for (const c of [...pluginBaseCards, ...pluginTodoCards]) {
  registerCardRenderer(c.descriptor.type, c.Component);
}

ws.connect(`ws://${location.host}/ws`);

ws.on(KernelEvents.PlatformReady, (data) => {
  // eslint-disable-next-line no-console
  console.log('[ws] platform.ready', data);
});

ws.on(KernelEvents.RegistrySnapshot, (data) => {
  // eslint-disable-next-line no-console
  console.log('[ws] registry.snapshot', data);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
