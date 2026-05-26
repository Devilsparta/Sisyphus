/**
 * plugin-broker — daemon side of the host↔plugin RPC channel.
 *
 * Replaces the in-process dynamic import used in M9..M23. For each
 * activated plugin we spawn a child process (the same daemon binary
 * re-entered with SISYPHUS_MODE=plugin-host) and talk JSON-RPC over its
 * stdio. The broker exposes a small Promise-y API to the rest of the
 * daemon — activate, deactivate, invokeSkill, invokeAgent — and hides
 * the wire details + child lifecycle.
 *
 * See docs/plugin-rpc.md for the protocol contract.
 */
import { type ChildProcess } from 'node:child_process';
import type {
  AgentDescriptor,
  AgentEvent,
  AgentRunContext,
  CardDescriptor,
  PluginManifest,
  SkillDescriptor,
  ViewDescriptor,
} from '@sisyphus/kernel';
import { resolvePluginPaths } from './plugin-loader';
import { createPluginStorage } from './storage';

const ERR_PLUGIN_CRASHED = -32050;
const ERR_INTERNAL = -32603;
const ERR_METHOD_NOT_FOUND = -32601;

export interface ActivationResult {
  manifest: PluginManifest;
  agents: AgentDescriptor[];
  skills: SkillDescriptor[];
  views: ViewDescriptor[];
  cards: CardDescriptor[];
  uiBundlePath: string | null;
  /**
   * Absolute path of the file the child process imported as its plugin
   * entry. Dev mode watches this for changes to drive hot reload via
   * deactivate + activate.
   */
  daemonEntryPath: string;
}

/**
 * Observer notified when a plugin's child process exits unexpectedly
 * (not via deactivate). Plugin-manager subscribes so it can dispose
 * the registry contributions of a dead plugin and surface the state
 * to the UI / HTTP routes.
 */
export type CrashObserver = (
  packageName: string,
  info: { code: number | null; signal: NodeJS.Signals | null },
) => void;

type PendingMap = Map<
  number | string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>;

interface PluginChild {
  packageName: string;
  /** Plugin manifest id — only populated after `activate` returns. */
  pluginId: string;
  child: ChildProcess;
  rpcId: number;
  pending: PendingMap;
  buffer: string;
  crashed: boolean;
}

/**
 * Signature the daemon registers so the broker can dispatch cross-plugin
 * skill invocations. The daemon's implementation reads the central registry
 * and applies M13 ACL before forwarding.
 */
export type CrossPluginSkillInvoker = (
  skillId: string,
  args: Record<string, unknown>,
  conversationId: string,
  callerPluginId: string,
) => Promise<unknown>;

/**
 * Return the skills a given caller plugin is allowed to see. Daemon
 * implements this by reading the central Registry and applying M13 ACL
 * (own namespace + manifest.requires.skills).
 */
export type SkillsForPluginProvider = (
  callerPluginId: string,
) => SkillDescriptor[];

/**
 * Spawn the actual child process for plugin-host mode. Daemon entry picks
 * the right form (SEA self-spawn in prod, `node --import tsx <entry>` in
 * dev) and hands it to the broker as a closure.
 */
export type PluginChildSpawner = (env: NodeJS.ProcessEnv) => ChildProcess;

export class PluginBroker {
  private children = new Map<string, PluginChild>();
  private byPluginId = new Map<string, PluginChild>();
  /** conversationId → agent emit callback, set per invokeAgent call. */
  private agentEmits = new Map<string, (ev: AgentEvent) => void>();
  private crossInvoke: CrossPluginSkillInvoker | null = null;
  private skillsForPlugin: SkillsForPluginProvider | null = null;
  private crashObserver: CrashObserver | null = null;
  /** Active deactivations — set so attachExit can tell intent vs accident. */
  private deactivating = new Set<string>();

  constructor(private spawner: PluginChildSpawner) {}

  setCrossPluginSkillInvoker(fn: CrossPluginSkillInvoker): void {
    this.crossInvoke = fn;
  }

