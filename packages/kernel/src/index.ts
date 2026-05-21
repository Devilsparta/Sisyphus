/**
 * @sisyphus/kernel — shared plugin contracts.
 *
 * Single source of truth for daemon ↔ UI ↔ plugin types.
 *
 * M2 architecture: multi-agent. The kernel hosts a Router that picks among
 * agents contributed by plugins. Each agent runs its own LLM call and streams
 * events directly to the UI (transparent pass-through through the daemon).
 * Plugins describe when their agent should be spawned via `spawnHint`.
 *
 * See wiki: concepts/sisyphus-plugin-architecture.md
 */

// ─── Panel Layout (VSCode-Lite, fixed four regions) ──────────────────────────

export type Region = 'activity-bar' | 'side' | 'main' | 'bottom';

/**
 * A view is a unit rendered into a Panel Layout region.
 * Metadata travels through the IPC; the renderer (React component / iframe /
 * web component) lives on the UI side and is resolved by id.
 */
export interface ViewDescriptor {
  /** Namespace-prefixed id, e.g. "plugin-base.view.canvas". */
  id: string;
  region: Region;
  title: string;
  /** Optional icon identifier (lucide name or URI). */
  icon?: string;
  defaultVisible?: boolean;
}

// ─── Chat cards ──────────────────────────────────────────────────────────────

export interface CardDescriptor {
  /** Namespace-prefixed type, e.g. "plugin-base.card.jsx". */
  type: string;
}

export interface CardInstance {
  type: string;
  payload: unknown;
  meta?: { id?: string; createdAt?: number };
}

// ─── Skills (OpenAI-tools-format capabilities) ───────────────────────────────

export interface OpenAIToolSchema {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface SkillDescriptor {
  /** Namespace-prefixed id, e.g. "plugin-base.skill.run-shell". */
  id: string;
  schema: OpenAIToolSchema;
}

export type SkillHandler = (
  args: Record<string, unknown>,
  ctx: SkillContext,
) => Promise<unknown>;

export interface SkillContext {
  conversationId: string;
}

// ─── Agents (M2 multi-agent architecture) ────────────────────────────────────

/**
 * Metadata describing an agent. The router uses `spawnHint` (a short natural-
 * language clause like "use when the user wants to build a React UI") to pick
 * between agents when multiple are registered.
 */
export interface AgentDescriptor {
  /** Namespace-prefixed id, e.g. "plugin-base.agent.react-designer". */
  id: string;
  displayName: string;
  /** Short user-facing description shown in the UI. */
  description: string;
  /**
   * Router hint: when should this agent be spawned? Read by the router (and
   * eventually fed to an LLM router prompt in M4+) and by the UI to explain
   * available capabilities.
   */
  spawnHint: string;
  /**
   * Optional explicit keywords the router uses for cheap deterministic
   * matching (M3 strategy). Higher precision than parsing the prose
   * spawnHint. M4+ will treat these as bias signals layered atop an LLM
   * router.
   */
  triggerKeywords?: string[];
  /**
   * Tie-breaker / fan-out ordering signal (M14).
   * Higher = preferred. When the router fan-outs across multiple agents
   * (or chooses among tied candidates), it picks by descending priority.
   * Default 0 when omitted.
   */
  priority?: number;
}

/**
 * Streaming events an agent emits during a run. They pass-through the daemon
 * to the UI without router interpretation; the router only observes `done`
 * for completion / retry decisions.
 *
 * `source` is injected by the router at emit time (agents shouldn't set it
 * themselves); it identifies which agent produced the event. Vital for
 * fan-out / spawnAgent traces so the UI can route events to the right cell.
 */
interface EventBase {
  source?: string;
}
export type AgentEvent =
  | (EventBase & { type: 'token'; text: string })
  | (EventBase & { type: 'reasoning'; text: string })
  | (EventBase & { type: 'card'; card: CardInstance })
  | (EventBase & {
      type: 'tool_call';
      id: string;
      skill: string;
      args: Record<string, unknown>;
    })
  | (EventBase & {
      type: 'tool_result';
      id: string;
      result?: unknown;
      error?: string;
    })
  | (EventBase & {
      type: 'done';
      reason: 'stop' | 'error' | 'cancelled';
      error?: string;
    });

/**
 * Context passed to an agent's `run`. The `emit` callback funnels events back
 * through the daemon to the UI; `signal` is the abort signal the router (or
 * the user) can fire to cancel a long-running agent.
 */
export interface AgentRunContext {
  conversationId: string;
  history: ChatMessage[];
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
  /**
   * Invoke a registered skill by id. The daemon dispatches to whichever
   * plugin owns the skill handler. Agents should also `emit` matching
   * `tool_call` / `tool_result` events so the UI can show the invocation
   * trace; the platform does NOT emit those events automatically (the agent
   * may choose to call a skill silently).
   */
  invokeSkill: (id: string, args: Record<string, unknown>) => Promise<unknown>;
  /**
   * Snapshot of every skill currently registered with the daemon. Agents
   * use this to build the `tools` array for an LLM tool-calling call:
   * each skill's `schema` is already OpenAI tools format.
   *
   * Note: OpenAI's function name pattern disallows '.', so skill.schema
   * .function.name will not be the namespaced skill.id — the agent must
   * keep its own name→id map when dispatching the LLM's tool_calls.
   */
  querySkills: () => SkillDescriptor[];
  /**
   * Spawn another agent as a sub-task (M14). The sub-agent's events stream
   * through to the UI tagged with the sub-agent's id as `source`. Awaits
   * the sub-agent to completion; its `done` is forwarded but does NOT end
   * the parent's run — the parent must still emit its own `done`.
   *
   * The same skill-ACL applies to the sub-agent (it can only invoke its
   * own plugin's skills + whatever its manifest declares).
   */
  spawnAgent: (agentId: string, userMessage: string) => Promise<void>;
}

/**
 * A plugin-provided agent implementation. The daemon registers these and the
 * router routes user messages to whichever one matches the situation.
 *
 * Contract: `run` MUST emit a final `{type:'done'}` event so the router knows
 * the agent has completed (and can fire retries / handle timeouts). Failing
 * to emit `done` leaves the conversation in an indeterminate state.
 */
export interface AgentImpl {
  descriptor: AgentDescriptor;
  run(userMessage: string, ctx: AgentRunContext): Promise<void>;
}

// ─── Plugin manifest (lives in package.json "sisyphus" field) ────────────────

export interface PluginManifest {
  /** Plugin id; used as namespace prefix for all contributed ids. */
  id: string;
  displayName?: string;
  version: string;
  /** Other plugin ids this one depends on. Daemon load order is topo-sorted. */
  dependencies?: string[];
  contributes?: {
    views?: ViewDescriptor[];
    cards?: CardDescriptor[];
    skills?: SkillDescriptor[];
    agents?: AgentDescriptor[];
  };
  /**
   * Cross-plugin dependencies the daemon will gate at invocation time.
   * By default a plugin's agents can only invoke skills under their own
   * namespace; to call another plugin's skill the id must be listed here.
   *
   * Cross-plugin view/card use is mediated by registry queries (already
   * shared) so doesn't need a declaration. Skills are different because
   * they're invocable side-effects.
   */
  requires?: {
    skills?: string[];
  };
}

// ─── Plugin runtime entry (default export from plugin's main) ────────────────

export interface SisyphusPlugin {
  manifest: PluginManifest;

