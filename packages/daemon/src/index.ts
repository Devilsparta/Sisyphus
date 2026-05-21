/**
 * sisyphus-daemon — HTTP + WebSocket server (M2 cut: multi-agent router).
 *
 * Endpoints:
 *   GET  /health                  — liveness probe
 *   POST /api/chat                — agent dispatch (SSE of AgentEvents)
 *   GET  /api/registry/views      — list registered views (optional ?region=)
 *   GET  /api/registry/cards      — list registered card types
 *   GET  /api/registry/skills     — list registered skills
 *   GET  /api/registry/agents     — list registered agents
 *   WS   /ws                      — IPC channel (events + RPC frames)
 *
 * Plugin loading is hardcoded to a single import of @sisyphus/plugin-base.
 * Dynamic discovery (npm scan, plugins.config.ts) lands in M4+, per the
 * "M2 之前不写插件加载器" charter rule applied one milestone later: M2 has
 * exactly one plugin so dynamic loading would still be dead code.
 */
import type { Server as HTTPServer } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config as loadDotenv } from 'dotenv';
import {
  KernelEvents,
  type AgentEvent,
  type ChatMessage,
  type PluginContext,
  type Region,
  type SisyphusPlugin,
} from '@sisyphus/kernel';
import { Registry } from './registry';
import { Router } from './router';
import { createWSHub } from './ws';
import { bus } from './event-bus';
import { createPluginStorage } from './storage';
import { resolveEnabledPlugins, loadPlugin } from './plugin-loader';

// Load both .env and .env.local; the latter overrides and is the convention
// for unchecked-in secrets (used here for OPENAI_API_KEY etc).
loadDotenv();
loadDotenv({ path: '.env.local', override: true });

const PORT = Number(process.env.SISYPHUS_DAEMON_PORT ?? 8787);

export const registry = new Registry();
const router = new Router(registry);
const startedAt = Date.now();

async function activatePlugin(plugin: SisyphusPlugin): Promise<void> {
  const ctx: PluginContext = {
    registry,
    storage: createPluginStorage(plugin.manifest.id),
    log: (level, msg, meta) => {
      // eslint-disable-next-line no-console
      console.log(
        `[plugin:${plugin.manifest.id}][${level}] ${msg}`,
        meta ?? '',
      );
    },
  };
  await plugin.onActivate?.(ctx);
  // Register declared agents
  for (const agent of plugin.agents ?? []) {
    registry.registerAgent(agent);
  }
  // Register declared skill handlers (paired with manifest descriptors)
  const skillDescs = plugin.manifest.contributes?.skills ?? [];
  for (const desc of skillDescs) {
    const handler = plugin.skillHandlers?.[desc.id];
    if (handler) {
      registry.registerSkill(desc, handler);
    }
  }
  // eslint-disable-next-line no-console
  console.log(
    `[sisyphus-daemon] activated plugin "${plugin.manifest.id}"`,
    {
      agents: (plugin.agents ?? []).map((a) => a.descriptor.id),
      skills: Object.keys(plugin.skillHandlers ?? {}),
    },
  );
}

// Resolve the plugin list from ~/.sisyphus/plugins.config.json (falls back to
// the two workspace plugins in dev). Activate each independently so one
// broken plugin doesn't take down the others.
const enabledPluginNames = await resolveEnabledPlugins();
// eslint-disable-next-line no-console
console.log('[sisyphus-daemon] enabled plugins:', enabledPluginNames);
for (const name of enabledPluginNames) {
  try {
    const plugin = await loadPlugin(name);
    await activatePlugin(plugin);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[sisyphus-daemon] failed to load plugin "${name}":`,
      err instanceof Error ? err.message : err,
    );
  }
}

const wsHub = createWSHub({
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

interface ChatRequest {
  messages: ChatMessage[];
}

const app = new Hono();
app.use('*', cors());
app.get('/health', (c) => c.json({ ok: true, name: 'sisyphus-daemon' }));

const api = new Hono();

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

api.get('/registry/views', (c) => {
  const region = c.req.query('region') as Region | undefined;
  return c.json(registry.queryViews(region ? { region } : undefined));
});
api.get('/registry/cards', (c) => c.json(registry.queryCards()));
api.get('/registry/skills', (c) => c.json(registry.querySkills()));
api.get('/registry/agents', (c) => c.json(registry.queryAgents()));

app.route('/api', api);

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[sisyphus-daemon] listening on http://localhost:${info.port}`);
});

// See M0.5 note: serve() returns ServerType (HTTP / HTTP/2 union) but the
// default factory uses http.createServer().
wsHub.attach(server as unknown as HTTPServer);
