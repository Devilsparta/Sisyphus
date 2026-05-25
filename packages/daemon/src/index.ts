/**
 * sisyphus-daemon — HTTP + WebSocket server.
 *
 * Plugin lifecycle (M19+):
 *   - Boot reads ~/.sisyphus/plugins.config.json (legacy schema migrated).
 *   - For each `enabled` entry, PluginManager.activate() loads it from
 *     ~/.sisyphus/plugins-node_modules (or daemon's own node_modules
 *     in monorepo dev), registers contributions, runs onActivate.
 *   - /api/plugins endpoints let the UI install / uninstall / enable /
 *     disable at runtime, no daemon restart needed.
 */
import type { Server as HTTPServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config as loadDotenv } from 'dotenv';
import {
  KernelEvents,
  type AgentEvent,
  type ChatMessage,
  type Region,
} from '@sisyphus/kernel';
import { Registry } from './registry';
import { Router } from './router';
import { createWSHub } from './ws';
import { bus } from './event-bus';
import { requireApiKey, isWSAuthorized } from './auth';
import { createDevWatcher, isDevModeEnabled } from './dev-watcher';
import {
  reloadConfig,
  getMergedConfig,
  getWorkspace,
  setWorkspace,
  writeUserConfig,
  writeProjectConfig,
  maskConfigForResponse,
  stripMaskedFields,
  type SisyphusConfig,
} from './config';
import {
  readPluginsConfig,
  writePluginsConfig,
  addInstalled,
  removeInstalled,
  setEnabled,
} from './plugin-config';
import {
  installPackage,
  uninstallPackage,
  isInstalled,
  ensurePluginsRoot,
} from './plugin-installer';
import { PluginManager } from './plugin-manager';
import { searchNpm, fetchMarketplace } from './plugin-search';

