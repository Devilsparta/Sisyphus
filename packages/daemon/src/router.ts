/**
 * Router — the kernel's master agent.
 *
 * Selection (M3 → M8 → M14):
 *   1 agent  → fast-path.
 *   ≥2 agents:
 *     - keyword score sorted by (score desc, priority desc).
 *     - unique top.score > 0 wins  → fast-path single agent.
 *     - tied or zero-score → consult LLM (SISYPHUS_ROUTER_MODEL fallback chain).
 *       LLM picks one id; on failure / unknown id, fall back to the highest-
 *       priority tied candidate.
 *     - When SISYPHUS_FANOUT_CAP > 1 and tied candidates exist, select top
 *       N by priority for parallel fan-out instead of asking the LLM. Each
 *       agent runs concurrently; their events are interleaved with a
 *       `source` field identifying which agent emitted them.
 *
 * Skill ACL (M13): per-run scopedInvokeSkill enforces same-namespace or
 * manifest.requires.skills declarations.
 *
 * spawnAgent (M14): agents can re-enter the same runAgent helper to invoke
 * a sub-agent and have its events stream through (tagged with the sub-
 * agent's id as source).
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

interface AgentRunResult {
  reason: 'stop' | 'error' | 'cancelled';
  error?: string;
}

const ID_PATTERN = /[a-zA-Z0-9_-]+\.agent\.[a-zA-Z0-9_.-]+/;
const AGENT_SEPARATOR = '.agent.';

function pluginIdFromAgent(agentId: string): string | null {
  const idx = agentId.indexOf(AGENT_SEPARATOR);
  return idx > 0 ? agentId.slice(0, idx) : null;
}

function canInvokeSkill(
  callerPluginId: string,
  skillId: string,
  callerManifest: PluginManifest | undefined,
): boolean {
  if (skillId.startsWith(`${callerPluginId}.`)) return true;
  const required = callerManifest?.requires?.skills ?? [];
  return required.includes(skillId);
}

function fanoutCap(): number {
  const raw = Number(process.env.SISYPHUS_FANOUT_CAP);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(raw, 8); // safety upper bound
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
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.desc.priority ?? 0) - (a.desc.priority ?? 0);
      });
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
    return match ? match[0] : raw;
  }

  private async selectMany(
    userMessage: string,
    signal: AbortSignal,
  ): Promise<AgentImpl[]> {
    const agents = this.registry.queryAgents();
    if (agents.length === 0) return [];
    if (agents.length === 1) {
      const a = this.registry.getAgent(agents[0].id);
      return a ? [a] : [];
    }

    const scored = this.scoreByKeywords(userMessage);
    const top = scored[0];
    const second = scored[1];

    // Confident unique winner.
    if (top.score > 0 && top.score > second.score) {
      const a = this.registry.getAgent(top.desc.id);
      return a ? [a] : [];
    }

    // Tied or low-score: gather the tie group, then choose between LLM
    // (cap=1) and parallel fan-out (cap>1).
    const tieGroup = scored.filter((s) => s.score === top.score);
    const cap = fanoutCap();

    if (cap > 1 && tieGroup.length > 1) {
      const sorted = [...tieGroup]
        .sort(
          (a, b) => (b.desc.priority ?? 0) - (a.desc.priority ?? 0),
        )
        .slice(0, cap);
      return sorted
        .map((s) => this.registry.getAgent(s.desc.id))
        .filter((a): a is AgentImpl => Boolean(a));
    }

    // cap=1 or zero-tie: LLM picks one.
    try {
      const picked = await this.llmSelect(userMessage, agents, signal);
      if (picked) {
        const a = this.registry.getAgent(picked);
        if (a) return [a];
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

    // Fallback: highest priority in tie group (or top.score group).
    const best = [...tieGroup].sort(
      (a, b) => (b.desc.priority ?? 0) - (a.desc.priority ?? 0),
    )[0];
    const a = best ? this.registry.getAgent(best.desc.id) : null;
    return a ? [a] : [];
  }

  /**
   * Run one agent with a per-agent context (source-tagged emit, ACL-scoped
   * invokeSkill, recursive spawnAgent). Re-used by router.run() AND by the
   * spawnAgent helper handed to running agents.
   */
  private async runAgent(
    agent: AgentImpl,
    userMessage: string,
    req: RouteRequest,
    parentEmit: (event: AgentEvent) => void,
  ): Promise<AgentRunResult> {
    const ownerPluginId = pluginIdFromAgent(agent.descriptor.id);
    const ownerManifest = ownerPluginId
      ? this.registry.getPluginManifest(ownerPluginId)
      : undefined;

    let doneReason: 'stop' | 'error' | 'cancelled' = 'stop';
    let doneError: string | undefined;
    let sawDone = false;

    const sourcedEmit = (event: AgentEvent) => {
      if (event.type === 'done') {
        sawDone = true;
        doneReason = event.reason;
        doneError = event.error;
      }
      // Don't overwrite source if a sub-agent already set it (preserves
      // origin through nested spawnAgent chains).
      parentEmit({
        ...event,
        source: event.source ?? agent.descriptor.id,
      });
    };

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

    const spawnSubAgent = async (
      subAgentId: string,
      subMessage: string,
    ): Promise<void> => {
      const sub = this.registry.getAgent(subAgentId);
      if (!sub) {
        throw new Error(`Unknown agent: ${subAgentId}`);
      }
      // Sub-agent gets its own ctx via this same runAgent helper. Its
      // events flow through parentEmit so the UI sees everything inline.
      await this.runAgent(sub, subMessage, req, parentEmit);
    };

    try {
      await agent.run(userMessage, {
        conversationId: req.conversationId,
        history: req.history,
        emit: sourcedEmit,
        signal: req.signal,
        invokeSkill: scopedInvokeSkill,
        querySkills: () => this.registry.querySkills(),
        spawnAgent: spawnSubAgent,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!sawDone) {
        parentEmit({
          type: 'done',
          reason: 'error',
          error: msg,
          source: agent.descriptor.id,
        });
      }
      return { reason: 'error', error: msg };
    }

    if (!sawDone) {
      const error = `agent ${agent.descriptor.id} returned without emitting "done"`;
      parentEmit({
        type: 'done',
        reason: 'error',
        error,
        source: agent.descriptor.id,
      });
      return { reason: 'error', error };
    }

    return { reason: doneReason, error: doneError };
  }

  async run(req: RouteRequest): Promise<RouteResult> {
    const agents = await this.selectMany(req.userMessage, req.signal);
    if (agents.length === 0) {
      const error = 'no agent registered';
      req.emit({ type: 'done', reason: 'error', error });
      return { agentId: '', reason: 'error', error };
    }

    const results = await Promise.all(
      agents.map((agent) =>
        this.runAgent(agent, req.userMessage, req, req.emit),
      ),
    );

    // Aggregate: first non-stop reason wins; error beats cancelled.
    const errored = results.find((r) => r.reason === 'error');
    const cancelled = results.find((r) => r.reason === 'cancelled');
    const verdict = errored ?? cancelled ?? results[0];

    return {
      agentId: agents[0].descriptor.id,
      reason: verdict.reason,
      error: verdict.error,
    };
  }
}
