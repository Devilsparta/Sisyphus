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
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

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
const hostTripleStr = hostTriple(rustc);
// SISYPHUS_TARGET_TRIPLE lets the caller cross-build for another arch
// (e.g. aarch64-apple-darwin from an Intel mac). Default = host triple.
const triple = process.env.SISYPHUS_TARGET_TRIPLE ?? hostTripleStr;
const isMacOS = process.platform === "darwin";
const isWindows = process.platform === "win32";
const binName = isWindows
  ? `sisyphus-daemon-${triple}.exe`
  : `sisyphus-daemon-${triple}`;
const outfile = resolve(outDir, binName);
const isCrossBuild = triple !== hostTripleStr;

// Map our rust target triple to the nodejs.org darwin distribution arch label.
function nodejsArchFor(triple) {
  if (triple === "x86_64-apple-darwin") return "x64";
  if (triple === "aarch64-apple-darwin") return "arm64";
  return null;
}

/**
 * Download and cache nodejs.org's single-arch node binary for the given
 * target. Returns absolute path to a node binary matching `process.version`
 * (so the SEA blob format lines up). Skips download if already cached.
 */
async function fetchTargetNodeBinary(targetTriple) {
  const arch = nodejsArchFor(targetTriple);
  if (!arch) {
    throw new Error(
      `Cross-build for triple ${targetTriple} not supported yet (no nodejs.org tarball known)`,
    );
  }
  const version = process.version; // e.g. "v24.14.1"
  const cacheRoot = resolve(os.homedir(), ".cache/sisyphus-build");
  const distName = `node-${version}-darwin-${arch}`;
  const cacheDir = resolve(cacheRoot, distName);
  const nodeBin = resolve(cacheDir, "bin/node");

  if (existsSync(nodeBin)) {
    console.log(`[build-daemon-bin] cached target node binary: ${nodeBin}`);
    return nodeBin;
  }

  const url = `https://nodejs.org/dist/${version}/${distName}.tar.gz`;
  const tarPath = resolve(cacheRoot, `${distName}.tar.gz`);
  mkdirSync(cacheRoot, { recursive: true });

  console.log(`[build-daemon-bin] downloading ${url}`);
  await new Promise((resolveDl, rejectDl) => {
    https
      .get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          // follow redirect once
          https
            .get(res.headers.location, (r2) => {
              if (r2.statusCode !== 200) {
                rejectDl(new Error(`HTTP ${r2.statusCode} on redirect ${url}`));
                return;
              }
              pipeline(r2, createWriteStream(tarPath)).then(resolveDl, rejectDl);
            })
            .on("error", rejectDl);
          return;
        }
        if (res.statusCode !== 200) {
          rejectDl(new Error(`HTTP ${res.statusCode} fetching ${url}`));
          return;
        }
        pipeline(res, createWriteStream(tarPath)).then(resolveDl, rejectDl);
      })
      .on("error", rejectDl);
  });

  console.log(`[build-daemon-bin] extracting ${tarPath}`);
  const tarR = spawnSync(
    "tar",
    ["-xzf", tarPath, "-C", cacheRoot],
    { stdio: "inherit" },
  );
  if (tarR.status !== 0) {
    throw new Error(`tar extract failed (exit ${tarR.status})`);
  }
  rmSync(tarPath);

  if (!existsSync(nodeBin)) {
    throw new Error(`extracted tarball missing bin/node at ${nodeBin}`);
  }
  return nodeBin;
}

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

// 3. Copy the right node binary to the sidecar path Tauri expects.
//    - Native build, host node is a universal binary: lipo -thin the host
//      arch (nodejs.org's macOS install ships universal; postject can't
//      inject into a fat macho because the sentinel appears in every slice).
//    - Native build, host node already single-arch: copy as-is.
//    - Cross build (SISYPHUS_TARGET_TRIPLE != host): download the
//      single-arch nodejs.org darwin-arm64 (or x64) tarball matching
//      process.version, copy from there.
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
try {
  rmSync(outfile);
} catch {
  // not present, fine
}

let sourceNode = process.execPath;
if (isCrossBuild) {
  console.log(
    `[build-daemon-bin] cross-build host=${hostTripleStr} target=${triple}`,
  );
  sourceNode = await fetchTargetNodeBinary(triple);
}

if (isMacOS && !isCrossBuild) {
  const archForLipo = triple.startsWith("aarch64") ? "arm64" : "x86_64";
  const fileOut = execFileSync("file", [sourceNode], { encoding: "utf8" });
  if (fileOut.includes("universal binary")) {
    run("lipo thin", "lipo", [
      sourceNode,
      "-thin",
      archForLipo,
      "-output",
      outfile,
    ]);
  } else {
    copyFileSync(sourceNode, outfile);
  }
} else {
  copyFileSync(sourceNode, outfile);
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
