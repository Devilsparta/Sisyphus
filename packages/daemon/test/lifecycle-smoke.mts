#!/usr/bin/env -S node --import=tsx
/**
 * M24.5 + M24.6 lifecycle smoke test.
 *
 * Covers:
 *   - PluginManager.respawn() on a healthy plugin = transparent
 *     re-spawn; registry entries are re-registered.
 *   - Plugin process crash (via the new self-destruct skill) →
 *     plugin-manager observes via the broker's crash callback →
 *     disposes registry entries → flips isActivated/false +
 *     isCrashed/true → fires CrashListener.
 *   - PluginManager.respawn() after a crash = recovery path; clears
 *     the crashed flag, fresh activation, registry repopulated.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginBroker } from '../src/plugin-broker.js';
import { PluginManager, type CrashedRecord } from '../src/plugin-manager.js';
import { Registry } from '../src/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonEntry = path.resolve(__dirname, '../src/index.ts');

const HELLO = '@sisylabs/plugin-hello';

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

function makeStack(): { registry: Registry; pm: PluginManager; crashes: CrashedRecord[] } {
  const broker = new PluginBroker((env) =>
    spawn(process.execPath, ['--import', 'tsx', daemonEntry], {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    }),
  );
  const registry = new Registry();
  const pm = new PluginManager(registry, broker);
  const crashes: CrashedRecord[] = [];
  pm.onCrash((rec) => crashes.push(rec));
  return { registry, pm, crashes };
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 3000,
  pollMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

async function main(): Promise<void> {
  // ── Step 1: healthy respawn — no crash, contributions repopulate ────────
  console.log('[smoke] step 1: respawn a healthy plugin');
  const ctx1 = makeStack();
  const first = await ctx1.pm.activate(HELLO);
  assertEq(
    'before respawn: isActivated',
    ctx1.pm.isActivated(HELLO),
    true,
  );
  assertEq(
    'before respawn: skills in registry',
    ctx1.registry
      .querySkills()
      .map((s) => s.id)
      .sort(),
    ['plugin-hello.skill.echo', 'plugin-hello.skill.self-destruct'],
  );

  const after = await ctx1.pm.respawn(HELLO);
  if (!after) throw new Error('respawn returned null for healthy plugin');
  assertEq(
    'after respawn: isActivated',
    ctx1.pm.isActivated(HELLO),
    true,
  );
  assertEq('after respawn: still no crashes seen', ctx1.crashes.length, 0);
  assertEq(
    'after respawn: skills still registered',
    ctx1.registry
      .querySkills()
      .map((s) => s.id)
      .sort(),
    ['plugin-hello.skill.echo', 'plugin-hello.skill.self-destruct'],
  );
  // ActivatedRecord should be a brand-new object (different disposers list).
  if (after.disposers === first.disposers) {
    throw new Error('respawn reused old disposers array — child not actually re-spawned');
  }
  console.log('  ✓ fresh ActivatedRecord (disposers identity changed)');
  await ctx1.pm.deactivate(HELLO);

  // ── Step 2: crash → manager flags + disposes + listener fires ──────────
  console.log('[smoke] step 2: crash via self-destruct skill');
  const ctx2 = makeStack();
  await ctx2.pm.activate(HELLO);
  assertEq('pre-crash: activated', ctx2.pm.isActivated(HELLO), true);
  assertEq('pre-crash: crashed', ctx2.pm.isCrashed(HELLO), false);
  assertEq(
    'pre-crash: agents registered',
    ctx2.registry
      .queryAgents()
      .map((a) => a.id)
      .sort()
      .length > 0,
    true,
  );

  // Invoke the suicide skill. We don't care about the reply — the child
  // exits via setImmediate(() => process.exit(42)) right after returning.
  // The RPC may resolve or reject (race between reply flush and exit).
  await Promise.allSettled([
    ctx2.pm
      ['broker'].invokeSkill(HELLO, 'plugin-hello.skill.self-destruct', {}, 'crash-conv'),
  ]);

  await waitFor('plugin marked crashed', () => ctx2.pm.isCrashed(HELLO));
  assertEq('post-crash: isCrashed', ctx2.pm.isCrashed(HELLO), true);
  assertEq('post-crash: isActivated', ctx2.pm.isActivated(HELLO), false);
  const crashRec = ctx2.pm.getCrashed(HELLO);
  if (!crashRec) throw new Error('expected a crashed record');
  assertEq('post-crash: pluginId in record', crashRec.pluginId, 'plugin-hello');
  if (!crashRec.reason.includes('42')) {
    throw new Error(`crash reason should mention exit code 42, got: ${crashRec.reason}`);
  }
  console.log(`  ✓ crash reason: ${crashRec.reason}`);
  assertEq(
    'post-crash: registry agents disposed',
    ctx2.registry
      .queryAgents()
      .filter((a) => a.id.startsWith('plugin-hello.')).length,
    0,
  );
  assertEq(
    'post-crash: registry skills disposed',
    ctx2.registry
      .querySkills()
      .filter((s) => s.id.startsWith('plugin-hello.')).length,
    0,
  );
  assertEq('post-crash: listener fired once', ctx2.crashes.length, 1);
  assertEq(
    'post-crash: listener payload pluginId',
    ctx2.crashes[0].pluginId,
    'plugin-hello',
  );

  // ── Step 3: respawn after crash recovers the plugin ─────────────────────
  console.log('[smoke] step 3: respawn after crash');
  const recovered = await ctx2.pm.respawn(HELLO);
  if (!recovered) throw new Error('respawn returned null for crashed plugin');
  assertEq('post-recovery: isActivated', ctx2.pm.isActivated(HELLO), true);
  assertEq('post-recovery: isCrashed', ctx2.pm.isCrashed(HELLO), false);
  assertEq(
    'post-recovery: skills re-registered',
    ctx2.registry
      .querySkills()
      .map((s) => s.id)
      .sort(),
    ['plugin-hello.skill.echo', 'plugin-hello.skill.self-destruct'],
  );
  await ctx2.pm.deactivate(HELLO);

  console.log('[smoke] ✓ lifecycle smoke passed');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[smoke] FAIL:', err);
    process.exit(1);
  });
