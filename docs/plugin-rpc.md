# Plugin RPC Protocol (M24)

> Status: **draft v1** (lands with M24.1).
> Wire format: **JSON-RPC 2.0** over **stdio**, newline-delimited.
> Each message is one line of JSON. UTF-8.

This document specifies how the daemon (the *host*) talks to each plugin's
*child process*. Plugin authors do not write this protocol directly — the
`@sisylabs/plugin-sdk` package implements it on the plugin side. This doc
is the contract between SDK and host.

## Transport

- Each plugin runs as a child process spawned by the daemon. In prod, the
  child is the daemon SEA binary itself, re-entered with
  `SISYPHUS_MODE=plugin-host`. In dev, it's `node` (or `tsx`) running the
  plugin entry directly.
- The host writes JSON-RPC frames to the child's **stdin**, reads frames
  from the child's **stdout**. The child's **stderr** is forwarded to the
  daemon log as-is (free-form text, not RPC).
- Each frame is **one line** of JSON, terminated with `\n`. Embedded
  newlines inside string values are escaped (`\\n`). No `Content-Length`
  framing — keep it simple, line-delimited is fine for the sizes we ship.

## Boot sequence

```
1. Daemon spawns child binary with:
     env  SISYPHUS_MODE=plugin-host
          SISYPHUS_PLUGIN_ENTRY=<absolute path to plugin's main module>
          SISYPHUS_PLUGIN_ID=<plugin manifest id>
          SISYPHUS_API_VERSION=1
2. Child boots → loads plugin entry → SDK opens stdio RPC loop
3. Host → child: `init`           (handshake)
4. Host → child: `activate`       (returns ContributionsSnapshot)
5. Host registers contributions into daemon-side Registry (proxied)
6. … runtime …
7. Host → child: `deactivate` → `shutdown`, then SIGTERM if no reply
```

## Methods — host → plugin (requests, expect reply)

| method | params | result | notes |
|---|---|---|---|
| `init` | `{ apiVersion: 1 }` | `{ apiVersion: 1, sdkVersion: string }` | abort spawn on mismatch |
| `activate` | `{}` | `ContributionsSnapshot` | runs user's `onActivate(ctx)`; ctx accumulates registrations and they're returned in the reply |
| `deactivate` | `{}` | `{}` | runs user's `onDeactivate(ctx)` if defined |
| `invokeSkill` | `{ skillName: string, args: unknown }` | `{ result: unknown }` | host asks plugin to run one of its own skills |
| `invokeAgent` | `{ agentName, userMessage, history, conversationId, availableSkills? }` | `{}` (events stream via `agent.event` notification, see below) | reply lands only when agent emits `done` and the loop unwinds. `availableSkills` is an ACL-filtered snapshot the host pre-resolves; plugin's `ctx.querySkills()` returns it. |
| `shutdown` | `{}` | `{}` | graceful, then host closes stdin |

## Methods — plugin → host (requests, expect reply)

| method | params | result | notes |
|---|---|---|---|
| `host.invokeSkill` | `{ skillName: string, args: unknown, conversationId?: string }` | `{ result: unknown }` | broker dispatches to the owning plugin; **subject to ACL** (M13). errors with code `-32030` on ACL deny. `conversationId` is forwarded to the target skill's `SkillContext`. |
| `host.querySkills` | `{}` | `{ skills: SkillDescriptor[] }` | snapshot of skills the caller is allowed to see — own namespace + `manifest.requires.skills`. Snapshotted at call time, not subscription. |
| `host.storage.get` | `{ key: string }` | `{ value: unknown \| null }` | per-plugin KV (M4); plugin id is implicit (taken from spawn env) |
| `host.storage.set` | `{ key: string, value: unknown }` | `{}` | |
| `host.storage.delete` | `{ key: string }` | `{}` | |
| `host.config.get` | `{}` | `{ config: SisyphusConfig }` | merged project>user>env, with apiKey already masked unless plugin requires it |

## Notifications — plugin → host (no reply)

| method | params | notes |
|---|---|---|
| `agent.event` | `{ conversationId: string, event: AgentEvent }` | host pipes event into the SSE stream for that conversation |
| `log` | `{ level: 'info' \| 'warn' \| 'error', message: string, data?: unknown }` | structured log; merged into daemon stdout |

## Notifications — host → plugin (no reply)

| method | params | notes |
|---|---|---|
| `agent.cancel` | `{ conversationId: string }` | host wants the agent for this conversation aborted; SDK looks up the matching AbortController and fires it. Signal-aware agent code unwinds and is expected to emit a final `{ type: 'done', reason: 'cancelled' }`. |

## ContributionsSnapshot

What `activate` returns. Mirrors the in-process contribution shapes but with
no function references (those live behind RPC proxies on the host side).

```typescript
interface ContributionsSnapshot {
  agents: Array<{
    id: string;             // namespaced: "<pluginId>.<localId>"
    name: string;
    description?: string;
    routerHints?: { keywords?: string[]; intents?: string[] };
  }>;
  skills: Array<{
    id: string;             // namespaced: "<pluginId>.<localId>"
    name: string;
    description: string;
    parameters: JSONSchema; // OpenAI tool calling-compatible
  }>;
  views: Array<{
    id: string;
    region: 'left' | 'right' | 'bottom' | 'center';
    title: string;
    icon?: string;
  }>;
  cards: Array<{
    type: string;           // namespaced: "<pluginId>.<type>"
    description?: string;
  }>;
}
```

`views` and `cards` are metadata only; the React components live in the
plugin's UI bundle (loaded via `/api/plugins/:id/ui.mjs` — M16, unchanged).

## Error codes

Standard JSON-RPC error codes plus our extensions:

| code | meaning |
|---|---|
| `-32700` | parse error (malformed JSON) |
| `-32600` | invalid request |
| `-32601` | method not found |
| `-32602` | invalid params |
| `-32603` | internal error (uncaught exception inside handler) |
| `-32000` | plugin not yet activated |
| `-32010` | skill not registered |
| `-32020` | agent not registered |
| `-32030` | ACL denied (cross-plugin skill not in manifest.requires.skills) |
| `-32040` | apiVersion mismatch (init) |
| `-32050` | plugin process crashed mid-call (host-side synthesized) |

## Lifecycle nits

- **Crash**: child exits non-zero or stdout closes → host marks plugin
  `crashed`, fails any in-flight RPC with `-32050`, removes contributions
  from the registry, requires user to re-enable. (M24.1 doesn't auto-restart.)
- **Shutdown**: `deactivate` → `shutdown` → wait `5s` → SIGTERM → wait `2s`
  → SIGKILL. Stdin close serves as the deactivation signal in the SDK loop.
- **Concurrency**: host can have multiple in-flight requests to one plugin
  process; SDK loop reads sequentially but a single handler can be async.
  Replies are correlated by `id`. Plugin authors should not assume request
  serialization — write skill handlers as pure functions.
