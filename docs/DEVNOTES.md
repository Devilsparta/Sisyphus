# Sisyphus — Development Notes

> Last updated: 2026-05-23  
> This file is the single source of truth for context recovery after session loss.

## What is this project?

**Sisyphus = AI-native VSCode platform.** A plugin-based desktop app where you chat with AI agents to generate UI, manage todos, and build custom workflows. Think: VSCode meets ChatGPT, but extensible by third-party plugin developers.

## Why "Sisyphus"?

From Camus' reading of the Greek myth. AI tools iterate so fast that today's useful thing is tomorrow's obsolete. But while it's useful, we do meaningful work. Pushing the rock is the point.

## Quick start

```bash
cd ~/workspace/sisyphus

# Daemon (API + static serve) → http://localhost:8787
pnpm --filter @sisyphus/daemon dev

# Tauri desktop shell (spawns daemon automatically)
pnpm tauri dev
```

Config: `packages/daemon/.env.local` (OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL)

## Architecture (mental model)

```
┌──────────────────────────────────────────────┐
│  Tauri Shell (M22) — spawns daemon, webview  │
│──────────────────────────────────────────────│
│  Daemon (Hono :8787)                          │
│  ├─ Plugin Loader → Plugin Manager            │
│  ├─ Registry (ScopedRegistry per plugin)      │
│  ├─ Router (keyword fast-path + LLM fallback) │
│  ├─ Skill Dispatch (tool calling loop)        │
│  ├─ Config (per-project > per-user > default) │
│  ├─ Auth (opt-in API key)                     │
│  ├─ Static File Server (UI dist)              │
│  └─ WS Hub (registry events)                  │
│──────────────────────────────────────────────│
│  Kernel (types + UI runtime registries)       │
│──────────────────────────────────────────────│
│  Plugins (npm packages, dual-entry)            │
│  ├─ plugin-base: react-designer, time-helper,  │
│  │   assistant, chat view, canvas, settings    │
│  └─ plugin-todo: todo-manager, task list       │
└──────────────────────────────────────────────┘
```

## Milestones completed (26 commits)

