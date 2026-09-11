import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  qualificationReceiptFor,
  qualifyWindowsRuntimeRelease,
  writeQualificationEvidenceReceipt,
} from "../qualify-windows-runtime-release.mjs";
import { RUNTIME_QUALIFICATION_SUITE } from "../runtime-activation-manifest.mjs";
import { hashDirectoryTree } from "../portable-runtime.mjs";
import {
  inventoryWindowsPortableCorePeFiles,
  inventoryWindowsPortablePeFiles,
  closeWindowsGenerationDirectory,
} from "../windows-portable-signing.mjs";

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

function portableExecutable(marker = 0) {
  const bytes = Buffer.alloc(128, marker);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  bytes.writeUInt32LE(64, 0x3c);
  bytes.set([0x50, 0x45, 0x00, 0x00], 64);
  return bytes;
}

function fixture() {
  const stageRoot = root();
  const payloadRoot = join(stageRoot, "payload", "Keiko");
  const resourceRoot = payloadRoot;
  const supervisor = portableExecutable(6);
  const secureRead = portableExecutable(7);
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
  writeFileSync(join(payloadRoot, "Keiko.exe"), portableExecutable(1));
  const nodePath = join(resourceRoot, "runtime", "node", "node.exe");
  mkdirSync(dirname(nodePath), { recursive: true });
  writeFileSync(nodePath, portableExecutable(2));
  const sidecarRoot = join(resourceRoot, "runtime", "sidecars", "opencode-compatible");
  mkdirSync(sidecarRoot, { recursive: true });
  writeFileSync(join(sidecarRoot, "opencode.exe"), portableExecutable(9));
  writeFileSync(join(sidecarRoot, "LICENSE.txt"), "MIT");
  const sidecarDigest = hashDirectoryTree(sidecarRoot);
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
    sidecarRuntimes: [
      {
        name: "opencode-compatible",
        platformTarget: "windows-x64",
        payloadRootPath: "runtime/sidecars/opencode-compatible",
        payloadSha256: sidecarDigest,
      },
    ],
    releaseImpact: { entryId: "fixture" },
  };
  const activationPath = join(resourceRoot, ".portable", "runtime-activation.json");
  mkdirSync(dirname(activationPath), { recursive: true });
  writeFileSync(activationPath, `${JSON.stringify(activation)}\n`);
  const expectedInventoryPath = join(stageRoot, "inventory.json");
  writeFileSync(
    expectedInventoryPath,
    JSON.stringify(inventoryWindowsPortablePeFiles(resourceRoot)),
  );
  const manifest = { schemaVersion: 1 };
  const manifestPath = join(stageRoot, "manifest", "portable-manifest.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const verificationInputPath = join(stageRoot, "verification.json");
  writeFileSync(
    verificationInputPath,
    JSON.stringify({
      peInventorySha256: sha256(readFileSync(expectedInventoryPath)),
      reasonCodes: [],
      verificationChecks: { publisherChainVerified: true, timestampVerified: true },
      sidecarRuntimes: [
        {
          name: "opencode-compatible",
          payloadSha256: sidecarDigest,
          reasonCodes: [],
          verificationChecks: { publisherChainVerified: true, timestampVerified: true },
        },
      ],
    }),
  );
  return {
    activation,
    activationPath,
    expectedInventoryPath,
    resourceRoot,
    stageRoot,
    verificationInputPath,
  };
}

async function closedGenerationFixture() {
  const value = fixture();
  const payloadRoot = value.resourceRoot;
  const temporaryInner = join(value.stageRoot, "inner-generation");
  mkdirSync(join(temporaryInner, ".portable"), { recursive: true });
  renameSync(join(payloadRoot, "runtime"), join(temporaryInner, "runtime"));
  renameSync(value.activationPath, join(temporaryInner, ".portable", "runtime-activation.json"));
  rmSync(join(payloadRoot, ".portable"), { recursive: true });
  mkdirSync(join(payloadRoot, ".portable"), { recursive: true });
  renameSync(temporaryInner, join(payloadRoot, ".portable", "generation-staging"));
  const generationId = await closeWindowsGenerationDirectory(value.stageRoot);
  value.resourceRoot = join(payloadRoot, ".portable", "generations", generationId);
  value.activationPath = join(value.resourceRoot, ".portable", "runtime-activation.json");
  writeFileSync(
    value.expectedInventoryPath,
    JSON.stringify(inventoryWindowsPortableCorePeFiles(value.resourceRoot)),
  );
  const verification = JSON.parse(readFileSync(value.verificationInputPath, "utf8"));
  verification.peInventorySha256 = sha256(readFileSync(value.expectedInventoryPath));
  writeFileSync(value.verificationInputPath, JSON.stringify(verification));
  const manifest = {
    schemaVersion: 2,
    windowsGeneration: {
      schemaVersion: 1,
      resourceRoot: `.portable/generations/${generationId}`,
      treeHashSchema: "KHT1",
      treeSha256: generationId,
      launcherPath: "Keiko.exe",
      launcherSha256: sha256(readFileSync(join(payloadRoot, "Keiko.exe"))),
    },
  };
  writeFileSync(
    join(value.stageRoot, "manifest", "portable-manifest.json"),
    `${JSON.stringify(manifest)}\n`,
  );
  return value;
}

