/**
 * Plugin-scoped facade over the global Registry.
 *
 * Plugins receive one of these as `ctx.registry` instead of the real
 * Registry. Every register* call goes through `enforcePrefix` first — a
 * plugin can only register ids that start with `${manifest.id}.`, so it
 * physically can't squat on another plugin's namespace.
 *
 * Query methods pass through (any plugin may see anything; visibility
 * restrictions would need their own design).
 */
import type {
  AgentImpl,
  CardDescriptor,
  Disposable,
  Region,
  RegistryAPI,
  SkillDescriptor,
  SkillHandler,
  ViewDescriptor,
} from '@sisylabs/kernel';
import type { Registry } from './registry';

export class ScopedRegistry implements RegistryAPI {
  constructor(
    private inner: Registry,
    private pluginId: string,
  ) {}

  private enforcePrefix(kind: string, id: string): void {
    const prefix = `${this.pluginId}.`;
    if (!id.startsWith(prefix)) {
      throw new Error(
        `Plugin "${this.pluginId}" tried to register ${kind} id "${id}" — must be namespace-prefixed with "${prefix}"`,
      );
    }
  }

  registerView(view: ViewDescriptor): Disposable {
    this.enforcePrefix('view', view.id);
    return this.inner.registerView(view);
  }

  registerCard(card: CardDescriptor): Disposable {
    this.enforcePrefix('card', card.type);
    return this.inner.registerCard(card);
  }

  registerSkill(skill: SkillDescriptor, handler: SkillHandler): Disposable {
    this.enforcePrefix('skill', skill.id);
    return this.inner.registerSkill(skill, handler);
  }

  registerAgent(agent: AgentImpl): Disposable {
    this.enforcePrefix('agent', agent.descriptor.id);
    return this.inner.registerAgent(agent);
  }

  queryViews(filter?: { region?: Region }) {
    return this.inner.queryViews(filter);
  }
  queryCards() {
    return this.inner.queryCards();
  }
  querySkills() {
    return this.inner.querySkills();
  }
  queryAgents() {
    return this.inner.queryAgents();
  }
}
