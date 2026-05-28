#!/usr/bin/env -S node --import=tsx
/**
 * M24.1 vertical slice smoke test.
 *
 * Spawns @sisylabs/plugin-hello in a child process via the broker,
 * exercises the host→plugin RPC surface end to end:
 *
 *   1. init handshake
 *   2. activate → ContributionsSnapshot reply
 *   3. invokeSkill → echo result
 *   4. invokeAgent → stream of agent.event notifications + done
 *   5. deactivate + shutdown
 *
 * Runs standalone (no daemon HTTP / Tauri). Exit 0 = pass, non-zero = fail.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonEntry = path.resolve(__dirname, '../src/index.ts');

const HELLO = '@sisylabs/plugin-hello';

function assertEq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`assert failed: ${label}\n  expected: ${e}\n  actual:   ${a}`);
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
  broker.setCrossPluginSkillInvoker(async () => {
    throw new Error('cross-plugin invoke not exercised here');
  });

  console.log('[smoke] step 1: activate plugin-hello');
  const result = await broker.activate(HELLO);
  assertEq('manifest.id', result.manifest.id, 'plugin-hello');
  assertEq(
    'skills returned',
    result.skills.map((s) => s.id).sort(),
    ['plugin-hello.skill.echo', 'plugin-hello.skill.self-destruct'],
  );
  assertEq(
    'agents returned',
    result.agents.map((a) => a.id).sort(),
    [
      'plugin-hello.agent.fanout-time',
      'plugin-hello.agent.hello-bot',
      'plugin-hello.agent.long-runner',
      'plugin-hello.agent.skill-lister',
    ],
  );

  console.log('[smoke] step 2: invoke echo skill (verify conversationId propagation)');
  const echoed = (await broker.invokeSkill(
    HELLO,
    'plugin-hello.skill.echo',
    { message: 'hi there' },
    'conv-smoke-1',
  )) as { echoed: string; convo: string };
  assertEq('echo result', echoed, {
    echoed: 'you said: hi there',
    convo: 'conv-smoke-1',
  });

  console.log('[smoke] step 3: invoke hello-bot agent');
  const events: AgentEvent[] = [];
  const history: ChatMessage[] = [];
  const ac = new AbortController();
  const ctx: AgentRunContext = {
    conversationId: 'conv-smoke-2',
    history,
    emit: (ev) => events.push(ev),
    signal: ac.signal,
    invokeSkill: async () => {
      throw new Error('not exercised');
    },
    querySkills: () => [],
    spawnAgent: async () => {
      throw new Error('not exercised');
    },
  };
  await broker.invokeAgent(
    HELLO,
    'plugin-hello.agent.hello-bot',
    ctx,
    'smoke msg',
  );
  assertEq('agent event count', events.length, 4);
  assertEq('first event type', events[0].type, 'token');
  assertEq('last event type', events[events.length - 1].type, 'done');
  const reassembled = events
    .filter((e): e is AgentEvent & { type: 'token'; text: string } => e.type === 'token')
    .map((e) => e.text)
    .join('');
  assertEq(
    'token stream concatenation',
    reassembled,
    'hello there, you said "smoke msg"',
  );

  console.log('[smoke] step 4: querySkills snapshot via host RPC');
  // skill-lister emits the JSON-stringified id list it can see via
  // ctx.querySkills(). With no requires.skills declared, plugin-hello
  // should see only its own skill.
  const listerEvents: AgentEvent[] = [];
  const listerCtx: AgentRunContext = {
    conversationId: 'conv-smoke-3',
    history: [],
    emit: (ev) => listerEvents.push(ev),
    signal: new AbortController().signal,
    invokeSkill: async () => {
      throw new Error('not exercised');
    },
    querySkills: () => [],
    spawnAgent: async () => {
      throw new Error('not exercised');
    },
  };
  // Inject a skillsForPlugin provider that mimics what plugin-manager does
  // in the real daemon. Without it, the broker would hand the plugin an
  // empty list.
  broker.setSkillsForPluginProvider((pluginId) => {
    if (pluginId !== 'plugin-hello') return [];
    return [
      {
        id: 'plugin-hello.skill.echo',
        schema: {
          type: 'function',
          function: { name: 'plugin_hello_echo', description: '', parameters: {} },
        },
      },
    ];
  });
  await broker.invokeAgent(
    HELLO,
    'plugin-hello.agent.skill-lister',
    listerCtx,
    'list em',
  );
  const tokenEv = listerEvents.find(
    (e): e is AgentEvent & { type: 'token'; text: string } => e.type === 'token',
  );
  if (!tokenEv) throw new Error('skill-lister produced no token event');
  const reportedSkills = JSON.parse(tokenEv.text) as string[];
  assertEq('querySkills returned own skill', reportedSkills, [
    'plugin-hello.skill.echo',
  ]);
  // Note: only the echo skill is injected by the test's
  // setSkillsForPluginProvider above; in a real daemon plugin-manager
  // would surface both echo + self-destruct via the same path.

  console.log('[smoke] step 5: long-runner cancel via runCtx.signal');
  const cancelAc = new AbortController();
  const cancelEvents: AgentEvent[] = [];
  const cancelCtx: AgentRunContext = {
    conversationId: 'conv-smoke-4',
    history: [],
    emit: (ev) => {
      cancelEvents.push(ev);
      // Cancel after 3 tokens
      if (
        ev.type === 'token' &&
        cancelEvents.filter((e) => e.type === 'token').length === 3
      ) {
        cancelAc.abort();
      }
    },
    signal: cancelAc.signal,
    invokeSkill: async () => {
      throw new Error('not exercised');
    },
    querySkills: () => [],
    spawnAgent: async () => {
      throw new Error('not exercised');
    },
  };
  await broker.invokeAgent(
    HELLO,
    'plugin-hello.agent.long-runner',
    cancelCtx,
    'go',
  );
  const tokens = cancelEvents.filter((e) => e.type === 'token').length;
  const doneEv = cancelEvents.find(
    (e): e is AgentEvent & { type: 'done'; reason: string } => e.type === 'done',
  );
  if (!doneEv) throw new Error('long-runner produced no done event');
  assertEq('done.reason after cancel', doneEv.reason, 'cancelled');
  if (tokens >= 50) {
    throw new Error(
      `expected cancel before 50 tokens, got ${tokens} — abort didn't propagate`,
    );
  }
  console.log(`  ✓ long-runner cancelled after ${tokens} tokens (< 50)`);

  console.log('[smoke] step 6: deactivate');
  await broker.deactivate(HELLO);
  assertEq('isActivated after deactivate', broker.isActivated(HELLO), false);

  console.log('[smoke] ✓ all assertions passed');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[smoke] FAIL:', err);
    process.exit(1);
  });
