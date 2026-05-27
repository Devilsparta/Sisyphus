# @sisyphus/kernel

Shared plugin contracts for the [Sisyphus](https://github.com/Devilsparta/Sisyphus) AI-native VSCode platform. Every Sisyphus plugin imports types from here; that's the whole point of the package.

## Install

```bash
npm install --save-dev @sisyphus/kernel
```

Most of what you'll use are `import type` declarations — the package emits a tiny amount of runtime code only for the UI registries (`@sisyphus/kernel/ui`), and `KernelEvents` constants.

## Authoring a plugin

```typescript
import type {
  SisyphusPlugin,
  AgentImpl,
  SkillDescriptor,
  SkillHandler,
} from '@sisyphus/kernel';

const myAgent: AgentImpl = {
  descriptor: {
    id: 'my-plugin.agent.hello',
    displayName: 'Hello',
    description: 'A friendly greeter',
    spawnHint: 'when the user says hi',
    triggerKeywords: ['hi', 'hello'],
  },
  async run(userMessage, ctx) {
    ctx.emit({ type: 'token', text: `Hi! You said: ${userMessage}` });
    ctx.emit({ type: 'done', reason: 'stop' });
  },
};

const plugin: SisyphusPlugin = {
  manifest: {
    id: 'my-plugin',
    displayName: 'My Plugin',
    version: '0.1.0',
    contributes: { agents: [myAgent.descriptor] },
  },
  agents: [myAgent],
};

export default plugin;
```

Compile to ESM with esbuild or tsc; ship `dist/index.mjs` as your daemon entry. The Sisyphus daemon SEA binary has no TypeScript loader, so prod plugins must be pre-compiled JS.

`package.json` must include `"keywords": ["sisyphus-plugin"]` to show up in npm registry search, plus a `sisyphus` block:

```json
{
  "keywords": ["sisyphus-plugin"],
  "sisyphus": {
    "id": "my-plugin",
    "version": "0.1.0",
    "contributes": {
      "agents": ["my-plugin.agent.hello"]
    }
  }
}
```

## What's exported

- **`@sisyphus/kernel`** — all types: `SisyphusPlugin`, `PluginManifest`, `AgentImpl`, `AgentDescriptor`, `AgentRunContext`, `AgentEvent`, `SkillDescriptor`, `SkillHandler`, `ViewDescriptor`, `CardDescriptor`, `CardInstance`, `PluginContext`, `PluginStorage`, `RegistryAPI`, `Disposable`, `ChatMessage`, plus `KernelEvents` constants and `IPCMessage` envelopes.
- **`@sisyphus/kernel/ui`** — browser-only runtime helpers your plugin's `./ui` entry uses to register views, card renderers, and React context providers: `registerView` / `registerCardRenderer` / `registerProvider` (and their list / get / dispose siblings).

## Plugin RPC protocol

If you're curious how plugins talk to the daemon — they don't share the daemon's process. Each activated plugin runs as its own child process and talks JSON-RPC over stdio. Full protocol: see `docs/plugin-rpc.md` in the [main repo](https://github.com/Devilsparta/Sisyphus/blob/main/docs/plugin-rpc.md).

You don't have to think about the wire format though — the daemon does the marshalling and hands your code the same `ctx` it always had.

## License

MIT
