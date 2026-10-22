import { Buffer } from "node:buffer";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMMITTED_VERIFIER_ASSET,
  REVIEWED_WINDOWS_2025_VS2026_TOOLCHAIN,
  assertCommittedVerifierAsset,
  discoverTrustedVerifierToolchain,
  executeCheckCli,
  resolveTrustedVerifierToolchain,
  selectReviewedVerifierToolchain,
} from "../check-windows-portable-authenticode-verifier.mjs";

const roots = [];

function trustedToolchainFixture() {
  const root = mkdtempSync(join(tmpdir(), "keiko-verifier-cli-test-"));
  roots.push(root);
  const programFiles = join(root, "Program Files");
  const programFilesX86 = join(root, "Program Files (x86)");
  const compilerPath = join(
    programFiles,
    "Microsoft Visual Studio",
    "2022",
    "Enterprise",
    "MSBuild",
    "Current",
    "Bin",
    "Roslyn",
    "csc.exe",
  );
  const referenceDirectory = join(
    programFilesX86,
    "Reference Assemblies",
    "Microsoft",
    "Framework",
    ".NETFramework",
    "v4.8.1",
  );
  const installationPath = join(programFiles, "Microsoft Visual Studio", "2022", "Enterprise");
  const vswherePath = join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  mkdirSync(join(compilerPath, ".."), { recursive: true });
  mkdirSync(referenceDirectory, { recursive: true });
  mkdirSync(join(vswherePath, ".."), { recursive: true });
  writeFileSync(compilerPath, "reviewed compiler");
  writeFileSync(vswherePath, "reviewed locator");
  return {
    compilerPath,
    environment: { ProgramFiles: programFiles, "ProgramFiles(x86)": programFilesX86 },
    installationPath,
    referenceDirectory,
    vswherePath,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("committed Windows portable Authenticode verifier asset", () => {
  it("preserves the pin failure when optional toolchain inspection fails", () => {
    const pinError = new Error(
      "C# compiler digest does not match the reviewed generated-asset pin",
    );
    const diagnostics = [];
    expect(() =>
      executeCheckCli({
        discover: () => ({ compilerPath: "/trusted/csc", referenceDirectory: "/trusted/refs" }),
        check: () => {
          throw pinError;
        },
        inspect: () => {
          throw new Error("diagnostic read failed");
        },
        writeError: (line) => diagnostics.push(line),
        writeOutput: () => {
          throw new Error("success must not be reported");
        },
      }),
    ).toThrow(pinError);
    expect(diagnostics).toEqual(["windows-verifier-toolchain: inspection-unavailable\n"]);
  });

  it("reports a reviewed fingerprint but still throws the original pin failure", () => {
    const pinError = new Error(
      "C# compiler digest does not match the reviewed generated-asset pin",
    );
    const fingerprint = { compilerSha256: "a".repeat(64) };
    const output = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() =>
        executeCheckCli({
          discover: () => ({ compilerPath: "/trusted/csc", referenceDirectory: "/trusted/refs" }),
          check: () => {
            throw pinError;
          },
          inspect: () => fingerprint,
        }),
      ).toThrow(pinError);
      expect(output).toHaveBeenCalledWith(
        `windows-verifier-toolchain: ${JSON.stringify(fingerprint)}\n`,
      );
    } finally {
      output.mockRestore();
    }
  });

  it("does not inspect unrelated failures or report success", () => {
    const failure = new Error("unrelated verifier failure");
    const inspect = vi.fn();
    const writeError = vi.fn();
    const writeOutput = vi.fn();
    expect(() =>
      executeCheckCli({
        discover: () => ({ compilerPath: "/trusted/csc", referenceDirectory: "/trusted/refs" }),
        check: () => {
          throw failure;
        },
        inspect,
        writeError,
        writeOutput,
      }),
    ).toThrow(failure);
    expect(inspect).not.toHaveBeenCalled();
    expect(writeError).not.toHaveBeenCalled();
    expect(writeOutput).not.toHaveBeenCalled();
  });

  it("reports a verified success", () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      executeCheckCli({
        discover: () => ({ compilerPath: "/trusted/csc", referenceDirectory: "/trusted/refs" }),
        check: () => undefined,
      });
      expect(output).toHaveBeenCalledWith("windows-portable-authenticode-verifier: PASS\n");
    } finally {
      output.mockRestore();
    }
  });

  it("accepts the reviewed updated compiler only with its exact distribution and references", () => {
    expect(selectReviewedVerifierToolchain(REVIEWED_WINDOWS_2025_VS2026_TOOLCHAIN)).toBe(
      REVIEWED_WINDOWS_2025_VS2026_TOOLCHAIN,
    );
    expect(() =>
      selectReviewedVerifierToolchain({
        ...REVIEWED_WINDOWS_2025_VS2026_TOOLCHAIN,
        compilerDistribution: {
          ...REVIEWED_WINDOWS_2025_VS2026_TOOLCHAIN.compilerDistribution,
          sha256: "0".repeat(64),
        },
      }),
    ).toThrow(/reviewed generated-asset pin/u);
    expect(() =>
      selectReviewedVerifierToolchain({
        ...REVIEWED_WINDOWS_2025_VS2026_TOOLCHAIN,
        compilerSha256: "0".repeat(64),
      }),
    ).toThrow(/reviewed generated-asset pin/u);
  });

  it("admits only the observed October compiler candidate for byte-equality checking", () => {
    const observed = {
      compilerSha256: "a13d1edf3ef5dd0d0e09886251f03fa18877d46ba2dacee075b4c8a5add21457",
      compilerDistribution: {
        fileCount: 111,
        sha256: "6d96789fadf839936d7e980a511d8d1b19a13d4691a338531fc4dc13650dce6a",
        totalBytes: 36401120,
      },
      referenceSha256: {
        "mscorlib.dll": "1eb7ab99447ceed5ec717c97b94c4aec5da1edeef9fe4989c287355e03a8f58f",
        "System.dll": "3fba2c9ab7f1538d09d3a025730da545f3dc24af0b6b74ea5f92cc7768edd5d5",
        "System.Core.dll": "0c5a6f6527a4ebda1d105809c48c0577b316d75d5fd04177a5a0e54f1e4cff59",
        "System.Security.dll": "fbd98d2027a174137b3dc8c7ba4fda4606c7c8506e35781ede74703676321844",
      },
    };
    expect(selectReviewedVerifierToolchain(observed)).toEqual(observed);
    expect(() =>
      selectReviewedVerifierToolchain({
        ...observed,
        compilerDistribution: { ...observed.compilerDistribution, fileCount: 112 },
      }),
    ).toThrow(/reviewed generated-asset pin/u);
    expect(() =>
      selectReviewedVerifierToolchain({
        ...observed,
        referenceSha256: { ...observed.referenceSha256, "System.dll": "0".repeat(64) },
      }),
    ).toThrow(/reviewed generated-asset pin/u);
  });

  it("binds the canonical source and exact assembly bytes to SHA-256", () => {
    expect(assertCommittedVerifierAsset(COMMITTED_VERIFIER_ASSET)).toHaveLength(
      COMMITTED_VERIFIER_ASSET.assemblyByteLength,
    );
  });

  it("rejects corrupt, truncated, and source-mismatched generated assets", () => {
    const bytes = Buffer.from(COMMITTED_VERIFIER_ASSET.assemblyBase64, "base64");
    const corrupt = Buffer.from(bytes);
    corrupt[Math.floor(corrupt.length / 2)] ^= 0xff;
    expect(() =>
      assertCommittedVerifierAsset({
        ...COMMITTED_VERIFIER_ASSET,
        assemblyBase64: corrupt.toString("base64"),
      }),
    ).toThrow(/assembly digest/u);
    expect(() =>
      assertCommittedVerifierAsset({
        ...COMMITTED_VERIFIER_ASSET,
        assemblyBase64: bytes.subarray(0, bytes.length - 1).toString("base64"),
      }),
    ).toThrow(/assembly digest/u);
    expect(() =>
      assertCommittedVerifierAsset({
        ...COMMITTED_VERIFIER_ASSET,
        source: `${COMMITTED_VERIFIER_ASSET.source}\n`,
      }),
    ).toThrow(/source digest/u);
  });

  it("rejects malformed compiler and framework-reference pins before regeneration", () => {
    expect(() =>
      assertCommittedVerifierAsset({
        ...COMMITTED_VERIFIER_ASSET,
        compilerDistribution: null,
      }),
    ).toThrow(/compiler-distribution pin/u);
    expect(() =>
      assertCommittedVerifierAsset({
        ...COMMITTED_VERIFIER_ASSET,
        referenceSha256: {
          ...COMMITTED_VERIFIER_ASSET.referenceSha256,
          "System.Core.dll": "not-a-digest",
        },
      }),
    ).toThrow(/System.Core.dll pin/u);
  });

  it("accepts only canonical toolchain paths inside the approved Windows system roots", () => {
    const fixture = trustedToolchainFixture();
    expect(resolveTrustedVerifierToolchain(fixture, fixture.environment)).toEqual({
      compilerPath: realpathSync(fixture.compilerPath),
      referenceDirectory: realpathSync(fixture.referenceDirectory),
    });
    expect(() =>
      resolveTrustedVerifierToolchain(
        { ...fixture, compilerPath: join(fixture.compilerPath, "..", "..", "other.exe") },
        fixture.environment,
      ),
    ).toThrow(/approved Visual Studio toolchain layout/u);
    expect(() =>
      resolveTrustedVerifierToolchain(
        {
          ...fixture,
          compilerPath: join(fixture.environment.ProgramFiles, "..", "attacker", "csc.exe"),
        },
        fixture.environment,
      ),
    ).toThrow(/approved system root/u);
    expect(() =>
      resolveTrustedVerifierToolchain(
        { ...fixture, referenceDirectory: join(fixture.referenceDirectory, "..") },
        fixture.environment,
      ),
    ).toThrow(/approved .NET Framework 4.8.1 path/u);
  });

  it("discovers the pinned toolchain without accepting command-line paths", () => {
    const fixture = trustedToolchainFixture();
    const run = vi.fn().mockReturnValue({
      status: 0,
      stderr: "",
      stdout: `${fixture.installationPath}\r\n`,
    });

    expect(discoverTrustedVerifierToolchain(fixture.environment, run)).toEqual({
      compilerPath: realpathSync(fixture.compilerPath),
      referenceDirectory: realpathSync(fixture.referenceDirectory),
    });
    expect(run).toHaveBeenCalledWith(
      realpathSync(fixture.vswherePath),
      expect.arrayContaining(["-latest", "-requires", "Microsoft.Component.MSBuild"]),
      expect.objectContaining({ shell: false }),
    );
  });

  it.each([
    ["non-base64 assembly text", { assemblyBase64: "not base64!" }, /assembly encoding/u],
    ["a zero assembly byte length", { assemblyByteLength: 0 }, /assembly encoding/u],
    ["a noncanonical assembly digest", { assemblySha256: "A".repeat(64) }, /assembly digest/u],
    ["a noncanonical source digest", { sourceSha256: "A".repeat(64) }, /source digest/u],
    ["a noncanonical compiler digest", { compilerSha256: "A".repeat(64) }, /compiler pin/u],
    [
      "an empty compiler distribution receipt",
      {
        compilerDistribution: {
          ...COMMITTED_VERIFIER_ASSET.compilerDistribution,
          fileCount: 0,
        },
      },
      /compiler-distribution pin/u,
    ],
    [
      "a missing framework-reference receipt",
      {
        referenceSha256: {
          ...COMMITTED_VERIFIER_ASSET.referenceSha256,
          "System.dll": undefined,
        },
      },
      /System\.dll pin/u,
    ],
  ])("rejects %s", (_label, override, expectedError) => {
    expect(() =>
      assertCommittedVerifierAsset({
        ...COMMITTED_VERIFIER_ASSET,
        ...override,
      }),
    ).toThrow(expectedError);
  });
});
