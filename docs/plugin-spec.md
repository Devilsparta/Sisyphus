# Sisyphus plugin spec

A Sisyphus plugin is a regular npm package with a couple of conventions
that let the daemon discover, install, and load it at runtime.

## package.json

```json
{
  "name": "@example/sisyphus-plugin-foo",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["sisyphus-plugin"],
  "main": "./dist/index.mjs",
  "exports": {
    ".": "./dist/index.mjs",
    "./ui": "./dist/ui.mjs",
    "./package.json": "./package.json"
  },
  "sisyphus": {
    "id": "example-foo",
    "displayName": "Foo",
    "version": "0.1.0",
    "uiEntry": "./dist/ui.mjs",
    "dependencies": [],
    "requires": {
      "skills": []
    },
    "contributes": {
      "agents": [],
      "views": [],
      "cards": [],
      "skills": []
    }
  }
}
```

### Required fields

- `keywords` MUST include `"sisyphus-plugin"`. The daemon's npm-search
  endpoint filters by this keyword; nothing else is reliably discoverable.
- `exports["./package.json"]` MUST be `"./package.json"`. Node's strict
  exports gate otherwise blocks the daemon's `require.resolve(...)`
  fallback when resolving installed plugins.
- `sisyphus.id` MUST be a globally unique, namespace-prefixed string
  (e.g. `"example-foo"`). All ids the plugin registers (agents, skills,
  views, cards) MUST start with `${sisyphus.id}.` — the daemon's
  ScopedRegistry rejects anything else.
- `sisyphus.version` MUST match `package.json.version`.

### Optional fields

- `sisyphus.uiEntry` (default `"./dist/ui.mjs"`) — path the daemon
  serves at `/api/plugins/<id>/ui.mjs` so the host UI can dynamically
  import it. Omit (or set to `""`) for daemon-only plugins.
- `sisyphus.dependencies: string[]` — other plugin ids this one needs
  activated first. Topo-sorted at boot.
- `sisyphus.requires.skills: string[]` — fully-qualified skill ids
  this plugin's agents will invoke. Cross-plugin skill calls without
  a corresponding entry are denied by ACL.
- `sisyphus.contributes` — declarative manifest of what the plugin
  registers. Mostly for the UI to display before activation.

## Build targets

Two artifacts shipped in the tarball:

- `dist/index.mjs` — daemon entry. ESM, default export of
  `SisyphusPlugin`. Bundle your daemon dependencies (with esbuild's
  `--bundle`), except for the host-provided packages:
    `@sisylabs/kernel`, `openai`, `hono`, `ws`
  (the daemon's own dep closure — the plugin can `import` them
  without bundling).
- `dist/ui.mjs` — browser entry. ESM, exports
  `{ views, cardRenderers, providers }`. Bundle with esbuild; mark
  `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`,
  `@sisylabs/kernel`, `@sisylabs/kernel/ui` as `external`. The host
  resolves React via importmap so plugin + host share one instance.

A reference build script lives at
`packages/plugin-base/build-ui.mjs` in the Sisyphus repo.

## Daemon entry

```typescript
import type { SisyphusPlugin } from '@sisylabs/kernel';

const plugin: SisyphusPlugin = {
  manifest: { /* matches package.json sisyphus block */ },
  async onActivate(ctx) {
    // ctx.registry, ctx.storage, ctx.log
  },
  agents: [/* AgentImpl[] */],
  skillHandlers: { /* by skill id */ },
};

export default plugin;
```

Every `AgentImpl` MUST `ctx.emit({ type: 'done', reason })` before
returning, otherwise the router synthesizes an error.

## UI entry

```typescript
import type { ComponentType, ReactNode } from 'react';

export const views = [
  { descriptor: { id: 'example-foo.view.x', region: 'side', title: 'X' }, Component: XView },
];
export const cardRenderers = [
  { descriptor: { type: 'example-foo.card.y' }, Component: YCard },
];
export const providers: ComponentType<{ children: ReactNode }>[] = [
  // optional context providers
];
```

## Storage

`ctx.storage` is a per-plugin KV with `get`/`set`/`delete`/`clear`/`keys`.
Values must be JSON-serializable. Files live at
`~/.sisyphus/plugins/<plugin-id>.json`. Safe across daemon restarts;
treat as your plugin's source of truth.

## Lifecycle

1. User installs from Sisyphus Settings → Plugins → Browse, or via
   `POST /api/plugins/install { packageName }`.
2. Daemon `pacote.extract`s the tarball into
   `~/.sisyphus/plugins-node_modules/<scope>/<name>/`.
3. Config records the install; the plugin is auto-enabled and
   activated immediately (no daemon restart).
4. `onActivate(ctx)` runs; declared `agents` + `skillHandlers` are
   registered through a ScopedRegistry that enforces the namespace prefix.
5. UI fetches `/api/plugins`, sees the new entry, dynamic-imports
   `/api/plugins/<id>/ui.mjs`, registers `views`/`cardRenderers`/`providers`.
6. User can later Disable (deactivate + keep installed) / Enable /
   Remove (uninstall + delete files).

## Publishing

```bash
npm publish --access public
```

After publishing, the package is searchable through
`GET /api/plugins/search?q=<keyword>` (which calls
`registry.npmjs.org/-/v1/search?text=keywords:sisyphus-plugin+<q>`).

To get listed in the curated marketplace, open a PR adding your entry
to `marketplace.json` at the repo root.
