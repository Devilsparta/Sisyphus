#!/usr/bin/env -S node --import=tsx
/**
 * M24.3 plugin migration smoke test.
 *
 * Brings up the broker + plugin-manager + central Registry, activates the
 * two real reference plugins (@sisylabs/plugin-base, @sisylabs/plugin-todo)
 * the same way the daemon does at boot, then exercises:
 *
 *   1. plugin-base: activate → Registry sees its three agents and the
 *      current-time skill.
 *   2. plugin-base: time-helper agent end-to-end through registry.getAgent.
 *      Touches tool_call → invokeSkill (same-plugin, RPC bounces home) →
 *      tool_result → token → done.
 *   3. plugin-todo: activate → onActivate runs (loads persisted store).
 *   4. plugin-todo: todo-manager `add ...` → emits token + card; persisted
 *      to ~/.sisyphus/plugins/plugin-todo.json via host.storage.set.
 *   5. Deactivate both, then a fresh broker+pm re-activates plugin-todo and
 *      reads `list` — the task we added in step 4 should still be there.
 *
 * No LLM is called; assistant + react-designer aren't exercised here (need
 * an OPENAI_API_KEY) but their activation surface is verified.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
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

const TODO_STORAGE_FILE = path.join(
  os.homedir(),
  '.sisyphus/plugins/plugin-todo.json',
);

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

function makeBroker(): { broker: PluginBroker; registry: Registry; pm: PluginManager } {
  const broker = new PluginBroker((env) =>
    spawn(process.execPath, ['--import', 'tsx', daemonEntry], {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    }),
  );
  const registry = new Registry();
  const pm = new PluginManager(registry, broker);
  return { broker, registry, pm };
}

function makeRunCtx(
  conversationId: string,
  history: ChatMessage[],
  events: AgentEvent[],
  ac: AbortController,
): AgentRunContext {
  return {
    conversationId,
    history,
    emit: (ev) => events.push(ev),
    signal: ac.signal,
    invokeSkill: async () => {
      throw new Error('runCtx.invokeSkill not called from outside the agent');
    },
    querySkills: () => [],
    spawnAgent: async () => {
      throw new Error('runCtx.spawnAgent not called from outside the agent');
    },
  };
}

async function main(): Promise<void> {
  // Ensure no stale persisted todos from a previous failed run.
  await fs.rm(TODO_STORAGE_FILE, { force: true });

  // ── Step 1: activate plugin-base ─────────────────────────────────────────
  console.log('[smoke] step 1: activate @sisylabs/plugin-base');
  const ctx1 = makeBroker();
  const baseActivation = await ctx1.pm.activate('@sisylabs/plugin-base');
  assertEq('plugin-base manifest.id', baseActivation.manifest.id, 'plugin-base');
  const baseAgents = ctx1.registry
    .queryAgents()
    .map((a) => a.id)
    .filter((id) => id.startsWith('plugin-base.'))
    .sort();
  assertEq('plugin-base agents in Registry', baseAgents, [
    'plugin-base.agent.assistant',
    'plugin-base.agent.react-designer',
    'plugin-base.agent.time-helper',
  ]);
  const baseSkills = ctx1.registry
    .querySkills()
    .map((s) => s.id)
    .filter((id) => id.startsWith('plugin-base.'));
  assertEq('plugin-base skills in Registry', baseSkills, [
    'plugin-base.skill.current-time',
  ]);

  // ── Step 2: time-helper end-to-end ───────────────────────────────────────
  console.log('[smoke] step 2: run plugin-base.agent.time-helper');
  const helper = ctx1.registry.getAgent('plugin-base.agent.time-helper');
  if (!helper) throw new Error('time-helper not in registry');
  const helperEvents: AgentEvent[] = [];
  await helper.run(
    'what time is it',
    makeRunCtx('conv-base-1', [], helperEvents, new AbortController()),
  );
  const tcEv = helperEvents.find(
    (e): e is AgentEvent & { type: 'tool_call' } => e.type === 'tool_call',
  );
  const trEv = helperEvents.find(
    (e): e is AgentEvent & { type: 'tool_result' } => e.type === 'tool_result',
  );
  const doneEv = helperEvents.find(
    (e): e is AgentEvent & { type: 'done' } => e.type === 'done',
  );
  if (!tcEv || !trEv || !doneEv) {
    throw new Error(
      `time-helper missing event(s): ${JSON.stringify(helperEvents.map((e) => e.type))}`,
    );
  }
  assertEq('tool_call skill', tcEv.skill, 'plugin-base.skill.current-time');
  if (!trEv.result || typeof trEv.result !== 'object') {
    throw new Error(`tool_result missing or non-object: ${JSON.stringify(trEv)}`);
  }
  const skillResult = trEv.result as { iso?: string; unix?: number };
  if (typeof skillResult.iso !== 'string' || typeof skillResult.unix !== 'number') {
    throw new Error(`tool_result payload bad: ${JSON.stringify(skillResult)}`);
  }
  console.log(`  ✓ tool_call → invokeSkill → tool_result (iso=${skillResult.iso})`);
  assertEq('agent done reason', doneEv.reason, 'stop');

  // ── Step 3: activate plugin-todo ─────────────────────────────────────────
  console.log('[smoke] step 3: activate @sisylabs/plugin-todo');
  const todoActivation = await ctx1.pm.activate('@sisylabs/plugin-todo');
  assertEq('plugin-todo manifest.id', todoActivation.manifest.id, 'plugin-todo');
  const todoAgents = ctx1.registry
    .queryAgents()
    .map((a) => a.id)
    .filter((id) => id.startsWith('plugin-todo.'));
  assertEq('plugin-todo agents in Registry', todoAgents, [
    'plugin-todo.agent.todo-manager',
  ]);

  // ── Step 4: todo-manager add → emits token + card, persists to disk ──────
  console.log('[smoke] step 4: todo-manager add buy-milk');
  const todoAgent = ctx1.registry.getAgent('plugin-todo.agent.todo-manager');
  if (!todoAgent) throw new Error('todo-manager not in registry');
  const todoEvents: AgentEvent[] = [];
  await todoAgent.run(
    'add buy milk',
    makeRunCtx('conv-todo-1', [], todoEvents, new AbortController()),
  );
  const todoToken = todoEvents.find(
    (e): e is AgentEvent & { type: 'token' } => e.type === 'token',
  );
  const todoCard = todoEvents.find(
    (e): e is AgentEvent & { type: 'card' } => e.type === 'card',
  );
  if (!todoToken || !todoCard) {
    throw new Error('todo-manager missing token or card event');
  }
  assertEq('todo token', todoToken.text, 'Added: buy milk');
  assertEq('todo card type', todoCard.card.type, 'plugin-todo.card.task-list');
  const cardPayload = todoCard.card.payload as { tasks: { text: string }[] };
  assertEq('todo card task count', cardPayload.tasks.length, 1);
  assertEq('todo card task text', cardPayload.tasks[0].text, 'buy milk');

  // Give the fire-and-forget storage.set time to flush before deactivate.
  await new Promise((r) => setTimeout(r, 100));

  // ── Step 5: deactivate both, then verify storage persisted across a fresh broker ─
  console.log('[smoke] step 5: deactivate, then re-activate from fresh broker');
  await ctx1.pm.deactivate('@sisylabs/plugin-todo');
  await ctx1.pm.deactivate('@sisylabs/plugin-base');

  // Read the storage file directly to confirm it's actually on disk.
  const persisted = JSON.parse(
    await fs.readFile(TODO_STORAGE_FILE, 'utf-8'),
  ) as { tasks?: { text: string }[] };
  const tasks = persisted.tasks ?? [];
  assertEq('storage file task count', tasks.length, 1);
  assertEq('storage file task text', tasks[0].text, 'buy milk');

  // Fresh broker + manager — onActivate should re-hydrate from disk.
  const ctx2 = makeBroker();
  await ctx2.pm.activate('@sisylabs/plugin-todo');
  const todoAgent2 = ctx2.registry.getAgent('plugin-todo.agent.todo-manager');
  if (!todoAgent2) throw new Error('todo-manager not in registry (round 2)');
  const list2Events: AgentEvent[] = [];
  await todoAgent2.run(
    'list',
    makeRunCtx('conv-todo-2', [], list2Events, new AbortController()),
  );
  const list2Card = list2Events.find(
    (e): e is AgentEvent & { type: 'card' } => e.type === 'card',
  );
  if (!list2Card) throw new Error('list card missing');
  const list2Payload = list2Card.card.payload as { tasks: { text: string }[] };
  assertEq('after restart: task count', list2Payload.tasks.length, 1);
  assertEq('after restart: task text', list2Payload.tasks[0].text, 'buy milk');

  await ctx2.pm.deactivate('@sisylabs/plugin-todo');

  // Cleanup
  await fs.rm(TODO_STORAGE_FILE, { force: true });

  console.log('[smoke] ✓ migration smoke passed');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[smoke] FAIL:', err);
    process.exit(1);
  });
