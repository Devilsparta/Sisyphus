/**
 * sisyphus-daemon — HTTP server (M1 cut).
 *
 * Endpoints:
 *   GET  /health                  — liveness probe
 *   POST /api/chat                — LLM streaming (SSE)
 *   GET  /api/registry/views      — list registered views (optional ?region=)
 *   GET  /api/registry/cards      — list registered card types
 *   GET  /api/registry/skills     — list registered skills
 *
 * Plugin loader and WebSocket land later in M1 (WS frame format is still
 * pending a user decision; see wiki待拍决策 #1).
 *
 * The system prompt is still hardcoded here (M2 moves it into plugin-base).
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import 'dotenv/config';
import OpenAI from 'openai';
import type { Region } from '@sisyphus/kernel';
import { Registry } from './registry';

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
          const content = chunk.choices[0]?.delta?.content;
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

serve({ fetch: app.fetch, port: PORT }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[sisyphus-daemon] listening on http://localhost:${info.port}`);
});
