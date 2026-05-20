/**
 * assistant agent — general-purpose LLM helper with tool calling.
 *
 * Build target for M6: take whatever skills the platform has registered,
 * expose them all to the LLM as tools, and let the model decide which to
 * call. Loops until the model finishes without further tool_calls.
 *
 * Non-streaming on purpose: the tool-calling round-trip is multi-turn and
 * streaming partial tool_call arguments is fiddly. Once the loop is correct
 * we can switch to streaming with chunk-merging if latency becomes painful.
 *
 * Skill id ↔ tool name mapping:
 *   OpenAI's function-name regex disallows '.', so skill.id like
 *   "plugin-base.skill.current-time" can't be the schema.function.name.
 *   This agent builds a {tool_name → skill_id} map from ctx.querySkills()
 *   each turn so dispatch finds the right handler.
 */
import type { AgentImpl, AgentRunContext } from '@sisyphus/kernel';
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

    // Build the tools array from currently-registered skills, plus a map so
    // we can translate the LLM's tool_call.function.name back to a skill id.
    const skills = ctx.querySkills();
    const tools = skills.map((s) => s.schema);
    const nameToId = new Map<string, string>();
    for (const s of skills) {
      nameToId.set(s.schema.function.name, s.id);
    }

    type AssistantMessage =
      OpenAI.Chat.ChatCompletionMessageParam;

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

        const completion = await client.chat.completions.create(
          {
            model,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            tool_choice: tools.length > 0 ? 'auto' : undefined,
            stream: false,
          },
          { signal: ctx.signal },
        );

        const msg = completion.choices[0]?.message;
        if (!msg) {
          ctx.emit({
            type: 'done',
            reason: 'error',
            error: 'empty completion',
          });
          return;
        }

        // Forward any reasoning trace the model produced (Kimi-K2.5 fills
        // delta.reasoning_content; non-streaming responses put it on the
        // message object directly).
        const reasoning = (msg as { reasoning_content?: string })
          .reasoning_content;
        if (reasoning) {
          ctx.emit({ type: 'reasoning', text: reasoning });
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Need to push the assistant turn (including tool_calls) before
          // appending tool results — OpenAI requires the conversation to
          // alternate assistant(tool_calls) → tool messages.
          messages.push(msg as AssistantMessage);

          for (const call of msg.tool_calls) {
            if (call.type !== 'function') continue;
            const skillId = nameToId.get(call.function.name);
            let args: Record<string, unknown> = {};
            try {
              args = call.function.arguments
                ? (JSON.parse(call.function.arguments) as Record<
                    string,
                    unknown
                  >)
                : {};
            } catch {
              args = {};
            }

            const traceId = randomUUID();
            ctx.emit({
              type: 'tool_call',
              id: traceId,
              skill: skillId ?? call.function.name,
              args,
            });

            if (!skillId) {
              const error = `unknown tool name: ${call.function.name}`;
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
          // Loop: feed tool results back to the model for the next turn.
          continue;
        }

        // No tool calls → terminal turn. Surface the natural-language reply
        // and finish.
        if (msg.content) {
          ctx.emit({ type: 'token', text: msg.content });
        }
        ctx.emit({ type: 'done', reason: 'stop' });
        return;
      }

      // Bail-out: too many tool turns.
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
