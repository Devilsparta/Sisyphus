import React from 'react';
import ReactDOM from 'react-dom/client';
import { KernelEvents } from '@sisyphus/kernel';
import {
  registerView,
  registerCardRenderer,
  registerProvider,
} from '@sisyphus/kernel/ui';
import {
  views as pluginBaseViews,
  cardRenderers as pluginBaseCards,
  providers as pluginBaseProviders,
} from '@sisyphus/plugin-base/ui';
import {
  views as pluginTodoViews,
  cardRenderers as pluginTodoCards,
  providers as pluginTodoProviders,
} from '@sisyphus/plugin-todo/ui';
import App from './App';
import { ws } from './services/ws-client';
import './index.css';

// Register all plugin-contributed UI surface. The host doesn't know which
// plugins are loaded — it just iterates whatever shows up. M4+ dynamic-loader
// will discover this list at runtime; M4 still hardcodes the imports but the
// downstream wiring is plugin-agnostic.
const loaded = [
  {
    views: pluginBaseViews,
    cards: pluginBaseCards,
    providers: pluginBaseProviders,
  },
  {
    views: pluginTodoViews,
    cards: pluginTodoCards,
    providers: pluginTodoProviders,
  },
];

for (const p of loaded) {
  for (const v of p.views) registerView(v.descriptor, v.Component);
  for (const c of p.cards) registerCardRenderer(c.descriptor.type, c.Component);
  for (const Provider of p.providers) registerProvider(Provider);
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
