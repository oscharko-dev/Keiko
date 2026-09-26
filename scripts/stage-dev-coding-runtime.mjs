// Stages the complete supported dev-lane coding-runtime layout (#2475, ADR-0140):
// the review-approved OpenCode payload (via prepare-approved-sidecar-payloads) plus a locally
// built secure-workspace-read helper, pinned by a dev-lane manifest that server discovery
// re-verifies fail-closed at every start. Dev checkouts only; packaged installs never use this.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareApprovedSidecarPayloads } from "./prepare-approved-sidecar-payloads.mjs";
import { runSecureWorkspaceReadBuild } from "./build-secure-workspace-read.mjs";
import { runRuntimeSupervisorBuild } from "./build-runtime-supervisor.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGED_ROOT = ".portable-sidecar-payloads";
const HELPER_RELATIVE = "native/keiko-secure-workspace-read";
const RUNTIME_SUPERVISOR_RELATIVE = "native/keiko-runtime-supervisor";
const HELPER_SOURCE_DIR = "native/secure-workspace-read";
const RUNTIME_SUPERVISOR_SOURCE_DIR = "native/runtime-supervisor/windows";
const MANIFEST_FILE = "dev-lane-manifest.json";

export function hostDevLaneTarget(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") return "windows-x64";
  if (platform !== "darwin") return undefined;
  if (arch === "arm64") return "macos-arm64";
  return arch === "x64" ? "macos-x64" : undefined;
}

export function helperRelativePath(target) {
  return `${HELPER_RELATIVE}${target === "windows-x64" ? ".exe" : ""}`;
}

export function runtimeSupervisorRelativePath(target) {
  return target === "windows-x64" ? `${RUNTIME_SUPERVISOR_RELATIVE}.exe` : undefined;
}

export function devLaneManifestDocument(
  { target, helperSha256, helperSizeBytes, sourceCommit, runtimeSupervisor },
  root = repoRoot,
) {
  const manifest = {
    schemaVersion: 1,
    target,
    helper: {
      sha256: helperSha256,
      sizeBytes: helperSizeBytes,
      sourceCommit,
      sourceTreeSha256: hashHelperSourceTree(join(root, HELPER_SOURCE_DIR)),
    },
  };
  if (runtimeSupervisor === undefined) return manifest;
  return {
    ...manifest,
    runtimeSupervisor: {
      ...runtimeSupervisor,
      sourceTreeSha256: hashHelperSourceTree(join(root, RUNTIME_SUPERVISOR_SOURCE_DIR)),
    },
  };
}

// Server discovery re-derives this digest in a different process; ordering is plain code-unit
// comparison so no locale/ICU collation can diverge between staging and discovery. Mirrors
// `hashHelperSourceTree` in devLanePortableCodingRuntime.ts.
export function hashHelperSourceTree(root) {
  const hash = createHash("sha256");
  for (const file of listFilesSorted(root)) {
    const rel = relative(root, file).split(sep).join("/");
    const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
    hash.update(`${rel}\0${digest}\0`);
  }
  return hash.digest("hex");
}

export function compareCodeUnits(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

export function listFilesSorted(root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFilesSorted(full));
    else if (entry.isFile()) out.push(resolve(full));
  }
  return out.sort(compareCodeUnits);
}

async function buildHelper(target, helperPath, root, runBuild) {
  const buildScript = join(root, "scripts", "build-secure-workspace-read.mjs");
  const status = await runBuild({ argv: [process.execPath, buildScript, target, helperPath] });
  if (status !== 0) {
    throw new Error(`secure-workspace-read build failed with status ${String(status)}`);
  }
}

async function buildRuntimeSupervisor(target, supervisorPath, root, runBuild) {
  const buildScript = join(root, "scripts", "build-runtime-supervisor.mjs");
  const status = await runBuild({ argv: [process.execPath, buildScript, target, supervisorPath] });
  if (status !== 0) {
    throw new Error(`runtime supervisor build failed with status ${String(status)}`);
  }
}

export function resolveStageDeps(deps) {
  return { ...resolveStageIoDeps(deps), ...resolveStageHost(deps) };
}

function resolveStageIoDeps(deps) {
  return {
    root: deps.root ?? repoRoot,
    prepareSidecars: deps.prepareSidecars ?? prepareApprovedSidecarPayloads,
    runBuild: deps.runBuild ?? runSecureWorkspaceReadBuild,
    runSupervisorBuild: deps.runSupervisorBuild ?? runRuntimeSupervisorBuild,
    resolveGit: deps.resolveGit ?? (() => resolveHostExecutable("git")),
    exec: deps.exec ?? execFileSync,
    log: deps.log ?? console.log,
  };
}

