# {{displayName}}

{{description}}

A [Sisyphus](https://github.com/Devilsparta/Sisyphus) plugin. Scaffolded with `npm create @sisylabs/plugin`.

## Develop

```bash
pnpm install   # or npm install / yarn

# Edit src/index.ts — add agents, skills, storage. Type contracts:
# https://www.npmjs.com/package/@sisylabs/kernel

pnpm build     # emits dist/index.mjs
pnpm typecheck
```

## Publish

```bash
# 1. set a real npm scope in package.json (replace @your-scope/...)
# 2. npm login
# 3. publish
npm publish
```

Once published with `keywords: ["sisyphus-plugin"]`, any Sisyphus installation will discover it in its in-app marketplace search.

## Plugin shape

```typescript
import type { SisyphusPlugin } from '@sisylabs/kernel';

const plugin: SisyphusPlugin = {
  manifest: { id, displayName, version, contributes: { agents, skills, views, cards } },
  agents,           // AgentImpl[]
  skillHandlers,    // Record<skillId, SkillHandler>
  onActivate(ctx),  // optional
  onDeactivate(ctx),// optional
};

export default plugin;
```

Each agent's `run(userMessage, ctx)` emits `AgentEvent`s (`token` / `reasoning` / `tool_call` / `tool_result` / `card` / `done`). The host streams them to the UI verbatim.

Each skill handler is a plain `async (args, ctx) => result`. The host's M13 ACL means by default your agents can only invoke your own skills; cross-plugin invocation needs `manifest.requires.skills` declarations.

## How does the daemon run my plugin?

Sisyphus daemon spawns each activated plugin as its own child process and talks JSON-RPC over stdio (M24). Your code stays single-process; the daemon handles isolation, lifecycle, crash recovery, fan-out routing. Full protocol: [`docs/plugin-rpc.md`](https://github.com/Devilsparta/Sisyphus/blob/main/docs/plugin-rpc.md).

## License

MIT
