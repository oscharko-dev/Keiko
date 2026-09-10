import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LinuxRuntimeQualificationError,
  linuxQualificationVitestArgs,
  qualificationReceiptFor,
  qualifyLinuxRuntimeRelease,
} from "../qualify-linux-runtime-release.mjs";
import { RUNTIME_QUALIFICATION_SUITE } from "../runtime-activation-manifest.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TARGET = "linux-x64";
const roots = [];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const stageRoot = mkdtempSync(join(tmpdir(), "keiko-linux-runtime-qualification-"));
  roots.push(stageRoot);
  const resourceRoot = join(stageRoot, "payload", "Keiko");
  const supervisor = Buffer.from("compiled sandbox runtime\n");
  const secureRead = Buffer.from("secure workspace read\n");
  const nativeHelpers = [
    {
      name: "keiko-runtime-supervisor",
      platformTarget: TARGET,
      executablePath: "app/node_modules/@oscharko-dev/keiko-sandbox/dist/runtime.js",
      sizeBytes: supervisor.length,
      shippedSha256: sha256(supervisor),
    },
    {
      name: "keiko-secure-workspace-read",
      platformTarget: TARGET,
      executablePath: "runtime/native/keiko-secure-workspace-read",
      sizeBytes: secureRead.length,
      shippedSha256: sha256(secureRead),
    },
  ];
  for (const [helper, bytes] of [
    [nativeHelpers[0], supervisor],
    [nativeHelpers[1], secureRead],
  ]) {
    const path = join(resourceRoot, ...helper.executablePath.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  const activation = {
    schemaVersion: 1,
    suiteVersion: RUNTIME_QUALIFICATION_SUITE,
    sourceCommitSha: COMMIT,
    platformTarget: TARGET,
    artifact: { platformTarget: TARGET },
    runtime: { nodePlatform: "linux", nodeArchitecture: "x64" },
    security: { verificationStatus: "verified-production" },
    nativeHelpers,
    sidecarRuntimes: [
      { name: "opencode-compatible", platformTarget: TARGET, payloadSha256: "a".repeat(64) },
    ],
  };
  const activationPath = join(resourceRoot, ".portable", "runtime-activation.json");
  mkdirSync(dirname(activationPath), { recursive: true });
  writeFileSync(activationPath, `${JSON.stringify(activation)}\n`);
  return { activation, activationPath, resourceRoot, stageRoot };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Linux runtime qualification", () => {
  it("binds the exact production activation, helper bytes, and sidecar", () => {
    const value = fixture();
    expect(
      qualificationReceiptFor({
        activationPath: value.activationPath,
        resourceRoot: value.resourceRoot,
        sourceCommitSha: COMMIT,
      }),
    ).toMatchObject({
      platformTarget: TARGET,
      supervisorSha256: value.activation.nativeHelpers[0].shippedSha256,
      secureReadSha256: value.activation.nativeHelpers[1].shippedSha256,
      sidecars: [{ name: "opencode-compatible", sha256: "a".repeat(64) }],
      backend: "linux-namespace-gateway",
      result: "passed",
    });
  });

  it("runs the mandatory proof and persists the canonical receipt", () => {
    const value = fixture();
    const exactCleanHead = vi.fn();
    const runQualificationTests = vi.fn();
    const receipt = qualifyLinuxRuntimeRelease(
      {
        "source-commit-sha": COMMIT,
        "stage-root": value.stageRoot,
        "test-report": join(value.stageRoot, "tests.json"),
      },
      { exactCleanHead, platform: "linux", runQualificationTests },
    );
    expect(exactCleanHead).toHaveBeenCalledWith(COMMIT);
    expect(runQualificationTests).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        readFileSync(join(value.resourceRoot, ".portable", "runtime-qualification.json"), "utf8"),
      ),
    ).toEqual(receipt);
    qualifyLinuxRuntimeRelease(
      { ...optionsFor(value), "verify-only": "true" },
      { exactCleanHead, platform: "linux", runQualificationTests },
    );
  });

  it("fails closed on the wrong host, invalid identity, and changed helper bytes", () => {
    const value = fixture();
    const options = {
      "source-commit-sha": COMMIT,
      "stage-root": value.stageRoot,
      "test-report": join(value.stageRoot, "tests.json"),
    };
    expect(() => qualifyLinuxRuntimeRelease(options, { platform: "darwin" })).toThrow(
      "qualification requires Linux",
    );
    expect(() =>
      qualifyLinuxRuntimeRelease(
        { ...options, "source-commit-sha": "not-a-commit" },
        { platform: "linux" },
      ),
    ).toThrow("source commit is invalid");
    expect(() =>
      qualifyLinuxRuntimeRelease(
        { ...options, "verify-only": "sometimes" },
        { exactCleanHead: vi.fn(), platform: "linux", runQualificationTests: vi.fn() },
      ),
    ).toThrow("--verify-only is invalid");
    writeFileSync(
      join(value.resourceRoot, "runtime", "native", "keiko-secure-workspace-read"),
      "changed\n",
    );
    expect(() =>
      qualificationReceiptFor({
        activationPath: value.activationPath,
        resourceRoot: value.resourceRoot,
        sourceCommitSha: COMMIT,
      }),
    ).toThrow(LinuxRuntimeQualificationError);
  });

  it("pins the real namespace-gateway and production-composition suites", () => {
    expect(linuxQualificationVitestArgs("/tmp/report.json")).toEqual(
      expect.arrayContaining([
        "packages/keiko-sandbox/src/linux-gateway-launcher.test.ts",
        "packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.test.ts",
        "--reporter=json",
        "--outputFile=/tmp/report.json",
      ]),
    );
  });
});

function optionsFor(value) {
  return {
    "source-commit-sha": COMMIT,
    "stage-root": value.stageRoot,
    "test-report": join(value.stageRoot, "tests.json"),
  };
}
