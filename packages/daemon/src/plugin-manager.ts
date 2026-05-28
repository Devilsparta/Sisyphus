/**
 * Plugin lifecycle manager (M24 — broker-backed).
 *
 * Plugins now run as child processes. This file:
 *   - delegates spawn / activate / deactivate / RPC to PluginBroker,
 *   - takes the ContributionsSnapshot the plugin reports and registers it
 *     into the central daemon-side Registry, with skill handlers and agent
 *     impls implemented as RPC proxies (handler invocations bounce through
 *     the broker into the plugin child),
 *   - hosts the cross-plugin skill invoker the broker uses when one plugin
 *     calls `host.invokeSkill` — this is where the M13 ACL lives.
 *
 * The public surface (isActivated / activate / deactivate / listActivated)
 * mirrors the in-process M9..M23 manager so daemon index.ts and the
 * /api/plugins/* routes don't have to know they're talking to subprocesses.
 */
import type {
  AgentEvent,
  AgentImpl,
  AgentRunContext,
  ChatMessage,
  Disposable,
  PluginManifest,
  SkillDescriptor,
  SkillHandler,
} from '@sisylabs/kernel';
import type { Registry } from './registry';
import { ScopedRegistry } from './scoped-registry';
import type { PluginBroker } from './plugin-broker';

const ERR_ACL_DENIED = -32030;

export interface ActivatedRecord {
  packageName: string;
  manifest: PluginManifest;
  uiBundlePath: string | null;
  daemonEntryPath: string;
  disposers: Disposable[];
}

export interface CrashedRecord {
  packageName: string;
  pluginId: string | null;
  manifest: PluginManifest | null;
  reason: string;
  /** Wall-clock when the crash was observed. */
  at: number;
}

/**
 * Notified after plugin-manager has fully reacted to an unexpected child
 * exit: registry entries disposed, internal state updated. Daemon
 * subscribes to broadcast a WS event to the UI.
 */
export type CrashListener = (record: CrashedRecord) => void;

export class PluginManager {
  private activated = new Map<string, ActivatedRecord>();
  /**
   * Plugins whose child process died unexpectedly. UI shows them as
   * "crashed, needs reactivation"; the user calls reactivate() to clear.
   */
  private crashed = new Map<string, CrashedRecord>();
  private crashListeners = new Set<CrashListener>();

  constructor(
    private registry: Registry,
    private broker: PluginBroker,
  ) {
    broker.setCrossPluginSkillInvoker(
      (skillId, args, conversationId, callerPluginId) =>
        this.invokeCrossPluginSkill(
          skillId,
          args,
          conversationId,
          callerPluginId,
        ),
    );
    broker.setSkillsForPluginProvider((callerPluginId) =>
      this.skillsForPlugin(callerPluginId),
    );
    broker.setCrashObserver((pkg, info) => {
      this.handleCrash(pkg, info);
    });
    broker.setSpawnAgentHandler((p) => this.spawnSubAgent(p));
  }

  isActivated(packageName: string): boolean {
    return this.activated.has(packageName);
  }

  isCrashed(packageName: string): boolean {
    return this.crashed.has(packageName);
  }

  getCrashed(packageName: string): CrashedRecord | undefined {
    return this.crashed.get(packageName);
  }

  listActivated(): ActivatedRecord[] {
    return Array.from(this.activated.values());
  }

  listCrashed(): CrashedRecord[] {
    return Array.from(this.crashed.values());
  }

  onCrash(listener: CrashListener): () => void {
    this.crashListeners.add(listener);
    return () => this.crashListeners.delete(listener);
  }

