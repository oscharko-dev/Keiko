// Stages the complete macOS dev-lane coding-runtime layout (#2475, ADR-0140):
// the review-approved OpenCode payload (via prepare-approved-sidecar-payloads) plus a locally
// built secure-workspace-read helper, pinned by a dev-lane manifest that server discovery
// re-verifies fail-closed at every start. Dev checkouts only; packaged installs never use this.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareApprovedSidecarPayloads } from "./prepare-approved-sidecar-payloads.mjs";
import { runSecureWorkspaceReadBuild } from "./build-secure-workspace-read.mjs";
import { hashDirectoryTree } from "./portable-runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGED_ROOT = ".portable-sidecar-payloads";
const HELPER_RELATIVE = "native/keiko-secure-workspace-read";
const HELPER_SOURCE_DIR = "native/secure-workspace-read";

export function hostDevLaneTarget(platform = process.platform, arch = process.arch) {
  if (platform !== "darwin") return undefined;
  if (arch === "arm64") return "macos-arm64";
  return arch === "x64" ? "macos-x64" : undefined;
}

export function devLaneManifestDocument({ target, helperSha256, helperSizeBytes, sourceCommit }) {
  return {
    schemaVersion: 1,
    target,
    helper: {
      sha256: helperSha256,
      sizeBytes: helperSizeBytes,
      sourceCommit,
      sourceTreeSha256: hashDirectoryTree(join(repoRoot, HELPER_SOURCE_DIR)),
    },
  };
}

async function buildHelper(target, helperPath) {
  const buildScript = join(repoRoot, "scripts", "build-secure-workspace-read.mjs");
  const status = await runSecureWorkspaceReadBuild({
    argv: [process.execPath, buildScript, target, helperPath],
  });
  if (status !== 0) {
    throw new Error(`secure-workspace-read build failed with status ${String(status)}`);
  }
}

async function stageDevCodingRuntime(argv) {
  const target = hostDevLaneTarget();
  if (target === undefined) {
    throw new Error(
      "The coding-runtime dev lane supports macOS (arm64/x64) checkouts only; " +
        `this host is ${process.platform}/${process.arch}.`,
    );
  }
  console.log(`[dev-lane] preparing approved sidecar payload for ${target} …`);
  await prepareApprovedSidecarPayloads(["--target", target, ...argv]);
  const stagedTargetRoot = join(repoRoot, STAGED_ROOT, target);
  const helperPath = join(stagedTargetRoot, HELPER_RELATIVE);
  console.log("[dev-lane] building the secure-workspace-read helper …");
  await buildHelper(target, helperPath);
  const helperBytes = readFileSync(helperPath);
  const manifest = devLaneManifestDocument({
    target,
    helperSha256: createHash("sha256").update(helperBytes).digest("hex"),
    helperSizeBytes: statSync(helperPath).size,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim(),
  });
  writeFileSync(
    join(stagedTargetRoot, "dev-lane-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(`[dev-lane] staged ${target} under ${join(STAGED_ROOT, target)}.`);
  console.log(
    "[dev-lane] start the dev server with the lane enabled:\n" +
      "  KEIKO_CODING_RUNTIME_DEV_LANE=1 npm run dev:start\n" +
      "See docs/coding-runtime/dev-lane.md for the full posture and verification notes.",
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stageDevCodingRuntime(process.argv.slice(2)).catch((error) => {
    console.error(`[dev-lane] staging failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
