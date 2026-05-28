# @sisylabs/create-plugin

Scaffolder for [Sisyphus](https://github.com/Devilsparta/Sisyphus) plugins. Run it once, get a publish-ready plugin skeleton.

## Usage

```bash
# npm
npm create @sisylabs/plugin@latest my-plugin

# pnpm
pnpm create @sisylabs/plugin my-plugin

# yarn
yarn create @sisylabs/plugin my-plugin
```

You'll be prompted for the npm package name, display name, and description (each has sane defaults — hit enter to accept). The scaffolder writes a working starter into `./my-plugin/`:

```
my-plugin/
├── package.json      # @sisylabs/kernel peer dep + sisyphus manifest block
├── src/
│   └── index.ts      # one hello agent + one echo skill
├── build.mjs         # esbuild bundle → dist/index.mjs
├── tsconfig.json
├── .gitignore
└── README.md
```

Then:

```bash
cd my-plugin
pnpm install
pnpm build              # dist/index.mjs ready for publish
npm publish             # once you've replaced @your-scope/ with a real scope
```

After `npm publish`, Sisyphus's in-app marketplace search (M23) finds your package via the `keywords: ["sisyphus-plugin"]` flag the scaffolder set, and any user can install it in one click.

## Non-interactive mode

Pass `--yes` (or `-y`) to skip all prompts:

```bash
npm create @sisylabs/plugin@latest my-plugin -- --yes
```

This generates with default values for everything (`@your-scope/<slug>`, derived display name, etc.) — useful for CI and quick experimentation.

## What the starter contains

- **One agent** (`<id>.agent.hello`): streams a greeting in two tokens then `done`.
- **One skill** (`<id>.skill.echo`): echoes back its `message` arg.
- **`onActivate`** hook example using `ctx.log`.

It's enough to make sure the wiring works on the Sisyphus daemon. Replace it with your own agents / skills / views / cards. The full type contract is in [`@sisylabs/kernel`](https://www.npmjs.com/package/@sisylabs/kernel); the host RPC protocol is in [`docs/plugin-rpc.md`](https://github.com/Devilsparta/Sisyphus/blob/main/docs/plugin-rpc.md).

## License

MIT
