/**
 * assistant agent — general-purpose LLM helper with streaming tool calling.
 *
 * Strategy: streaming per LLM turn so reasoning + token chunks surface as the
 * model produces them (no 30+ second silence before the first character).
 * Tool calls arrive as `delta.tool_calls[]` shards keyed by `index`, which we
 * merge per-index across chunks; once the stream ends we dispatch them all,
 * push the tool messages back, and run the next turn.
 *
 * Loop terminates when a turn produces no tool calls (LLM answered) or after
 * MAX_TOOL_TURNS as a runaway guard.
 *
 * Skill id ↔ tool name mapping:
 *   OpenAI's function-name regex disallows '.', so skill.id like
 *   "plugin-base.skill.current-time" can't be the schema.function.name.
 *   This agent builds a {tool_name → skill_id} map from ctx.querySkills()
 *   each turn so dispatch finds the right handler.
 */
import type { AgentImpl } from '@sisyphus/kernel';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';

const SYSTEM_PROMPT = `You are Sisyphus's general assistant. You have access to tools (functions) that the platform exposes through plugins. Use them when they help you answer the user's question. After all needed tool calls, give a concise natural-language answer.`;

const MAX_TOOL_TURNS = 5;

function makeClient(): OpenAI {
  return new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY ?? '',
  });
}

interface PendingToolCall {
  id: string;
  name: string;
  argumentsRaw: string;
}

export const assistantAgent: AgentImpl = {
  descriptor: {
    id: 'plugin-base.agent.assistant',
    displayName: 'Assistant',
    description:
      'General-purpose assistant. Uses the LLM with whatever skills the platform has registered as tools.',
    spawnHint:
      'use as a fallback when no other agent matches, or when the user asks a general question that may need one or more tool calls (lookup, fetch, computation).',
    triggerKeywords: [
      'help',
      'assistant',
      'question',
      'ask',
      'how',
      'why',
      'what',
      'who',
      'when',
      'where',
      'tell',
      'explain',
    ],
  },

  async run(userMessage, ctx) {
    const client = makeClient();
    const model = process.env.OPENAI_MODEL ?? 'gpt-4o';

    const skills = ctx.querySkills();
    const tools = skills.map((s) => s.schema);
    const nameToId = new Map<string, string>();
    for (const s of skills) {
      nameToId.set(s.schema.function.name, s.id);
    }

    type AssistantMessage = OpenAI.Chat.ChatCompletionMessageParam;

    const messages: AssistantMessage[] = [
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
      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        if (ctx.signal.aborted) {
          ctx.emit({ type: 'done', reason: 'cancelled' });
          return;
        }

        const stream = await client.chat.completions.create(
          {
            model,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            tool_choice: tools.length > 0 ? 'auto' : undefined,
            stream: true,
          },
          { signal: ctx.signal },
        );

        let content = '';
        const pendingByIndex = new Map<number, PendingToolCall>();

        for await (const chunk of stream) {
          if (ctx.signal.aborted) {
            ctx.emit({ type: 'done', reason: 'cancelled' });
            return;
          }
          const delta = chunk.choices[0]?.delta as
            | {
                content?: string;
                reasoning_content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  type?: 'function';
                  function?: { name?: string; arguments?: string };
                }>;
              }
            | undefined;
          if (!delta) continue;

          if (delta.reasoning_content) {
            ctx.emit({ type: 'reasoning', text: delta.reasoning_content });
          }
          if (delta.content) {
            content += delta.content;
            ctx.emit({ type: 'token', text: delta.content });
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              let pending = pendingByIndex.get(tc.index);
              if (!pending) {
                pending = { id: '', name: '', argumentsRaw: '' };
                pendingByIndex.set(tc.index, pending);
              }
              if (tc.id) pending.id = tc.id;
              if (tc.function?.name) pending.name = tc.function.name;
              if (tc.function?.arguments) {
                pending.argumentsRaw += tc.function.arguments;
              }
            }
          }
        }

        const calls = [...pendingByIndex.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, c]) => c);

        if (calls.length === 0) {
          // No tool calls → terminal turn. Token chunks already emitted.
          ctx.emit({ type: 'done', reason: 'stop' });
          return;
        }

        // Push the assistant turn (with tool_calls) before appending tool
        // messages — OpenAI requires the alternation.
        messages.push({
          role: 'assistant',
          content: content || null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.argumentsRaw || '{}' },
          })),
        } as AssistantMessage);

        for (const call of calls) {
          const skillId = nameToId.get(call.name);
          let args: Record<string, unknown> = {};
          try {
            args = call.argumentsRaw
              ? (JSON.parse(call.argumentsRaw) as Record<string, unknown>)
              : {};
          } catch {
            args = {};
          }

          const traceId = randomUUID();
          ctx.emit({
            type: 'tool_call',
            id: traceId,
            skill: skillId ?? call.name,
            args,
          });

          if (!skillId) {
            const error = `unknown tool name: ${call.name}`;
            ctx.emit({ type: 'tool_result', id: traceId, error });
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({ error }),
            });
            continue;
          }

          try {
            const result = await ctx.invokeSkill(skillId, args);
            ctx.emit({ type: 'tool_result', id: traceId, result });
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(result),
            });
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            ctx.emit({ type: 'tool_result', id: traceId, error });
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({ error }),
            });
          }
        }
        // Continue the loop: feed tool results back for the next LLM turn.
      }

      ctx.emit({
        type: 'token',
        text: `(assistant: stopped after ${MAX_TOOL_TURNS} tool turns)`,
      });
      ctx.emit({
        type: 'done',
        reason: 'error',
        error: `exceeded MAX_TOOL_TURNS=${MAX_TOOL_TURNS}`,
      });
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
