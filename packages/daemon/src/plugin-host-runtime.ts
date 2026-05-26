/**
 * plugin-host-runtime — runs *inside* a plugin's child process.
 *
 * Boot path: daemon SEA binary spawned with SISYPHUS_MODE=plugin-host →
 * index.ts main() dispatches here → we dynamic-import the plugin entry,
 * grab its default SisyphusPlugin export, and start a stdio JSON-RPC loop
 * (per docs/plugin-rpc.md).
 *
 * Design notes:
 *   - The plugin author's code is untouched: same { manifest, onActivate,
 *     agents, skillHandlers } shape as in-process. The ctx we hand them
 *     forwards storage/log to the host process; agent emit/invokeSkill
 *     also tunnel over RPC.
 *   - Contributions are collected during onActivate and returned in the
 *     `activate` RPC reply — host registers them into its central
 *     Registry on receipt.
 *   - One in-flight request at a time per direction is the common case,
 *     but the loop tolerates concurrent: ids correlate replies and
 *     handlers are async.
 */
import { pathToFileURL } from 'node:url';
import type {
  AgentDescriptor,
  AgentEvent,
  AgentImpl,
  AgentRunContext,
  CardDescriptor,
  ChatMessage,
  Disposable,
  PluginContext,
  PluginStorage,
  RegistryAPI,
  SisyphusPlugin,
  SkillContext,
  SkillDescriptor,
  SkillHandler,
  ViewDescriptor,
} from '@sisyphus/kernel';

const API_VERSION = 1;
const SDK_VERSION = '0.1.0';

// ── RPC framing ─────────────────────────────────────────────────────────────

interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}
interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}
type RpcFrame = RpcRequest | RpcResponse | RpcNotification;

const ERR = {
  PARSE: -32700,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  NOT_ACTIVATED: -32000,
  SKILL_NOT_FOUND: -32010,
  AGENT_NOT_FOUND: -32020,
  ACL_DENIED: -32030,
  API_VERSION_MISMATCH: -32040,
} as const;

function rpcError(code: number, message: string, data?: unknown): Error & {
  code: number;
  data?: unknown;
} {
  const e = new Error(message) as Error & { code: number; data?: unknown };
  e.code = code;
  if (data !== undefined) e.data = data;
  return e;
}

function writeFrame(frame: RpcFrame): void {
  process.stdout.write(JSON.stringify(frame) + '\n');
}

// ── Outbound calls (plugin → host) ──────────────────────────────────────────

let nextOutId = 1;
const pendingOut = new Map<
  number | string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

function callHost(method: string, params: unknown): Promise<unknown> {
  const id = nextOutId++;
  return new Promise((resolve, reject) => {
    pendingOut.set(id, { resolve, reject });
    writeFrame({ jsonrpc: '2.0', id, method, params });
  });
}

function notifyHost(method: string, params: unknown): void {
  writeFrame({ jsonrpc: '2.0', method, params });
}

// ── Plugin state ────────────────────────────────────────────────────────────

let plugin: SisyphusPlugin | null = null;
let activated = false;

interface CollectedContributions {
  agents: AgentDescriptor[];
  skills: SkillDescriptor[];
  views: ViewDescriptor[];
  cards: CardDescriptor[];
}

const collected: CollectedContributions = {
  agents: [],
  skills: [],
  views: [],
  cards: [],
};

/**
 * In-flight agent runs, keyed by conversationId. Host sends an
 * `agent.cancel` notification on user abort; we look up the matching
 * AbortController and fire it. The plugin's agent.run is expected to
 * observe ctx.signal (most LLM SDKs already do) and unwind.
 */
const agentRuns = new Map<string, AbortController>();

function collectorRegistry(): RegistryAPI {
  return {
    registerView(view: ViewDescriptor): Disposable {
      collected.views.push(view);
      return { dispose() {} };
    },
    registerCard(card: CardDescriptor): Disposable {
      collected.cards.push(card);
      return { dispose() {} };
    },
    registerSkill(skill: SkillDescriptor, _handler: SkillHandler): Disposable {
      // Handler stays in plugin.skillHandlers[id]; we only collect the
      // descriptor here so the host can advertise the skill.
      collected.skills.push(skill);
      return { dispose() {} };
    },
    registerAgent(agent: AgentImpl): Disposable {
      collected.agents.push(agent.descriptor);
      return { dispose() {} };
    },
    queryViews() {
      return [...collected.views];
    },
    queryCards() {
      return [...collected.cards];
    },
    querySkills() {
      return [...collected.skills];
    },
    queryAgents() {
      return [...collected.agents];
    },
  };
}

const storage: PluginStorage = {
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const r = (await callHost('host.storage.get', { key })) as {
      value: T | null;
    };
    return r.value === null ? undefined : (r.value as T);
  },
  async set(key, value) {
    await callHost('host.storage.set', { key, value });
  },
  async delete(key) {
    await callHost('host.storage.delete', { key });
  },
  async clear() {
    await callHost('host.storage.clear', {});
  },
  async keys() {
    const r = (await callHost('host.storage.keys', {})) as { keys: string[] };
    return r.keys;
  },
};

