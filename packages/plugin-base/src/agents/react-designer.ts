/**
 * react-designer — plugin-base's reference agent.
 *
 * Reproduces the M0..M1 behaviour (chat → jsx code block → Sandpack preview)
 * but as a self-contained agent. The router routes here today; once a second
 * agent exists (M3+) the router will pick between them using `spawnHint`.
 */
import type { AgentImpl, AgentRunContext } from '@sisyphus/kernel';
import OpenAI from 'openai';

const SYSTEM_PROMPT =
  'You are a helpful coding assistant. When the user asks you to build something, respond with a single React component in a ```jsx code block. The code should be a complete, self-contained React component using export default. You can use inline styles. Do not use external imports besides React.';

function makeClient(): OpenAI {
  return new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY ?? '',
  });
}

export const reactDesignerAgent: AgentImpl = {
  descriptor: {
    id: 'plugin-base.agent.react-designer',
    displayName: 'React Designer',
    description:
      'Generates self-contained React components based on natural-language descriptions, previewable in the canvas.',
    spawnHint:
      'use when the user wants to build, design, or iterate on a UI component or page prototype in React',
  },

  async run(userMessage: string, ctx: AgentRunContext): Promise<void> {
    const client = makeClient();
    const model = process.env.OPENAI_MODEL ?? 'gpt-4o';

    // OpenAI's tool-role message has a different shape (needs tool_call_id);
    // history at this milestone won't contain tool messages (no skills yet),
    // so filter them out and let the rest map cleanly.
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...ctx.history
        .filter((m) => m.role !== 'tool')
        .map((m) => ({
          role: m.role as 'system' | 'user' | 'assistant',
          content: m.content,
        })),
      { role: 'user', content: userMessage },
    ];

    try {
      const stream = await client.chat.completions.create(
        {
          model,
          messages,
          stream: true,
        },
        { signal: ctx.signal },
      );

      for await (const chunk of stream) {
        if (ctx.signal.aborted) {
          ctx.emit({ type: 'done', reason: 'cancelled' });
          return;
        }
        const delta = chunk.choices[0]?.delta as
          | { content?: string; reasoning_content?: string }
          | undefined;
        // Reasoning models (e.g. Kimi-K2.5) emit think-aloud in
        // reasoning_content while content stays "". Forward both, on separate
        // event types so the UI can present them differently.
        if (delta?.reasoning_content) {
          ctx.emit({ type: 'reasoning', text: delta.reasoning_content });
        }
        if (delta?.content) {
          ctx.emit({ type: 'token', text: delta.content });
        }
      }

      ctx.emit({ type: 'done', reason: 'stop' });
    } catch (err) {
      if (ctx.signal.aborted) {
        ctx.emit({ type: 'done', reason: 'cancelled' });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      ctx.emit({ type: 'done', reason: 'error', error: msg });
    }
  },
};
