/**
 * sisyphus-daemon — entry point.
 *
 * M0: stub only. HTTP+WS server, registry implementation, and plugin loader
 * land in M1. This file exists so the workspace links and typechecks.
 */
import type { SisyphusPlugin } from '@sisyphus/kernel';

const loaded: SisyphusPlugin[] = [];

// eslint-disable-next-line no-console
console.log('[sisyphus-daemon] M0 stub — server arrives in M1');
// eslint-disable-next-line no-console
console.log(`[sisyphus-daemon] plugins loaded: ${loaded.length}`);
