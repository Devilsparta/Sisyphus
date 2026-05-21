/**
 * Router — the kernel's master agent.
 *
 * Selection strategy (M8 hybrid):
 *   1 agent  → fast-path.
 *   ≥2 agents:
 *     a. Score by triggerKeyword substring matches.
 *     b. If the top score is ≥2 AND beats the runner-up by ≥2, accept it
 *        (confident keyword match, no LLM call needed).
 *     c. Otherwise (tie / low score / ambiguous) → call an LLM to pick.
 *        Model: SISYPHUS_ROUTER_MODEL → OPENAI_MODEL fallback.
 *        Prompt: list agents w/ description + spawnHint, ask for the id.
 *        Response sanitised by regex (LLM may wrap with extra text).
 *     d. If the LLM call fails or returns an unknown id, fall back to the
 *        keyword winner (top.score's agent).
 *
 * Per project charter: the router doesn't intercept or rewrite the child
 * agent's token stream. It only observes `done` for completion/retry/timeout
 * decisions.
 */
import type {
  AgentDescriptor,
  AgentEvent,
  AgentImpl,
  ChatMessage,
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

    // LLMs occasionally wrap the id with quotes / explanation; extract.
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

    // Confident keyword win: top has hits AND beats runner-up by at least 1.
    // "add buy milk" scores todo-manager:1 / others:0 → fast-path. A keyword
    // collision producing a tie (or all-zero) still falls through to the LLM.
    if (top.score > 0 && top.score > second.score) {
      return this.registry.getAgent(top.desc.id) ?? null;
    }

    // Ambiguous → consult LLM. On any failure, fall back to keyword winner.
    try {
      const picked = await this.llmSelect(
        userMessage,
        agents,
        signal,
      );
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

    try {
      await agent.run(req.userMessage, {
        conversationId: req.conversationId,
        history: req.history,
        emit: observingEmit,
        signal: req.signal,
        invokeSkill: (id, args) =>
          this.registry.invokeSkill(id, args, req.conversationId),
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
