#!/usr/bin/env -S node --import=tsx
/**
 * M24.1 vertical slice smoke test.
 *
 * Spawns @sisyphus/plugin-hello in a child process via the broker,
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
} from '@sisyphus/kernel';
import { PluginBroker } from '../src/plugin-broker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonEntry = path.resolve(__dirname, '../src/index.ts');

const HELLO = '@sisyphus/plugin-hello';

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
    result.skills.map((s) => s.id),
    ['plugin-hello.skill.echo'],
  );
  assertEq(
    'agents returned',
    result.agents.map((a) => a.id),
    ['plugin-hello.agent.hello-bot'],
  );

  console.log('[smoke] step 2: invoke echo skill');
  const echoed = (await broker.invokeSkill(
    HELLO,
    'plugin-hello.skill.echo',
    { message: 'hi there' },
    'conv-smoke-1',
  )) as { echoed: string };
  assertEq('echo result', echoed, { echoed: 'you said: hi there' });

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

  console.log('[smoke] step 4: deactivate');
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
