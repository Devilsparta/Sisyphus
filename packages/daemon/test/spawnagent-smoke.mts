#!/usr/bin/env -S node --import=tsx
/**
 * M24 spawnAgent smoke — cross-plugin fan-out over RPC.
 *
 * Setup:
 *   plugin-hello has a `fanout-time` agent that calls
 *   ctx.spawnAgent('plugin-base.agent.time-helper', ...). With both
 *   plugins activated through the broker, each lives in its own child
 *   process. fanout-time fires `host.spawnAgent` → daemon routes to
 *   plugin-base's process → time-helper runs → its events stream back
 *   into the parent (hello-fanout) run's emit tagged with source =
 *   plugin-base.agent.time-helper.
 *
 * Asserts:
 *   1. Parent's emit received the sub-agent's tool_call / tool_result /
 *      token / done events.
 *   2. Source on sub-agent events is "plugin-base.agent.time-helper"
 *      (preserved by router-equivalent emit chain).
 *   3. Source on parent's own events is "plugin-hello.agent.fanout-time".
 *   4. The parent run finishes after the sub finishes — order of done
 *      events is: sub done → parent done.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentEvent,
  AgentRunContext,
  ChatMessage,
} from '@sisylabs/kernel';
import { PluginBroker } from '../src/plugin-broker.js';
import { PluginManager } from '../src/plugin-manager.js';
import { Registry } from '../src/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonEntry = path.resolve(__dirname, '../src/index.ts');

function assertEq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(
      `assert failed: ${label}\n  expected: ${e}\n  actual:   ${a}`,
    );
  }
  console.log(`  ✓ ${label}`);
}

async function main(): Promise<void> {
  const broker = new PluginBroker((env) =>
    spawn(process.execPath, ['--import', 'tsx', daemonEntry], {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    }),
  );
  const registry = new Registry();
  const pm = new PluginManager(registry, broker);

  console.log('[smoke] activating plugin-base + plugin-hello');
  await pm.activate('@sisylabs/plugin-base');
  await pm.activate('@sisylabs/plugin-hello');

  const fanout = registry.getAgent('plugin-hello.agent.fanout-time');
  if (!fanout) throw new Error('fanout-time agent not registered');

  console.log('[smoke] invoking fanout-time (will spawn time-helper sub-agent)');
  const events: AgentEvent[] = [];
  const history: ChatMessage[] = [];
  const ac = new AbortController();
  // Emit goes through a source-preserving wrapper that mimics what router.ts
  // does for the top-level agent: tags source = parent.id if missing.
  const sourcedEmit = (ev: AgentEvent): void => {
    events.push({ ...ev, source: ev.source ?? 'plugin-hello.agent.fanout-time' });
  };
  const ctx: AgentRunContext = {
    conversationId: 'conv-fanout-1',
    history,
    emit: sourcedEmit,
    signal: ac.signal,
    invokeSkill: async () => {
      throw new Error('not exercised');
    },
    querySkills: () => [],
    spawnAgent: async () => {
      throw new Error('top-level spawnAgent stub');
    },
  };

  await broker.invokeAgent(
    '@sisylabs/plugin-hello',
    'plugin-hello.agent.fanout-time',
    ctx,
    'go',
  );

  // ── Assertions ──────────────────────────────────────────────────────────
  const fanoutSource = 'plugin-hello.agent.fanout-time';
  const subSource = 'plugin-base.agent.time-helper';

  const fanoutEvents = events.filter((e) => e.source === fanoutSource);
  const subEvents = events.filter((e) => e.source === subSource);

  console.log(
    `[smoke] received ${events.length} events ` +
      `(${fanoutEvents.length} from fanout-time, ${subEvents.length} from time-helper)`,
  );

  if (fanoutEvents.length === 0) throw new Error('no parent-sourced events');
  if (subEvents.length === 0) throw new Error('no sub-agent-sourced events');

  // Parent emitted "spawning time-helper..." and "sub done" tokens.
  const parentTokens = fanoutEvents
    .filter(
      (e): e is AgentEvent & { type: 'token'; text: string } =>
        e.type === 'token',
    )
    .map((e) => e.text);
  assertEq(
    'parent emitted both pre + post tokens',
    parentTokens.some((t) => t.includes('spawning')) &&
      parentTokens.some((t) => t.includes('sub done')),
    true,
  );

  // Sub-agent emitted tool_call → tool_result → token → done.
  const subTypes = subEvents.map((e) => e.type);
  assertEq(
    'sub-agent event types in order',
    subTypes,
    ['tool_call', 'tool_result', 'token', 'done'],
  );

  // Order check: sub-agent's `done` must come BEFORE parent's `done`,
  // since the parent awaits spawnAgent before emitting its own done.
  const subDoneIdx = events.findIndex(
    (e) => e.source === subSource && e.type === 'done',
  );
  const parentDoneIdx = events.findIndex(
    (e) => e.source === fanoutSource && e.type === 'done',
  );
  if (subDoneIdx === -1 || parentDoneIdx === -1) {
    throw new Error('missing done event(s)');
  }
  if (subDoneIdx >= parentDoneIdx) {
    throw new Error(
      `expected sub done (idx ${subDoneIdx}) before parent done (idx ${parentDoneIdx})`,
    );
  }
  console.log(
    `  ✓ ordering: sub done idx ${subDoneIdx} < parent done idx ${parentDoneIdx}`,
  );

  // Sub-agent's tool_call points at the right skill.
  const tc = subEvents.find(
    (e): e is AgentEvent & { type: 'tool_call'; skill: string } =>
      e.type === 'tool_call',
  );
  assertEq('sub tool_call.skill', tc?.skill, 'plugin-base.skill.current-time');

  await pm.deactivate('@sisylabs/plugin-hello');
  await pm.deactivate('@sisylabs/plugin-base');

  console.log('[smoke] ✓ spawnAgent fan-out smoke passed');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[smoke] FAIL:', err);
    process.exit(1);
  });
