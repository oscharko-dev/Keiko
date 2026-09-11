import { Buffer } from "node:buffer";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMMITTED_VERIFIER_ASSET,
  assertCommittedVerifierAsset,
  discoverTrustedVerifierToolchain,
  resolveTrustedVerifierToolchain,
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
