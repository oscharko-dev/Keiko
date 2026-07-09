import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateInstallMode } from "@oscharko-dev/keiko-contracts";
import { createUpdateLocalStateManager } from "./update-local-state.js";
import { createPortableUpdateStager } from "./update-portable-staging.js";
import {
  assertPortableArchiveEntryLimits,
  type PortableArchiveLimitState,
} from "./update-portable-staging-archive.js";
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_INFLATE_RATIO,
  MAX_UNCOMPRESSED_BYTES,
  PortableUpdateStagingError,
} from "./update-portable-staging-shared.js";

const ENC = new TextEncoder();
const TARGET_VERSION = "0.2.11";
const RELEASE_ID = 987_654_321;
const ASSET_ID = 42;
const TARGET = "windows-x64";
const ASSET_NAME = "keiko-windows-x64.zip";
const MACOS_ARM64_ASSET_NAME = "keiko-macos-arm64.zip";
const MACOS_X64_ASSET_NAME = "keiko-macos-x64.zip";
const SIDECAR_ROOT = "runtime/sidecars/opencode-compatible";
const tempRoots: string[] = [];

const CRC32_TABLE: Uint32Array = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (CRC32_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function u16le(value: number): readonly [number, number] {
  return [value & 0xff, (value >>> 8) & 0xff];
}
function u32le(value: number): readonly [number, number, number, number] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}
function localHeader(name: Uint8Array, size: number, crc: number): number[] {
  return [
    0x50,
    0x4b,
    0x03,
    0x04,
    ...u16le(20),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u32le(crc),
    ...u32le(size),
    ...u32le(size),
    ...u16le(name.length),
    ...u16le(0),
    ...name,
  ];
}

function centralHeader(name: Uint8Array, size: number, crc: number, offset: number): number[] {
  return [
    0x50,
    0x4b,
    0x01,
    0x02,
    ...u16le(20),
    ...u16le(20),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u32le(crc),
    ...u32le(size),
    ...u32le(size),
    ...u16le(name.length),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u32le(0),
    ...u32le(offset),
    ...name,
  ];
}

function zipEntries(
  entries: readonly { readonly name: string; readonly bytes: Uint8Array }[],
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: number[][] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = ENC.encode(entry.name);
    const crc = crc32(entry.bytes);
    const local = Uint8Array.from(localHeader(name, entry.bytes.length, crc));
    chunks.push(local, entry.bytes);
    central.push(centralHeader(name, entry.bytes.length, crc, offset));
    offset += local.length + entry.bytes.length;
  }
  return zipBytes(chunks, central, offset);
}

function zipBytes(
  chunks: readonly Uint8Array[],
  central: readonly number[][],
  offset: number,
): Uint8Array {
  const centralFlat = Uint8Array.from(central.flatMap((entry) => entry));
  const eocd = Uint8Array.from([
    0x50,
    0x4b,
    0x05,
    0x06,
    ...u16le(0),
    ...u16le(0),
    ...u16le(central.length),
    ...u16le(central.length),
    ...u32le(centralFlat.length),
    ...u32le(offset),
    ...u16le(0),
  ]);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, centralFlat.length + eocd.length);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...chunks, centralFlat, eocd]) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sidecarFiles(): readonly { readonly relativePath: string; readonly bytes: Uint8Array }[] {
  return [
    { relativePath: "LICENSE.txt", bytes: ENC.encode("sidecar license") },
    { relativePath: "evidence/sbom.cdx.json", bytes: ENC.encode('{"bomFormat":"CycloneDX"}') },
    { relativePath: "opencode.cmd", bytes: ENC.encode("@echo off\r\n") },
  ];
}

function sidecarPayloadSha256(
  files: readonly { readonly relativePath: string; readonly bytes: Uint8Array }[],
): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : 1,
  )) {
    hash.update(`${file.relativePath}\0${sha256(file.bytes)}\0`);
  }
  return hash.digest("hex");
}

function sidecarArchiveEntries(
  files: readonly { readonly relativePath: string; readonly bytes: Uint8Array }[],
): readonly { readonly name: string; readonly bytes: Uint8Array }[] {
  return files.map((file) => ({
    name: `Keiko/${SIDECAR_ROOT}/${file.relativePath}`,
    bytes: file.bytes,
  }));
}

