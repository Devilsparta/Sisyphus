import React from 'react';
import ReactDOM from 'react-dom/client';
import { KernelEvents } from '@sisyphus/kernel';
import App from './App';
import { ws } from './services/ws-client';
import './index.css';

// Connect to the daemon WS so we receive registry updates and other platform
// events. The Vite dev server proxies /ws to the daemon; in production the
// daemon will serve the UI directly so the same path works.
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
