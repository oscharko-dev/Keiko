import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  DEV_LANE_HELPER_RELATIVE_PATH,
  DEV_LANE_MANIFEST_FILE,
  DEV_LANE_STAGED_PAYLOADS_DIR,
  KEIKO_CODING_RUNTIME_DEV_LANE_ENV,
  type DevLaneOpenCodeTarget,
} from "../devLanePortableCodingRuntime.js";

const FIXTURE_TARGET: DevLaneOpenCodeTarget = "macos-arm64";
const FIXTURE_EXECUTABLE = "#!/bin/sh\nexit 0\n";
const FIXTURE_LICENSE = "fixture license evidence\n";
const FIXTURE_SBOM = '{"bomFormat":"CycloneDX"}\n';
const FIXTURE_HELPER = "#!/bin/sh\nexit 0\n";
const FIXTURE_HELPER_SOURCE = "/* fixture secure_workspace_read source */\n";
const FIXTURE_COMMIT = "a".repeat(40);

interface DevLaneFixturePaths {
  readonly catalog: string;
  readonly stagedTargetRoot: string;
  readonly executable: string;
  readonly license: string;
  readonly sbom: string;
  readonly helper: string;
  readonly helperManifest: string;
  readonly helperSourceDir: string;
}

export interface DevLaneFixture {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly paths: DevLaneFixturePaths;
}

/**
 * Stages a complete, self-consistent dev-checkout fixture: checkout markers, a fixture approvals
 * catalog whose digests are computed from the staged fixture payload, the staged payload itself,
 * and a fixture secure-read helper with a matching dev-lane manifest. Tests mutate individual
 * files afterwards to drive each fail-closed row of the discovery matrix.
 */
export function stageDevLaneFixture(root: string): DevLaneFixture {
  writeFile(join(root, "package.json"), `${JSON.stringify({ name: "@oscharko-dev/keiko" })}\n`);
  writeFile(join(root, "tsconfig.packages.json"), "{}\n");
  const helperSourceDir = join(root, "native", "secure-workspace-read");
  writeFile(join(helperSourceDir, "secure_workspace_read.c"), FIXTURE_HELPER_SOURCE);
  const stagedTargetRoot = join(root, DEV_LANE_STAGED_PAYLOADS_DIR, FIXTURE_TARGET);
  const installRoot = join(stagedTargetRoot, "opencode-compatible");
  const executable = join(installRoot, "payload", "bin", "opencode");
  const license = join(installRoot, "payload", "evidence", "LICENSE");
  const sbom = join(installRoot, "payload", "evidence", "sbom.cdx.json");
  writeFile(executable, FIXTURE_EXECUTABLE);
  chmodSync(executable, 0o755);
  writeFile(license, FIXTURE_LICENSE);
  writeFile(sbom, FIXTURE_SBOM);
  const helper = join(stagedTargetRoot, DEV_LANE_HELPER_RELATIVE_PATH);
  writeFile(helper, FIXTURE_HELPER);
  chmodSync(helper, 0o755);
  const helperManifest = join(stagedTargetRoot, DEV_LANE_MANIFEST_FILE);
  writeFile(helperManifest, `${JSON.stringify(fixtureHelperManifest())}\n`);
  const catalog = join(root, "portable-runtime-approvals.json");
  writeFile(catalog, `${JSON.stringify(fixtureCatalog())}\n`);
  return {
    root,
    env: {
      [KEIKO_CODING_RUNTIME_DEV_LANE_ENV]: "1",
      KEIKO_CLI_BIN_PATH: join(root, "package.json"),
    },
    paths: {
      catalog,
      stagedTargetRoot,
      executable,
      license,
      sbom,
      helper,
      helperManifest,
      helperSourceDir,
    },
  };
}

function fixtureCatalog(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    sidecarRuntimes: [
      {
        name: "opencode-compatible",
        kind: "coding-runtime",
        upstream: { owner: "anomalyco", repository: "opencode", version: "1.17.17" },
        adapterCompatibility: {
          adapterName: "keiko-coding-sidecar",
          adapterVersion: "1",
          transport: "http-sse",
        },
        protocolSchema: { sha256: sha256Text("fixture-protocol-schema") },
        releaseApproval: { redistribution: { status: "approved" } },
        license: { spdxId: "MIT", sha256: sha256Text(FIXTURE_LICENSE) },
        archives: {
          [FIXTURE_TARGET]: {
            executableName: "opencode",
            sha256: sha256Text("fixture-archive"),
            sizeBytes: FIXTURE_EXECUTABLE.length,
            executableTreeSha256: sha256Text(`bin/opencode\0${sha256Text(FIXTURE_EXECUTABLE)}\0`),
          },
        },
      },
    ],
  };
}

function fixtureHelperManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    target: FIXTURE_TARGET,
    helper: {
      sha256: sha256Text(FIXTURE_HELPER),
      sizeBytes: FIXTURE_HELPER.length,
      sourceCommit: FIXTURE_COMMIT,
      sourceTreeSha256: sha256Text(
        `secure_workspace_read.c\0${sha256Text(FIXTURE_HELPER_SOURCE)}\0`,
      ),
    },
  };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function writeFile(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, body);
}
