/**
 * Router — the kernel's master agent. Picks among registered agents based on
 * the user message and each agent's spawnHint / triggerKeywords, then spawns
 * the chosen one and transparently forwards its event stream to the caller.
 *
 * M3 strategy: keyword-based scoring.
 * - Single agent → fast-path, no decision.
 * - Multi agent → score each by overlap of `triggerKeywords` with the user
 *   message (lowercased substring match). Highest score wins; ties go to
 *   registration order; zero match falls back to the first agent.
 *
 * M4+ will layer an LLM router on top once latency is acceptable (current
 * default model is a reasoning model so a routing call would cost 5-10s
 * per turn — unacceptable for chat).
 *
 * Per project charter: the router doesn't intercept or rewrite the child
 * agent's token stream. It only observes `done` for completion/retry/timeout
 * decisions.
 */
import type {
  AgentEvent,
  AgentImpl,
  ChatMessage,
} from '@sisyphus/kernel';
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

export class Router {
  constructor(private registry: Registry) {}

  private select(userMessage: string): AgentImpl | null {
    const agents = this.registry.queryAgents();
    if (agents.length === 0) return null;
    if (agents.length === 1) {
      return this.registry.getAgent(agents[0].id) ?? null;
    }

    const lower = userMessage.toLowerCase();
    let bestId: string | null = null;
    let bestScore = 0;

    for (const desc of agents) {
      const keywords = desc.triggerKeywords ?? [];
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw.toLowerCase())) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestId = desc.id;
      }
    }

    if (bestId && bestScore > 0) {
      const picked = this.registry.getAgent(bestId);
      if (picked) return picked;
    }

    // No keyword match (or hit but agent vanished) — fall back to first.
    return this.registry.getAgent(agents[0].id) ?? null;
  }

  async run(req: RouteRequest): Promise<RouteResult> {
    const agent = this.select(req.userMessage);
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
