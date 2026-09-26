import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  DEV_LANE_HELPER_RELATIVE_PATH,
  DEV_LANE_MANIFEST_FILE,
  DEV_LANE_RUNTIME_SUPERVISOR_RELATIVE_PATH,
  DEV_LANE_STAGED_PAYLOADS_DIR,
  KEIKO_CODING_RUNTIME_DEV_LANE_ENV,
  type DevLaneOpenCodeTarget,
} from "../devLanePortableCodingRuntime.js";
import { OPENCODE_PINNED_VERSION } from "../opencodeToolSchemas.js";

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
export function stageDevLaneFixture(
  root: string,
  target: DevLaneOpenCodeTarget = FIXTURE_TARGET,
): DevLaneFixture {
  writeFile(join(root, "package.json"), `${JSON.stringify({ name: "@oscharko-dev/keiko" })}\n`);
  writeFile(join(root, "tsconfig.packages.json"), "{}\n");
  const helperSourceDir = join(root, "native", "secure-workspace-read");
  writeFile(join(helperSourceDir, "secure_workspace_read.c"), FIXTURE_HELPER_SOURCE);
  const staged = stageRuntimeFixture(root, target);
  const helper = stageHelperFixture(root, target, staged.stagedTargetRoot);
  const helperManifest = join(staged.stagedTargetRoot, DEV_LANE_MANIFEST_FILE);
  writeFile(helperManifest, `${JSON.stringify(fixtureHelperManifest(target))}\n`);
  const catalog = join(root, "portable-runtime-approvals.json");
  writeFile(catalog, `${JSON.stringify(fixtureCatalog(target))}\n`);
  return {
    root,
    env: {
      [KEIKO_CODING_RUNTIME_DEV_LANE_ENV]: "1",
      KEIKO_CLI_BIN_PATH: join(root, "package.json"),
    },
    paths: { catalog, helperManifest, helperSourceDir, helper, ...staged },
  };
}

function stageRuntimeFixture(
  root: string,
  target: DevLaneOpenCodeTarget,
): Omit<DevLaneFixturePaths, "catalog" | "helper" | "helperManifest" | "helperSourceDir"> {
  const stagedTargetRoot = join(root, DEV_LANE_STAGED_PAYLOADS_DIR, target);
  const installRoot = join(stagedTargetRoot, "opencode-compatible");
  const executable = join(
    installRoot,
    "payload",
    "bin",
    target === "windows-x64" ? "opencode.exe" : "opencode",
  );
  const license = join(installRoot, "payload", "evidence", "LICENSE");
  const sbom = join(installRoot, "payload", "evidence", "sbom.cdx.json");
  writeFile(executable, FIXTURE_EXECUTABLE);
  chmodSync(executable, 0o755);
  writeFile(license, FIXTURE_LICENSE);
  writeFile(sbom, FIXTURE_SBOM);
  return { stagedTargetRoot, executable, license, sbom };
}

function stageHelperFixture(
  root: string,
  target: DevLaneOpenCodeTarget,
  stagedTargetRoot: string,
): string {
  if (target === "windows-x64") {
    writeFile(
      join(root, "native", "runtime-supervisor", "windows", "keiko_runtime_supervisor.c"),
      FIXTURE_HELPER_SOURCE,
    );
  }
  const helper = join(
    stagedTargetRoot,
    `${DEV_LANE_HELPER_RELATIVE_PATH}${target === "windows-x64" ? ".exe" : ""}`,
  );
  writeFile(helper, FIXTURE_HELPER);
  chmodSync(helper, 0o755);
  const supervisor = join(stagedTargetRoot, `${DEV_LANE_RUNTIME_SUPERVISOR_RELATIVE_PATH}.exe`);
  if (target === "windows-x64") {
    writeFile(supervisor, FIXTURE_HELPER);
    chmodSync(supervisor, 0o755);
  }
  return helper;
}

function fixtureCatalog(target: DevLaneOpenCodeTarget): Record<string, unknown> {
  return {
    schemaVersion: 2,
    sidecarRuntimes: [
      {
        name: "opencode-compatible",
        kind: "coding-runtime",
        upstream: { owner: "anomalyco", repository: "opencode", version: OPENCODE_PINNED_VERSION },
        adapterCompatibility: {
          adapterName: "keiko-coding-sidecar",
          adapterVersion: "1",
          transport: "http-sse",
        },
        protocolSchema: { sha256: sha256Text("fixture-protocol-schema") },
        releaseApproval: { redistribution: { status: "approved" } },
        license: { spdxId: "MIT", sha256: sha256Text(FIXTURE_LICENSE) },
        archives: {
          [target]: {
            executableName: target === "windows-x64" ? "opencode.exe" : "opencode",
            sha256: sha256Text("fixture-archive"),
            sizeBytes: FIXTURE_EXECUTABLE.length,
            executableTreeSha256: sha256Text(
              `bin/${target === "windows-x64" ? "opencode.exe" : "opencode"}\0${sha256Text(FIXTURE_EXECUTABLE)}\0`,
            ),
            // KEIKO-0763: catalog-approved SBOM digest that verifiedPayload compares against
            // the on-disk sbom.cdx.json's sha256. Uses the fixture's own SBOM contents so a
            // matching payload activates, while a tampered SBOM would refuse as "payload-tampered".
            sbomSha256: sha256Text(FIXTURE_SBOM),
          },
        },
      },
    ],
  };
}

function fixtureHelperManifest(target: DevLaneOpenCodeTarget): Record<string, unknown> {
  const manifest = {
    schemaVersion: 1,
    target,
    helper: {
      sha256: sha256Text(FIXTURE_HELPER),
      sizeBytes: FIXTURE_HELPER.length,
      sourceCommit: FIXTURE_COMMIT,
      sourceTreeSha256: sha256Text(
        `secure_workspace_read.c\0${sha256Text(FIXTURE_HELPER_SOURCE)}\0`,
      ),
    },
  };
  if (target !== "windows-x64") return manifest;
  return {
    ...manifest,
    runtimeSupervisor: {
      sha256: sha256Text(FIXTURE_HELPER),
      sizeBytes: FIXTURE_HELPER.length,
      sourceCommit: FIXTURE_COMMIT,
      sourceTreeSha256: sha256Text(
        `keiko_runtime_supervisor.c\0${sha256Text(FIXTURE_HELPER_SOURCE)}\0`,
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
