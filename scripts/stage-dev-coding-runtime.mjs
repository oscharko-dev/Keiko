// Stages the complete macOS dev-lane coding-runtime layout (#2475, ADR-0140):
// the review-approved OpenCode payload (via prepare-approved-sidecar-payloads) plus a locally
// built secure-workspace-read helper, pinned by a dev-lane manifest that server discovery
// re-verifies fail-closed at every start. Dev checkouts only; packaged installs never use this.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareApprovedSidecarPayloads } from "./prepare-approved-sidecar-payloads.mjs";
import { runSecureWorkspaceReadBuild } from "./build-secure-workspace-read.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGED_ROOT = ".portable-sidecar-payloads";
const HELPER_RELATIVE = "native/keiko-secure-workspace-read";
const HELPER_SOURCE_DIR = "native/secure-workspace-read";
const MANIFEST_FILE = "dev-lane-manifest.json";

export function hostDevLaneTarget(platform = process.platform, arch = process.arch) {
  if (platform !== "darwin") return undefined;
  if (arch === "arm64") return "macos-arm64";
  return arch === "x64" ? "macos-x64" : undefined;
}

export function devLaneManifestDocument(
  { target, helperSha256, helperSizeBytes, sourceCommit },
  root = repoRoot,
) {
  return {
    schemaVersion: 1,
    target,
    helper: {
      sha256: helperSha256,
      sizeBytes: helperSizeBytes,
      sourceCommit,
      sourceTreeSha256: hashHelperSourceTree(join(root, HELPER_SOURCE_DIR)),
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

export function resolveStageDeps(deps) {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  return {
    root: deps.root ?? repoRoot,
    prepareSidecars: deps.prepareSidecars ?? prepareApprovedSidecarPayloads,
    runBuild: deps.runBuild ?? runSecureWorkspaceReadBuild,
    resolveGit: deps.resolveGit ?? (() => resolveHostExecutable("git")),
    exec: deps.exec ?? execFileSync,
    log: deps.log ?? console.log,
    platform,
    arch,
    target: deps.target ?? hostDevLaneTarget(platform, arch),
  };
}

function stagedManifest({ target, helperPath, root, exec, resolveGit }) {
  return devLaneManifestDocument(
    {
      target,
      helperSha256: createHash("sha256").update(readFileSync(helperPath)).digest("hex"),
      helperSizeBytes: statSync(helperPath).size,
      // Resolve git to an absolute, non-writable trusted path (no bare-name PATH lookup) — the
      // repo-wide convention for script git invocations.
      sourceCommit: exec(resolveGit(), ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    },
    root,
  );
}

/**
 * Stages the dev lane. The I/O boundary is injectable so the orchestration is testable on any
 * host; production invocation supplies the real payload preparer, native builder, and git.
 */
export async function stageDevCodingRuntime(argv, deps = {}) {
  const { root, prepareSidecars, runBuild, resolveGit, exec, log, platform, arch, target } =
    resolveStageDeps(deps);
  if (target === undefined) {
    // Report the identity that actually drove the decision (injected in tests, real otherwise).
    throw new Error(
      "The coding-runtime dev lane supports macOS (arm64/x64) checkouts only; " +
        `this host is ${platform}/${arch}.`,
    );
  }
  log(`[dev-lane] preparing approved sidecar payload for ${target} …`);
  await prepareSidecars(["--target", target, ...argv]);
  const stagedTargetRoot = join(root, STAGED_ROOT, target);
  const helperPath = join(stagedTargetRoot, HELPER_RELATIVE);
  log("[dev-lane] building the secure-workspace-read helper …");
  await buildHelper(target, helperPath, root, runBuild);
  const manifest = stagedManifest({ target, helperPath, root, exec, resolveGit });
  const manifestPath = join(stagedTargetRoot, MANIFEST_FILE);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`[dev-lane] staged ${target} under ${join(STAGED_ROOT, target)}.`);
  log(
    "[dev-lane] start the dev server with the lane enabled:\n" +
      "  KEIKO_CODING_RUNTIME_DEV_LANE=1 npm run dev:start\n" +
      "See docs/coding-runtime/dev-lane.md for the full posture and verification notes.",
  );
  return manifestPath;
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
