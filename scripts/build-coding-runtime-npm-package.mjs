#!/usr/bin/env node
// Builds the npm runtime package that lets an npm-installed Keiko run the Coding Workbench (#3577).
// The main package ships no coding engine: until now only the desktop packages carried OpenCode and
// the native secure-read helper, so an npm installation listed its coding models and could never
// start a run. A customer who cannot install a desktop package (no admin rights, no infrastructure
// approval) gets the engine through npm instead: these packages are optionalDependencies of the main
// package with os/cpu fields, so `npm install -g @oscharko-dev/keiko` installs the one for the host.
//
// Nothing here is a new trust decision. The OpenCode executable is the review-approved archive from
// portable-runtime-approvals.json, staged and digest-verified by the same function the dev lane and
// the desktop packages use, and the helper is compiled by the same build script. The server
// re-verifies both against digests pinned in its own source at every start (npm lane,
// devLanePortableCodingRuntime.ts), so this package never vouches for itself.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runSecureWorkspaceReadBuild } from "./build-secure-workspace-read.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import { prepareApprovedSidecarPayloads } from "./prepare-approved-sidecar-payloads.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_NAME = "opencode-compatible";
const HELPER_RELATIVE_PATH = "native/keiko-secure-workspace-read";

/** Keiko portable target -> the npm `os`/`cpu` pair and package suffix npm selects a host by. */
export const NPM_RUNTIME_PACKAGE_TARGETS = Object.freeze({
  "macos-arm64": Object.freeze({ cpu: "arm64", os: "darwin", suffix: "darwin-arm64" }),
  "macos-x64": Object.freeze({ cpu: "x64", os: "darwin", suffix: "darwin-x64" }),
});

export function codingRuntimePackageName(target) {
  const entry = NPM_RUNTIME_PACKAGE_TARGETS[target];
  if (entry === undefined) throw new TypeError(`unsupported npm runtime package target: ${target}`);
  return `@oscharko-dev/keiko-coding-runtime-${entry.suffix}`;
}

export function codingRuntimePackageManifest(target, version) {
  const entry = NPM_RUNTIME_PACKAGE_TARGETS[target];
  return {
    name: codingRuntimePackageName(target),
    version,
    description:
      "Keiko Coding Workbench runtime for npm installations: the review-approved OpenCode " +
      "executable and Keiko's native secure workspace read helper. Verified by Keiko at every start.",
    // A valid SPDX expression, never "SEE LICENSE IN …": the supply-chain gates evaluate the
    // license of everything the main package can install and refuse what they cannot parse.
    // OpenCode is MIT, the helper is Keiko's own Apache-2.0 code.
    license: "Apache-2.0 AND MIT",
    repository: { type: "git", url: "git+https://github.com/oscharko-dev/Keiko.git" },
    os: [entry.os],
    cpu: [entry.cpu],
    files: ["runtime", "LICENSE.md"],
    publishConfig: { access: "public" },
  };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function licenseNotice(target) {
  return [
    `# ${codingRuntimePackageName(target)}`,
    "",
    "This package redistributes two components:",
    "",
    "- `runtime/opencode-compatible/payload/bin/opencode`: OpenCode, MIT License. The upstream",
    "  license text is `runtime/opencode-compatible/payload/evidence/LICENSE`, and its software",
    "  bill of materials is `runtime/opencode-compatible/payload/evidence/sbom.cdx.json`.",
    "- `runtime/native/keiko-secure-workspace-read`: part of Keiko, under Keiko's license",
    "  (https://github.com/oscharko-dev/Keiko/blob/dev/LICENSE).",
    "",
  ].join("\n");
}

/**
 * Stages one target into `outDir` and returns the digests the server pins. `outDir` must not exist
 * or must be empty: a runtime directory is an execution boundary, never merged into.
 */
export async function buildCodingRuntimeNpmPackage({ target, version, outDir, deps = {} }) {
  if (!isAbsolute(outDir)) throw new TypeError("outDir must be an absolute path");
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`outDir must not exist or must be empty: ${outDir}`);
  }
  const prepare = deps.prepareSidecars ?? prepareApprovedSidecarPayloads;
  const runBuild = deps.runBuild ?? runSecureWorkspaceReadBuild;
  const manifest = codingRuntimePackageManifest(target, version);
  const staging = mkdtempSync(join(tmpdir(), "keiko-coding-runtime-npm-"));
  try {
    await prepare(["--target", target, "--output-root", staging], undefined, repoRoot);
    const runtimeRoot = join(outDir, "runtime");
    mkdirSync(join(runtimeRoot, "native"), { recursive: true });
    cpSync(
      join(staging, target, SIDECAR_NAME, "payload"),
      join(runtimeRoot, SIDECAR_NAME, "payload"),
      {
        recursive: true,
      },
    );
    const helperPath = join(runtimeRoot, HELPER_RELATIVE_PATH);
    const buildScript = join(repoRoot, "scripts", "build-secure-workspace-read.mjs");
    const status = await runBuild({ argv: [process.execPath, buildScript, target, helperPath] });
    if (status !== 0) throw new Error(`secure-workspace-read build failed with status ${status}`);
    writeFileSync(join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(outDir, "LICENSE.md"), licenseNotice(target));
    return {
      helperSha256: sha256File(helperPath),
      helperSizeBytes: statSync(helperPath).size,
      name: manifest.name,
      outDir,
      target,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  const [target, version, outDir] = process.argv.slice(2);
  if (process.argv.length !== 5) {
    console.error(
      "usage: build-coding-runtime-npm-package.mjs <target> <version> <absolute-out-dir>",
    );
    process.exit(2);
  }
  const result = await buildCodingRuntimeNpmPackage({ target, version, outDir: resolve(outDir) });
  console.log(JSON.stringify(result, null, 2));
}