// Wrapped in an async IIFE so the bundled output has no top-level await.
// Node SEA's ESM main support is brittle (Node 24 still loads .mjs blobs as
// CJS in practice), so the build pipeline emits CJS — and CJS forbids TLA.
async function main() {

// Load both .env and .env.local; then layer ~/.sisyphus/config.json over.
loadDotenv();
loadDotenv({ path: '.env.local', override: true });
await reloadConfig();
await ensurePluginsRoot();

const PORT = Number(process.env.SISYPHUS_DAEMON_PORT ?? 8787);

const registry = new Registry();
const router = new Router(registry);
const pluginManager = new PluginManager(registry);
const startedAt = Date.now();

// Boot: read persisted plugin config, activate everything in `enabled`.
const pluginsCfg = await readPluginsConfig();
// eslint-disable-next-line no-console
console.log('[sisyphus-daemon] plugin config:', pluginsCfg);

for (const pkgName of pluginsCfg.enabled) {
  try {
    await pluginManager.activate(pkgName);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[sisyphus-daemon] failed to activate "${pkgName}":`,
      err instanceof Error ? err.message : err,
    );
  }
}

const wsHub = createWSHub({
  isAuthorized: isWSAuthorized,
  onConnection(send) {
    send(KernelEvents.PlatformReady, { startedAt });
    send(KernelEvents.RegistrySnapshot, registry.snapshot());
  },
});

for (const event of [
  KernelEvents.RegistryViewAdded,
  KernelEvents.RegistryViewRemoved,
  KernelEvents.RegistryCardAdded,
  KernelEvents.RegistryCardRemoved,
  KernelEvents.RegistrySkillAdded,
  KernelEvents.RegistrySkillRemoved,
  KernelEvents.RegistryAgentAdded,
  KernelEvents.RegistryAgentRemoved,
]) {
  bus.on(event, (data) => wsHub.broadcast(event, data));
}

if (isDevModeEnabled()) {
  // eslint-disable-next-line no-console
  console.log('[sisyphus-daemon] SISYPHUS_DEV=1, starting plugin watcher');
  const devWatcher = createDevWatcher(registry, (event, data) =>
    wsHub.broadcast(event, data),
  );
  devWatcher.start();
}

interface ChatRequest {
  messages: ChatMessage[];
}

const app = new Hono();
app.use('*', cors());
app.get('/health', (c) => c.json({ ok: true, name: 'sisyphus-daemon' }));

const api = new Hono();
api.use('*', requireApiKey);

api.post('/chat', async (c) => {
  const { messages } = await c.req.json<ChatRequest>();
  const userMessage = messages[messages.length - 1]?.content ?? '';
  const history = messages.slice(0, -1);
  const conversationId = crypto.randomUUID();

  const abort = new AbortController();
  c.req.raw.signal.addEventListener('abort', () => abort.abort());

  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(streamCtrl) {
      const emit = (event: AgentEvent) => {
        streamCtrl.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };
      try {
        await router.run({
          userMessage,
          history,
          conversationId,
          signal: abort.signal,
          emit,
        });
        streamCtrl.enqueue(encoder.encode('data: [DONE]\n\n'));
        streamCtrl.close();
      } catch (err) {
        streamCtrl.error(err);
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});

api.get('/config', (c) => c.json(maskConfigForResponse(getMergedConfig())));

api.post('/config', async (c) => {
  const body = await c.req.json<{
    scope: 'user' | 'project';
    config: SisyphusConfig;
  }>();
  const patch = stripMaskedFields(body.config);
  try {
    if (body.scope === 'project') {
      await writeProjectConfig(patch);
    } else {
      await writeUserConfig(patch);
    }
    await reloadConfig();
    return c.json({
      ok: true,
      config: maskConfigForResponse(getMergedConfig()),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg }, 400);
  }
});

api.get('/workspace', (c) => c.json({ path: getWorkspace() }));

api.post('/workspace', async (c) => {
  const { path: p } = await c.req.json<{ path: string | null }>();
  await setWorkspace(p ?? null);
  return c.json({
    ok: true,
    path: getWorkspace(),
    config: maskConfigForResponse(getMergedConfig()),
  });
});

api.get('/registry/views', (c) => {
  const region = c.req.query('region') as Region | undefined;
  return c.json(registry.queryViews(region ? { region } : undefined));
});
api.get('/registry/cards', (c) => c.json(registry.queryCards()));
api.get('/registry/skills', (c) => c.json(registry.querySkills()));
api.get('/registry/agents', (c) => c.json(registry.queryAgents()));

/**
 * /api/plugins now reports both registry-side data (for activated
 * plugins) and config-side data (for installed-but-disabled). This is
 * how the management UI knows what to show toggles for.
 */
api.get('/plugins', async (c) => {
  const cfg = await readPluginsConfig();
  const records = registry.queryPluginRecords();
  const recordsByPkg = new Map(records.map((r) => [r.packageName, r]));

  const out = cfg.installed.map((pkgName) => {
    const enabled = cfg.enabled.includes(pkgName);
    const record = recordsByPkg.get(pkgName);
    return {
      packageName: pkgName,
      enabled,
      activated: record !== undefined,
      id: record?.manifest.id ?? null,
      displayName: record?.manifest.displayName ?? null,
      version: record?.manifest.version ?? null,
      hasUiBundle: record?.uiBundlePath != null,
      manifest: record?.manifest ?? null,
    };
  });
  return c.json(out);
});

api.get('/plugins/:id/ui.mjs', async (c) => {
  const id = c.req.param('id');
  const record = registry.getPluginRecord(id);
  if (!record) {
    return c.json({ error: `unknown plugin: ${id}` }, 404);
  }
  if (!record.uiBundlePath) {
    return c.json(
      { error: `plugin "${id}" declares no UI bundle or it isn't built yet` },
      404,
    );
  }
  const { promises: fs } = await import('node:fs');
  try {
    const content = await fs.readFile(record.uiBundlePath);
    c.header('Content-Type', 'application/javascript; charset=utf-8');
    c.header('Cache-Control', 'no-store');
    return c.body(content);
  } catch (err) {
    return c.json(
      {
        error: `failed to read UI bundle: ${err instanceof Error ? err.message : err}`,
      },
      500,
    );
  }
});

api.get('/plugins/search', async (c) => {
  const q = c.req.query('q') ?? '';
  const sizeRaw = c.req.query('size');
  const size = sizeRaw ? Math.min(Math.max(1, Number(sizeRaw)), 50) : 20;
  const entries = await searchNpm(q, size);
  return c.json({ entries });
});