  async activate(packageName: string): Promise<ActivatedRecord> {
    if (this.activated.has(packageName)) {
      return this.activated.get(packageName)!;
    }

    // Activating a previously crashed plugin clears the crashed flag —
    // user explicitly opted to retry.
    this.crashed.delete(packageName);

    const result = await this.broker.activate(packageName);
    const { manifest, uiBundlePath, daemonEntryPath } = result;

    // Manifest first so any cross-plugin ACL lookup during this activation
    // sees it. UI bundle endpoint also uses pluginRecords to resolve the
    // file path.
    this.registry.registerPluginRecord({
      manifest,
      packageName,
      uiBundlePath,
    });

    const scoped = new ScopedRegistry(this.registry, manifest.id);
    const disposers: Disposable[] = [];

    try {
      for (const skill of result.skills) {
        const proxy: SkillHandler = async (args, ctx) =>
          this.broker.invokeSkill(
            packageName,
            skill.id,
            args,
            ctx.conversationId,
          );
        disposers.push(scoped.registerSkill(skill, proxy));
      }

      for (const agentDesc of result.agents) {
        const impl: AgentImpl = {
          descriptor: agentDesc,
          run: async (userMessage, runCtx) =>
            this.broker.invokeAgent(
              packageName,
              agentDesc.id,
              runCtx,
              userMessage,
            ),
        };
        disposers.push(scoped.registerAgent(impl));
      }

      for (const view of result.views) {
        disposers.push(scoped.registerView(view));
      }

      for (const card of result.cards) {
        disposers.push(scoped.registerCard(card));
      }
    } catch (err) {
      for (const d of disposers) {
        try {
          d.dispose();
        } catch {
          /* ignore */
        }
      }
      await this.broker.deactivate(packageName);
      throw err;
    }

    const record: ActivatedRecord = {
      packageName,
      manifest,
      uiBundlePath,
      daemonEntryPath,
      disposers,
    };
    this.activated.set(packageName, record);

    // eslint-disable-next-line no-console
    console.log(
      `[plugin-manager] activated "${manifest.id}" (${packageName})`,
      {
        agents: result.agents.map((a) => a.id),
        skills: result.skills.map((s) => s.id),
        views: result.views.map((v) => v.id),
        hasUI: uiBundlePath !== null,
      },
    );

    return record;
  }

  async deactivate(packageName: string): Promise<void> {
    const entry = this.activated.get(packageName);
    if (!entry) return;

    for (const d of entry.disposers) {
      try {
        d.dispose();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[plugin-manager] disposer for "${packageName}" threw:`,
          err,
        );
      }
    }
    this.activated.delete(packageName);

    await this.broker.deactivate(packageName);

    // eslint-disable-next-line no-console
    console.log(`[plugin-manager] deactivated "${packageName}"`);
  }

  /**
   * Dev-mode hot reload — kill the plugin child, re-activate fresh. Skips
   * the work if the plugin isn't activated or crashed already. Idempotent
   * if called for a crashed plugin: deactivate is a no-op since the child
   * is already gone; activate then spawns fresh.
   */
  async respawn(packageName: string): Promise<ActivatedRecord | null> {
    const wasActivated = this.activated.has(packageName);
    const wasCrashed = this.crashed.has(packageName);
    if (!wasActivated && !wasCrashed) return null;

    if (wasActivated) {
      await this.deactivate(packageName);
    }
    return await this.activate(packageName);
  }

  /**
   * Broker → plugin-manager bridge for unexpected child exits. Disposes
   * registry contributions of the now-defunct plugin, stashes a
   * CrashedRecord for the API + UI, and fires registered listeners.
   * The plugin's installer / enabled state is untouched so it stays
   * "installed + enabled" — the user reactivates to bring it back.
   */
  private handleCrash(
    packageName: string,
    info: { code: number | null; signal: NodeJS.Signals | null },
  ): void {
    const prior = this.activated.get(packageName);
    if (!prior) return;
    this.activated.delete(packageName);

    for (const d of prior.disposers) {
      try {
        d.dispose();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[plugin-manager] crash cleanup: disposer for "${packageName}" threw:`,
          err,
        );
      }
    }

    const reason =
      info.signal !== null
        ? `terminated by signal ${info.signal}`
        : info.code !== null
          ? `exited with code ${info.code}`
          : 'process exited unexpectedly';

    const crashRecord: CrashedRecord = {
      packageName,
      pluginId: prior.manifest.id,
      manifest: prior.manifest,
      reason,
      at: Date.now(),
    };
    this.crashed.set(packageName, crashRecord);

    // eslint-disable-next-line no-console
    console.error(
      `[plugin-manager] plugin "${packageName}" crashed: ${reason}; cleaned ${prior.disposers.length} registrations`,
    );

