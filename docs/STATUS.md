# Sisyphus — project status

Living document. Updated 2026-05-23. Companion to wiki
`concepts/sisyphus-plugin-architecture.md` (architecture rationale) and
`entities/sisyphus.md` (current snapshot). Also see `docs/plugin-spec.md`
for the developer-facing plugin contract.

## What this is

**Sisyphus is an AI-native VSCode for plugin-driven workflows.**

- A host (`daemon` + `ui`) that's intentionally small. It has no
  business logic — no chat, no code-gen, no todo list. It only knows
  how to run agents, register skills/views/cards, and route messages.
- A plugin system where third-party developers ship their AI workflow
  as an npm package (`keywords: ["sisyphus-plugin"]`). Plugins
  contribute agents (LLM- or rule-driven), skills (tools agents can
  invoke), card renderers (rich chat outputs), and views (panels in
  the UI).
- The plugin developer's audience is non-technical end users who want
  the workflow that plugin encodes. Sisyphus is to "AI workflows" what
  VSCode is to "language tooling": platform + ecosystem, not the
  features themselves.

Target distribution: **Tauri desktop app** for end users (M22 phase 1
done, phase 2 sidecar pending), plus **Docker image** for self-hosted
web deploys (M21 done). No CLI — that lane is already well served by
Claude Code, Aider, etc.

## Architecture (one diagram)

```
┌─────────────────────── Sisyphus host (daemon + UI) ──────────────────────┐
│                                                                          │
│   kernel              daemon (Node, Hono :8787)                          │
│   ─ Types only        ─ PluginManager: install/enable/disable/activate   │
│   ─ UI registries     ─ Router: keyword + LLM disambiguation             │
│     (kernel/ui)       ─ ScopedRegistry: per-plugin namespace + ACL       │
│                       ─ HTTP /api/{chat, plugins, plugins/search,        │
│                                       plugins/marketplace,              │
│                                       config, workspace, registry/*}   │
│                       ─ WS /ws (custom 3-frame protocol)                │
│                       ─ optional UI static serve (SISYPHUS_UI_DIR)       │
│                       ─ dev mode fs.watch plugin bundles                 │
│                                                                          │
│   ui (Vite SPA)                                                          │
│   ─ Panel Layout shell (Activity Bar / Side / Main / Bottom)             │
│   ─ Boot: fetch /api/plugins → dynamic-import each ui.mjs                │
│   ─ importmap → host React (single instance across plugins)              │
└──────────────────────────────────────────────────────────────────────────┘
                  ▲                                  ▲
                  │ pacote install                   │ npm publish
                  │                                  │
┌─── ~/.sisyphus/ (per-user state) ────┐  ┌─── npm registry ──────────────┐
│  plugins-node_modules/<pkg>/         │  │  any package with             │
│  plugins.config.json                 │  │  keywords:["sisyphus-plugin"] │
│  plugins/<plugin-id>.json (KV)       │  │  is searchable                │
│  config.json (LLM endpoint + key)    │  └───────────────────────────────┘
└──────────────────────────────────────┘
```

## Packages

| Package | Role |
|---|---|
| `@sisyphus/kernel` | Type contracts + UI runtime registries (`kernel/ui`). Zero React runtime import. |
| `@sisyphus/daemon` | Hono server. Plugin lifecycle + router + storage + auth + dev watcher + UI static serve. |
| `@sisyphus/ui` | Vite SPA host. Layout shell + dynamic plugin loader. Zero business logic. |
| `@sisyphus/plugin-base` | Reference plugin: 3 agents (react-designer, time-helper, assistant), 1 skill (current-time), chat+canvas+settings views. Will be separately published. |
| `@sisyphus/plugin-todo` | Second reference plugin: rule-based agent + persistence + custom card payload. Compresses the extension surface. |
| `src-tauri/` (Rust) | Tauri shell. Spawns daemon, waits health, hosts the webview. |

## Milestone history