| # | What | When |
|---|------|------|
| M0 | Monorepo skeleton (pnpm workspace, kernel contracts) | 05-20 |
| M1 | Panel Layout (4-region), WebSocket IPC, Registry API | 05-20 |
| M2 | Multi-agent architecture (router + plugin-base agent) | 05-20 |
| M3 | Second plugin (plugin-todo), multi-agent router | 05-20 |
| M4 | Per-plugin storage + provider stack | 05-20 |
| M5 | Tool call/tool result dispatch | 05-20 |
| M6 | LLM tool calling loop (assistant agent, non-streaming) | 05-20 |
| M7 | Streaming assistant (reasoning + token chunks) | 05-21 |
| M8 | LLM router (hybrid keyword + LLM disambiguation) | 05-21 |
| M9 | Dynamic plugin loading (daemon side) | 05-21 |
| M10 | Namespace enforcement + dependency topology | 05-21 |
| M11 | API-key auth for /api/* and WS | 05-21 |
| M12 | Per-project/user config + settings UI | 05-22 |
| M13 | Per-plugin skill ACL | 05-22 |
| M14 | Agent fan-out (parallel spawn) | 05-22 |
| M16 | UI dynamic plugin loading + build pipeline | 05-22 |
| M17 | Plugin dev mode (esbuild watch + fs watcher) | 05-22 |
| M18 | Decouple host from plugins | 05-22 |
| M19 | Runtime plugin install/enable/disable/uninstall | 05-22 |
| M20+M21 | Plugins management UI + web deploy (daemon serves UI) | 05-22 |
| M23 | Plugin discovery (npm search + curated marketplace) | 05-23 |
| M22.1 | Tauri desktop shell phase-1 (spawn daemon via pnpm) | 05-23 |
| M22.2 | Tauri sidecar — bun-compiled daemon binary as externalBin | 05-23 |
| M22.3 | Daemon SEA migration (Node 24 single-executable, drops Bun) | 05-25 |
| M22.4 | UI dist in .app/Contents/Resources/ui — self-contained .dmg | 05-25 |
| M24.1 | Plugin process isolation — broker + stdio JSON-RPC vertical slice | 05-25 |
| M24.2 | Agent API parity — signal/abort, conversationId, host.querySkills | 05-26 |
| M24.3 | Migrated plugin-base + plugin-todo onto broker; daemon HTTP /api/chat verified | 05-26 |
| M24.4 | SEA self-spawn smoke — daemon binary spawning itself as plugin host works | 05-26 |
| M24.5 | Dev hot reload via broker.respawn (daemon-entry fs watch) | 05-26 |
| M24.6 | Crashed plugin state — manager disposes, WS broadcast, /api/plugins reactivate | 05-26 |
| M24.7 | spawnAgent over RPC (cross-process fan-out) + arm64 cross-build + UI crash badge | 05-26 |

## Key files to know

```
packages/daemon/src/
├── index.ts          # Entry: sets up Hono, mounts all routes
├── router.ts         # Multi-agent routing (keyword + LLM)
├── plugin-loader.ts  # Dynamic ES module import
├── plugin-graph.ts   # Topo sort + dependency validation
├── plugin-search.ts  # npm registry + marketplace search
├── plugin-installer.ts # pacote extract into ~/.sisyphus/
├── plugin-manager.ts # Lifecycle: activate/deactivate
├── registry.ts       # Global registry with event bus
├── scoped-registry.ts # Per-plugin namespace enforcement
├── config.ts         # Multi-layer config (project/user/default)
├── auth.ts           # API key middleware
├── storage.ts        # Per-plugin file-backed KV
├── ws.ts             # WebSocket hub
├── event-bus.ts      # Typed event emitter
├── dev-watcher.ts    # fs watcher for plugin dev mode
└── plugin-config.ts  # Config management for plugin state

packages/kernel/src/
├── index.ts          # Shared types, AgentRunContext
└── ui.ts             # UI runtime registries

src-tauri/
├── src/lib.rs        # Tauri app: spawn daemon, poll /health, webview
├── src/main.rs       # Entry point
├── tauri.conf.json   # Window config (1280x800), bundle settings
└── Cargo.toml        # Rust deps (tauri 2, tokio, reqwest)
```

## Plugin system in 30 seconds

A plugin is an npm package with:
- `keywords: ["sisyphus-plugin"]` in package.json
- `.` export → daemon entry (SisyphusPlugin type)
- `./ui` export → browser entry (views, cardRenderers, providers)
- `sisyphus` block in package.json declaring agents, skills, views, cards

Install path: `~/.sisyphus/plugins-node_modules/<scope>/<name>/`
Storage path: `~/.sisyphus/plugins/<plugin-id>.json`
Config path: `~/.sisyphus/plugins.config.json`

## What just happened (most recent work)

**Today (2026-05-26):**
- M24.7: three remaining items closed.
  - **UI crash badge**: plugin-base settings view extended — PluginInfo carries `crashed`/`crashReason`/`crashedAt`, the panel shows a red "· crashed" badge + the reason inline, and a "Reactivate" button that hits `POST /api/plugins/reactivate`. Plus a 3s poll so the badge surfaces without a manual refresh.
  - **spawnAgent over RPC**: `host.spawnAgent` notification + dispatch. Each `broker.invokeAgent` now generates a UUID `runId`; agent.event notifications carry the runId, broker.agentEmits indexes by runId (instead of conversationId) so concurrent runs in the same conversation don't trample each other's emit. Plugin-host runtime auto-tags `event.source = agentName` if unset, router's existing source-preservation does the rest. `plugin-manager.spawnSubAgent` reads `broker.getEmitForRun(parentRunId)` to wire the sub-agent's emit straight back into the parent's emit chain. Verified by new `spawnagent-smoke.mts`: plugin-hello has a `fanout-time` agent that spawns plugin-base's `time-helper` (in another process), parent + sub events both stream into the same emit with correct source tags and sub-done lands before parent-done.
  - **arm64 cross-build**: `SISYPHUS_TARGET_TRIPLE=aarch64-apple-darwin` makes `build:bin` download the matching nodejs.org darwin-arm64 tarball (cached at `~/.cache/sisyphus-build/`), skip the lipo step, and produce a single-arch arm64 daemon binary. `pnpm tauri build --target aarch64-apple-darwin` + `TARGET=aarch64-apple-darwin scripts/make-dmg.sh` complete the chain. Shipped: 49 MB x64 dmg + 47 MB arm64 dmg, both unsigned.
- Full smoke chain now 57 assertions across 5 suites; `pnpm --filter @sisyphus/daemon test:smoke` builds plugin-hello, runs broker/migration/lifecycle/spawnagent under tsx dev, rebuilds the SEA binary, runs sea-smoke. All green.
- M24.5 + M24.6: plugin lifecycle polish. Two missing pieces filled in:
  - **Hot reload (M24.5).** Broker's activate result now carries the resolved `daemonEntryPath`; plugin-manager exposes `respawn(packageName) = deactivate + activate`; `dev-watcher` watches the entry path on top of the existing UI bundle path and calls `respawn` on change. Plugin authors who write atomic-output build pipelines (esbuild watch → dist/index.mjs) get true hot reload without restarting the daemon — UI WebSocket stays up.
  - **Crash detection (M24.6).** Broker tells the difference between intentional shutdown (called `deactivate` first) and unexpected exit via a new `deactivating` set; the latter fires a `CrashObserver` callback. Plugin-manager subscribes, disposes all registry entries (agents/skills/views/cards) of the dead plugin, flips internal state (`isActivated → false`, `isCrashed → true`), and surfaces a `CrashedRecord` with the reason. `/api/plugins` reply gained `crashed` / `crashReason` / `crashedAt` fields; new `POST /api/plugins/reactivate` endpoint calls `respawn` (one button on the UI side covers both "the plugin crashed, restart it" and "I just edited code, restart it"). Daemon WebSocket broadcasts a `plugin.crashed` event when the manager flags a crash, so the UI can show a badge without polling.
- New smoke test (`test/lifecycle-smoke.mts`, 17 assertions): healthy-respawn identity check, crash via a new `plugin-hello.skill.self-destruct` (process.exit(42) after returning), then respawn-after-crash recovery. Combined with the existing three smokes, `pnpm test:smoke` now runs 53 assertions and rebuilds the SEA binary in the middle.
- M24.4: SEA self-spawn validated end-to-end. New smoke test (`packages/daemon/test/sea-smoke.mts`) uses the daemon SEA binary itself as the spawner instead of `node --import tsx`, then runs the same RPC surface as broker-smoke. Result: 9/9 assertions pass — `SISYPHUS_MODE=plugin-host` dispatch fires, the binary loads a pre-compiled `.mjs` plugin from disk, RPC over stdio works, cancel-via-signal works, deactivate is clean. This means the prod path (`Sisyphus.app/Contents/MacOS/sisyphus-daemon` spawned by Tauri, then spawning itself as plugin host) works without a separate node binary in the bundle. `plugin-hello` switched to npm-shape (`dist/index.mjs` via esbuild bundle, 2.6 KB) — the SEA Node runtime can't load `.ts`, so all production plugins must ship pre-compiled. Added `pnpm --filter @sisyphus/daemon test:smoke` that runs broker-smoke + migration-smoke (dev tsx) + rebuilds SEA + runs sea-smoke; reproducible single command for the whole M24 contract.
- M24.3: Reference plugins migrated. Both `@sisyphus/plugin-base` and `@sisyphus/plugin-todo` now run through the broker exactly the same way `plugin-hello` does. A new smoke test (`packages/daemon/test/plugin-migration-smoke.mts`, 14 assertions) covers: agent registration of all four reference agents and the current-time skill; `time-helper` end-to-end (tool_call → cross-plugin invokeSkill via host RPC → tool_result → token → done); `plugin-todo` onActivate hydrating from disk; storage round-trip (add task → persist → fresh broker re-activates and re-reads). Found and fixed a bug: storage namespacing keyed off `state.pluginId` which was empty during onActivate (broker only learned the manifest id from the `activate` reply, after onActivate had already run). Now `resolvePluginPaths` pre-reads `sisyphus.id` from package.json so the broker namespaces storage / logs from the first RPC; the live manifest still reconciles if it disagrees.
- Daemon HTTP integration verified: booting `pnpm --filter @sisyphus/daemon start` with both plugins enabled, hitting `/api/chat` with "what time is it" routes through the keyword router → broker → child process → tool_call/tool_result/token/done streaming back as SSE, all events automatically `source`-tagged by the router. Same wire shape users had before M24, now with process isolation under the hood.
- M24.2: Agent API parity for brokered plugins. Three gaps closed against M24.1:
  - **signal/abort over RPC**: broker.invokeAgent now subscribes to `runCtx.signal`; on abort it writes an `agent.cancel` notification to the child, plugin-host-runtime fires the matching AbortController, signal-aware agent code unwinds and emits `done`/`cancelled`.
  - **conversationId on cross-plugin invokeSkill**: plugin-host-runtime's `ctx.invokeSkill` now passes the run's `conversationId` in the `host.invokeSkill` params; the target skill's `SkillContext.conversationId` is no longer empty for RPC-routed calls.
  - **host.querySkills RPC + ACL snapshot**: broker takes a `SkillsForPluginProvider` from plugin-manager. plugin-manager implements it with the same M13 canInvoke rule (own namespace + manifest.requires.skills). broker pre-resolves the snapshot at invoke time and passes it via `availableSkills` in `invokeAgent` params, so `ctx.querySkills()` stays synchronous on the plugin side. `host.querySkills` also exposed as a standalone RPC for late queries.
- Smoke test extended to 13 assertions: cancel-mid-stream (long-runner agent emits 50 tokens with 20ms delay, aborted after 3), conversationId round-trip via echo skill, skill-lister agent emits its ACL-filtered skill list.

**Yesterday (2026-05-25):**
- M24.1: Plugin process isolation, vertical slice. Plugins now run as child processes; daemon ↔ plugin talk JSON-RPC over stdio (protocol spec: `docs/plugin-rpc.md`). New `plugin-broker.ts` manages child lifecycle + RPC client + dispatches plugin→host requests (storage / cross-plugin invokeSkill with M13 ACL). `plugin-host-runtime.ts` runs *inside* the child — daemon SEA binary self-spawns with `SISYPHUS_MODE=plugin-host`, loads the plugin entry, exposes a `PluginContext` whose storage/log/invokeSkill all tunnel back through stdio. `plugin-manager.ts` rewritten to wrap broker calls behind the same activate/deactivate facade, registering RPC-proxy skill handlers + agent impls into the central Registry — router and HTTP routes don't know they're talking to subprocesses. Smoke test (`packages/daemon/test/broker-smoke.mts`) covers init → activate → invokeSkill → invokeAgent (token stream over `agent.event` notification) → deactivate end-to-end against a new test fixture `@sisyphus/plugin-hello`. **Plugin author API unchanged**: same `export default { manifest, onActivate, agents, skillHandlers }`.
- M22.3: Replaced Bun-compiled sidecar with Node 24 SEA. `build:bin` now runs esbuild → CJS bundle → `node --experimental-sea-config` → `postject` inject into a `lipo -thin`'d copy of `node` → `codesign --sign -` ad-hoc. ~118 MB binary, full npm ecosystem (native addons work, no Bun compatibility roulette). Plugin loader's `createRequire(import.meta.url)` falls back to `__filename` for CJS bundle.
- M22.4: UI dist now lives at `Sisyphus.app/Contents/Resources/ui/` via `tauri.conf.json` `resources` map. `lib.rs::locate_ui_dir` uses `app.path().resource_dir().join("ui")` in prod, falls back to monorepo `packages/ui/dist` in dev. The shipped .app is fully self-contained.
- `bundle.targets` reduced to `["app"]`; we dropped Tauri's dmg target because create-dmg's AppleScript step intermittently fails ("AppleEvent timed out" -1712). `scripts/make-dmg.sh` uses plain `hdiutil` to pack the .app into a 49 MB UDZO dmg.

**Earlier (2026-05-23):**
- M22.1: Added Tauri v2 desktop shell. Rust binary that spawns the daemon as a child process, polls `/health`, then reloads the webview. On close, kills the daemon.
- M22.2: Bundled the daemon as a Tauri sidecar via `bun build --compile` (superseded by M22.3).
- M23: Plugin discovery — daemon can search npm registry for `keywords:sisyphus-plugin` packages, and serves a curated marketplace from GitHub `marketplace.json`

**Yesterday (2026-05-22):**
- M19: Runtime plugin install via pacote (no daemon restart needed)
- M20+M21: Plugins management UI + daemon serves UI from `packages/ui/dist`
- M17: Plugin dev mode — esbuild watch for hot reload
- M18: Decoupled host from plugins (shared load path for dev/prod)
- M16: UI-side dynamic plugin loading
- M14: Agent fan-out (parallel agent spawning)
- M13: Skill ACL (cross-plugin access control)
- M12: Multi-layer config system + settings UI

## What's next (TODO)

1. **Assistant agent + LLM tool calling under broker**: smokes cover the wiring but don't actually drive an LLM. Worth running plugin-base.assistant against a real key to surface latency / streaming buffering issues.
2. **Publish `@sisyphus/kernel` to npm**: outside plugin authors need `import type { SisyphusPlugin }` — workspace dep blocks them.
6. **Publish plugin-base + plugin-todo to npm**: marketplace install button currently fails on these because pacote can't resolve them outside the workspace.
7. **Plugin storage upgrade**: SQLite or LevelDB instead of JSON files
8. **UI auth flow**: Production auth for non-dev users (login/OAuth)
9. **Multi-agent UI**: How to display parallel agent results
10. **Apple Developer codesign**: $99/yr account so users don't need the Gatekeeper bypass dance. Defer until we have non-internal users.

## Dev shortcuts

```bash
# Git
cd ~/workspace/sisyphus
git status
git log --oneline

# Start daemon
pnpm --filter @sisyphus/daemon dev

# Tauri desktop
pnpm tauri dev

# Check daemon health
curl http://localhost:8787/health

# Install a plugin via API
curl -X POST http://localhost:8787/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"@scope/plugin-name"}'

# Search plugins
curl http://localhost:8787/api/plugins/search?q=react
```

## Related docs

- `docs/plugin-spec.md` — Plugin authoring spec
- `docs/DEVNOTES.md` — This file
- `marketplace.json` — Curated plugin catalog
- Wiki: `concepts/sisyphus-plugin-architecture.md` — Full architecture doc
- Wiki: `entities/sisyphus.md` — Project entity with tech stack
- README.md — User-facing overview

## Context loss recovery

If this session is lost and you need to resume:

1. Read this file (`docs/DEVNOTES.md`)
2. Read `docs/plugin-spec.md` 
3. Run `git log --oneline -10` to see latest commits
4. Check wiki at `concepts/sisyphus-plugin-architecture.md`
5. Check `entities/sisyphus.md` for tech stack and startup instructions
