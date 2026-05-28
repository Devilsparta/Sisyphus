import React from 'react';
import ReactDOM from 'react-dom/client';
import { KernelEvents } from '@sisylabs/kernel';
import App from './App';
import { loadAllPluginUI } from './plugin-loader';
import { ws } from './services/ws-client';
import './index.css';

// Load all plugin UI surfaces before the first render so view / card /
// provider registries are populated. Dev: hardcoded static imports;
// Prod: fetched dynamically from /api/plugins. See ./plugin-loader.ts.
const loadResult = await loadAllPluginUI();
// eslint-disable-next-line no-console
console.log(
  `[main] plugins loaded: [${loadResult.loaded.join(', ')}]` +
    (loadResult.failed.length
      ? ` failed: [${loadResult.failed.join(', ')}]`
      : ''),
);

ws.connect(`ws://${location.host}/ws`);

ws.on(KernelEvents.PlatformReady, (data) => {
  // eslint-disable-next-line no-console
  console.log('[ws] platform.ready', data);
});

ws.on(KernelEvents.RegistrySnapshot, (data) => {
  // eslint-disable-next-line no-console
  console.log('[ws] registry.snapshot', data);
});

// Dev mode (daemon SISYPHUS_DEV=1): plugin's `pnpm dev` rebuilds
// dist/ui.mjs, daemon notices, broadcasts this event. Simplest correct
// thing to do — full page reload. React state will reset, but plugin-state
// recovery is the plugin's job. State-preserving hot-replace is a future
// enhancement; for now, the iteration is plugin save → ~200ms → page refresh.
ws.on(KernelEvents.PluginUiBundleChanged, (data) => {
  // eslint-disable-next-line no-console
  console.log('[ws] plugin.ui.bundle.changed → reloading page', data);
  window.location.reload();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
