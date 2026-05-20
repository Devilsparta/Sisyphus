/**
 * time-helper agent — minimal demonstrator for the skill dispatch round-trip.
 *
 * Rule-based, no LLM, so the test stays cheap and deterministic. When the
 * user asks about the time, it:
 *   1. Emits a `tool_call` event (UI gets a visible trace of the invocation).
 *   2. Calls ctx.invokeSkill('plugin-base.skill.current-time', {}).
 *   3. Emits a `tool_result` event with the return value.
 *   4. Emits a human-readable `token` summarising the result.
 *   5. Emits `done`.
 *
 * Doubles as the smoke test for the M5 skill plumbing: kernel → router →
 * registry → handler → back to agent.
 */
import { randomUUID } from 'node:crypto';
import type { AgentImpl } from '@sisyphus/kernel';

const SKILL_ID = 'plugin-base.skill.current-time';

export const timeHelperAgent: AgentImpl = {
  descriptor: {
    id: 'plugin-base.agent.time-helper',
    displayName: 'Time Helper',
    description:
      'Reports the current server time on request. Demo of the skill dispatch loop.',
    spawnHint:
      'use when the user asks about the current time, date, or "what time is it".',
    triggerKeywords: ['time', 'clock', 'date', 'now', 'timestamp'],
  },

  async run(userMessage, ctx) {
    const callId = randomUUID();
    ctx.emit({
      type: 'tool_call',
      id: callId,
      skill: SKILL_ID,
      args: {},
    });

    let result: { iso: string; unix: number } | null = null;
    try {
      result = (await ctx.invokeSkill(SKILL_ID, {})) as typeof result;
      ctx.emit({
        type: 'tool_result',
        id: callId,
        result,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.emit({
        type: 'tool_result',
        id: callId,
        error: msg,
      });
      ctx.emit({
        type: 'token',
        text: `Failed to fetch time: ${msg}`,
      });
      ctx.emit({ type: 'done', reason: 'error', error: msg });
      return;
    }

    ctx.emit({
      type: 'token',
      text: `Server time is ${result!.iso} (unix ${result!.unix}). ` +
        `User asked: "${userMessage.trim()}"`,
    });
    ctx.emit({ type: 'done', reason: 'stop' });
  },
};
