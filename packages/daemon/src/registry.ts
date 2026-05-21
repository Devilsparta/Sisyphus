/**
 * Daemon-side Registry — the platform's source of truth for what views,
 * cards, skills, and agents currently exist. Plugins register their
 * contributions through this object during activation; the HTTP API exposes
 * read access to the UI (and to other plugins, indirectly).
 *
 * Mutations publish on the internal event bus so the WS hub can rebroadcast
 * registry deltas to connected UI clients.
 *
 * Service-discovery discipline (project charter):
 * - No implicit lookup. Everything must be explicitly declared and
 *   registered through this object.
 * - Ids must be namespace-prefixed (enforced lightly here: collision check
 *   only; the prefix convention is documented in the kernel contract).
 * - dispose() must fully revoke the registration AND emit a removal event.
 */
import {
  KernelEvents,
  type AgentDescriptor,
  type AgentImpl,
  type CardDescriptor,
  type Disposable,
  type PluginManifest,
  type Region,
  type RegistryAPI,
  type RegistrySnapshot,
  type SkillDescriptor,
  type SkillHandler,
  type ViewDescriptor,
} from '@sisyphus/kernel';
import { bus } from './event-bus';

interface SkillEntry {
  descriptor: SkillDescriptor;
  handler: SkillHandler;
}

export class Registry implements RegistryAPI {
  private views = new Map<string, ViewDescriptor>();
  private cards = new Map<string, CardDescriptor>();
  private skills = new Map<string, SkillEntry>();
  private agents = new Map<string, AgentImpl>();
  // plugin id → manifest, for ACL lookups (which skills can an agent
  // owned by plugin X invoke?).
  private manifests = new Map<string, PluginManifest>();

  registerView(view: ViewDescriptor): Disposable {
    if (this.views.has(view.id)) {
      throw new Error(`View id collision: ${view.id}`);
    }
    this.views.set(view.id, view);
    bus.emit(KernelEvents.RegistryViewAdded, view);
    return {
      dispose: () => {
        if (this.views.delete(view.id)) {
          bus.emit(KernelEvents.RegistryViewRemoved, { id: view.id });
        }
      },
    };
  }

  registerCard(card: CardDescriptor): Disposable {
    if (this.cards.has(card.type)) {
      throw new Error(`Card type collision: ${card.type}`);
    }
    this.cards.set(card.type, card);
    bus.emit(KernelEvents.RegistryCardAdded, card);
    return {
      dispose: () => {
        if (this.cards.delete(card.type)) {
          bus.emit(KernelEvents.RegistryCardRemoved, { type: card.type });
        }
      },
    };
  }

  registerSkill(skill: SkillDescriptor, handler: SkillHandler): Disposable {
    if (this.skills.has(skill.id)) {
      throw new Error(`Skill id collision: ${skill.id}`);
    }
    this.skills.set(skill.id, { descriptor: skill, handler });
    bus.emit(KernelEvents.RegistrySkillAdded, skill);
    return {
      dispose: () => {
        if (this.skills.delete(skill.id)) {
          bus.emit(KernelEvents.RegistrySkillRemoved, { id: skill.id });
        }
      },
    };
  }

  registerAgent(agent: AgentImpl): Disposable {
    if (this.agents.has(agent.descriptor.id)) {
      throw new Error(`Agent id collision: ${agent.descriptor.id}`);
    }
    this.agents.set(agent.descriptor.id, agent);
    bus.emit(KernelEvents.RegistryAgentAdded, agent.descriptor);
    return {
      dispose: () => {
        if (this.agents.delete(agent.descriptor.id)) {
          bus.emit(KernelEvents.RegistryAgentRemoved, {
            id: agent.descriptor.id,
          });
        }
      },
    };
  }

  queryViews(filter?: { region?: Region }): ViewDescriptor[] {
    const all = Array.from(this.views.values());
    return filter?.region
      ? all.filter((v) => v.region === filter.region)
      : all;
  }

  queryCards(): CardDescriptor[] {
    return Array.from(this.cards.values());
  }

  querySkills(): SkillDescriptor[] {
    return Array.from(this.skills.values()).map((s) => s.descriptor);
  }

  queryAgents(): AgentDescriptor[] {
    return Array.from(this.agents.values()).map((a) => a.descriptor);
  }

  /** Lookup an agent impl by id (router uses this to dispatch). */
  getAgent(id: string): AgentImpl | undefined {
    return this.agents.get(id);
  }

  /** Record a plugin's manifest so router can look up its requires.skills. */
  registerPluginManifest(manifest: PluginManifest): void {
    this.manifests.set(manifest.id, manifest);
  }

  getPluginManifest(id: string): PluginManifest | undefined {
    return this.manifests.get(id);
  }

  snapshot(): RegistrySnapshot {
    return {
      views: this.queryViews(),
      cards: this.queryCards(),
      skills: this.querySkills(),
      agents: this.queryAgents(),
    };
  }

  /**
   * Server-side skill dispatch (used by HTTP / WS routes). Not part of the
   * RegistryAPI contract surface — that contract is for plugins; this is the
   * platform's own invoker.
   */
  async invokeSkill(
    id: string,
    args: Record<string, unknown>,
    conversationId: string,
  ): Promise<unknown> {
    const entry = this.skills.get(id);
    if (!entry) {
      throw new Error(`Unknown skill: ${id}`);
    }
    return entry.handler(args, { conversationId });
  }
}