api.get('/plugins/marketplace', async (c) => {
  const force = c.req.query('refresh') === '1';
  const entries = await fetchMarketplace(force);
  return c.json({ entries });
});

api.post('/plugins/install', async (c) => {
  const body = await c.req.json<{ packageName: string; version?: string }>();
  if (!body.packageName) {
    return c.json({ ok: false, error: 'packageName required' }, 400);
  }
  try {
    if (!(await isInstalled(body.packageName))) {
      // eslint-disable-next-line no-console
      console.log(
        `[sisyphus-daemon] installing ${body.packageName}@${body.version ?? 'latest'}`,
      );
      await installPackage(body.packageName, body.version);
    }
    let cfg = await readPluginsConfig();
    cfg = addInstalled(cfg, body.packageName, /* alsoEnable */ true);
    await writePluginsConfig(cfg);

    // Auto-activate the freshly installed plugin (no restart).
    if (!pluginManager.isActivated(body.packageName)) {
      await pluginManager.activate(body.packageName);
    }

    return c.json({ ok: true, packageName: body.packageName });
  } catch (err) {
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

api.post('/plugins/uninstall', async (c) => {
  const body = await c.req.json<{ packageName: string }>();
  if (!body.packageName) {
    return c.json({ ok: false, error: 'packageName required' }, 400);
  }
  try {
    if (pluginManager.isActivated(body.packageName)) {
      await pluginManager.deactivate(body.packageName);
    }
    await uninstallPackage(body.packageName);
    let cfg = await readPluginsConfig();
    cfg = removeInstalled(cfg, body.packageName);
    await writePluginsConfig(cfg);
    return c.json({ ok: true, packageName: body.packageName });
  } catch (err) {
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

api.post('/plugins/enable', async (c) => {
  const body = await c.req.json<{ packageName: string }>();
  try {
    let cfg = await readPluginsConfig();
    cfg = setEnabled(cfg, body.packageName, true);
    await writePluginsConfig(cfg);
    if (!pluginManager.isActivated(body.packageName)) {
      await pluginManager.activate(body.packageName);
    }
    return c.json({ ok: true, packageName: body.packageName });
  } catch (err) {
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      400,
    );
  }
});

api.post('/plugins/disable', async (c) => {
  const body = await c.req.json<{ packageName: string }>();
  try {
    let cfg = await readPluginsConfig();
    cfg = setEnabled(cfg, body.packageName, false);
    await writePluginsConfig(cfg);
    if (pluginManager.isActivated(body.packageName)) {
      await pluginManager.deactivate(body.packageName);
    }
    return c.json({ ok: true, packageName: body.packageName });
  } catch (err) {
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      400,
    );
  }
});

app.route('/api', api);

// Optional UI static serve. When SISYPHUS_UI_DIR points to a built UI
// (`packages/ui/dist` in dev, /opt/sisyphus/ui in a docker image), daemon
// becomes the single origin for /api, /ws, AND the SPA — the web-deploy
// shape. Without it, the UI runs separately (e.g. `pnpm --filter ui dev`
// through the Vite proxy).
const UI_DIR = process.env.SISYPHUS_UI_DIR
  ? path.resolve(process.env.SISYPHUS_UI_DIR)
  : null;
if (UI_DIR) {
  try {
    await fs.access(path.join(UI_DIR, 'index.html'));
    // eslint-disable-next-line no-console
    console.log(`[sisyphus-daemon] serving UI from ${UI_DIR}`);
    // Serve hashed assets (index-*.js / *.css / favicon.ico ...) as files.
    app.use('/*', serveStatic({ root: UI_DIR }));
    // SPA fallback: anything not /api, /ws, /health, or a real file →
    // index.html. Lets future client-side routing work.
    app.get('*', async (c) => {
      const content = await fs.readFile(path.join(UI_DIR, 'index.html'), 'utf-8');
      return c.html(content);
    });
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      `[sisyphus-daemon] SISYPHUS_UI_DIR=${UI_DIR} but index.html not found — not serving UI`,
    );
  }
}

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[sisyphus-daemon] listening on http://localhost:${info.port}`);
});

wsHub.attach(server as unknown as HTTPServer);

} // end of main()

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[sisyphus-daemon] fatal:', err);
  process.exit(1);
});