function sidecarFileSha256(
  files: readonly { readonly relativePath: string; readonly bytes: Uint8Array }[],
  relativePath: string,
): string {
  const file = files.find((candidate) => candidate.relativePath === relativePath);
  if (file === undefined) throw new Error(`missing sidecar fixture file: ${relativePath}`);
  return sha256(file.bytes);
}

function sidecarRuntime(
  files: readonly { readonly relativePath: string; readonly bytes: Uint8Array }[],
  payloadSha256 = sidecarPayloadSha256(files),
): Record<string, unknown> {
  return {
    name: "opencode-compatible",
    kind: "coding-runtime",
    upstream: { name: "OpenCode-compatible", version: "1.0.0" },
    adapterCompatibility: {
      adapterName: "keiko-coding-sidecar",
      adapterVersion: "1",
      protocolVersion: "coding-sidecar-v1",
    },
    platformTarget: TARGET,
    payloadRootPath: SIDECAR_ROOT,
    executablePath: `${SIDECAR_ROOT}/opencode.cmd`,
    payloadSha256,
    sizeBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
    licenseEvidence: {
      path: `${SIDECAR_ROOT}/LICENSE.txt`,
      sha256: sidecarFileSha256(files, "LICENSE.txt"),
    },
    sbomEvidence: {
      path: `${SIDECAR_ROOT}/evidence/sbom.cdx.json`,
      sha256: sidecarFileSha256(files, "evidence/sbom.cdx.json"),
    },
    signing: {
      verificationPolicy: "production",
      verificationStatus: "verified-production",
      verificationReasonCodes: [],
      signatureKind: "authenticode",
      signatureVerified: true,
      notarizationRequired: false,
      notarizationVerified: false,
      verificationChecks: { publisherChainVerified: true, timestampVerified: true },
    },
  };
}

function setupManifest(): string {
  return JSON.stringify({
    schemaVersion: 1,
    platformTarget: TARGET,
    packageName: "@oscharko-dev/keiko",
    packageVersion: TARGET_VERSION,
    stable: true,
    primaryLauncher: "Keiko.exe",
    bootstrapUpdateEligible: false,
    runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
  });
}

function portableArchive(
  extraEntries: readonly { readonly name: string; readonly bytes: Uint8Array }[] = [],
): Uint8Array {
  return zipEntries([
    { name: "Keiko/Keiko.exe", bytes: ENC.encode("launcher") },
    { name: "Keiko/.portable/setup-manifest.json", bytes: ENC.encode(setupManifest()) },
    {
      name: "Keiko/app/package.json",
      bytes: ENC.encode(JSON.stringify({ name: "@oscharko-dev/keiko", version: TARGET_VERSION })),
    },
    { name: "Keiko/runtime/node/node.exe", bytes: ENC.encode("node") },
    ...extraEntries,
  ]);
}

function portableMode(): UpdateInstallMode {
  return {
    schemaVersion: "1",
    status: "supported",
    packageName: "@oscharko-dev/keiko",
    installKind: "portable-managed",
    portable: {
      status: "managed",
      target: TARGET,
      updateEligible: true,
      packageVersion: "0.2.10",
      stable: true,
    },
    recommendedAction: "portable-managed-update",
  };
}

function assetUrl(name: string): string {
  return `https://github.com/oscharko-dev/Keiko/releases/download/v${TARGET_VERSION}/${name}`;
}

function redirectedAssetUrl(name: string): string {
  return `https://objects.githubusercontent.com/github-production-release-asset/${name}`;
}

function release(sizeBytes: number): Record<string, unknown> {
  return {
    id: RELEASE_ID,
    tag_name: `v${TARGET_VERSION}`,
    draft: false,
    prerelease: false,
    assets: [
      {
        id: ASSET_ID,
        name: ASSET_NAME,
        size: sizeBytes,
        browser_download_url: assetUrl(ASSET_NAME),
      },
      {
        id: 201,
        name: MACOS_ARM64_ASSET_NAME,
        size: 128_001,
        browser_download_url: assetUrl(MACOS_ARM64_ASSET_NAME),
      },
      {
        id: 202,
        name: MACOS_X64_ASSET_NAME,
        size: 128_002,
        browser_download_url: assetUrl(MACOS_X64_ASSET_NAME),
      },
      {
        id: 101,
        name: `${TARGET}-portable-manifest.json`,
        size: 2048,
        browser_download_url: assetUrl(`${TARGET}-portable-manifest.json`),
      },
      {
        id: 102,
        name: `${TARGET}-SHA256SUMS.txt`,
        size: 128,
        browser_download_url: assetUrl(`${TARGET}-SHA256SUMS.txt`),
      },
    ],
  };
}

