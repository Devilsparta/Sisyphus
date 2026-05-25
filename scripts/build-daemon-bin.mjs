#!/usr/bin/env node
// Build sisyphus-daemon as a Node Single-Executable-Application (SEA).
//
// Pipeline:
//   1. esbuild bundle packages/daemon/src/index.ts → daemon.mjs (ESM, all deps inlined)
//   2. node --experimental-sea-config → sea-prep.blob
//   3. Copy the host's node binary → src-tauri/binaries/sisyphus-daemon-<triple>
//   4. (macOS) codesign --remove-signature so postject can mutate the macho
//   5. postject inject the blob into the binary
//   6. (macOS) codesign --sign - (ad-hoc) so launchd/Gatekeeper will execute it
//
// We chose SEA over `bun --compile` for npm-ecosystem compatibility — third-
// party plugins may pull native addons and Node-only APIs that Bun doesn't
// match. Cost: a chunkier build pipeline. See docs/DEVNOTES.md (M22.2).

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const entry = resolve(repoRoot, "packages/daemon/src/index.ts");
const buildDir = resolve(repoRoot, "packages/daemon/dist-bin");
const bundleFile = resolve(buildDir, "daemon.cjs");
const seaConfigPath = resolve(buildDir, "sea-config.json");
const seaBlobPath = resolve(buildDir, "sea-prep.blob");
const outDir = resolve(repoRoot, "src-tauri/binaries");

function resolveRustc() {
  const candidates = [
    process.env.RUSTC,
    "rustc",
    `${os.homedir()}/.cargo/bin/rustc`,
  ].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { stdio: "ignore" });
    if (r.status === 0) return c;
  }
  throw new Error("rustc not found (tried $RUSTC, $PATH, ~/.cargo/bin/rustc)");
}

function hostTriple(rustc) {
  const out = execFileSync(rustc, ["-vV"], { encoding: "utf8" });
  const m = out.match(/^host:\s*(\S+)/m);
  if (!m) throw new Error(`could not parse 'host:' from rustc -vV:\n${out}`);
  return m[1];
}

function run(label, cmd, args, opts = {}) {
  console.log(`[build-daemon-bin] ${label}: ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: repoRoot, ...opts });
  if (r.status !== 0) {
    throw new Error(`${label} failed (exit ${r.status})`);
  }
}

const rustc = resolveRustc();
const triple = hostTriple(rustc);
const isMacOS = process.platform === "darwin";
const isWindows = process.platform === "win32";
const binName = isWindows
  ? `sisyphus-daemon-${triple}.exe`
  : `sisyphus-daemon-${triple}`;
const outfile = resolve(outDir, binName);

console.log(`[build-daemon-bin] node=${process.execPath} (${process.version})`);
console.log(`[build-daemon-bin] triple=${triple}`);
console.log(`[build-daemon-bin] outfile=${outfile}`);

// 1. esbuild bundle daemon source into a single ESM file with all deps inlined.
//    node: built-ins are external by virtue of --platform=node. fsevents is a
//    macOS-only optional chokidar dep that fails to bundle and is fine to skip.
mkdirSync(buildDir, { recursive: true });
const esbuildBin = resolve(repoRoot, "node_modules/.bin/esbuild");
run("esbuild bundle", esbuildBin, [
  entry,
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--target=node22",
  `--outfile=${bundleFile}`,
  "--external:fsevents",
  // node-gyp is only required by pacote when installing packages with
  // unprebuilt native deps. Sisyphus plugins ship prebuilt or pure JS, so
  // skip the bundle (suppresses an esbuild "require.resolve" warning).
  "--external:node-gyp",
  "--legal-comments=none",
]);

// 2. Generate the SEA blob from the bundled ESM entry.
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundleFile,
      output: seaBlobPath,
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
);
run("SEA blob", process.execPath, [
  "--experimental-sea-config",
  seaConfigPath,
]);

// 3. Copy the host node binary to the sidecar path Tauri expects. On macOS
//    nodejs.org ships a universal binary; postject can't inject into a fat
//    macho because the SEA sentinel appears in every slice. Thin it down to
//    the host arch first.
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
try {
  rmSync(outfile);
} catch {
  // not present, fine
}
if (isMacOS) {
  const archForLipo = triple.startsWith("aarch64") ? "arm64" : "x86_64";
  const fileOut = execFileSync("file", [process.execPath], { encoding: "utf8" });
  if (fileOut.includes("universal binary")) {
    run("lipo thin", "lipo", [
      process.execPath,
      "-thin",
      archForLipo,
      "-output",
      outfile,
    ]);
  } else {
    copyFileSync(process.execPath, outfile);
  }
} else {
  copyFileSync(process.execPath, outfile);
}
chmodSync(outfile, 0o755);

// 4. macOS only: strip existing signature so postject can mutate the macho.
if (isMacOS) {
  run("codesign remove", "codesign", ["--remove-signature", outfile]);
}

// 5. Inject the SEA blob into the node binary via postject.
const postjectBin = resolve(repoRoot, "node_modules/.bin/postject");
const postjectArgs = [
  outfile,
  "NODE_SEA_BLOB",
  seaBlobPath,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
if (isMacOS) {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
run("postject inject", postjectBin, postjectArgs);

// 6. macOS only: ad-hoc re-sign so launchd / Gatekeeper will *execute* the
//    mutated binary. This is not Developer ID signing — chrome users still
//    need to right-click → Open the first time they run the .app.
if (isMacOS) {
  run("codesign ad-hoc", "codesign", ["--sign", "-", outfile]);
}

console.log(`[build-daemon-bin] ok → ${outfile}`);
