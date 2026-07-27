import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildWindowsRuntimeAttestationCarrier,
  generateWindowsRuntimeAttestation,
  windowsBuildToolchain,
} from "../generate-windows-runtime-attestation.mjs";
import { RUNTIME_QUALIFICATION_SUITE } from "../runtime-activation-manifest.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const roots = [];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function root() {
  const value = mkdtempSync(join(tmpdir(), "keiko-windows-runtime-attestation-"));
  roots.push(value);
  return value;
}

function fixture() {
  const stageRoot = root();
  const activation = Buffer.from('{"schemaVersion":1}\n');
  const activationPath = join(
    stageRoot,
    "payload",
    "Keiko",
    ".portable",
    "runtime-activation.json",
  );
  mkdirSync(dirname(activationPath), { recursive: true });
  writeFileSync(activationPath, activation);
  const manifestPath = join(stageRoot, "manifest", "portable-manifest.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, '{"schemaVersion":1}\n');
  const receipt = {
    schemaVersion: 1,
    suiteVersion: RUNTIME_QUALIFICATION_SUITE,
    platformTarget: "windows-x64",
    sourceCommitSha: COMMIT,
    activationManifestSha256: sha256(activation),
    supervisorSha256: "a".repeat(64),
    secureReadSha256: "b".repeat(64),
    sidecars: [{ name: "opencode-compatible", sha256: "c".repeat(64) }],
    backend: "windows-job-object",
    result: "passed",
  };
  const receiptPath = join(stageRoot, "receipt.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  return { manifestPath, receipt, receiptPath, stageRoot };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Windows runtime attestation carrier", () => {
  it("binds a validated qualification receipt to the generated carrier and catalog", () => {
    const value = fixture();
    const catalog = join(value.stageRoot, "attestation-catalog.txt");
    const buildCarrierFn = vi.fn((destination) => {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, "signed-later\n");
    });
    generateWindowsRuntimeAttestation(
      {
        "stage-root": value.stageRoot,
        receipt: value.receiptPath,
        catalog,
      },
      { buildCarrierFn, platform: "win32" },
    );
    expect(buildCarrierFn).toHaveBeenCalledWith(expect.stringMatching(/attestation\.exe$/u), {
      ...value.receipt,
    });
    const manifest = JSON.parse(readFileSync(value.manifestPath, "utf8"));
    expect(manifest.runtimeAttestation).toMatchObject({
      carrierKind: "authenticode-executable",
      executablePath: "runtime/native/keiko-runtime-attestation.exe",
      signing: {
        signatureKind: "authenticode",
        verificationStatus: "unverified-staging",
        signatureVerified: false,
      },
    });
    expect(readFileSync(catalog, "utf8")).toBe(
      "payload/Keiko/runtime/native/keiko-runtime-attestation.exe\n",
    );
  });

  it("builds the carrier with a generated bounded header and removes scratch state", () => {
    const value = fixture();
    const destination = join(value.stageRoot, "carrier.exe");
    const spawnSyncImpl = vi.fn((_compiler, args) => {
      const include = args.find((arg) => arg.startsWith("/I")).slice(2);
      expect(readFileSync(join(include, "runtime_attestation_payload.h"), "utf8")).toContain(
        "KEIKO_RUNTIME_ATTESTATION_LENGTH",
      );
      writeFileSync(destination, "carrier\n");
      return { status: 0 };
    });
    buildWindowsRuntimeAttestationCarrier(destination, value.receipt, {
      spawnSyncImpl,
      toolchain: {
        compiler: String.raw`C:\Program Files\MSVC\bin\cl.exe`,
        environment: { PATH: String.raw`C:\Program Files\MSVC\bin` },
      },
    });
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      String.raw`C:\Program Files\MSVC\bin\cl.exe`,
      expect.arrayContaining(["/std:c11", `/Fe:${destination}`]),
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(readFileSync(destination, "utf8")).toBe("carrier\n");
  });

  it("accepts only real single-link MSVC binaries under fixed system roots", () => {
    const compiler = String.raw`C:\Program Files\MSVC\bin\cl.exe`;
    const lstat = vi.fn(() => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      nlink: 1,
    }));
    expect(
      windowsBuildToolchain(
        {
          PATH: [
            String.raw`C:\Users\attacker\bin`,
            String.raw`C:\Program Files\MSVC\bin`,
            String.raw`C:\Windows\System32`,
          ].join(win32.delimiter),
          INCLUDE: String.raw`C:\Program Files\MSVC\include`,
        },
        { lstat, realpath: (path) => path },
      ),
    ).toEqual({
      compiler,
      environment: {
        PATH: [String.raw`C:\Program Files\MSVC\bin`, String.raw`C:\Windows\System32`].join(
          win32.delimiter,
        ),
        INCLUDE: String.raw`C:\Program Files\MSVC\include`,
      },
    });
    expect(() =>
      windowsBuildToolchain(
        { PATH: String.raw`C:\Users\attacker\bin` },
        { lstat, realpath: (path) => path },
      ),
    ).toThrow("approved MSVC compiler path is unavailable");
  });

  it("rejects unsupported platforms, invalid receipts, stale activation binding, and failed builds", () => {
    const value = fixture();
    const options = {
      "stage-root": value.stageRoot,
      receipt: value.receiptPath,
      catalog: join(value.stageRoot, "catalog.txt"),
    };
    expect(() => generateWindowsRuntimeAttestation(options, { platform: "darwin" })).toThrow(
      "generation requires Windows",
    );
    writeFileSync(value.receiptPath, '{"schemaVersion":2}\n');
    expect(() =>
      generateWindowsRuntimeAttestation(options, {
        buildCarrierFn: vi.fn(),
        platform: "win32",
      }),
    ).toThrow("qualification receipt is invalid");

    writeFileSync(
      value.receiptPath,
      `${JSON.stringify({ ...value.receipt, activationManifestSha256: "d".repeat(64) })}\n`,
    );
    expect(() =>
      generateWindowsRuntimeAttestation(options, {
        buildCarrierFn: vi.fn(),
        platform: "win32",
      }),
    ).toThrow("qualification receipt activation binding is stale");

    const destination = join(value.stageRoot, "failed.exe");
    expect(() =>
      buildWindowsRuntimeAttestationCarrier(destination, value.receipt, {
        spawnSyncImpl: () => ({ status: 1 }),
        toolchain: { compiler: "cl.exe", environment: {} },
      }),
    ).toThrow("native attestation carrier build failed");
  });
});