function portableManifest(
  archiveBytes: Uint8Array,
  archiveSha = sha256(archiveBytes),
  sidecarRuntimes: readonly Record<string, unknown>[] = [],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    product: { name: "Keiko", packageName: "@oscharko-dev/keiko", packageVersion: TARGET_VERSION },
    release: {
      releaseId: RELEASE_ID,
      releaseTag: `v${TARGET_VERSION}`,
      stable: true,
      commitSha: "c".repeat(40),
    },
    artifact: {
      platformTarget: TARGET,
      assetId: ASSET_ID,
      assetName: ASSET_NAME,
      archiveFormat: "zip",
      sizeBytes: archiveBytes.length,
      sha256: archiveSha,
    },
    runtime: {
      nodeVersion: "22.23.1",
      nodePlatform: "win32",
      nodeArchitecture: "x64",
      nodeDistribution: "official-nodejs-dist",
      nodeArchiveSha256: "d".repeat(64),
    },
    security: {
      verificationPolicy: "production",
      verificationStatus: "verified-production",
      verificationReasonCodes: [],
      signatureKind: "authenticode",
      signatureVerified: true,
      notarizationRequired: false,
      notarizationVerified: false,
      verificationChecks: { publisherChainVerified: true, timestampVerified: true },
    },
    releaseImpact: {
      entryPackageVersion: TARGET_VERSION,
      entryReleaseTag: `v${TARGET_VERSION}`,
      reviewedBinding: {
        releaseId: RELEASE_ID,
        assetId: ASSET_ID,
        assetName: ASSET_NAME,
        assetSizeBytes: archiveBytes.length,
        platformTarget: TARGET,
        packageVersion: TARGET_VERSION,
        archiveSha256: archiveSha,
        platformSignatureLocallyVerified: true,
        ...(sidecarRuntimes.length > 0 ? { sidecarRuntimes } : {}),
      },
    },
    ...(sidecarRuntimes.length > 0 ? { sidecarRuntimes } : {}),
    updateEligibility: {
      stableOnly: true,
      rollbackSupported: false,
      eligibleAfterSetupOnly: true,
      requiredPredicates: {
        artifactShaVerified: true,
        manifestReleaseImpactBound: true,
        platformSignatureLocallyVerified: true,
      },
    },
  });
}

function responseFor(
  archiveBytes: Uint8Array,
  manifestText = portableManifest(archiveBytes),
  releaseRecord: Record<string, unknown> = release(archiveBytes.length),
): typeof fetch {
  return vi.fn<typeof fetch>((input) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url);
    if (url.endsWith("/releases/latest")) return Promise.resolve(Response.json(releaseRecord));
    if (parsed.hostname === "github.com") {
      const name = parsed.pathname.split("/").at(-1);
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: name === undefined ? "" : redirectedAssetUrl(name) },
        }),
      );
    }
    if (url.endsWith(`${TARGET}-portable-manifest.json`))
      return Promise.resolve(new Response(manifestText));
    if (url.endsWith(`${TARGET}-SHA256SUMS.txt`)) {
      return Promise.resolve(new Response(`${sha256(archiveBytes)}  ${ASSET_NAME}\n`));
    }
    if (url.endsWith(ASSET_NAME)) return Promise.resolve(new Response(Buffer.from(archiveBytes)));
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

function releaseWithout(assetName: string, archiveBytes: Uint8Array): Record<string, unknown> {
  const base = release(archiveBytes.length);
  return {
    ...base,
    assets: (base.assets as readonly Record<string, unknown>[]).filter(
      (asset) => asset.name !== assetName,
    ),
  };
}

function makeManagedInstall(): {
  readonly root: string;
  readonly stateDir: string;
  readonly packageRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-portable-stager-"));
  tempRoots.push(root);
  const managedRoot = join(root, "Programs", "Keiko");
  const packageRoot = join(managedRoot, "app");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(managedRoot, "active.txt"), "active", "utf8");
  return { root: managedRoot, stateDir: join(root, ".keiko"), packageRoot };
}