    for (const fn of this.crashListeners) {
      try {
        fn(crashRecord);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[plugin-manager] crash listener threw:', err);
      }
    }
  }

  /**
   * Broker's cross-plugin skill bridge. When a plugin's child process calls
   * `host.invokeSkill` (typically from an agent's `ctx.invokeSkill`), this
   * is what runs. M13 ACL lives here — same canInvokeSkill rule as the
   * router: skill in caller's namespace = OK, otherwise must be declared
   * in caller's `manifest.requires.skills`.
   */
  /**
   * Sub-agent spawn handler bridged from the broker. Routes the call to
   * whichever plugin owns the target agent, sharing the caller's
   * conversation + parent-emit so events flow inline.
   *
   * Source-tagging: the sub-agent's plugin-host runtime auto-tags emitted
   * events with `source = subAgentId`. Parent's emit (re-used here as
   * `sub-runCtx.emit`) preserves an already-set source, so the UI sees
   * fan-out branches distinguished by source even though they all stream
   * into the same conversation.
   *
   * No agent-side ACL in v1: any plugin that has another plugin's agent
   * id can spawn it. Skill ACL still applies inside the sub-agent.
   */
  private async spawnSubAgent(params: {
    callerPluginId: string;
    parentAgentId: string;
    parentRunId: string;
    subAgentId: string;
    subMessage: string;
    conversationId: string;
    history: ChatMessage[];
  }): Promise<void> {
    const parentEmit = this.broker.getEmitForRun(params.parentRunId);
    if (!parentEmit) {
      throw new Error(
        `spawnAgent: no parent run registered for runId "${params.parentRunId}"`,
      );
    }

    // Sub-agent's owner plugin lives under the namespace prefix of its id.
    const dot = params.subAgentId.indexOf('.');
    const ownerPluginId =
      dot > 0 ? params.subAgentId.slice(0, dot) : params.subAgentId;
    const record = this.registry.getPluginRecord(ownerPluginId);
    if (!record) {
      throw new Error(
        `spawnAgent: target plugin "${ownerPluginId}" not registered`,
      );
    }
    const ownerPackage = record.packageName;
    if (!this.activated.has(ownerPackage)) {
      throw new Error(
        `spawnAgent: plugin "${ownerPackage}" not currently activated`,
      );
    }

    const subAc = new AbortController();
    const subRunCtx: AgentRunContext = {
      conversationId: params.conversationId,
      history: params.history,
      emit: (ev: AgentEvent) => parentEmit(ev),
      signal: subAc.signal,
      // Sub-agent's own RPC ctx is built fresh inside the child process by
      // plugin-host-runtime; the stubs we pass here are only invoked if
      // some daemon-side code calls them directly (it doesn't).
      invokeSkill: async () => {
        throw new Error(
          'invokeSkill is only available inside the plugin process, not the daemon shim',
        );
      },
      querySkills: () => [],
      spawnAgent: async () => {
        throw new Error('nested spawnAgent must originate from the plugin');
      },
    };

    await this.broker.invokeAgent(
      ownerPackage,
      params.subAgentId,
      subRunCtx,
      params.subMessage,
    );
  }

  /**
   * Returns the skills the caller plugin is allowed to invoke — its own
   * namespace plus whatever `manifest.requires.skills` opts in to. Same
   * rule as `canInvokeSkill` in router.ts (M13), keep them in sync.
   */
  private skillsForPlugin(callerPluginId: string): SkillDescriptor[] {
    const callerManifest = this.registry.getPluginManifest(callerPluginId);
    const required = callerManifest?.requires?.skills ?? [];
    const ownPrefix = `${callerPluginId}.`;
    return this.registry
      .querySkills()
      .filter(
        (s) => s.id.startsWith(ownPrefix) || required.includes(s.id),
      );
  }

  private async invokeCrossPluginSkill(
    skillId: string,
    args: Record<string, unknown>,
    conversationId: string,
    callerPluginId: string,
  ): Promise<unknown> {
    if (!skillId.startsWith(`${callerPluginId}.`)) {
      const callerManifest = this.registry.getPluginManifest(callerPluginId);
      const required = callerManifest?.requires?.skills ?? [];
      if (!required.includes(skillId)) {
        throw Object.assign(
          new Error(
            `Plugin "${callerPluginId}" is not allowed to invoke skill "${skillId}". ` +
              `Add it to manifest.requires.skills.`,
          ),
          { code: ERR_ACL_DENIED },
        );
      }
    }
    return this.registry.invokeSkill(skillId, args, conversationId);
  }
}
