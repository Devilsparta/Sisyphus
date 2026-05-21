/**
 * Router — the kernel's master agent.
 *
 * Selection strategy (M8 hybrid):
 *   1 agent  → fast-path.
 *   ≥2 agents → keyword score; confident winner takes fast-path; ambiguous
 *               cases consult an LLM (SISYPHUS_ROUTER_MODEL → OPENAI_MODEL
 *               → 'gpt-4o' fallback).
 *
 * Skill ACL (M13): the per-agent invokeSkill helper enforces
 *   - same-namespace calls (skill id starts with the agent's plugin id) → allow
 *   - cross-plugin calls require the agent's plugin manifest to list the
 *     target skill id under `requires.skills`
 *   - otherwise → throw before dispatch (the agent surfaces the error as
 *     a tool_result with `error`).
 */
import type {
  AgentDescriptor,
  AgentEvent,
  AgentImpl,
  ChatMessage,
  PluginManifest,
} from '@sisyphus/kernel';
import OpenAI from 'openai';
import type { Registry } from './registry';

export interface RouteRequest {
  userMessage: string;
  history: ChatMessage[];
  conversationId: string;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
}

export interface RouteResult {
  agentId: string;
  reason: 'stop' | 'error' | 'cancelled';
  error?: string;
}

interface ScoredAgent {
  desc: AgentDescriptor;
  score: number;
}

const ID_PATTERN = /[a-zA-Z0-9_-]+\.agent\.[a-zA-Z0-9_.-]+/;
const AGENT_SEPARATOR = '.agent.';

/** Recover the owning plugin id from an agent id (everything before .agent.). */
function pluginIdFromAgent(agentId: string): string | null {
  const idx = agentId.indexOf(AGENT_SEPARATOR);
  return idx > 0 ? agentId.slice(0, idx) : null;
}

/**
 * Check whether a plugin is allowed to invoke a given skill.
 *  - same-namespace → always allowed
 *  - cross-plugin → must be listed in manifest.requires.skills
 */
function canInvokeSkill(
  callerPluginId: string,
  skillId: string,
  callerManifest: PluginManifest | undefined,
): boolean {
  if (skillId.startsWith(`${callerPluginId}.`)) return true;
  const required = callerManifest?.requires?.skills ?? [];
  return required.includes(skillId);
}

export class Router {
  constructor(private registry: Registry) {}

  private scoreByKeywords(userMessage: string): ScoredAgent[] {
    const lower = userMessage.toLowerCase();
    return this.registry
      .queryAgents()
      .map((desc) => {
        const keywords = desc.triggerKeywords ?? [];
        let score = 0;
        for (const kw of keywords) {
          if (lower.includes(kw.toLowerCase())) score++;
        }
        return { desc, score };
      })
      .sort((a, b) => b.score - a.score);
  }

  private async llmSelect(
    userMessage: string,
    agents: AgentDescriptor[],
    signal: AbortSignal,
  ): Promise<string | null> {
    const model =
      process.env.SISYPHUS_ROUTER_MODEL ??
      process.env.OPENAI_MODEL ??
      'gpt-4o';
    const client = new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY ?? '',
    });

    const list = agents
      .map(
        (a, i) =>
          `${i + 1}. ${a.id}\n   description: ${a.description}\n   spawn_hint: ${a.spawnHint}`,
      )
      .join('\n\n');

    const prompt = `You route user messages to the best-matching agent on the Sisyphus platform. Respond with ONLY the agent id — no quotes, no explanation, nothing else.

Available agents:
${list}

User message: ${userMessage}

Best agent id:`;

    const completion = await client.chat.completions.create(
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      },
      { signal },
    );

    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) return null;

    const match = raw.match(ID_PATTERN);
    if (match) return match[0];
    return raw;
  }

  private async select(
    userMessage: string,
    signal: AbortSignal,
  ): Promise<AgentImpl | null> {
    const agents = this.registry.queryAgents();
    if (agents.length === 0) return null;
    if (agents.length === 1) {
      return this.registry.getAgent(agents[0].id) ?? null;
    }

    const scored = this.scoreByKeywords(userMessage);
    const top = scored[0];
    const second = scored[1];

    if (top.score > 0 && top.score > second.score) {
      return this.registry.getAgent(top.desc.id) ?? null;
    }

    try {
      const picked = await this.llmSelect(userMessage, agents, signal);
      if (picked) {
        const agent = this.registry.getAgent(picked);
        if (agent) return agent;
        // eslint-disable-next-line no-console
        console.warn(
          `[router] LLM picked unknown agent id "${picked}"; falling back`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[router] LLM select failed, falling back to keyword winner:',
        err instanceof Error ? err.message : err,
      );
    }

    return this.registry.getAgent(top.desc.id) ?? null;
  }

  async run(req: RouteRequest): Promise<RouteResult> {
    const agent = await this.select(req.userMessage, req.signal);
    if (!agent) {
      const error = 'no agent registered';
      req.emit({ type: 'done', reason: 'error', error });
      return { agentId: '', reason: 'error', error };
    }

    let doneReason: 'stop' | 'error' | 'cancelled' = 'stop';
    let doneError: string | undefined;
    let sawDone = false;

    const observingEmit = (event: AgentEvent) => {
      if (event.type === 'done') {
        sawDone = true;
        doneReason = event.reason;
        doneError = event.error;
      }
      req.emit(event);
    };

    // ACL setup: figure out which plugin owns this agent so invokeSkill
    // can be gated against the plugin's manifest.requires.skills.
    const ownerPluginId = pluginIdFromAgent(agent.descriptor.id);
    const ownerManifest = ownerPluginId
      ? this.registry.getPluginManifest(ownerPluginId)
      : undefined;
    const scopedInvokeSkill = async (
      id: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      if (!ownerPluginId) {
        throw new Error(
          `Agent "${agent.descriptor.id}" lacks a recognizable plugin namespace`,
        );
      }
      if (!canInvokeSkill(ownerPluginId, id, ownerManifest)) {
        throw new Error(
          `Plugin "${ownerPluginId}" is not allowed to invoke skill "${id}". Add it to manifest.requires.skills.`,
        );
      }
      return this.registry.invokeSkill(id, args, req.conversationId);
    };

    try {
      await agent.run(req.userMessage, {
        conversationId: req.conversationId,
        history: req.history,
        emit: observingEmit,
        signal: req.signal,
        invokeSkill: scopedInvokeSkill,
        querySkills: () => this.registry.querySkills(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      doneReason = 'error';
      doneError = msg;
      if (!sawDone) {
        req.emit({ type: 'done', reason: 'error', error: msg });
      }
      return { agentId: agent.descriptor.id, reason: 'error', error: msg };
    }

    if (!sawDone) {
      const error = `agent ${agent.descriptor.id} returned without emitting "done"`;
      req.emit({ type: 'done', reason: 'error', error });
      return { agentId: agent.descriptor.id, reason: 'error', error };
    }

    return {
      agentId: agent.descriptor.id,
      reason: doneReason,
      error: doneError,
    };
  }
}