function pluginCtx(): PluginContext {
  return {
    registry: collectorRegistry(),
    storage,
    log(level, msg, meta) {
      notifyHost('log', { level, message: msg, data: meta });
    },
  };
}

// ── Inbound request handlers ────────────────────────────────────────────────

async function handleInit(params: { apiVersion?: number }): Promise<unknown> {
  if (params?.apiVersion !== API_VERSION) {
    throw rpcError(
      ERR.API_VERSION_MISMATCH,
      `apiVersion ${params?.apiVersion} not supported (this host expects ${API_VERSION})`,
    );
  }
  return { apiVersion: API_VERSION, sdkVersion: SDK_VERSION };
}

async function handleActivate(_params: unknown): Promise<unknown> {
  if (!plugin) {
    throw rpcError(ERR.INTERNAL, 'plugin entry produced no default export');
  }
  await plugin.onActivate?.(pluginCtx());

  // Merge explicit plugin.agents / manifest.contributes into the collected
  // snapshot. Plugins typically use this declarative shape rather than
  // ctx.registry.*, so we have to read both.
  for (const a of plugin.agents ?? []) {
    if (!collected.agents.some((d) => d.id === a.descriptor.id)) {
      collected.agents.push(a.descriptor);
    }
  }
  for (const s of plugin.manifest.contributes?.skills ?? []) {
    if (!collected.skills.some((d) => d.id === s.id)) {
      collected.skills.push(s);
    }
  }
  for (const v of plugin.manifest.contributes?.views ?? []) {
    if (!collected.views.some((d) => d.id === v.id)) {
      collected.views.push(v);
    }
  }
  for (const c of plugin.manifest.contributes?.cards ?? []) {
    if (!collected.cards.some((d) => d.type === c.type)) {
      collected.cards.push(c);
    }
  }
  activated = true;
  return {
    manifest: plugin.manifest,
    agents: collected.agents,
    skills: collected.skills,
    views: collected.views,
    cards: collected.cards,
  };
}

async function handleDeactivate(_params: unknown): Promise<unknown> {
  if (!plugin || !activated) return {};
  try {
    await plugin.onDeactivate?.(pluginCtx());
  } finally {
    activated = false;
  }
  return {};
}

interface InvokeSkillParams {
  skillName: string;
  args: Record<string, unknown>;
  conversationId?: string;
}
async function handleInvokeSkill(params: InvokeSkillParams): Promise<unknown> {
  if (!plugin) throw rpcError(ERR.NOT_ACTIVATED, 'plugin not loaded');
  const handler: SkillHandler | undefined =
    plugin.skillHandlers?.[params.skillName];
  if (!handler) {
    throw rpcError(
      ERR.SKILL_NOT_FOUND,
      `skill "${params.skillName}" not registered`,
    );
  }
  const skillCtx: SkillContext = { conversationId: params.conversationId ?? '' };
  const result = await handler(params.args, skillCtx);
  return { result };
}

interface InvokeAgentParams {
  agentName: string;
  userMessage: string;
  history: ChatMessage[];
  conversationId: string;
  /**
   * ACL-filtered snapshot of skills the host wants this agent to see in
   * querySkills(). Snapshotted at invoke time so the agent doesn't have
   * to make an async RPC during synchronous LLM prompt assembly.
   */
  availableSkills?: SkillDescriptor[];
}
async function handleInvokeAgent(params: InvokeAgentParams): Promise<unknown> {
  if (!plugin) throw rpcError(ERR.NOT_ACTIVATED, 'plugin not loaded');
  const agent: AgentImpl | undefined = plugin.agents?.find(
    (a) => a.descriptor.id === params.agentName,
  );
  if (!agent) {
    throw rpcError(
      ERR.AGENT_NOT_FOUND,
      `agent "${params.agentName}" not registered`,
    );
  }

  const ac = new AbortController();
  agentRuns.set(params.conversationId, ac);

  const availableSkills = params.availableSkills ?? [...collected.skills];

  const runCtx: AgentRunContext = {
    conversationId: params.conversationId,
    history: params.history,
    emit(ev: AgentEvent) {
      notifyHost('agent.event', {
        conversationId: params.conversationId,
        event: ev,
      });
    },
    signal: ac.signal,
    async invokeSkill(id, args) {
      const r = (await callHost('host.invokeSkill', {
        skillName: id,
        args,
        conversationId: params.conversationId,
      })) as { result: unknown };
      return r.result;
    },
    querySkills() {
      return availableSkills;
    },
    async spawnAgent(_agentId, _userMessage) {
      // TODO M24.3: route through host.spawnAgent so the daemon picks the
      // owner plugin and a sub-run is brokered with source-tagged events.
      throw rpcError(
        ERR.METHOD_NOT_FOUND,
        'spawnAgent over RPC: not implemented yet',
      );
    },
  };

  try {
    await agent.run(params.userMessage, runCtx);
  } finally {
    agentRuns.delete(params.conversationId);
  }
  return {};
}

