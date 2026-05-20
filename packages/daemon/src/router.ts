/**
 * Router — the kernel's master agent. Picks among registered agents based on
 * the user message and each agent's spawnHint, then spawns the chosen one and
 * transparently forwards its event stream to the caller.
 *
 * M2 simplification: when exactly one agent is registered, we route to it
 * unconditionally (no LLM call). When zero are registered we error. M3+ adds
 * LLM-driven selection once a second agent exists to make the decision
 * non-trivial.
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

  /**
   * Select which registered agent should handle this user message.
   * M2: trivial — only one agent, just return it.
   * M3+: feed agent spawnHints + message into a small LLM call.
   */
  private select(_userMessage: string): AgentImpl | null {
    const ids = this.registry.queryAgents().map((a) => a.id);
    if (ids.length === 0) return null;
    // Single-agent fast path. With more than one we'd run an LLM router here.
    return this.registry.getAgent(ids[0]) ?? null;
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

    // Wrap emit so we can observe `done` events the child agent fires.
    const wrappedEmit = (event: AgentEvent) => {
      if (event.type === 'done') {
        doneReason = event.reason;
        doneError = event.error;
      }
      req.emit(event);
    };

    let sawDone = false;
    const observingEmit = (event: AgentEvent) => {
      if (event.type === 'done') sawDone = true;
      wrappedEmit(event);
    };

    try {
      await agent.run(req.userMessage, {
        conversationId: req.conversationId,
        history: req.history,
        emit: observingEmit,
        signal: req.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      doneReason = 'error';
      doneError = msg;
      // Agent crashed without emitting `done`; synthesize one so the UI /
      // router state stays consistent.
      if (!sawDone) {
        req.emit({ type: 'done', reason: 'error', error: msg });
      }
      return { agentId: agent.descriptor.id, reason: 'error', error: msg };
    }

    // Contract violation: agent returned without emitting `done`. Synthesize.
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