  // Lifecycle
  onActivate?: (ctx: PluginContext) => void | Promise<void>;
  onDeactivate?: (ctx: PluginContext) => void | Promise<void>;

  /** AgentImpls declared by this plugin. Daemon registers each on activation. */
  agents?: AgentImpl[];

  /** Keyed by skill id (must match a SkillDescriptor in the manifest). */
  skillHandlers?: Record<string, SkillHandler>;
}

export interface PluginContext {
  registry: RegistryAPI;
  storage: PluginStorage;
  log: (
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    meta?: unknown,
  ) => void;
}

/**
 * Per-plugin persistent key-value storage. Daemon provides a sandboxed
 * instance to each plugin (keyed by manifest id) so plugin state survives
 * restarts. Values must be JSON-serializable.
 *
 * Concurrency model: writes are debounced and best-effort durable; callers
 * needn't await `set`/`delete` for correctness during the run, but the
 * daemon flushes pending writes on shutdown.
 */
export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  cards?: CardInstance[];
}

// ─── Registry API (central service-discovery contract) ───────────────────────
//
// All plugin contributions flow through this API. No implicit discovery, no
// global pollution. Disposing a registration must fully revoke the capability
// (UI removes view, agent service stops offering skill, etc).

export interface RegistryAPI {
  registerView(view: ViewDescriptor): Disposable;
  registerCard(card: CardDescriptor): Disposable;
  registerSkill(skill: SkillDescriptor, handler: SkillHandler): Disposable;
  registerAgent(agent: AgentImpl): Disposable;

  queryViews(filter?: { region?: Region }): ViewDescriptor[];
  queryCards(): CardDescriptor[];
  querySkills(): SkillDescriptor[];
  queryAgents(): AgentDescriptor[];
}

export interface Disposable {
  dispose(): void;
}

// ─── IPC envelopes (HTTP + WebSocket) ───────────────────────────────────────
//
// Wire format decision (2026-05-20): custom protocol with three frame kinds
// distinguished by a `type` discriminator. See wiki — chosen over JSON-RPC 2.0
// for clearer separation between request/response (RPC) and event (pubsub).

export interface IPCRequest<T = unknown> {
  type: 'request';
  id: string;
  method: string;
  params?: T;
}

export interface IPCResponse<T = unknown> {
  type: 'response';
  id: string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface IPCEvent<T = unknown> {
  type: 'event';
  event: string;
  data: T;
}

export type IPCMessage = IPCRequest | IPCResponse | IPCEvent;

// Well-known kernel event names. Plugins must use their own namespace-prefixed
// event names (e.g. "plugin-base.chat.token") to avoid collisions.
export const KernelEvents = {
  PlatformReady: 'platform.ready',
  RegistrySnapshot: 'registry.snapshot',
  RegistryViewAdded: 'registry.view.added',
  RegistryViewRemoved: 'registry.view.removed',
  RegistryCardAdded: 'registry.card.added',
  RegistryCardRemoved: 'registry.card.removed',
  RegistrySkillAdded: 'registry.skill.added',
  RegistrySkillRemoved: 'registry.skill.removed',
  RegistryAgentAdded: 'registry.agent.added',
  RegistryAgentRemoved: 'registry.agent.removed',
} as const;

export type KernelEventName = (typeof KernelEvents)[keyof typeof KernelEvents];

export interface RegistrySnapshot {
  views: ViewDescriptor[];
  cards: CardDescriptor[];
  skills: SkillDescriptor[];
  agents: AgentDescriptor[];
}