  setSkillsForPluginProvider(fn: SkillsForPluginProvider): void {
    this.skillsForPlugin = fn;
  }

  /**
   * Register a callback fired when a plugin child exits *outside* of a
   * pending deactivate (i.e. it crashed, or was SIGKILLed externally).
   * Wires plugin-manager to dispose registrations and surface the state.
   */
  setCrashObserver(fn: CrashObserver): void {
    this.crashObserver = fn;
  }

  isActivated(packageName: string): boolean {
    const s = this.children.get(packageName);
    return !!s && !s.crashed;
  }

  listActivated(): string[] {
    return Array.from(this.children.keys()).filter((p) =>
      this.isActivated(p),
    );
  }

  async activate(packageName: string): Promise<ActivationResult> {
    if (this.children.has(packageName)) {
      throw new Error(`plugin "${packageName}" already activated`);
    }
    const paths = await resolvePluginPaths(packageName);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      SISYPHUS_MODE: 'plugin-host',
      SISYPHUS_PLUGIN_ENTRY: paths.daemonEntryPath,
      SISYPHUS_PLUGIN_ID: paths.pluginId,
    };
    const child = this.spawner(childEnv);

    // pluginId is pre-resolved from package.json sisyphus.id so storage /
    // log namespacing works for RPCs fired during onActivate (which runs
    // inside the activate RPC, before the host has seen the live manifest).
    const state: PluginChild = {
      packageName,
      pluginId: paths.pluginId,
      child,
      rpcId: 1,
      pending: new Map(),
      buffer: '',
      crashed: false,
    };
    this.children.set(packageName, state);
    this.byPluginId.set(paths.pluginId, state);
    this.attachStdio(state);
    this.attachExit(state);

