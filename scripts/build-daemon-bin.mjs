#!/usr/bin/env node
// Compile packages/daemon to a single-file binary via `bun build --compile`
// and place it at src-tauri/binaries/sisyphus-daemon-<rust-target-triple>
// so Tauri can pick it up as an externalBin sidecar.
//
// Tauri's sidecar convention requires the file to be suffixed with the
// host's rust target triple. We resolve the triple via `rustc -vV` and
// translate it into bun's --target flag.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const entry = resolve(repoRoot, "packages/daemon/src/index.ts");
const outDir = resolve(repoRoot, "src-tauri/binaries");

function resolveBun() {
  const candidates = [
    process.env.BUN_BIN,
    "bun",
    `${os.homedir()}/.bun/bin/bun`,
  ].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { stdio: "ignore" });
    if (r.status === 0) return c;
  }
  throw new Error("bun not found (tried $BUN_BIN, $PATH, ~/.bun/bin/bun)");
}

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

// Map rust target triple → bun --target value. Bun only supports a few
// concrete targets; we cover what we ship today.
function bunTargetFor(triple) {
  switch (triple) {
    case "x86_64-apple-darwin":
      return "bun-darwin-x64";
    case "aarch64-apple-darwin":
      return "bun-darwin-arm64";
    case "x86_64-unknown-linux-gnu":
      return "bun-linux-x64";
    case "aarch64-unknown-linux-gnu":
      return "bun-linux-arm64";
    case "x86_64-pc-windows-msvc":
      return "bun-windows-x64";
    default:
      throw new Error(`unsupported host triple for bun compile: ${triple}`);
  }
}

const bun = resolveBun();
const rustc = resolveRustc();
const triple = hostTriple(rustc);
const bunTarget = bunTargetFor(triple);

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const outfile = resolve(outDir, `sisyphus-daemon-${triple}`);
console.log(`[build-daemon-bin] bun=${bun} rustc=${rustc}`);
console.log(`[build-daemon-bin] triple=${triple} → bunTarget=${bunTarget}`);
console.log(`[build-daemon-bin] entry=${entry}`);
console.log(`[build-daemon-bin] outfile=${outfile}`);

const args = [
  "build",
  entry,
  "--compile",
  `--target=${bunTarget}`,
  `--outfile=${outfile}`,
];
const r = spawnSync(bun, args, { stdio: "inherit", cwd: repoRoot });
if (r.status !== 0) process.exit(r.status ?? 1);

console.log(`[build-daemon-bin] ok → ${outfile}`);