| | Commit | Contents |
|---|---|---|
| M0 | `f50f7b5` | pnpm monorepo skeleton + kernel type contracts |
| M0.5 | `da8d826` | Next.js → Vite SPA + Hono daemon |
| M1.1 | `33f5eb1` | Panel Layout + Registry HTTP |
| M1.2 | `297ae70` | WebSocket IPC (custom 3-frame protocol) |
| fix | `58b1431` | dotenv .env.local + reasoning_content forward |
| M2 | `891759d` | Multi-agent architecture + plugin-base split |
| M3 | `b72157d` | plugin-todo + multi-agent keyword router |
| M4 | `485508e` | Per-plugin file-backed storage + generic provider stack |
| M5 | `a750530` | tool_call / tool_result dispatch loop |
| M6 | `64138ef` | LLM tool calling loop (assistant agent) |
| M7 | `ba0520c` | Streaming assistant agent |
| M8 | `4a64dfa` | LLM router (hybrid keyword + LLM disambiguation) |
| M9 | `428cbce` | Dynamic plugin loading (daemon-side) |
| M10 | `4149b1b` | Namespace enforcement + dependency topology |
| M11 | `1a007c4` | API-key auth for /api/* and WS |
| M12 | `1ee11f4`+`e633b77` | Per-project + per-user config with precedence chain + UI settings view |
| M13 | `641ac22` | Per-plugin skill ACL (default-deny cross-plugin) |
| M14 | `4f969aa` | Agent fan-out infrastructure (priority + source + spawnAgent) |
| M16 backend | `f420491` | Daemon serves plugin UI bundles + plugin build pipeline |
| M16 UI | `5f17a3b` | UI runtime dynamic plugin loading + importmap |
| M17 | `e935e95` | Plugin developer mode (esbuild --watch + daemon fs watcher + UI reload) |
| M18 | `60091f8` | Decouple host from plugins; dev/prod share one dynamic load path |
| chore | `d7474be` | Refresh lockfile after M18 deps demote |
| M19 | `61b06f7` | Runtime plugin install/enable/disable/uninstall (no daemon restart) |
| M20+M21 | `095ea37` | Plugins management UI + daemon serves UI static (web deploy) |
| M23 | `72d747b` | Plugin discovery: npm search + curated marketplace + UI browse panel |
| M22 phase 1 | `a93ca55` | Tauri desktop shell (spawns daemon as child) |

(M15 matrix UI was deferred — needs interactive design with user.)

## What works today

- **Web deploy form**: `docker build -t sisyphus . && docker run -p 8787:8787 -v ~/.sisyphus:/root/.sisyphus sisyphus` → browser at `localhost:8787` works. Daemon serves UI + API + WS at one origin.
- **Tauri dev**: `pnpm tauri:dev` → Rust binary spawns daemon, polls `/health`, reloads webview when ready. Requires dev env (pnpm + tsx in PATH); phase-2 sidecar lifts that.
- **Plugin lifecycle without restart**: install (pacote tarball extract) → activate → register agents/views/cards → enable/disable toggle → uninstall → fully clean.
- **Plugin discovery**: Settings → Browse plugins → marketplace featured cards by default, debounced npm search results when user types.
- **Multi-agent router**: keyword fast-path for clear cases (~20ms), LLM router fallback for ties.
- **Tool calling**: agents emit `tool_call`/`tool_result` traces visible in chat; `ctx.invokeSkill` dispatches across ACL boundary.
- **LLM streaming + tool calling loop** in the assistant agent; reasoning + token chunks surface immediately.
- **Per-plugin file-backed storage**: state survives daemon restart; e.g., plugin-todo's task list reloads correctly.
- **Plugin developer mode**: change plugin source → esbuild --watch rebuilds → daemon notices → WS event → UI page reload.

## What's deferred or unfinished

| Item | M | Why deferred |
|---|---|---|
| **Matrix UI for fan-out** | M15 | Needs hands-on design session with user (chat → matrix is a UX redesign, not pure backend). Default `SISYPHUS_FANOUT_CAP=1` keeps current single-agent UI working. |
| **Tauri phase 2: sidecar binary** | M22.2 | Daemon needs to be bundled (esbuild → single .mjs, or pkg → static binary) and registered in `tauri.conf.json` as `bundle.externalBin`. Then `workspace_root()` switches to resource-path resolution. Phase 1 works in dev only. |
| **State-preserving plugin hot reload** | M17.x | Current dev mode does `location.reload()` — React state resets. True hot-replace needs subscribable kernel/ui registries + keyed `<ProviderStack>` remount. |
| **Recursive plugin dep install** | M19.x | `pacote.extract` only fetches the plugin tarball, not its npm deps. Plugins are expected to self-bundle (esbuild) or rely on host-provided packages. Use `@npmcli/arborist` when plugins start carrying heavy independent deps. |
| **UI auth flow (prod)** | M11.x | Daemon side (SISYPHUS_API_KEY) is done. Prod UI needs a way to surface/persist the key (login form, OAuth, or env var via Tauri). Dev mode (key unset) skips this. |
| **Plugin storage upgrade** | M19.x | File JSON is fine until plugins start storing MB of data; then swap to sqlite. |
| **Cross-plugin agent spawn ACL** | M14.x | `ctx.spawnAgent` currently lets a plugin spawn any registered agent. Should require manifest declaration similar to `requires.skills`. |
| **Plugin marketplace 2.0** | M23.x | Today: hand-edited `marketplace.json` in repo. Future: sisyphus.dev site with screenshots, reviews, install counts. |
| **Windows / Linux Tauri targets** | M22.3 | Only macOS bundle target enabled. Adding others is config + signing keys per platform. |

## Open decisions (not yet made)

1. When to publish `@sisyphus/plugin-base` and `@sisyphus/plugin-todo` to npm. Currently they only resolve through monorepo workspace symlinks. Until published, the marketplace `Install` button on those entries won't work end-to-end (pacote can't fetch them).
2. Tauri sidecar: bundle daemon as `esbuild --bundle --platform=node --target=node20` single .mjs + ship Node runtime, OR `pkg` / Node SEA to a static native binary. Tradeoff is image size vs build complexity.
3. macOS code signing for Tauri build: requires Apple Developer cert ($99/yr) or notarization workaround. Decision needed before shipping a `.dmg` end users can install without right-click → Open.

## Key files (where to look)

```
sisyphus/
├── docs/
│   ├── plugin-spec.md     ← contract for plugin authors
│   └── STATUS.md          ← this file
├── marketplace.json       ← curated plugin list (PR target)
├── Dockerfile             ← web-deploy image
├── src-tauri/             ← desktop shell (Rust)
│   ├── tauri.conf.json
│   ├── Cargo.toml
│   └── src/lib.rs         ← daemon spawn + window
└── packages/
    ├── kernel/src/
    │   ├── index.ts       ← all type contracts
    │   └── ui.ts          ← view/card/provider runtime registries
    ├── daemon/src/
    │   ├── index.ts       ← HTTP/WS server + endpoint definitions
    │   ├── plugin-loader.ts
    │   ├── plugin-manager.ts
    │   ├── plugin-installer.ts (pacote)
    │   ├── plugin-config.ts
    │   ├── plugin-search.ts (npm search + marketplace)
    │   ├── plugin-graph.ts (topo sort)
    │   ├── scoped-registry.ts (namespace + ACL)
    │   ├── router.ts      ← multi-agent selection + dispatch
    │   ├── registry.ts
    │   ├── storage.ts (per-plugin file KV)
    │   ├── config.ts (LLM endpoint precedence)
    │   ├── auth.ts (SISYPHUS_API_KEY)
    │   ├── dev-watcher.ts (SISYPHUS_DEV=1)
    │   ├── ws.ts
    │   └── event-bus.ts
    ├── ui/src/
    │   ├── main.tsx       ← boot: loadAllPluginUI then render
    │   ├── App.tsx        ← <ProviderStack><PanelLayout/></ProviderStack>
    │   ├── plugin-loader.ts
    │   ├── layout/
    │   │   ├── PanelLayout.tsx
    │   │   ├── ActivityBar.tsx
    │   │   ├── SidePane.tsx
    │   │   ├── MainPane.tsx
    │   │   ├── ProviderStack.tsx
    │   │   └── index.ts
    │   └── services/ws-client.ts
    ├── plugin-base/src/
    │   ├── index.ts       ← daemon entry (agents + skill handlers)
    │   ├── agents/{react-designer,time-helper,assistant}.ts
    │   ├── skills/current-time.ts
    │   └── ui/            ← browser entry, exports views/cards/providers
    └── plugin-todo/src/
        ├── index.ts
        ├── store.ts       ← in-memory + persistence
        ├── agents/todo-manager.ts
        └── ui/
```

## Dev workflows

### Day-to-day (host work, no plugin edits)

```bash
pnpm install
# Build plugin bundles once so daemon has dist/ui.mjs to serve:
pnpm -r --filter './packages/plugin-*' build:ui
# Then two terminals:
pnpm --filter @sisyphus/daemon dev          # :8787
pnpm --filter @sisyphus/ui dev              # :3000 (Vite proxy to daemon)
```

Open `http://localhost:3000`.

### Plugin author iteration

```bash
# Terminal 1: plugin watcher (esbuild --watch dist/ui.mjs)
pnpm --filter @sisyphus/plugin-todo dev

# Terminal 2: daemon in dev mode (fs.watch + WS push on bundle change)
SISYPHUS_DEV=1 pnpm --filter @sisyphus/daemon dev

# Terminal 3: UI (Vite dev)
pnpm --filter @sisyphus/ui dev
```

Edit plugin source → esbuild rebuilds → daemon broadcasts `plugin.ui.bundle.changed` → UI does `location.reload()`.

### Tauri (M22 phase 1, requires dev env)

```bash
pnpm install
pnpm -r --filter './packages/plugin-*' build:ui
pnpm --filter @sisyphus/ui build       # produces packages/ui/dist
pnpm tauri:dev                          # rust toolchain required
```

Rust binary spawns daemon as a child, polls `/health`, opens window on `http://localhost:8787`.

### Docker (web deploy)

```bash
docker build -t sisyphus .
docker run -p 8787:8787 \
  -v ~/.sisyphus:/root/.sisyphus \
  -e OPENAI_API_KEY=... \
  -e OPENAI_BASE_URL=https://api.openai.com/v1 \
  -e OPENAI_MODEL=gpt-4o \
  sisyphus
```

Browse `http://localhost:8787`.

## Config surfaces

| Env var | Purpose |
|---|---|
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` | LLM endpoint. Also overridable in UI Settings + persisted to `~/.sisyphus/config.json`. |
| `SISYPHUS_ROUTER_MODEL` | Override the model used for the LLM router (separate from agent calls). Defaults to `OPENAI_MODEL`. |
| `SISYPHUS_API_KEY` | If set, all `/api/*` requests need `Authorization: Bearer <key>`; WS upgrade needs same header or `?token=<key>`. Unset = dev mode, fully open + warning logged. |
| `SISYPHUS_DAEMON_PORT` | Daemon listen port (default 8787). |
| `SISYPHUS_UI_DIR` | If set + contains `index.html`, daemon also serves UI static at the root (web deploy + Tauri prod path). |
| `SISYPHUS_FANOUT_CAP` | Max concurrent agents for fan-out (1..8). Default 1 keeps current single-agent UI behavior. |
| `SISYPHUS_MARKETPLACE_URL` | Override the marketplace JSON URL (default = github raw of this repo's `marketplace.json`). |
| `SISYPHUS_DEV=1` | Enable plugin dev watcher (fs.watch dist/ui.mjs + WS broadcast). |

| File | Purpose |
|---|---|
| `~/.sisyphus/config.json` | User-scope LLM config + auth key. Layered under env vars. |
| `<workspace>/.sisyphus/config.json` | Project-scope override (when UI sets a workspace path). |
| `~/.sisyphus/plugins.config.json` | `{ installed: [pkg…], enabled: [pkg…] }`. Auto-migrates the legacy `{ enabled: [...] }` shape. |
| `~/.sisyphus/plugins-node_modules/<scope>/<name>/` | pacote-extracted plugin packages. |
| `~/.sisyphus/plugins/<plugin-id>.json` | Per-plugin KV storage (file-backed, JSON). |

## Next steps (suggested order)

1. **M22.2 Tauri sidecar** — bundle daemon (esbuild single .mjs), register `externalBin` in `tauri.conf.json`, swap `workspace_root()` for resource-path resolution. Outcome: `cargo tauri build` → `.dmg` that runs on any user mac without pnpm/tsx.
2. **M15 matrix UI** — interactive design session needed. Goal: chat → per-turn page with multiple agent cells when router fan-outs.
3. **Publish plugin-base + plugin-todo to npm** — closes the loop on marketplace `Install` actually working end-to-end.
4. **macOS code signing** decision for Tauri distribution.
5. **Windows / Linux Tauri targets** + CI matrix.

## Convenient one-liners

```bash
# Reset all local state (config, plugins, storage)
rm -rf ~/.sisyphus

# Force plugin bundle rebuild
pnpm -r --filter './packages/plugin-*' build:ui

# Quick chat smoke test (assumes daemon at :8787, no SISYPHUS_API_KEY)
curl -sN -X POST http://localhost:8787/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"add buy milk"}]}'
```