    try {
      await this.rpc(state, 'init', { apiVersion: 1 });
      const reply = (await this.rpc(state, 'activate', {})) as ActivationResult;
      // Reconcile if the live manifest disagrees with the pre-read sisyphus.id.
      if (reply.manifest.id !== state.pluginId) {
        this.byPluginId.delete(state.pluginId);
        state.pluginId = reply.manifest.id;
        this.byPluginId.set(reply.manifest.id, state);
      }
      return {
        ...reply,
        uiBundlePath: paths.uiBundlePath,
        daemonEntryPath: paths.daemonEntryPath,
      };
    } catch (err) {
      this.children.delete(packageName);
      this.byPluginId.delete(state.pluginId);
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  async deactivate(packageName: string): Promise<void> {
    const state = this.children.get(packageName);
    if (!state) return;
    this.deactivating.add(packageName);
    this.children.delete(packageName);
    if (state.pluginId) this.byPluginId.delete(state.pluginId);

    if (!state.crashed) {
      try {
        await this.rpc(state, 'deactivate', {});
      } catch {
        /* best effort */
      }
      try {
        await this.rpc(state, 'shutdown', {});
      } catch {
        /* best effort */
      }
      // give shutdown 2s, then SIGTERM, then 2s, then SIGKILL
      const child = state.child;
      setTimeout(() => {
        if (!child.killed && child.exitCode === null) {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!child.killed && child.exitCode === null) {
              child.kill('SIGKILL');
            }
          }, 2000);
        }
      }, 2000);
    }
  }

  async invokeSkill(
    packageName: string,
    skillId: string,
    args: Record<string, unknown>,
    conversationId?: string,
  ): Promise<unknown> {
    const state = this.requireActive(packageName);
    const reply = (await this.rpc(state, 'invokeSkill', {
      skillName: skillId,
      args,
      conversationId,
    })) as { result: unknown };
    return reply.result;
  }

  async invokeAgent(
    packageName: string,
    agentId: string,
    runCtx: AgentRunContext,
    userMessage: string,
  ): Promise<void> {
    const state = this.requireActive(packageName);

    // Snapshot the skills this caller plugin is allowed to see at invoke
    // time; the plugin uses it as ctx.querySkills() inside the agent.
    const availableSkills = this.skillsForPlugin
      ? this.skillsForPlugin(state.pluginId)
      : [];

    this.agentEmits.set(runCtx.conversationId, runCtx.emit);

    // Forward an abort on runCtx.signal as an `agent.cancel` notification
    // to the child. Plugin-host runtime fires the matching AbortController
    // and the agent's signal-aware code unwinds.
    const onAbort = (): void => {
      this.writeNotification(state, 'agent.cancel', {
        conversationId: runCtx.conversationId,
      });
    };
    runCtx.signal.addEventListener('abort', onAbort, { once: true });

    try {
      await this.rpc(state, 'invokeAgent', {
        agentName: agentId,
        userMessage,
        history: runCtx.history,
        conversationId: runCtx.conversationId,
        availableSkills,
      });
    } finally {
      runCtx.signal.removeEventListener('abort', onAbort);
      this.agentEmits.delete(runCtx.conversationId);
    }
  }

  async shutdownAll(): Promise<void> {
    await Promise.all(
      Array.from(this.children.keys()).map((p) => this.deactivate(p)),
    );
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private requireActive(packageName: string): PluginChild {
    const state = this.children.get(packageName);
    if (!state) throw new Error(`plugin "${packageName}" not activated`);
    if (state.crashed) {
      throw Object.assign(new Error(`plugin "${packageName}" has crashed`), {
        code: ERR_PLUGIN_CRASHED,
      });
    }
    return state;
  }

  private rpc(
    state: PluginChild,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    if (state.crashed) {
      return Promise.reject(
        Object.assign(new Error('plugin process crashed'), {
          code: ERR_PLUGIN_CRASHED,
        }),
      );
    }
    const id = state.rpcId++;
    return new Promise((resolve, reject) => {
      state.pending.set(id, { resolve, reject });
      const frame =
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      state.child.stdin?.write(frame);
    });
  }

  private writeReply(
    state: PluginChild,
    id: number | string,
    result: unknown,
    error?: { code: number; message: string; data?: unknown },
  ): void {
    const obj = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result };
    state.child.stdin?.write(JSON.stringify(obj) + '\n');
  }

  private writeNotification(
    state: PluginChild,
    method: string,
    params: unknown,
  ): void {
    if (state.crashed || state.child.stdin?.destroyed) return;
    state.child.stdin?.write(
      JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n',
    );
  }

  private attachStdio(state: PluginChild): void {
    const decoder = new TextDecoder();
    state.child.stdout?.on('data', (chunk: Buffer) => {
      state.buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = state.buffer.indexOf('\n')) !== -1) {
        const line = state.buffer.slice(0, nl).trim();
        state.buffer = state.buffer.slice(nl + 1);
        if (line) {
          void this.handleFrame(state, line);
        }
      }
    });
  }

  private attachExit(state: PluginChild): void {
    state.child.on('exit', (code, signal) => {
      state.crashed = true;
      const err = Object.assign(
        new Error(`plugin process exited (code=${code}, signal=${signal})`),
        { code: ERR_PLUGIN_CRASHED },
      );
      for (const [, p] of state.pending) p.reject(err);
      state.pending.clear();

      const wasDeactivating = this.deactivating.delete(state.packageName);
      // eslint-disable-next-line no-console
      console.warn(
        `[plugin-broker] plugin "${state.packageName}" exited ` +
          `(code=${code}, signal=${signal}, intentional=${wasDeactivating})`,
      );

      // Unexpected exit (no pending deactivate) → notify observer so
      // plugin-manager can dispose registry entries + flag the plugin.
      if (!wasDeactivating && this.crashObserver) {
        // Clean up internal maps in case deactivate() wasn't called.
        if (this.children.get(state.packageName) === state) {
          this.children.delete(state.packageName);
        }
        if (state.pluginId && this.byPluginId.get(state.pluginId) === state) {
          this.byPluginId.delete(state.pluginId);
        }
        try {
          this.crashObserver(state.packageName, { code, signal });
        } catch (cbErr) {
          // eslint-disable-next-line no-console
          console.error(
            `[plugin-broker] crash observer threw for "${state.packageName}":`,
            cbErr,
          );
        }
      }
    });
  }

  private async handleFrame(state: PluginChild, line: string): Promise<void> {
    interface AnyFrame {
      jsonrpc?: string;
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    }
    let frame: AnyFrame;
    try {
      frame = JSON.parse(line) as AnyFrame;
    } catch {
      return;
    }
    if (frame.method && frame.id !== undefined) {
      // plugin → host request
      try {
        const result = await this.dispatchHostRequest(
          state,
          frame.method,
          frame.params as Record<string, unknown> | undefined,
        );
        this.writeReply(state, frame.id, result);
      } catch (err) {
        const e = err as Error & { code?: number; data?: unknown };
        this.writeReply(state, frame.id, undefined, {
          code: e.code ?? ERR_INTERNAL,
          message: e.message,
          data: e.data,
        });
      }
    } else if (frame.id !== undefined && !frame.method) {
      // reply to one of our requests
      const p = state.pending.get(frame.id);
      if (!p) return;
      state.pending.delete(frame.id);
      if (frame.error) {
        p.reject(
          Object.assign(new Error(frame.error.message), {
            code: frame.error.code,
            data: frame.error.data,
          }),
        );
      } else {
        p.resolve(frame.result);
      }
    } else if (frame.method) {
      // notification from plugin
      this.handleNotification(state, frame.method, frame.params);
    }
  }

  private async dispatchHostRequest(
    state: PluginChild,
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    const p = params ?? {};
    const pluginKey = state.pluginId || state.packageName;
    switch (method) {
      case 'host.storage.get': {
        const storage = createPluginStorage(pluginKey);
        const value = await storage.get(p.key as string);
        return { value: value ?? null };
      }
      case 'host.storage.set': {
        const storage = createPluginStorage(pluginKey);
        await storage.set(p.key as string, p.value);
        return {};
      }
      case 'host.storage.delete': {
        const storage = createPluginStorage(pluginKey);
        await storage.delete(p.key as string);
        return {};
      }
      case 'host.storage.clear': {
        const storage = createPluginStorage(pluginKey);
        await storage.clear();
        return {};
      }
      case 'host.storage.keys': {
        const storage = createPluginStorage(pluginKey);
        const keys = await storage.keys();
        return { keys };
      }
      case 'host.invokeSkill': {
        if (!this.crossInvoke) {
          throw Object.assign(
            new Error('cross-plugin skill invoke not configured'),
            { code: ERR_INTERNAL },
          );
        }
        const result = await this.crossInvoke(
          p.skillName as string,
          (p.args as Record<string, unknown>) ?? {},
          (p.conversationId as string) ?? '',
          state.pluginId,
        );
        return { result };
      }
      case 'host.querySkills': {
        // Snapshot, not subscription. Plugin gets the ACL-filtered set as
        // it stands now; if a new skill registers later in the same agent
        // run the plugin won't see it without another querySkills call.
        const skills = this.skillsForPlugin
          ? this.skillsForPlugin(state.pluginId)
          : [];
        return { skills };
      }
      default:
        throw Object.assign(new Error(`unknown host method: ${method}`), {
          code: ERR_METHOD_NOT_FOUND,
        });
    }
  }

  private handleNotification(
    state: PluginChild,
    method: string,
    params: unknown,
  ): void {
    const p = (params as Record<string, unknown>) ?? {};
    switch (method) {
      case 'agent.event': {
        const convoId = p.conversationId as string;
        const event = p.event as AgentEvent;
        const emit = this.agentEmits.get(convoId);
        if (emit) emit(event);
        break;
      }
      case 'log': {
        const level = (p.level as string) ?? 'info';
        const message = p.message as string;
        const data = p.data;
        const tag = `[plugin:${state.pluginId || state.packageName}]`;
        // eslint-disable-next-line no-console
        const fn =
          level === 'error'
            ? console.error
            : level === 'warn'
              ? console.warn
              : console.log;
        if (data !== undefined) fn(`${tag} ${message}`, data);
        else fn(`${tag} ${message}`);
        break;
      }
      default:
        // unknown notification — ignore
        break;
    }
  }
}
