import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertSameExecutable,
  executionAppRoot,
  parseMacosQualificationArgs,
  qualificationReceiptFor,
  qualifyMacosRuntimeRelease,
  runQualificationCommand,
  runQuietQualificationCommand,
  writeQualificationEvidenceReceipt,
} from "../qualify-macos-runtime-release.mjs";
import { RUNTIME_QUALIFICATION_SUITE } from "../runtime-activation-manifest.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const roots = [];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function root() {
  const value = mkdtempSync(join(tmpdir(), "keiko-macos-runtime-qualification-"));
  roots.push(value);
  return value;
}

function fixture(target = "macos-arm64") {
  const stageRoot = root();
  const stagedAppRoot = join(stageRoot, "payload", "Keiko", "Keiko.app");
  const resourceRoot = join(stagedAppRoot, "Contents", "Resources");
  const executionAppRoot = join(stageRoot, "execution", "KeikoQualification-fixture.app");
  const supervisor = Buffer.from("supervisor\n");
  const secureRead = Buffer.from("secure-read\n");
  const manager = Buffer.from("manager\n");
  const helpers = [
    {
      name: "keiko-runtime-supervisor",
      platformTarget: target,
      executablePath: "runtime/native/keiko-runtime-supervisor",
      sizeBytes: supervisor.length,
      shippedSha256: sha256(supervisor),
    },
    {
      name: "keiko-secure-workspace-read",
      platformTarget: target,
      executablePath: "runtime/native/keiko-secure-workspace-read",
      sizeBytes: secureRead.length,
      shippedSha256: sha256(secureRead),
    },
  ];
  for (const [helper, bytes] of [
    [helpers[0], supervisor],
    [helpers[1], secureRead],
  ]) {
    const stagedPath = join(resourceRoot, ...helper.executablePath.split("/"));
    mkdirSync(dirname(stagedPath), { recursive: true });
    writeFileSync(stagedPath, bytes);
    if (helper.name === "keiko-runtime-supervisor") {
      const executionPath = join(
        executionAppRoot,
        "Contents",
        "Resources",
        ...helper.executablePath.split("/"),
      );
      mkdirSync(dirname(executionPath), { recursive: true });
      writeFileSync(executionPath, bytes);
    }
  }
  for (const appRoot of [stagedAppRoot, executionAppRoot]) {
    const path = join(appRoot, "Contents", "MacOS", "KeikoSystemExtensionManager");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, manager);
  }
  const activation = {
    schemaVersion: 1,
    suiteVersion: RUNTIME_QUALIFICATION_SUITE,
    product: { packageName: "@oscharko-dev/keiko", packageVersion: "0.2.15" },
    sourceCommitSha: COMMIT,
    platformTarget: target,
    artifact: { platformTarget: target },
    runtime: {
      nodePlatform: "darwin",
      nodeArchitecture: target === "macos-arm64" ? "arm64" : "x64",
    },
    security: { verificationStatus: "verified-production" },
    nativeHelpers: helpers,
    sidecarRuntimes: [{ name: "opencode-compatible", payloadSha256: "a".repeat(64) }],
    releaseImpact: { entryId: "fixture" },
  };
  const activationPath = join(resourceRoot, ".portable", "runtime-activation.json");
  mkdirSync(dirname(activationPath), { recursive: true });
  writeFileSync(activationPath, `${JSON.stringify(activation)}\n`);
  return {
    activation,
    activationPath,
    executionAppRoot,
    resourceRoot,
    stageRoot,
    stagedAppRoot,
    target,
  };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("macOS runtime qualification", () => {
  it.each(["macos-arm64", "macos-x64"])(
    "binds exact %s activation, helper bytes, and mandatory OpenCode",
    (target) => {
      const value = fixture(target);
      expect(
        qualificationReceiptFor({
          activationPath: value.activationPath,
          resourceRoot: value.resourceRoot,
          sourceCommitSha: COMMIT,
          target,
        }),
      ).toMatchObject({
        platformTarget: target,
        supervisorSha256: value.activation.nativeHelpers[0].shippedSha256,
        secureReadSha256: value.activation.nativeHelpers[1].shippedSha256,
        sidecars: [{ name: "opencode-compatible", sha256: "a".repeat(64) }],
        backend: "macos-endpoint-security",
        result: "passed",
      });
    },
  );

  it("qualifies the copied /Applications app and verifies the persisted receipt", () => {
    const value = fixture();
    const runFn = vi.fn((_command, args) => (args[0] === "--activate" ? "active" : ""));
    const runQuietFn = vi.fn();
    const deps = {
      executionAppRootFn: () => value.executionAppRoot,
      platform: "darwin",
      runFn,
      runQuietFn,
    };
    const options = {
      "execution-app-root": "/Applications/KeikoQualification-fixture.app",
      "source-commit-sha": COMMIT,
      "stage-root": value.stageRoot,
      target: value.target,
    };
    qualifyMacosRuntimeRelease(options, deps);
    const receiptPath = join(value.resourceRoot, ".portable", "runtime-qualification.json");
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
      backend: "macos-endpoint-security",
      result: "passed",
    });
    expect(runQuietFn).toHaveBeenCalledTimes(2);
    expect(runFn).toHaveBeenCalledTimes(2);
    qualifyMacosRuntimeRelease({ ...options, "verify-only": "true" }, deps);
  });

  it("rejects incomplete identity, approval, verification mode, and stale receipts", () => {
    const value = fixture();
    const base = {
      "execution-app-root": "/Applications/KeikoQualification-fixture.app",
      "source-commit-sha": COMMIT,
      "stage-root": value.stageRoot,
      target: value.target,
    };
    expect(() => qualifyMacosRuntimeRelease(base, { platform: "linux" })).toThrow(
      "qualification requires macOS",
    );
    expect(() =>
      qualifyMacosRuntimeRelease({ ...base, target: "macos-ppc" }, { platform: "darwin" }),
    ).toThrow("qualification identity is invalid");
    expect(() =>
      qualifyMacosRuntimeRelease(
        { ...base, "verify-only": "sometimes" },
        {
          executionAppRootFn: () => value.executionAppRoot,
          platform: "darwin",
          runFn: (_command, args) => (args[0] === "--activate" ? "active" : ""),
          runQuietFn: vi.fn(),
        },
      ),
    ).toThrow("--verify-only is invalid");
    expect(() =>
      qualifyMacosRuntimeRelease(base, {
        executionAppRootFn: () => value.executionAppRoot,
        platform: "darwin",
        runFn: () => "pending",
        runQuietFn: vi.fn(),
      }),
    ).toThrow("system extension requires approval");
  });

  it("fails closed while parsing malformed CLI arguments and activation documents", () => {
    expect(
      parseMacosQualificationArgs(["--target", "macos-arm64", "--source-commit-sha", COMMIT]),
    ).toEqual({ "source-commit-sha": COMMIT, target: "macos-arm64" });
    expect(() => parseMacosQualificationArgs(["--target"])).toThrow("invalid arguments");
    expect(() => parseMacosQualificationArgs(["target", "macos-arm64"])).toThrow(
      "invalid arguments",
    );
    expect(() => qualifyMacosRuntimeRelease({}, { platform: "darwin" })).toThrow(
      "--target is required",
    );

    const directoryActivation = fixture();
    expect(() =>
      qualificationReceiptFor({
        activationPath: dirname(directoryActivation.activationPath),
        resourceRoot: directoryActivation.resourceRoot,
        sourceCommitSha: COMMIT,
        target: directoryActivation.target,
      }),
    ).toThrow("activation manifest is invalid");

    const malformedActivation = fixture();
    writeFileSync(malformedActivation.activationPath, "{");
    expect(() =>
      qualificationReceiptFor({
        activationPath: malformedActivation.activationPath,
        resourceRoot: malformedActivation.resourceRoot,
        sourceCommitSha: COMMIT,
        target: malformedActivation.target,
      }),
    ).toThrow("activation manifest is invalid");
  });

  it("validates the canonical execution root and same-byte executable boundary", () => {
    const directory = { isDirectory: () => true, isSymbolicLink: () => false };
    expect(
      executionAppRoot(
        { "execution-app-root": "/Applications/KeikoQualification-abc_1.app" },
        () => directory,
      ),
    ).toBe("/Applications/KeikoQualification-abc_1.app");
    expect(() => executionAppRoot({}, () => directory)).toThrow("--execution-app-root is required");
    expect(() =>
      executionAppRoot({ "execution-app-root": "/tmp/Keiko.app" }, () => directory),
    ).toThrow("execution app root is invalid");

    const value = fixture();
    const staged = join(value.stagedAppRoot, "Contents", "MacOS", "KeikoSystemExtensionManager");
    const execution = join(
      value.executionAppRoot,
      "Contents",
      "MacOS",
      "KeikoSystemExtensionManager",
    );
    expect(() => assertSameExecutable(staged, execution, "manager")).not.toThrow();
    writeFileSync(execution, "tampered\n");
    expect(() => assertSameExecutable(staged, execution, "manager")).toThrow(
      "manager bytes are invalid",
    );
  });

  it("writes a receipt.json + artifact pair the #3390 checker reads (audit F8)", () => {
    const receiptsDir = root();
    writeQualificationEvidenceReceipt({
      receiptsDir,
      scenarioId: "packaged-macos-arm64-reference",
      receipt: { sourceCommitSha: COMMIT, platformTarget: "macos-arm64", result: "passed" },
      recordedAt: "2026-09-04T12:00:00Z",
    });
    expect(
      JSON.parse(
        readFileSync(join(receiptsDir, "packaged-macos-arm64-reference.receipt.json"), "utf8"),
      ),
    ).toEqual({
      scenarioId: "packaged-macos-arm64-reference",
      commitSha: COMMIT,
      platform: "macos-arm64",
      testStatus: "passed",
      recordedAt: "2026-09-04T12:00:00Z",
      provenance: "real-model",
    });
  });

  it("bridges a real qualification receipt into #3390 evidence when --qualification-receipts is set (audit F8)", () => {
    const value = fixture();
    const receiptsDir = root();
    const runFn = vi.fn((_command, args) => (args[0] === "--activate" ? "active" : ""));
    const runQuietFn = vi.fn();
    qualifyMacosRuntimeRelease(
      {
        "execution-app-root": "/Applications/KeikoQualification-fixture.app",
        "qualification-receipts": receiptsDir,
        "scenario-id": "packaged-macos-arm64-reference",
        "source-commit-sha": COMMIT,
        "stage-root": value.stageRoot,
        target: value.target,
      },
      {
        executionAppRootFn: () => value.executionAppRoot,
        platform: "darwin",
        runFn,
        runQuietFn,
      },
    );
    const receiptJson = JSON.parse(
      readFileSync(join(receiptsDir, "packaged-macos-arm64-reference.receipt.json"), "utf8"),
    );
    expect(receiptJson).toMatchObject({
      scenarioId: "packaged-macos-arm64-reference",
      commitSha: COMMIT,
      platform: "macos-arm64",
      testStatus: "passed",
      provenance: "real-model",
    });
    const artifact = readFileSync(join(receiptsDir, "packaged-macos-arm64-reference.artifact"));
    expect(JSON.parse(artifact.toString("utf8"))).toMatchObject({ result: "passed" });
  });

  it("writes nothing when --qualification-receipts is not set", () => {
    const value = fixture();
    const receiptsDir = root();
    qualifyMacosRuntimeRelease(
      {
        "execution-app-root": "/Applications/KeikoQualification-fixture.app",
        "source-commit-sha": COMMIT,
        "stage-root": value.stageRoot,
        target: value.target,
      },
      {
        executionAppRootFn: () => value.executionAppRoot,
        platform: "darwin",
        runFn: vi.fn((_command, args) => (args[0] === "--activate" ? "active" : "")),
        runQuietFn: vi.fn(),
      },
    );
    // No throw and no --scenario-id required: the bridge is opt-in.
    expect(readdirSync(receiptsDir)).toEqual([]);
  });

  it("requires --scenario-id when writing qualification evidence", () => {
    const receiptsDir = root();
    const value = fixture();
    expect(() =>
      qualifyMacosRuntimeRelease(
        {
          "execution-app-root": "/Applications/KeikoQualification-fixture.app",
          "qualification-receipts": receiptsDir,
          "source-commit-sha": COMMIT,
          "stage-root": value.stageRoot,
          target: value.target,
        },
        {
          executionAppRootFn: () => value.executionAppRoot,
          platform: "darwin",
          runFn: vi.fn((_command, args) => (args[0] === "--activate" ? "active" : "")),
          runQuietFn: vi.fn(),
        },
      ),
    ).toThrow("--scenario-id is required");
  });

  it("closes command execution on status, stderr, and spawn failures", () => {
    const success = vi.fn(() => ({ status: 0, stdout: "active\n", stderr: "" }));
    expect(runQualificationCommand("/bin/tool", ["--status"], "tool", success)).toBe("active");
    expect(() =>
      runQualificationCommand("/bin/tool", [], "tool", () => ({
        status: 0,
        stdout: "",
        stderr: "unexpected",
      })),
    ).toThrow("tool failed");
    expect(() =>
      runQuietQualificationCommand("/bin/tool", [], "tool", () => ({
        error: new Error("spawn"),
        status: null,
      })),
    ).toThrow("tool failed");
  });
});
