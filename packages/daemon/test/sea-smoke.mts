#!/usr/bin/env -S node --import=tsx
/**
 * M24.4 SEA self-spawn smoke test.
 *
 * Same protocol coverage as broker-smoke.mts, but the spawner this time
 * is the daemon SEA binary itself — exercising the prod path where a
 * .app's `Sisyphus.app/Contents/MacOS/sisyphus-daemon` is re-entered as
 * a plugin host via SISYPHUS_MODE=plugin-host. No tsx, no .ts plugin
 * sources; the plugin must ship pre-compiled .mjs as a real npm
 * package would.
 *
 * Pre-reqs (the script checks for them and fails loudly):
 *   1. `pnpm --filter @sisyphus/daemon build:bin`
 *   2. `pnpm --filter @sisyphus/plugin-hello build`
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentEvent,
  AgentRunContext,
  ChatMessage,
} from '@sisyphus/kernel';
import { PluginBroker } from '../src/plugin-broker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

function hostTriple(): string {
  const out = execSync('rustc -vV', {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const m = out.match(/^host:\s*(\S+)/m);
  if (!m) throw new Error('could not parse host triple from rustc -vV');
  return m[1];
}

const triple = hostTriple();
const seaBinary = path.join(
  repoRoot,
  `src-tauri/binaries/sisyphus-daemon-${triple}`,
);
const pluginHelloDist = path.join(
  repoRoot,
  'packages/plugin-hello/dist/index.mjs',
);

if (!existsSync(seaBinary)) {
  console.error(
    `[sea-smoke] SEA binary not found at ${seaBinary}\n` +
      `[sea-smoke] run \`pnpm --filter @sisyphus/daemon build:bin\` first`,
  );
  process.exit(1);
}
if (!existsSync(pluginHelloDist)) {
  console.error(
    `[sea-smoke] plugin-hello bundle not found at ${pluginHelloDist}\n` +
      `[sea-smoke] run \`pnpm --filter @sisyphus/plugin-hello build\` first`,
  );
  process.exit(1);
}

console.log(`[sea-smoke] SEA binary:   ${seaBinary}`);
console.log(`[sea-smoke] plugin entry: ${pluginHelloDist}`);

const HELLO = '@sisyphus/plugin-hello';

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
    // The SEA binary IS the daemon. With env SISYPHUS_MODE=plugin-host it
    // re-enters as plugin-host mode and loads SISYPHUS_PLUGIN_ENTRY.
    spawn(seaBinary, [], {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    }),
  );
  broker.setCrossPluginSkillInvoker(async () => {
    throw new Error('cross-plugin invoke not exercised here');
  });
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

  console.log('[sea-smoke] step 1: activate plugin-hello via SEA self-spawn');
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
      'plugin-hello.agent.hello-bot',
      'plugin-hello.agent.long-runner',
      'plugin-hello.agent.skill-lister',
    ],
  );

  console.log('[sea-smoke] step 2: invoke echo skill');
  const echoed = (await broker.invokeSkill(
    HELLO,
    'plugin-hello.skill.echo',
    { message: 'sea hi' },
    'sea-conv-1',
  )) as { echoed: string; convo: string };
  assertEq('echo result', echoed, {
    echoed: 'you said: sea hi',
    convo: 'sea-conv-1',
  });

  console.log('[sea-smoke] step 3: invoke hello-bot agent (token stream)');
  const helloEvents: AgentEvent[] = [];
  const helloCtx: AgentRunContext = {
    conversationId: 'sea-conv-2',
    history: [] as ChatMessage[],
    emit: (ev) => helloEvents.push(ev),
    signal: new AbortController().signal,
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
    helloCtx,
    'sea msg',
  );
  const reassembled = helloEvents
    .filter(
      (e): e is AgentEvent & { type: 'token'; text: string } =>
        e.type === 'token',
    )
    .map((e) => e.text)
    .join('');
  assertEq(
    'token stream',
    reassembled,
    'hello there, you said "sea msg"',
  );

  console.log('[sea-smoke] step 4: long-runner cancel');
  const cancelAc = new AbortController();
  const cancelEvents: AgentEvent[] = [];
  const cancelCtx: AgentRunContext = {
    conversationId: 'sea-conv-3',
    history: [],
    emit: (ev) => {
      cancelEvents.push(ev);
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
  const doneEv = cancelEvents.find(
    (e): e is AgentEvent & { type: 'done'; reason: string } => e.type === 'done',
  );
  if (!doneEv) throw new Error('long-runner produced no done event');
  assertEq('done.reason', doneEv.reason, 'cancelled');
  const tokens = cancelEvents.filter((e) => e.type === 'token').length;
  if (tokens >= 50) {
    throw new Error(
      `expected cancel before 50 tokens, got ${tokens} — abort did not propagate over SEA pipe`,
    );
  }
  console.log(`  ✓ cancelled after ${tokens} tokens`);

  console.log('[sea-smoke] step 5: deactivate');
  await broker.deactivate(HELLO);
  assertEq('isActivated after deactivate', broker.isActivated(HELLO), false);

  console.log('[sea-smoke] ✓ SEA self-spawn end-to-end OK');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[sea-smoke] FAIL:', err);
    process.exit(1);
  });
