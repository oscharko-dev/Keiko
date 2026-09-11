import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateCandidateSnapshot, UpdateInstallMode } from "@oscharko-dev/keiko-contracts";
import { createUpdateLocalStateManager } from "./update-local-state.js";
import { createPortableUpdateStager } from "./update-portable-staging.js";
import { fetchPortableAssetToFile } from "./update-portable-staging-manifest.js";
import { verifyPortableManifestSidecars } from "./update-portable-sidecar-verification.js";
import { hashPortableHandoffTree } from "./update-portable-handoff-tree.js";
import type { WindowsGenerationBinding } from "./update-portable-windows-generation.js";
import {
  requiredPortableDiskBytes,
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
const WINDOWS_SUPPORT_LAUNCHER =
  '@echo off\r\nset "SCRIPT_DIR=%~dp0"\r\n"%SCRIPT_DIR%..\\Keiko.exe" %*\r\n';
const windowsGenerationByArchive = new WeakMap<Uint8Array, WindowsGenerationBinding>();

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

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
    left.relativePath.localeCompare(right.relativePath),
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
    approvalSchemaVersion: 2,
    name: "opencode-compatible",
    kind: "coding-runtime",
    upstream: {
      owner: "anomalyco",
      repository: "opencode",
      name: "opencode",
      version: "1.17.17",
      tag: "v1.17.17",
      commit: "474abdd7ee60f4b67476cfcef7e5311beff4a824",
    },
    adapterCompatibility: {
      adapterName: "keiko-coding-sidecar",
      adapterVersion: "1",
      transport: "http-sse",
    },
    protocolSchema: {
      path: "packages/sdk/openapi.json",
      sha256: "7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de",
      hashAlgorithm: "sha256",
      hashEncoding: "lowercase-hex",
      digestInput: "upstream-raw-bytes",
      transport: "http-sse",
    },
    releaseApproval: { redistribution: { status: "approved" } },
    archive: {
      platformTarget: TARGET,
      sha256: "0a7fd7730a8efb00c69bce86fabcc0c24668371d821e99078a90dc78b71b4b85",
    },
    executableTreeAlgorithm: "keiko-directory-tree-sha256-v1",
    executableTreeSha256: "f".repeat(64),
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
      shippedExecutableSha256: sidecarFileSha256(files, "opencode.cmd"),
      shippedExecutableTreeAlgorithm: "keiko-directory-tree-sha256-v1",
      shippedExecutableTreeSha256: createHash("sha256")
        .update(`opencode.cmd\0${sidecarFileSha256(files, "opencode.cmd")}\0`)
        .digest("hex"),
    },
  };
}

function setupManifest(windowsGeneration: WindowsGenerationBinding): string {
  return JSON.stringify({
    schemaVersion: 2,
    platformTarget: TARGET,
    packageName: "@oscharko-dev/keiko",
    packageVersion: TARGET_VERSION,
    stable: true,
    primaryLauncher: "Keiko.exe",
    bootstrapUpdateEligible: false,
    runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
    windowsGeneration,
  });
}

