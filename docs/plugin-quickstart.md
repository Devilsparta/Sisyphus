# Sisyphus Plugin Author Quickstart

Five minutes from zero to a plugin you can install in any Sisyphus instance.

## 1. Scaffold

```bash
npm create @sisylabs/plugin@latest my-plugin
cd my-plugin
```

The scaffolder asks for a few fields (npm scope, display name, description) and writes a working skeleton:

```
my-plugin/
├── package.json            # @sisylabs/kernel peer + sisyphus manifest block
├── src/index.ts            # one hello agent + one echo skill
├── build.mjs               # esbuild bundle → dist/index.mjs
├── tsconfig.json
├── .gitignore
└── README.md
```

Pass `--yes` to skip the prompts and accept all defaults — handy for experimentation.

## 2. Install + build

```bash
pnpm install              # or npm install
pnpm build                # dist/index.mjs is what the daemon loads
pnpm typecheck            # optional sanity check
```

That's it — the plugin is now ready. Edit `src/index.ts` to add your own agents and skills; rebuild any time.

## 3. The plugin shape

Every Sisyphus plugin exports a default `SisyphusPlugin` from its main entry:

```typescript
import type { SisyphusPlugin } from '@sisylabs/kernel';

const plugin: SisyphusPlugin = {
  manifest: {
    id: 'my-plugin',
    version: '0.1.0',
    contributes: {
      agents: [myAgent.descriptor],
      skills: [mySkill],
      views: [],
      cards: [],
    },
  },
  agents: [myAgent],
  skillHandlers: { [mySkill.id]: myHandler },
  async onActivate(ctx) {
    // optional: hydrate state from ctx.storage, register late, etc.
  },
};

export default plugin;
```

**Agents** are functions of `(userMessage, ctx) => Promise<void>`. They `ctx.emit()` events as they work — `token`, `reasoning`, `tool_call`, `tool_result`, `card`, `done`. The host streams them to the UI verbatim.

**Skills** are pure async functions registered by id. Other agents (yours or, with M13 ACL declaration, other plugins') can invoke them via `ctx.invokeSkill`.

Full type contract: [`@sisylabs/kernel`](https://www.npmjs.com/package/@sisylabs/kernel). Wire protocol: [`docs/plugin-rpc.md`](./plugin-rpc.md).

## 4. Publish

```bash
# Set a real scope in package.json (replace @your-scope/...)
# Then:
npm login
npm publish
```

The scaffold adds `"keywords": ["sisyphus-plugin"]` automatically. That keyword is what Sisyphus's marketplace search reads — any user who searches "my-plugin" or browses featured plugins in Settings will find your package on the npm registry within minutes of publishing.

## 5. Install in Sisyphus

Open any Sisyphus installation → **Settings → Plugins → Browse**. Search for your plugin's name (or the slug), click **Install**. The daemon downloads via pacote, spawns it as a child process (M24 isolation), registers your agents and skills into the live registry, and your plugin starts answering chat messages.

No daemon restart, no manual install path — `~/.sisyphus/plugins-node_modules/` is the install target and Sisyphus manages it for you.

## What you get for free

Once you ship a plugin, the platform handles:

- **Process isolation**: each plugin runs in its own child process. If your plugin crashes, the daemon flags it (UI shows a "crashed" badge with a Reactivate button); other plugins keep running. M24.6.
- **Crash recovery**: a single click puts your plugin back into a fresh process with no daemon restart.
- **Hot reload during dev**: set `SISYPHUS_DEV=1` and your plugin's daemon entry is fs-watched — `pnpm build` re-emits `dist/index.mjs`, the daemon respawns the child, the UI WebSocket stays connected. M24.5.
- **Skill ACL**: by default your agents can only invoke skills under your own namespace. Cross-plugin invocation requires declaring `requires.skills` in `package.json`. M13.
- **Fan-out**: `ctx.spawnAgent('other-plugin.agent.x', msg)` runs another plugin's agent inline, its events stream back into your run tagged with `source = 'other-plugin.agent.x'`. M24.7.
- **Per-plugin storage**: `ctx.storage.get/set/delete/keys` — file-backed key-value, sandboxed by plugin id, survives restarts. M4.
- **Per-plugin config**: read user/project config layered values via `ctx.config` (the host strips masked secrets unless you declare you need them).

## Examples

The Sisyphus repo ships two reference plugins you can study:

- [`@sisylabs/plugin-base`](https://www.npmjs.com/package/@sisylabs/plugin-base) — LLM-driven `react-designer` and `assistant` agents, a rule-based `time-helper`, a `current-time` skill, plus React UI views (chat, canvas, settings).
- [`@sisylabs/plugin-todo`](https://www.npmjs.com/package/@sisylabs/plugin-todo) — rule-based todo manager, custom card type, side-pane view, persistent storage.

Both packages publish their source alongside `dist/`, so once installed you can read the TypeScript directly to see how a real plugin is built.

## Questions

- **My plugin needs a native addon.** Fine — the daemon SEA binary embeds a full Node runtime, native addons (`better-sqlite3`, `sharp`, etc.) work as expected. Just list them in `dependencies` so `npm publish` ships them.
- **My plugin has a UI panel.** Add a `./ui` export to your `package.json` and a `build:ui` step that emits `dist/ui.mjs`. The daemon will serve it at `/api/plugins/<your-id>/ui.mjs`; the host UI dynamic-imports it at runtime. See `@sisylabs/plugin-todo` for the smallest example.
- **My plugin shouldn't fan-out / spawn / call other plugins.** Don't — most plugins are a single agent and call no host APIs beyond `ctx.emit`. The starter is intentionally trivial.

## Where to ask

- Issues / discussions: https://github.com/Devilsparta/Sisyphus
- Plugin RPC protocol questions: [`docs/plugin-rpc.md`](./plugin-rpc.md)
- Wire-level integration / advanced: [`concepts/sisyphus-plugin-architecture.md`](https://github.com/Devilsparta/Sisyphus/blob/main/concepts/sisyphus-plugin-architecture.md) in the wiki
