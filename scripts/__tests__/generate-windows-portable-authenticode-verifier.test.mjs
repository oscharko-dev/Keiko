import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FRAMEWORK_REFERENCE_NAMES,
  assertPinnedToolchain,
  boundedDirectoryDigest,
  generateVerifierAsset,
  inspectVerifierToolchain,
  renderGeneratedVerifierAsset,
  verifierCompilerArguments,
} from "../generate-windows-portable-authenticode-verifier.mjs";

const roots = [];

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-authenticode-generator-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture() {
  const root = temporaryRoot();
  const compilerDirectory = join(root, "Roslyn");
  const referenceDirectory = join(root, "Reference Assemblies");
  const sourcePath = join(root, "verifier.cs");
  mkdirSync(join(compilerDirectory, "en"), { recursive: true });
  mkdirSync(referenceDirectory, { recursive: true });
  const compilerPath = join(compilerDirectory, "csc.exe");
  writeFileSync(compilerPath, "compiler");
  writeFileSync(join(compilerDirectory, "Microsoft.CodeAnalysis.dll"), "roslyn");
  writeFileSync(join(compilerDirectory, "en", "csc.resources.dll"), "resources");
  for (const name of FRAMEWORK_REFERENCE_NAMES) writeFileSync(join(referenceDirectory, name), name);
  writeFileSync(sourcePath, "namespace Keiko { public static class Probe {} }\n");
  const expectedToolchain = inspectVerifierToolchain({ compilerPath, referenceDirectory });
  return { compilerPath, expectedToolchain, referenceDirectory, sourcePath };
}