async function portableArchive(
  extraEntries: readonly { readonly name: string; readonly bytes: Uint8Array }[] = [],
  fault?: "generation-mutation" | "launcher-replacement" | "setup-rebind" | "support-replacement",
): Promise<Uint8Array> {
  const launcher = ENC.encode("launcher");
  const generationEntries = [
    {
      name: "app/package.json",
      bytes: ENC.encode(JSON.stringify({ name: "@oscharko-dev/keiko", version: TARGET_VERSION })),
    },
    { name: "runtime/node/node.exe", bytes: ENC.encode("node") },
    { name: "runtime/native/keiko-runtime-supervisor.exe", bytes: ENC.encode("supervisor") },
    { name: "runtime/evidence.txt", bytes: ENC.encode("non-PE generation evidence") },
    ...extraEntries
      .filter(
        (entry) => entry.name.startsWith("Keiko/runtime/") || entry.name.startsWith("Keiko/app/"),
      )
      .map((entry) => ({ ...entry, name: entry.name.slice("Keiko/".length) })),
  ];
  const generationFixtureRoot = mkdtempSync(join(tmpdir(), "keiko-generation-fixture-"));
  tempRoots.push(generationFixtureRoot);
  for (const entry of generationEntries) {
    const path = join(generationFixtureRoot, ...entry.name.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry.bytes);
  }
  const treeSha256 = await hashPortableHandoffTree(generationFixtureRoot, {
    deadline: Date.now() + 60_000,
  });
  const windowsGeneration: WindowsGenerationBinding = {
    schemaVersion: 1,
    resourceRoot: `.portable/generations/${treeSha256}`,
    treeHashSchema: "KHT1",
    treeSha256,
    launcherPath: "Keiko.exe",
    launcherSha256: sha256(launcher),
  };
  const setupGeneration =
    fault === "setup-rebind"
      ? { ...windowsGeneration, launcherSha256: "f".repeat(64) }
      : windowsGeneration;
  const archive = zipEntries([
    {
      name: "Keiko/Keiko.exe",
      bytes: fault === "launcher-replacement" ? ENC.encode("replacement launcher") : launcher,
    },
    {
      name: "Keiko/.portable/setup-manifest.json",
      bytes: ENC.encode(setupManifest(setupGeneration)),
    },
    {
      name: "Keiko/support/keiko-support.cmd",
      bytes: ENC.encode(
        fault === "support-replacement" ? "@echo off\r\n" : WINDOWS_SUPPORT_LAUNCHER,
      ),
    },
    ...generationEntries.map((entry) => ({
      ...entry,
      name: `Keiko/.portable/generations/${treeSha256}/${entry.name}`,
      bytes:
        fault === "generation-mutation" && entry.name === "runtime/evidence.txt"
          ? ENC.encode("mutated after generation closure")
          : entry.bytes,
    })),
    ...extraEntries.filter(
      (entry) => !entry.name.startsWith("Keiko/runtime/") && !entry.name.startsWith("Keiko/app/"),
    ),
  ]);
  windowsGenerationByArchive.set(archive, windowsGeneration);
  return archive;
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

function candidate(
  archiveBytes: Uint8Array,
  sidecarRuntimes: readonly Record<string, unknown>[] = [],
): UpdateCandidateSnapshot {
  const manifestText = portableManifest(archiveBytes, sha256(archiveBytes), sidecarRuntimes);
  const checksumText = `${sha256(archiveBytes)}  ${ASSET_NAME}\n`;
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  const sidecars = verifyPortableManifestSidecars(manifest, TARGET).summaries;
  return {
    schemaVersion: "1",
    candidateId: "candidate-portable-1",
    currentVersion: "0.2.10",
    targetVersion: TARGET_VERSION,
    channel: "stable",
    install: {
      packageName: "@oscharko-dev/keiko",
      installKind: "portable-managed",
      portableTarget: TARGET,
      installIdentitySha256: "1".repeat(64),
    },
    release: { source: "github-release", tag: `v${TARGET_VERSION}` },
    releaseImpactDigest: "2".repeat(64),
    issuedAt: "2026-09-04T10:00:00.000Z",
    expiresAt: "2026-09-04T10:10:00.000Z",
    portable: {
      target: TARGET,
      releaseId: RELEASE_ID,
      assetId: ASSET_ID,
      assetName: ASSET_NAME,
      sizeBytes: archiveBytes.length,
      uncompressedSizeBytes: archiveBytes.length,
      sha256: sha256(archiveBytes),
      manifestAssetName: `${TARGET}-portable-manifest.json`,
      manifestAssetId: 101,
      manifestSizeBytes: 2048,
      manifestSha256: sha256(ENC.encode(manifestText)),
      checksumAssetName: `${TARGET}-SHA256SUMS.txt`,
      checksumAssetId: 102,
      checksumSizeBytes: 128,
      checksumSha256: sha256(ENC.encode(checksumText)),
      checksumVerified: true,
      ...(sidecars.length === 0 ? {} : { sidecarRuntimes: sidecars }),
    },
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
  const windowsGeneration = windowsGenerationByArchive.get(archiveBytes);
  if (windowsGeneration === undefined) throw new Error("Windows generation fixture is unavailable");
  return JSON.stringify({
    schemaVersion: 2,
    windowsGeneration,
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
      uncompressedSizeBytes: archiveBytes.length,
      sha256: archiveSha,
    },
    runtime: {
      nodeVersion: "24.18.0",
      nodePlatform: "win32",
      nodeArchitecture: "x64",
      nodeDistribution: "official-nodejs-dist",
      nodeArchiveSha256: "d".repeat(64),
    },
    provenance: { windowsGeneration },
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
        windowsGeneration,
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
    if (url.endsWith(`/releases/${String(RELEASE_ID)}`)) {
      return Promise.resolve(Response.json(releaseRecord));
    }
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

  it("applies the frozen archive, inflation, current-tree, and 512 MiB disk formula", () => {
    expect(requiredPortableDiskBytes(100, 200, 300)).toBe(200 + 300 + 512 * 1024 * 1024);
    expect(requiredPortableDiskBytes(10_000_000_000, 200, 300)).toBe(
      200 + 300 + Math.ceil((10_000_000_000 + 200 + 300) * 0.1),
    );
  });
});

describe("portable update staging", () => {
  it("cancels a non-OK immutable release metadata body before failing", async () => {
    const archive = await portableArchive();
    const install = makeManagedInstall();
    const response = new Response("not found", { status: 404 });
    const body = response.body;
    if (body === null) throw new Error("response fixture body is missing");
    const cancel = vi.spyOn(body, "cancel");
    const stager = createPortableUpdateStager({
      env: {},
      fetchImpl: () => Promise.resolve(response),
      platformVerifier: verifyPlatform,
    });

    await expect(
      stager.stage({
        candidate: candidate(archive),
        sessionId: "session-metadata-404",
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        runtimeFacts: { packageRoot: install.packageRoot },
      }),
    ).rejects.toMatchObject({ reason: "portable-download-failed" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels an oversized streaming archive source exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-portable-download-"));
    tempRoots.push(root);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(Uint8Array.of(1, 2));
      },
      cancel,
    });
    const archive = await portableArchive();

    await expect(
      fetchPortableAssetToFile(
        { env: {}, fetchImpl: () => Promise.resolve(new Response(body)) },
        { id: ASSET_ID, name: ASSET_NAME, size: 1, downloadUrl: assetUrl(ASSET_NAME) },
        join(root, "archive.zip"),
        {
          candidate: candidate(archive),
          sessionId: "session-oversized-stream",
          targetVersion: TARGET_VERSION,
          installMode: portableMode(),
        },
      ),
    ).rejects.toMatchObject({ reason: "portable-download-failed" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels an aborted streaming archive source exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-portable-download-"));
    tempRoots.push(root);
    const controller = new AbortController();
    const cancel = vi.fn();
    let markProgressed: (() => void) | undefined;
    const progressed = new Promise<void>((resolveProgressed) => {
      markProgressed = resolveProgressed;
    });
    const body = new ReadableStream<Uint8Array>({
      start(stream): void {
        stream.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel,
    });
    const archive = await portableArchive();
    const download = fetchPortableAssetToFile(
      { env: {}, fetchImpl: () => Promise.resolve(new Response(body)) },
      { id: ASSET_ID, name: ASSET_NAME, size: 1024 * 1024 + 1, downloadUrl: assetUrl(ASSET_NAME) },
      join(root, "archive.zip"),
      {
        candidate: candidate(archive),
        sessionId: "session-aborted-stream",
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        signal: controller.signal,
        onProgress: () => markProgressed?.(),
      },
    );

    await progressed;
    controller.abort();
    await expect(download).rejects.toBeInstanceOf(Error);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects rebound release metadata before downloading candidate bytes", async () => {
    const archive = await portableArchive();
    const install = makeManagedInstall();
    const rebound = release(archive.length);
    const assets = rebound.assets as Record<string, unknown>[];
    const targetAsset = assets.find((asset) => asset.name === ASSET_NAME);
    if (targetAsset === undefined) throw new Error("target fixture missing");
    targetAsset.id = ASSET_ID + 1;
    const fetchImpl = responseFor(archive, portableManifest(archive), rebound);
    const stager = createPortableUpdateStager({
      env: {},
      fetchImpl,
      platformVerifier: verifyPlatform,
    });

    await expect(
      stager.stage({
        candidate: candidate(archive),
        sessionId: "session-rebound-release",
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        runtimeFacts: { packageRoot: install.packageRoot },
      }),
    ).rejects.toMatchObject({ reason: "portable-verification-failed" });
    const requested = vi.mocked(fetchImpl).mock.calls.map(([request]) => requestUrl(request));
    expect(requested).toEqual([
      `https://api.github.com/repos/oscharko-dev/keiko/releases/${String(RELEASE_ID)}`,
    ]);
    expect(requested).not.toContain(
      "https://api.github.com/repos/oscharko-dev/keiko/releases/latest",
    );
  });

  it("rejects rebound manifest and checksum metadata from the immutable release", async () => {
    const archive = await portableArchive();
    const install = makeManagedInstall();
    const rebound = release(archive.length);
    const assets = rebound.assets as Record<string, unknown>[];
    const manifest = assets.find((asset) => asset.name === `${TARGET}-portable-manifest.json`);
    if (manifest === undefined) throw new Error("manifest fixture missing");
    manifest.id = 999;
    const fetchImpl = responseFor(archive, portableManifest(archive), rebound);
    const stager = createPortableUpdateStager({
      env: {},
      fetchImpl,
      platformVerifier: verifyPlatform,
    });

    await expect(
      stager.stage({
        candidate: candidate(archive),
        sessionId: "session-rebound-evidence",
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        runtimeFacts: { packageRoot: install.packageRoot },
      }),
    ).rejects.toMatchObject({ reason: "portable-verification-failed" });
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
  });

  it("rejects checksum bytes that do not match the preflight candidate digest", async () => {
    const archive = await portableArchive();
    const install = makeManagedInstall();
    const snapshot = candidate(archive);
    if (snapshot.portable === undefined) throw new Error("portable candidate fixture missing");
    const stager = createPortableUpdateStager({
      env: {},
      fetchImpl: responseFor(archive),
      platformVerifier: verifyPlatform,
    });

    await expect(
      stager.stage({
        candidate: {
          ...snapshot,
          portable: { ...snapshot.portable, checksumSha256: "f".repeat(64) },
        },
        sessionId: "session-rebound-checksum",
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        runtimeFacts: { packageRoot: install.packageRoot },
      }),
    ).rejects.toMatchObject({ reason: "portable-verification-failed" });
  });

  it("fails before metadata or archive download when disk headroom is insufficient", async () => {
    const archive = await portableArchive();
    const install = makeManagedInstall();
    const fetchImpl = responseFor(archive);
    const stager = createPortableUpdateStager({
      env: {},
      fetchImpl,
      availableDiskBytes: () => 0,
      platformVerifier: verifyPlatform,
    });

    await expect(
      stager.stage({
        candidate: candidate(archive),
        sessionId: "session-low-disk",
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        runtimeFacts: { packageRoot: install.packageRoot },
      }),
    ).rejects.toMatchObject({ reason: "portable-staging-failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readFileSync(join(install.root, "active.txt"), "utf8")).toBe("active");
  });

  it("classifies a missing managed install root as non-retryable preflight ineligibility", async () => {
    const archive = await portableArchive();
    const base = mkdtempSync(join(tmpdir(), "keiko-portable-missing-root-"));
    tempRoots.push(base);
    const fetchImpl = responseFor(archive);
    const stager = createPortableUpdateStager({
      env: {},
      fetchImpl,
      platformVerifier: verifyPlatform,
    });

    await expect(
      stager.stage({
        candidate: candidate(archive),
        sessionId: "session-missing-root",
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        runtimeFacts: { packageRoot: join(base, "Programs", "Keiko", "app") },
      }),
    ).rejects.toMatchObject({ reason: "portable-preflight-ineligible" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cancels during extraction, removes partial staging, and preserves the active tree", async () => {
    const archive = await portableArchive();
    const install = makeManagedInstall();
    const controller = new AbortController();
    const stager = createPortableUpdateStager({
      env: {},
      fetchImpl: responseFor(archive),
      platformVerifier: verifyPlatform,
    });

    await expect(
      stager.stage({
        candidate: candidate(archive),
        sessionId: "session-cancel-extraction",
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        runtimeFacts: { packageRoot: install.packageRoot },
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === "staging") controller.abort();
        },
      }),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(readFileSync(join(install.root, "active.txt"), "utf8")).toBe("active");
    const stageBase = join(dirname(install.root), ".keiko-portable-updates");
    expect(readdirSync(stageBase)).toEqual([]);
  });

  it("downloads, verifies, stages, and records content-free state", async () => {
    const archive = await portableArchive();
    const install = makeManagedInstall();
    const localState = createUpdateLocalStateManager({ stateDir: install.stateDir });
    const stager = createPortableUpdateStager({
      env: {},
      localState,
      fetchImpl: responseFor(archive),
      platformVerifier: verifyPlatform,
    });

    const summary = await stager.stage({
      candidate: candidate(archive),
      sessionId: "session-1",
      targetVersion: TARGET_VERSION,
      installMode: portableMode(),
      runtimeFacts: { packageRoot: install.packageRoot },
    });

    const stageRoot = join(dirname(install.root), ".keiko-portable-updates", summary.stageId);
    expect(existsSync(join(stageRoot, "Keiko", "Keiko.exe"))).toBe(true);
    const binding = windowsGenerationByArchive.get(archive);
    if (binding === undefined) throw new Error("Windows generation fixture missing");
    expect(
      existsSync(
        join(stageRoot, "Keiko", ...binding.resourceRoot.split("/"), "runtime", "node", "node.exe"),
      ),
    ).toBe(true);
    expect(localState.readRuntimeState().portableStage).toEqual(summary);
    const persisted = JSON.stringify(localState.readRuntimeState());
    expect(persisted).not.toContain(install.root);
    expect(persisted).not.toContain("https://github.com");
  });

  it.each([
    ["generation-mutation", "staged Windows generation digest mismatch"],
    ["launcher-replacement", "staged Windows root launcher digest mismatch"],
    [
      "setup-rebind",
      "setup manifest Windows generation binding does not match the reviewed manifest",
    ],
    ["support-replacement", "staged Windows support launcher is not canonical"],
  ] as const)("rejects a Windows %s after reviewed binding", async (fault, message) => {
    const archive = await portableArchive([], fault);
    const install = makeManagedInstall();
    const stager = createPortableUpdateStager({
      env: {},
      fetchImpl: responseFor(archive),
      platformVerifier: verifyPlatform,
    });

    await expect(
      stager.stage({
        candidate: candidate(archive),
        sessionId: `session-${fault}`,
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        runtimeFacts: { packageRoot: install.packageRoot },
      }),
    ).rejects.toThrow(message);
  });

  it("fails closed when the release is missing a required first-class portable archive", async () => {
    const archive = await portableArchive();
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
        candidate: candidate(archive),
        sessionId: "session-missing-non-target-archive",
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        runtimeFacts: { packageRoot: install.packageRoot },
      }),
    ).rejects.toMatchObject({ reason: "portable-verification-failed" });

    expect(localState.readRuntimeState().portableStage).toBeUndefined();
  });

  it("verifies bundled sidecar payloads and records content-free sidecar state", async () => {
    const files = sidecarFiles();
    const sidecar = sidecarRuntime(files);
    const archive = await portableArchive(sidecarArchiveEntries(files));
    const install = makeManagedInstall();
    const localState = createUpdateLocalStateManager({ stateDir: install.stateDir });
    const stager = createPortableUpdateStager({
      env: {},
      localState,
      fetchImpl: responseFor(archive, portableManifest(archive, sha256(archive), [sidecar])),
      platformVerifier: verifyPlatform,
    });

    const summary = await stager.stage({
      candidate: candidate(archive, [sidecar]),
      sessionId: "session-sidecar",
      targetVersion: TARGET_VERSION,
      installMode: portableMode(),
      runtimeFacts: { packageRoot: install.packageRoot },
    });

    expect(summary.sidecarRuntimes?.[0]).toMatchObject({
      name: "opencode-compatible",
      upstreamVersion: "1.17.17",
      payloadSha256: sidecarPayloadSha256(files),
      payloadSha256Prefix: sidecarPayloadSha256(files).slice(0, 12),
      status: "verified",
    });
    const persisted = JSON.stringify(localState.readRuntimeState());
    expect(persisted).not.toContain(SIDECAR_ROOT);
    expect(persisted).not.toContain("opencode.cmd");
  });

  it("fails closed when staged sidecar payload digest does not match the manifest", async () => {
    const files = sidecarFiles();
    const sidecar = sidecarRuntime(files, "9".repeat(64));
    const archive = await portableArchive(sidecarArchiveEntries(files));
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
        candidate: candidate(archive, [sidecar]),
        sessionId: "session-sidecar-fail",
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        runtimeFacts: { packageRoot: install.packageRoot },
      }),
    ).rejects.toMatchObject({ reason: "portable-sidecar-verification-failed" });
    expect(readFileSync(join(install.root, "active.txt"), "utf8")).toBe("active");
    expect(localState.readRuntimeState().portableStage).toBeUndefined();
  });

  it("fails closed when the shipped executable digest is stale", async () => {
    const files = sidecarFiles();
    const sidecar = sidecarRuntime(files);
    const signing = sidecar.signing as Record<string, unknown>;
    signing.shippedExecutableSha256 = "9".repeat(64);
    const archive = await portableArchive(sidecarArchiveEntries(files));
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
        candidate: candidate(archive, [sidecar]),
        sessionId: "session-sidecar-stale-executable-digest",
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        runtimeFacts: { packageRoot: install.packageRoot },
      }),
    ).rejects.toMatchObject({ reason: "portable-sidecar-verification-failed" });
    expect(readFileSync(join(install.root, "active.txt"), "utf8")).toBe("active");
    expect(localState.readRuntimeState().portableStage).toBeUndefined();
  });

  it("fails closed when the archive hash no longer matches the verified manifest", async () => {
    const archive = await portableArchive();
    const install = makeManagedInstall();
    const stager = createPortableUpdateStager({
      env: {},
      localState: createUpdateLocalStateManager({ stateDir: install.stateDir }),
      fetchImpl: responseFor(archive, portableManifest(archive, "b".repeat(64))),
      platformVerifier: verifyPlatform,
    });

    await expect(
      stager.stage({
        candidate: candidate(archive),
        sessionId: "session-2",
        targetVersion: TARGET_VERSION,
        installMode: portableMode(),
        runtimeFacts: { packageRoot: install.packageRoot },
      }),
    ).rejects.toMatchObject({ reason: "portable-verification-failed" });
    expect(readFileSync(join(install.root, "active.txt"), "utf8")).toBe("active");
  });

  it("rejects traversal entries without mutating the active install", async () => {
    const archive = await portableArchive([{ name: "../evil.txt", bytes: ENC.encode("escape") }]);
    const install = makeManagedInstall();
    const stager = createPortableUpdateStager({
      env: {},
      localState: createUpdateLocalStateManager({ stateDir: install.stateDir }),
      fetchImpl: responseFor(archive),
      platformVerifier: verifyPlatform,
    });

    await expect(
      stager.stage({
        candidate: candidate(archive),
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
    const archive = await portableArchive();
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
        candidate: candidate(archive),
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
