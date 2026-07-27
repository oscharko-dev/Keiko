import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  qualificationReceiptFor,
  qualifyWindowsRuntimeRelease,
} from "../qualify-windows-runtime-release.mjs";
import { RUNTIME_QUALIFICATION_SUITE } from "../runtime-activation-manifest.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const roots = [];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function root() {
  const value = mkdtempSync(join(tmpdir(), "keiko-windows-runtime-qualification-"));
  roots.push(value);
  return value;
}

function fixture() {
  const stageRoot = root();
  const resourceRoot = join(stageRoot, "payload", "Keiko");
  const supervisor = Buffer.from("supervisor\n");
  const secureRead = Buffer.from("secure-read\n");
  const helpers = [
    {
      name: "keiko-runtime-supervisor",
      platformTarget: "windows-x64",
      executablePath: "runtime/native/keiko-runtime-supervisor.exe",
      sizeBytes: supervisor.length,
      shippedSha256: sha256(supervisor),
    },
    {
      name: "keiko-secure-workspace-read",
      platformTarget: "windows-x64",
      executablePath: "runtime/native/keiko-secure-workspace-read.exe",
      sizeBytes: secureRead.length,
      shippedSha256: sha256(secureRead),
    },
  ];
  for (const [helper, bytes] of [
    [helpers[0], supervisor],
    [helpers[1], secureRead],
  ]) {
    const path = join(resourceRoot, ...helper.executablePath.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  const activation = {
    schemaVersion: 1,
    suiteVersion: RUNTIME_QUALIFICATION_SUITE,
    product: { packageName: "@oscharko-dev/keiko", packageVersion: "0.2.15" },
    sourceCommitSha: COMMIT,
    platformTarget: "windows-x64",
    artifact: { platformTarget: "windows-x64" },
    runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
    security: { verificationStatus: "verified-production" },
    nativeHelpers: helpers,
    sidecarRuntimes: [{ name: "opencode-compatible", payloadSha256: "a".repeat(64) }],
    releaseImpact: { entryId: "fixture" },
  };
  const activationPath = join(resourceRoot, ".portable", "runtime-activation.json");
  mkdirSync(dirname(activationPath), { recursive: true });
  writeFileSync(activationPath, `${JSON.stringify(activation)}\n`);
  return { activation, activationPath, resourceRoot, stageRoot };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Windows runtime qualification", () => {
  it("binds the exact activation, helper bytes, OpenCode payload, and backend", () => {
    const value = fixture();
    expect(
      qualificationReceiptFor({
        activationPath: value.activationPath,
        resourceRoot: value.resourceRoot,
        sourceCommitSha: COMMIT,
      }),
    ).toMatchObject({
      schemaVersion: 1,
      suiteVersion: RUNTIME_QUALIFICATION_SUITE,
      platformTarget: "windows-x64",
      sourceCommitSha: COMMIT,
      supervisorSha256: value.activation.nativeHelpers[0].shippedSha256,
      secureReadSha256: value.activation.nativeHelpers[1].shippedSha256,
      sidecars: [{ name: "opencode-compatible", sha256: "a".repeat(64) }],
      backend: "windows-job-object",
      result: "passed",
    });
  });

  it("writes a closed receipt only after the shipped supervisor protocol passes", () => {
    const value = fixture();
    const output = join(value.stageRoot, "evidence", "qualification.json");
    mkdirSync(dirname(output), { recursive: true });
    const spawnSyncImpl = vi.fn(() => ({ status: 0 }));
    qualifyWindowsRuntimeRelease(
      {
        "stage-root": value.stageRoot,
        "source-commit-sha": COMMIT,
        output,
      },
      { platform: "win32", spawnSyncImpl },
    );
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["--helper"]),
      expect.objectContaining({
        env: { SystemRoot: String.raw`C:\Windows` },
        timeout: 60_000,
      }),
    );
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      backend: "windows-job-object",
      result: "passed",
    });
  });

  it("rejects wrong platforms, invalid options, failed protocols, and tampered helper bytes", () => {
    const value = fixture();
    const options = {
      "stage-root": value.stageRoot,
      "source-commit-sha": COMMIT,
      output: join(value.stageRoot, "qualification.json"),
    };
    expect(() => qualifyWindowsRuntimeRelease(options, { platform: "darwin" })).toThrow(
      "qualification requires Windows",
    );
    expect(() =>
      qualifyWindowsRuntimeRelease(
        { ...options, "source-commit-sha": "bad" },
        { platform: "win32" },
      ),
    ).toThrow("source commit is invalid");
    expect(() =>
      qualifyWindowsRuntimeRelease(options, {
        platform: "win32",
        spawnSyncImpl: () => ({ error: new Error("failed"), status: null }),
      }),
    ).toThrow("exact shipped supervisor did not pass qualification");

    const helperPath = join(
      value.resourceRoot,
      ...value.activation.nativeHelpers[0].executablePath.split("/"),
    );
    writeFileSync(helperPath, "tampered\n");
    expect(() =>
      qualificationReceiptFor({
        activationPath: value.activationPath,
        resourceRoot: value.resourceRoot,
        sourceCommitSha: COMMIT,
      }),
    ).toThrow("activation helper bytes are invalid");
  });

  it("rejects malformed activation manifests and ambiguous helper or OpenCode sets", () => {
    const value = fixture();
    const assertInvalid = (mutate, message) => {
      const activation = structuredClone(value.activation);
      mutate(activation);
      writeFileSync(value.activationPath, `${JSON.stringify(activation)}\n`);
      expect(() =>
        qualificationReceiptFor({
          activationPath: value.activationPath,
          resourceRoot: value.resourceRoot,
          sourceCommitSha: COMMIT,
        }),
      ).toThrow(message);
    };
    assertInvalid((activation) => {
      activation.extra = true;
    }, "activation manifest is invalid");
    assertInvalid((activation) => {
      activation.nativeHelpers.push(structuredClone(activation.nativeHelpers[0]));
    }, "activation helper set is invalid");
    assertInvalid((activation) => {
      activation.sidecarRuntimes = [];
    }, "activation OpenCode binding is invalid");
  });
});