function resolveStageHost(deps) {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  return {
    platform,
    arch,
    target: deps.target ?? hostDevLaneTarget(platform, arch),
  };
}

function stagedManifest({ target, helperPath, supervisorPath, root, exec, resolveGit }) {
  const sourceCommit = exec(resolveGit(), ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return devLaneManifestDocument(
    {
      target,
      helperSha256: createHash("sha256").update(readFileSync(helperPath)).digest("hex"),
      helperSizeBytes: statSync(helperPath).size,
      // Resolve git to an absolute, non-writable trusted path (no bare-name PATH lookup) — the
      // repo-wide convention for script git invocations.
      sourceCommit,
      ...(supervisorPath === undefined
        ? {}
        : {
            runtimeSupervisor: {
              sha256: createHash("sha256").update(readFileSync(supervisorPath)).digest("hex"),
              sizeBytes: statSync(supervisorPath).size,
              sourceCommit,
            },
          }),
    },
    root,
  );
}

function writeStagedManifest({ target, helperPath, supervisorPath, root, exec, resolveGit, log }) {
  const manifest = stagedManifest({ target, helperPath, supervisorPath, root, exec, resolveGit });
  const manifestPath = join(root, STAGED_ROOT, target, MANIFEST_FILE);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`[dev-lane] staged ${target} under ${join(STAGED_ROOT, target)}.`);
  log(
    "[dev-lane] start the dev server (the trusted launcher enables this verified lane):\n" +
      "  npm run dev:start\n" +
      "See docs/coding-runtime/dev-lane.md for the full posture and verification notes.",
  );
  return manifestPath;
}

async function stageWindowsSupervisor(target, stagedTargetRoot, root, runSupervisorBuild, log) {
  const relativePath = runtimeSupervisorRelativePath(target);
  if (relativePath === undefined) return undefined;
  const supervisorPath = join(stagedTargetRoot, relativePath);
  log("[dev-lane] building the runtime supervisor …");
  await buildRuntimeSupervisor(target, supervisorPath, root, runSupervisorBuild);
  return supervisorPath;
}

function requireSupportedDevLaneTarget({ target, platform, arch }) {
  if (target !== undefined) return target;
  throw new Error(
    "The coding-runtime dev lane supports macOS (arm64/x64) and Windows (x64) checkouts only; " +
      `this host is ${platform}/${arch}.`,
  );
}

async function stageDevLaneNativeHelpers({
  root,
  target,
  runBuild,
  runSupervisorBuild,
  resolveGit,
  exec,
  log,
}) {
  const stagedTargetRoot = join(root, STAGED_ROOT, target);
  // The native directory is an execution boundary. Recreate it instead of overwriting known
  // files so a planted DLL, stale binary, or Finder metadata cannot survive trusted staging.
  rmSync(join(stagedTargetRoot, "native"), { recursive: true, force: true });
  const helperPath = join(stagedTargetRoot, helperRelativePath(target));
  log("[dev-lane] building the secure-workspace-read helper …");
  await buildHelper(target, helperPath, root, runBuild);
  const supervisorPath = await stageWindowsSupervisor(
    target,
    stagedTargetRoot,
    root,
    runSupervisorBuild,
    log,
  );
  return writeStagedManifest({
    target,
    helperPath,
    supervisorPath,
    root,
    exec,
    resolveGit,
    log,
  });
}

/**
 * Rebuilds only the locally compiled native components of an already verified sidecar payload.
 * The trusted dev launcher uses this on every start, binding the current server process to
 * freshly built checkout sources without redownloading the approved sidecar archive.
 */
export async function restageDevCodingRuntimeNativeHelpers(deps = {}) {
  const resolved = resolveStageDeps(deps);
  const target = requireSupportedDevLaneTarget(resolved);
  return stageDevLaneNativeHelpers({ ...resolved, target });
}

/**
 * Stages the dev lane. The I/O boundary is injectable so the orchestration is testable on any
 * host; production invocation supplies the real payload preparer, native builder, and git.
 */
export async function stageDevCodingRuntime(argv, deps = {}) {
  const resolved = resolveStageDeps(deps);
  const target = requireSupportedDevLaneTarget(resolved);
  resolved.log(`[dev-lane] preparing approved sidecar payload for ${target} …`);
  await resolved.prepareSidecars(["--target", target, ...argv]);
  return stageDevLaneNativeHelpers({ ...resolved, target });
}

export function isDirectInvocation(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  return argv1 !== undefined && resolve(argv1) === fileURLToPath(moduleUrl);
}

if (isDirectInvocation()) {
  try {
    await stageDevCodingRuntime(process.argv.slice(2));
  } catch (error) {
    console.error(`[dev-lane] staging failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
