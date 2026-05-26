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
  AgentImpl,
  Disposable,
  PluginManifest,
  SkillDescriptor,
  SkillHandler,
} from '@sisyphus/kernel';
import type { Registry } from './registry';
import { ScopedRegistry } from './scoped-registry';
import type { PluginBroker } from './plugin-broker';

const ERR_ACL_DENIED = -32030;

interface ActivatedRecord {
  packageName: string;
  manifest: PluginManifest;
  uiBundlePath: string | null;
  disposers: Disposable[];
}

export class PluginManager {
  private activated = new Map<string, ActivatedRecord>();

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
  }

  isActivated(packageName: string): boolean {
    return this.activated.has(packageName);
  }

  listActivated(): ActivatedRecord[] {
    return Array.from(this.activated.values());
  }

  async activate(packageName: string): Promise<ActivatedRecord> {
    if (this.activated.has(packageName)) {
      return this.activated.get(packageName)!;
    }

    const result = await this.broker.activate(packageName);
    const { manifest, uiBundlePath } = result;

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
   * Broker's cross-plugin skill bridge. When a plugin's child process calls
   * `host.invokeSkill` (typically from an agent's `ctx.invokeSkill`), this
   * is what runs. M13 ACL lives here — same canInvokeSkill rule as the
   * router: skill in caller's namespace = OK, otherwise must be declared
   * in caller's `manifest.requires.skills`.
   */
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