function receiptInput(value) {
  return {
    activationPath: value.activationPath,
    expectedInventoryPath: value.expectedInventoryPath,
    resourceRoot: value.resourceRoot,
    sourceCommitSha: COMMIT,
    verificationInputPath: value.verificationInputPath,
  };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Windows runtime qualification", () => {
  it("binds the exact activation, helper bytes, OpenCode payload, and backend", () => {
    const value = fixture();
    expect(qualificationReceiptFor(receiptInput(value))).toMatchObject({
      schemaVersion: 1,
      suiteVersion: RUNTIME_QUALIFICATION_SUITE,
      platformTarget: "windows-x64",
      sourceCommitSha: COMMIT,
      supervisorSha256: value.activation.nativeHelpers[0].shippedSha256,
      secureReadSha256: value.activation.nativeHelpers[1].shippedSha256,
      sidecars: [
        {
          name: "opencode-compatible",
          sha256: value.activation.sidecarRuntimes[0].payloadSha256,
        },
      ],
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
        "expected-inventory": value.expectedInventoryPath,
        "source-commit-sha": COMMIT,
        "verification-input": value.verificationInputPath,
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

  it("requalifies a fresh schema 2 artifact from its bound closed generation", async () => {
    const value = await closedGenerationFixture();
    const output = join(value.stageRoot, "qualification.json");
    const spawnSyncImpl = vi.fn(() => ({ status: 0 }));

    qualifyWindowsRuntimeRelease(
      {
        "stage-root": value.stageRoot,
        "expected-inventory": value.expectedInventoryPath,
        "source-commit-sha": COMMIT,
        "verification-input": value.verificationInputPath,
        output,
      },
      { platform: "win32", spawnSyncImpl },
    );

    expect(spawnSyncImpl.mock.calls[0][1]).toContain(
      join(value.resourceRoot, "runtime", "native", "keiko-runtime-supervisor.exe"),
    );
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ result: "passed" });
  });

  it("writes a receipt.json + artifact pair the #3390 checker reads (audit F8)", () => {
    const receiptsDir = root();
    writeQualificationEvidenceReceipt({
      receiptsDir,
      scenarioId: "packaged-windows-x64",
      receipt: { sourceCommitSha: COMMIT, platformTarget: "windows-x64", result: "passed" },
      recordedAt: "2026-09-04T12:00:00Z",
    });
    expect(
      JSON.parse(readFileSync(join(receiptsDir, "packaged-windows-x64.receipt.json"), "utf8")),
    ).toEqual({
      scenarioId: "packaged-windows-x64",
      commitSha: COMMIT,
      platform: "windows-x64",
      testStatus: "passed",
      recordedAt: "2026-09-04T12:00:00Z",
      provenance: "real-model",
    });
  });

  it("bridges a real qualification receipt into #3390 evidence when --qualification-receipts is set (audit F8)", () => {
    const value = fixture();
    const receiptsDir = root();
    const output = join(value.stageRoot, "evidence", "qualification.json");
    mkdirSync(dirname(output), { recursive: true });
    qualifyWindowsRuntimeRelease(
      {
        "stage-root": value.stageRoot,
        "expected-inventory": value.expectedInventoryPath,
        "qualification-receipts": receiptsDir,
        "scenario-id": "packaged-windows-x64",
        "source-commit-sha": COMMIT,
        "verification-input": value.verificationInputPath,
        output,
      },
      { platform: "win32", spawnSyncImpl: vi.fn(() => ({ status: 0 })) },
    );
    expect(
      JSON.parse(readFileSync(join(receiptsDir, "packaged-windows-x64.receipt.json"), "utf8")),
    ).toMatchObject({
      scenarioId: "packaged-windows-x64",
      commitSha: COMMIT,
      testStatus: "passed",
    });
  });

  it("requires --scenario-id when writing qualification evidence", () => {
    const value = fixture();
    const output = join(value.stageRoot, "evidence", "qualification.json");
    mkdirSync(dirname(output), { recursive: true });
    expect(() =>
      qualifyWindowsRuntimeRelease(
        {
          "stage-root": value.stageRoot,
          "expected-inventory": value.expectedInventoryPath,
          "qualification-receipts": root(),
          "source-commit-sha": COMMIT,
          "verification-input": value.verificationInputPath,
          output,
        },
        { platform: "win32", spawnSyncImpl: vi.fn(() => ({ status: 0 })) },
      ),
    ).toThrow("--scenario-id is required");
  });

  it("rejects wrong platforms, invalid options, failed protocols, and tampered helper bytes", () => {
    const value = fixture();
    const options = {
      "stage-root": value.stageRoot,
      "expected-inventory": value.expectedInventoryPath,
      "source-commit-sha": COMMIT,
      "verification-input": value.verificationInputPath,
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
    expect(() => qualificationReceiptFor(receiptInput(value))).toThrow(
      "an executable-named payload file is not valid PE",
    );
  });

  it("rejects malformed activation manifests and ambiguous helper or OpenCode sets", () => {
    const value = fixture();
    const assertInvalid = (mutate, message) => {
      const activation = structuredClone(value.activation);
      mutate(activation);
      writeFileSync(value.activationPath, `${JSON.stringify(activation)}\n`);
      expect(() => qualificationReceiptFor(receiptInput(value))).toThrow(message);
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
