/**
 * Daemon-side Registry — the platform's source of truth for what views,
 * cards, and skills currently exist. Plugins register their contributions
 * through this object during activation; the HTTP API exposes read access
 * to the UI (and to other plugins, indirectly).
 *
 * Service-discovery discipline (project charter):
 * - No implicit lookup. Everything must be explicitly declared and
 *   registered through this object.
 * - Ids must be namespace-prefixed (enforced lightly here: collision check
 *   only; the prefix convention is documented in the kernel contract).
 * - dispose() must fully revoke the registration.
 */
import type {
  CardDescriptor,
  Disposable,
  Region,
  RegistryAPI,
  SkillDescriptor,
  SkillHandler,
  ViewDescriptor,
} from '@sisyphus/kernel';

interface SkillEntry {
  descriptor: SkillDescriptor;
  handler: SkillHandler;
}

export class Registry implements RegistryAPI {
  private views = new Map<string, ViewDescriptor>();
  private cards = new Map<string, CardDescriptor>();
  private skills = new Map<string, SkillEntry>();

  registerView(view: ViewDescriptor): Disposable {
    if (this.views.has(view.id)) {
      throw new Error(`View id collision: ${view.id}`);
    }
    this.views.set(view.id, view);
    return {
      dispose: () => {
        this.views.delete(view.id);
      },
    };
  }

  registerCard(card: CardDescriptor): Disposable {
    if (this.cards.has(card.type)) {
      throw new Error(`Card type collision: ${card.type}`);
    }
    this.cards.set(card.type, card);
    return {
      dispose: () => {
        this.cards.delete(card.type);
      },
    };
  }

  registerSkill(skill: SkillDescriptor, handler: SkillHandler): Disposable {
    if (this.skills.has(skill.id)) {
      throw new Error(`Skill id collision: ${skill.id}`);
    }
    this.skills.set(skill.id, { descriptor: skill, handler });
    return {
      dispose: () => {
        this.skills.delete(skill.id);
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
