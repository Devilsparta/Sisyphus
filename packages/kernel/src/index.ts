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
}

/**
 * Streaming events an agent emits during a run. They pass-through the daemon
 * to the UI without router interpretation; the router only observes `done`
 * for completion / retry decisions.
 */
export type AgentEvent =
  | { type: 'token'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'card'; card: CardInstance }
  | {
      type: 'tool_call';
      id: string;
      skill: string;
      args: Record<string, unknown>;
    }
  | { type: 'tool_result'; id: string; result?: unknown; error?: string }
  | {
      type: 'done';
      reason: 'stop' | 'error' | 'cancelled';
      error?: string;
    };

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
  log: (
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    meta?: unknown,
  ) => void;
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