describe("Windows portable Authenticode verifier generator", () => {
  it("hashes every regular compiler-distribution member in stable relative-path order", () => {
    const { compilerPath } = fixture();
    const compilerDirectory = join(compilerPath, "..");
    const first = boundedDirectoryDigest(compilerDirectory);
    const second = boundedDirectoryDigest(compilerDirectory);
    expect(first).toEqual(second);
    expect(first.fileCount).toBe(3);

    writeFileSync(join(compilerDirectory, "Microsoft.CodeAnalysis.dll"), "changed");
    expect(boundedDirectoryDigest(compilerDirectory).sha256).not.toBe(first.sha256);
  });

  it("rejects empty and symlinked compiler-distribution trees", () => {
    const root = temporaryRoot();
    const emptyDirectory = join(root, "empty");
    mkdirSync(emptyDirectory);
    expect(() => boundedDirectoryDigest(emptyDirectory)).toThrow(/toolchain tree is empty/u);

    const { compilerPath } = fixture();
    const compilerDirectory = join(compilerPath, "..");
    symlinkSync(compilerPath, join(compilerDirectory, "compiler-link.exe"));
    expect(() => boundedDirectoryDigest(compilerDirectory)).toThrow(/symbolic links/u);
  });

  it("pins deterministic AnyCPU compilation without ambient response files or references", () => {
    const args = verifierCompilerArguments({
      outputPath: String.raw`C:\scratch\output\Keiko.Portable.Runtime.Authenticode.dll`,
      references: Object.fromEntries(
        FRAMEWORK_REFERENCE_NAMES.map((name) => [name, String.raw`C:\refs\${name}`]),
      ),
      scratchRoot: String.raw`C:\scratch`,
      sourcePath: String.raw`C:\scratch\source\windows-portable-authenticode-verifier.cs`,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "/noconfig",
        "/nostdlib+",
        "/deterministic+",
        "/debug-",
        "/target:library",
        "/platform:anycpu",
        "/langversion:5",
        String.raw`/pathmap:C:\scratch=/_/`,
      ]),
    );
    expect(args.filter((value) => value.startsWith("/reference:"))).toHaveLength(4);
  });

  it("rejects compiler-distribution and framework-reference drift", () => {
    const { expectedToolchain } = fixture();
    expect(() => assertPinnedToolchain(expectedToolchain, expectedToolchain)).not.toThrow();
    expect(() =>
      assertPinnedToolchain(
        { ...expectedToolchain, compilerSha256: "0".repeat(64) },
        expectedToolchain,
      ),
    ).toThrow(/compiler digest/u);
    expect(() =>
      assertPinnedToolchain(
        {
          ...expectedToolchain,
          compilerDistribution: {
            ...expectedToolchain.compilerDistribution,
            sha256: "0".repeat(64),
          },
        },
        expectedToolchain,
      ),
    ).toThrow(/compiler distribution/u);
    expect(() =>
      assertPinnedToolchain(
        {
          ...expectedToolchain,
          referenceSha256: {
            ...expectedToolchain.referenceSha256,
            "System.Security.dll": "0".repeat(64),
          },
        },
        expectedToolchain,
      ),
    ).toThrow(/System.Security.dll digest/u);
  });

  it.each([
    ["compiler", (toolchain) => ({ ...toolchain, compilerSha256: "A".repeat(64) })],
    [
      "compiler distribution",
      (toolchain) => ({
        ...toolchain,
        compilerDistribution: { ...toolchain.compilerDistribution, sha256: "A".repeat(64) },
      }),
    ],
    [
      "framework reference",
      (toolchain) => ({
        ...toolchain,
        referenceSha256: { ...toolchain.referenceSha256, "System.dll": "A".repeat(64) },
      }),
    ],
  ])("rejects a noncanonical reviewed %s SHA-256 pin", (_label, mutateExpected) => {
    const { expectedToolchain } = fixture();

    expect(() =>
      assertPinnedToolchain(expectedToolchain, mutateExpected(expectedToolchain)),
    ).toThrow(/must be a lowercase SHA-256 digest/u);
  });

  it.each([
    ["a UTF-8 BOM", "\ufeffnamespace Keiko { public static class Probe {} }\n"],
    ["CRLF line endings", "namespace Keiko { public static class Probe {} }\r\n"],
    ["a missing trailing newline", "namespace Keiko { public static class Probe {} }"],
  ])("rejects verifier source with %s before starting the compiler", (_label, source) => {
    const fixtureData = fixture();
    writeFileSync(fixtureData.sourcePath, source);
    const spawn = vi.fn();

    expect(() => generateVerifierAsset({ ...fixtureData, spawn })).toThrow(/verifier source/u);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails closed when the deterministic compiler exits unsuccessfully", () => {
    const fixtureData = fixture();
    const spawn = vi.fn(() => ({ status: 1, stderr: "compile error", stdout: "" }));

    expect(() => generateVerifierAsset({ ...fixtureData, spawn })).toThrow(
      /deterministic verifier compilation failed \(1\)/u,
    );
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("fails closed when the deterministic compiler cannot start", () => {
    const fixtureData = fixture();
    const spawn = vi.fn(() => ({
      error: Object.assign(new Error("not found"), { code: "ENOENT" }),
    }));

    expect(() => generateVerifierAsset({ ...fixtureData, spawn })).toThrow(
      /deterministic verifier compilation failed \(ENOENT\)/u,
    );
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("emits a byte-stable asset and bounds the compiler subprocess", () => {
    const fixtureData = fixture();
    const assembly = Buffer.from("deterministic-assembly");
    const spawn = vi.fn((_command, args, _options) => {
      const output = args.find((value) => value.startsWith("/out:"));
      if (output === undefined) throw new Error("missing output argument");
      writeFileSync(output.slice("/out:".length), assembly);
      return { status: 0, stderr: "", stdout: "" };
    });
    const first = generateVerifierAsset({ ...fixtureData, spawn });
    const second = generateVerifierAsset({ ...fixtureData, spawn });
    expect(first.assembly).toEqual(assembly);
    expect(first.asset).toBe(second.asset);
    expect(first.asset).toBe(
      renderGeneratedVerifierAsset({
        assembly,
        source: "namespace Keiko { public static class Probe {} }\n",
        toolchain: fixtureData.expectedToolchain,
      }),
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ maxBuffer: 1024 * 1024, shell: false, timeout: 60_000 }),
    );
  });
});
import { Buffer } from "node:buffer";