async function verifyPlatform(): Promise<void> {
  return Promise.resolve();
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("portable archive limit guards", () => {
  function expectLimitFailure(
    state: PortableArchiveLimitState,
    entry: { readonly compressedSize: number; readonly uncompressedSize: number },
  ): void {
    expect(() => {
      assertPortableArchiveEntryLimits(entry, state);
    }).toThrow(PortableUpdateStagingError);
  }

  it("rejects entry count, total size, per-entry size, and inflate-ratio overages", () => {
    expectLimitFailure(
      { entries: MAX_ARCHIVE_ENTRIES, inflated: 0 },
      { compressedSize: 0, uncompressedSize: 0 },
    );
    expectLimitFailure(
      { entries: 0, inflated: MAX_UNCOMPRESSED_BYTES },
      { compressedSize: 1, uncompressedSize: 1 },
    );
    expectLimitFailure(
      { entries: 0, inflated: 0 },
      { compressedSize: 1, uncompressedSize: MAX_ENTRY_BYTES + 1 },
    );
    expectLimitFailure(
      { entries: 0, inflated: 0 },
      { compressedSize: 1, uncompressedSize: MAX_INFLATE_RATIO + 1 },
    );
  });
});

describe("portable update staging", () => {
  it("downloads, verifies, stages, and records content-free state", async () => {
    const archive = portableArchive();
    const install = makeManagedInstall();
    const localState = createUpdateLocalStateManager({ stateDir: install.stateDir });
    const stager = createPortableUpdateStager({
      env: {},
      localState,
      fetchImpl: responseFor(archive),
      platformVerifier: verifyPlatform,
    });

    const summary = await stager.stage({
      sessionId: "session-1",
      targetVersion: TARGET_VERSION,
      installMode: portableMode(),
      runtimeFacts: { packageRoot: install.packageRoot },
    });

    const stageRoot = join(dirname(install.root), ".keiko-portable-updates", summary.stageId);
    expect(existsSync(join(stageRoot, "Keiko", "Keiko.exe"))).toBe(true);
    expect(existsSync(join(stageRoot, "Keiko", "runtime", "node", "node.exe"))).toBe(true);
    expect(localState.readRuntimeState().portableStage).toEqual(summary);
    const persisted = JSON.stringify(localState.readRuntimeState());
    expect(persisted).not.toContain(install.root);
    expect(persisted).not.toContain("https://github.com");
    const audit = readFileSync(join(install.stateDir, "updates", "update-audit.jsonl"), "utf8");
    expect(audit).toContain("portable-download-result");
    expect(audit).toContain("portable-staging-result");
    expect(audit).not.toContain(install.root);
    expect(audit).not.toContain("https://github.com");
  });

  it("fails closed when the release is missing a required first-class portable archive", async () => {
    const archive = portableArchive();
    const install = makeManagedInstall();
    const localState = createUpdateLocalStateManager({ stateDir: install.stateDir });
    const stager = createPortableUpdateStager({
      env: {},
      localState,
      fetchImpl: responseFor(
        archive,
        portableManifest(archive),
        releaseWithout(MACOS_ARM64_ASSET_NAME, archive),
      ),
      platformVerifier: verifyPlatform,
    });

    await expect(
      stager.stage({
        sessionId: "session-missing-non-target-archive",
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        runtimeFacts: { packageRoot: install.packageRoot },
      }),
    ).rejects.toMatchObject({ reason: "portable-verification-failed" });

    const audit = readFileSync(join(install.stateDir, "updates", "update-audit.jsonl"), "utf8");
    expect(audit).toContain("portable-staging-result");
    expect(audit).toContain('"status":"failed"');
    expect(audit).not.toContain("portable-download-result");
  });

  it("verifies bundled sidecar payloads and records content-free sidecar evidence", async () => {
    const files = sidecarFiles();
    const sidecar = sidecarRuntime(files);
    const archive = portableArchive(sidecarArchiveEntries(files));
    const install = makeManagedInstall();
    const localState = createUpdateLocalStateManager({ stateDir: install.stateDir });
    const stager = createPortableUpdateStager({
      env: {},
      localState,
      fetchImpl: responseFor(archive, portableManifest(archive, sha256(archive), [sidecar])),
      platformVerifier: verifyPlatform,
    });

    const summary = await stager.stage({
      sessionId: "session-sidecar",
      targetVersion: TARGET_VERSION,
      installMode: portableMode(),
      runtimeFacts: { packageRoot: install.packageRoot },
    });

    expect(summary.sidecarRuntimes?.[0]).toMatchObject({
      name: "opencode-compatible",
      upstreamVersion: "1.0.0",
      payloadSha256: sidecarPayloadSha256(files),
      payloadSha256Prefix: sidecarPayloadSha256(files).slice(0, 12),
      status: "verified",
    });
    const persisted = JSON.stringify(localState.readRuntimeState());
    expect(persisted).not.toContain(SIDECAR_ROOT);
    expect(persisted).not.toContain("opencode.cmd");
    const audit = readFileSync(join(install.stateDir, "updates", "update-audit.jsonl"), "utf8");
    expect(audit).toContain("portable-sidecar-verification-result");
    expect(audit).toContain("opencode-compatible");
    expect(audit).toContain(sidecarPayloadSha256(files));
    expect(audit).not.toContain(SIDECAR_ROOT);
    expect(audit).not.toContain(install.root);
  });

  it("fails closed when staged sidecar payload digest does not match the manifest", async () => {
    const files = sidecarFiles();
    const sidecar = sidecarRuntime(files, "9".repeat(64));
    const archive = portableArchive(sidecarArchiveEntries(files));
    const install = makeManagedInstall();
    const localState = createUpdateLocalStateManager({ stateDir: install.stateDir });
    const stager = createPortableUpdateStager({
      env: {},
      localState,
      fetchImpl: responseFor(archive, portableManifest(archive, sha256(archive), [sidecar])),
      platformVerifier: verifyPlatform,
    });

    await expect(
      stager.stage({
        sessionId: "session-sidecar-fail",
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        runtimeFacts: { packageRoot: install.packageRoot },
      }),
    ).rejects.toMatchObject({ reason: "portable-sidecar-verification-failed" });
    expect(readFileSync(join(install.root, "active.txt"), "utf8")).toBe("active");
    const audit = readFileSync(join(install.stateDir, "updates", "update-audit.jsonl"), "utf8");
    expect(audit).toContain("sidecar-digest-mismatch");
    expect(audit).not.toContain(SIDECAR_ROOT);
    expect(audit).not.toContain(install.root);
  });

  it("fails closed when the archive hash no longer matches the verified manifest", async () => {
    const archive = portableArchive();
    const install = makeManagedInstall();
    const stager = createPortableUpdateStager({
      env: {},
      localState: createUpdateLocalStateManager({ stateDir: install.stateDir }),
      fetchImpl: responseFor(archive, portableManifest(archive, "b".repeat(64))),
      platformVerifier: verifyPlatform,
    });

    await expect(
      stager.stage({
        sessionId: "session-2",
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        runtimeFacts: { packageRoot: install.packageRoot },
      }),
    ).rejects.toMatchObject({ reason: "portable-verification-failed" });
    expect(readFileSync(join(install.root, "active.txt"), "utf8")).toBe("active");
  });

  it("rejects traversal entries without mutating the active install", async () => {
    const archive = portableArchive([{ name: "../evil.txt", bytes: ENC.encode("escape") }]);
    const install = makeManagedInstall();
    const stager = createPortableUpdateStager({
      env: {},
      localState: createUpdateLocalStateManager({ stateDir: install.stateDir }),
      fetchImpl: responseFor(archive),
      platformVerifier: verifyPlatform,
    });

    await expect(
      stager.stage({
        sessionId: "session-3",
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        runtimeFacts: { packageRoot: install.packageRoot },
      }),
    ).rejects.toMatchObject({ reason: "portable-staging-failed" });
    expect(existsSync(join(dirname(dirname(install.root)), "evil.txt"))).toBe(false);
    expect(readFileSync(join(install.root, "active.txt"), "utf8")).toBe("active");
  });

  it("fails closed when local platform verification rejects the staged payload", async () => {
    const archive = portableArchive();
    const install = makeManagedInstall();
    const localState = createUpdateLocalStateManager({ stateDir: install.stateDir });
    const stager = createPortableUpdateStager({
      env: {},
      localState,
      fetchImpl: responseFor(archive),
      platformVerifier: () =>
        Promise.reject(
          new PortableUpdateStagingError(
            "portable-verification-failed",
            "local signature verification failed",
          ),
        ),
    });

    await expect(
      stager.stage({
        sessionId: "session-platform-fail",
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        runtimeFacts: { packageRoot: install.packageRoot },
      }),
    ).rejects.toMatchObject({ reason: "portable-verification-failed" });
    expect(readFileSync(join(install.root, "active.txt"), "utf8")).toBe("active");
    expect(localState.readRuntimeState().portableStage).toBeUndefined();
  });
});
