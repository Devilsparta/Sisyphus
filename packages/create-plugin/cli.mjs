#!/usr/bin/env node
/**
 * @sisylabs/create-plugin
 *
 * Scaffolds a Sisyphus plugin in one command:
 *   npm create @sisylabs/plugin@latest my-plugin
 *   pnpm create @sisylabs/plugin my-plugin
 *   yarn create @sisylabs/plugin my-plugin
 *
 * Writes a working starter into `./<target>/`:
 *   - package.json with sisyphus-plugin keyword + manifest block
 *   - src/index.ts with one trivial agent + one trivial skill
 *   - build.mjs (esbuild) and tsconfig.json
 *   - .gitignore + README.md
 *
 * The result is publish-ready: `pnpm install && pnpm build && npm publish`
 * gets the plugin onto npm where any Sisyphus installation can find it via
 * the marketplace search (M23, keywords:sisyphus-plugin).
 */
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templateDir = resolve(__dirname, 'template');

function isValidName(name) {
  // npm package name + manifest id constraints intersected
  return /^[a-z][a-z0-9-]*$/.test(name) && name.length <= 60;
}

function toDisplayName(slug) {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function prompt(rl, question, fallback) {
  const ans = (await rl.question(`${question}${fallback ? ` (${fallback})` : ''}: `)).trim();
  return ans || fallback || '';
}

async function copyTree(src, dst, replacements) {
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const srcPath = join(src, e.name);
    // template uses .tpl suffix for files we want renamed (esp. dotfiles
    // npm strips during publish — `.gitignore` would otherwise vanish).
    const targetName = e.name.replace(/\.tpl$/, '').replace(/^_/, '.');
    const dstPath = join(dst, targetName);
    if (e.isDirectory()) {
      await mkdir(dstPath, { recursive: true });
      await copyTree(srcPath, dstPath, replacements);
    } else {
      let content = await readFile(srcPath, 'utf-8');
      for (const [k, v] of Object.entries(replacements)) {
        content = content.replaceAll(`{{${k}}}`, v);
      }
      await writeFile(dstPath, content);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let target = argv[0];
  const interactive = !argv.includes('--yes') && !argv.includes('-y');

  const rl = readline.createInterface({ input, output });

  console.log('');
  console.log('  Sisyphus plugin scaffolder');
  console.log('  https://github.com/Devilsparta/Sisyphus');
  console.log('');

  // 1. Target directory + slug.
  while (!target) {
    target = (await rl.question('Plugin slug (kebab-case, e.g. my-plugin): ')).trim();
  }
  if (!isValidName(target)) {
    console.error(
      `error: invalid slug "${target}". Use lowercase letters, digits and dashes; must start with a letter.`,
    );
    process.exit(1);
  }
  const outDir = resolve(process.cwd(), target);
  if (existsSync(outDir)) {
    const st = await stat(outDir);
    if (st.isDirectory()) {
      const overwrite = interactive
        ? (await rl.question(`"${target}" already exists. Overwrite? (y/N): `)).trim().toLowerCase()
        : 'n';
      if (overwrite !== 'y' && overwrite !== 'yes') {
        console.error('aborted.');
        process.exit(1);
      }
    } else {
      console.error(`error: "${target}" exists and is not a directory.`);
      process.exit(1);
    }
  }

  // 2. Package fields (defaults filled in non-interactive mode).
  const pluginId = target;
  const defaultPkgName = `@your-scope/${target}`;
  const pkgName = interactive
    ? await prompt(rl, 'npm package name', defaultPkgName)
    : defaultPkgName;
  const displayName = interactive
    ? await prompt(rl, 'Display name', toDisplayName(target))
    : toDisplayName(target);
  const description = interactive
    ? await prompt(rl, 'Description', `Sisyphus plugin: ${displayName}`)
    : `Sisyphus plugin: ${displayName}`;
  const author = interactive
    ? await prompt(rl, 'Author', '')
    : '';

  await rl.close();

  const replacements = {
    pluginId,
    pkgName,
    pkgNameJson: JSON.stringify(pkgName),
    displayName,
    description,
    author,
    authorJsonLine: author ? `  "author": ${JSON.stringify(author)},\n` : '',
  };

  // 3. Materialise the template tree.
  await mkdir(outDir, { recursive: true });
  await copyTree(templateDir, outDir, replacements);

  console.log('');
  console.log(`  ✓ scaffolded ${pkgName} into ${outDir}`);
  console.log('');
  console.log('  Next:');
  console.log(`    cd ${target}`);
  console.log('    pnpm install   # or npm install / yarn');
  console.log('    pnpm build     # emits dist/index.mjs');
  console.log('    npm publish    # once you\'ve set a real scope');
  console.log('');
  console.log('  Edit src/index.ts to add your agents + skills.');
  console.log('  See https://github.com/Devilsparta/Sisyphus#readme for the full plugin spec.');
  console.log('');
}

main().catch((err) => {
  console.error('error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
