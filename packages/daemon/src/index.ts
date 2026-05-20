/**
 * sisyphus-daemon — HTTP + WebSocket server (M1 cut).
 *
 * Endpoints:
 *   GET  /health                  — liveness probe
 *   POST /api/chat                — LLM streaming (SSE)
 *   GET  /api/registry/views      — list registered views (optional ?region=)
 *   GET  /api/registry/cards      — list registered card types
 *   GET  /api/registry/skills     — list registered skills
 *   WS   /ws                      — IPC channel (events + RPC frames)
 *
 * Plugin loader lands later in M1.5 / M2; for now the registry is empty and
 * the system prompt is still hardcoded here.
 */
import type { Server as HTTPServer } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config as loadDotenv } from 'dotenv';
import OpenAI from 'openai';

// Load both .env and .env.local; the latter overrides and is the convention
// for unchecked-in secrets (used here for OPENAI_API_KEY etc).
loadDotenv();
loadDotenv({ path: '.env.local', override: true });
import {
  KernelEvents,
  type Region,
} from '@sisyphus/kernel';
import { Registry } from './registry';
import { createWSHub } from './ws';
import { bus } from './event-bus';

const PORT = Number(process.env.SISYPHUS_DAEMON_PORT ?? 8787);

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY ?? '',
});

const model = process.env.OPENAI_MODEL ?? 'gpt-4o';

const SYSTEM_PROMPT =
  'You are a helpful coding assistant. When the user asks you to build something, respond with a single React component in a ```jsx code block. The code should be a complete, self-contained React component using export default. You can use inline styles. Do not use external imports besides React.';

interface ChatRequest {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
}

export const registry = new Registry();
const startedAt = Date.now();

const wsHub = createWSHub({
  // Greet every new connection with current platform state, so late joiners
  // see the same picture boot-time clients would have.
  onConnection(send) {
    send(KernelEvents.PlatformReady, { startedAt });
    send(KernelEvents.RegistrySnapshot, registry.snapshot());
  },
});

// Forward registry mutations from the in-process bus out to WS clients.
for (const event of [
  KernelEvents.RegistryViewAdded,
  KernelEvents.RegistryViewRemoved,
  KernelEvents.RegistryCardAdded,
  KernelEvents.RegistryCardRemoved,
  KernelEvents.RegistrySkillAdded,
  KernelEvents.RegistrySkillRemoved,
]) {
  bus.on(event, (data) => wsHub.broadcast(event, data));
}

const app = new Hono();

app.use('*', cors());

app.get('/health', (c) => c.json({ ok: true, name: 'sisyphus-daemon' }));

const api = new Hono();

api.post('/chat', async (c) => {
  const { messages } = await c.req.json<ChatRequest>();

  const completionStream = await client.chat.completions.create({
    model,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    stream: true,
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of completionStream) {
          // Some providers (e.g. Kimi-K2.5 via Volcengine) stream the model's
          // reasoning trace in `delta.reasoning_content` separately from the
          // final answer in `delta.content`. M1 collapses both into one stream;
          // M2 will split them so the UI can hide reasoning if it wants.
          const delta = chunk.choices[0]?.delta as
            | { content?: string; reasoning_content?: string }
            | undefined;
          // Use `||` (not `??`) — content is often "" during the reasoning
          // phase and we want to fall through to reasoning_content then.
          const content = delta?.content || delta?.reasoning_content;
          if (content) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ content })}\n\n`),
            );
          }
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
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

app.route('/api', api);

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[sisyphus-daemon] listening on http://localhost:${info.port}`);
});

// @hono/node-server's `serve()` returns a ServerType union (HTTP / HTTP/2)
// but the default factory uses http.createServer(), so the runtime instance
// is always an http.Server. Cast to narrow for ws-hub attachment.
wsHub.attach(server as unknown as HTTPServer);
