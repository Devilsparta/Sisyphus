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

**Today (2026-05-25):**
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

1. **M24 Plugin process isolation**: Plugins currently dynamic-import into the daemon process. To open the door to a public marketplace, spawn each plugin as a `child_process.fork` and route the existing `ctx.invokeSkill` API through stdio JSON-RPC (MCP-flavor). Plugin authors get crash isolation + free language choice; we get a real security boundary.
2. **Apple Developer codesign**: $99/yr account so users don't need the Gatekeeper bypass dance. Defer until we have non-internal users.
3. **arm64 build**: `lipo` step is host-only; cross-compiling SEA needs a clean arm64 node binary. Add CI runners.
4. **Publish plugin-base + plugin-todo to npm**: marketplace install button currently fails on these because pacote can't resolve them outside the workspace.
5. **Plugin storage upgrade**: SQLite or LevelDB instead of JSON files
6. **UI auth flow**: Production auth for non-dev users (login/OAuth)
7. **Multi-agent UI**: How to display parallel agent results
8. **More plugins**: Build actually useful plugins beyond the reference ones

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