interface CancelParams {
  conversationId: string;
}
function handleCancelNotification(params: CancelParams): void {
  const ac = agentRuns.get(params.conversationId);
  if (ac) ac.abort();
}

async function handleShutdown(_params: unknown): Promise<unknown> {
  setImmediate(() => process.exit(0));
  return {};
}

const HANDLERS: Record<string, (params: never) => Promise<unknown>> = {
  init: handleInit as (p: never) => Promise<unknown>,
  activate: handleActivate as (p: never) => Promise<unknown>,
  deactivate: handleDeactivate as (p: never) => Promise<unknown>,
  invokeSkill: handleInvokeSkill as (p: never) => Promise<unknown>,
  invokeAgent: handleInvokeAgent as (p: never) => Promise<unknown>,
  shutdown: handleShutdown as (p: never) => Promise<unknown>,
};

// ── Stdio frame loop ────────────────────────────────────────────────────────

function startReadLoop(): void {
  const decoder = new TextDecoder();
  let buffer = '';
  process.stdin.on('data', (chunk: Buffer) => {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        void handleFrame(line);
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

async function handleFrame(line: string): Promise<void> {
  let frame: RpcFrame;
  try {
    frame = JSON.parse(line) as RpcFrame;
  } catch {
    writeFrame({
      jsonrpc: '2.0',
      id: 0,
      error: { code: ERR.PARSE, message: 'invalid JSON' },
    });
    return;
  }
  if ('method' in frame && 'id' in frame) {
    // Inbound request from host
    const req = frame as RpcRequest;
    const fn = HANDLERS[req.method];
    if (!fn) {
      writeFrame({
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: ERR.METHOD_NOT_FOUND,
          message: `unknown method: ${req.method}`,
        },
      });
      return;
    }
    try {
      const result = await fn(req.params as never);
      writeFrame({ jsonrpc: '2.0', id: req.id, result });
    } catch (err) {
      const e = err as Error & { code?: number; data?: unknown };
      writeFrame({
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: e.code ?? ERR.INTERNAL,
          message: e.message,
          data: e.data,
        },
      });
    }
  } else if ('id' in frame && !('method' in frame)) {
    // Reply to one of our outbound requests
    const resp = frame as RpcResponse;
    const pending = pendingOut.get(resp.id);
    if (!pending) return;
    pendingOut.delete(resp.id);
    if (resp.error) {
      pending.reject(
        Object.assign(new Error(resp.error.message), { code: resp.error.code }),
      );
    } else {
      pending.resolve(resp.result);
    }
  }
  // Notifications from host
  if ('method' in frame && !('id' in frame)) {
    const notif = frame as RpcNotification;
    switch (notif.method) {
      case 'agent.cancel':
        handleCancelNotification(notif.params as CancelParams);
        break;
      default:
        // unknown notification — ignore
        break;
    }
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────

export async function runPluginHost(): Promise<void> {
  // Stdout is reserved for the JSON-RPC stream. Any console.log inside the
  // plugin's own code would corrupt it, so funnel all console output to
  // stderr (which the daemon already forwards to its own log).
  const writeStderr = (label: string, args: unknown[]): void => {
    const line =
      `[plugin-host:${label}] ` +
      args
        .map((a) =>
          typeof a === 'string' ? a : (() => {
            try {
              return JSON.stringify(a);
            } catch {
              return String(a);
            }
          })(),
        )
        .join(' ');
    process.stderr.write(line + '\n');
  };
  /* eslint-disable no-console */
  console.log = (...args) => writeStderr('log', args);
  console.info = (...args) => writeStderr('info', args);
  console.warn = (...args) => writeStderr('warn', args);
  console.error = (...args) => writeStderr('error', args);
  console.debug = (...args) => writeStderr('debug', args);
  /* eslint-enable no-console */

  const entry = process.env.SISYPHUS_PLUGIN_ENTRY;
  const pluginId = process.env.SISYPHUS_PLUGIN_ID;
  if (!entry) {
    process.stderr.write('[plugin-host] SISYPHUS_PLUGIN_ENTRY not set\n');
    process.exit(2);
  }
  try {
    const mod = (await import(pathToFileURL(entry).href)) as {
      default?: SisyphusPlugin;
    };
    if (!mod.default || typeof mod.default !== 'object') {
      throw new Error('plugin entry has no SisyphusPlugin default export');
    }
    plugin = mod.default;
    // SISYPHUS_PLUGIN_ID is the npm package name the broker spawned us
    // with; manifest.id is the plugin's self-declared identifier. They
    // are intentionally separate (a "@scope/plugin-foo" npm package can
    // declare manifest.id = "foo"). Don't warn on mismatch.
    void pluginId;
  } catch (err) {
    process.stderr.write(
      `[plugin-host] failed to load plugin entry "${entry}": ${(err as Error).message}\n`,
    );
    process.exit(3);
  }
  startReadLoop();
  // Keep the event loop alive; readLoop's 'end' or `shutdown` RPC exits.
  await new Promise<void>(() => {});
}
