import { createHash } from "node:crypto";
import {
  KEIKO_PORTABLE_RELEASE_TRUSTED_KEYS,
  verifyPortableReleaseTrust,
} from "@oscharko-dev/keiko-security/portable-release-trust";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  gatewayFetch,
  readBytesCapped,
  readJsonCapped,
} from "@oscharko-dev/keiko-model-gateway/internal/http";
import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";
import { UPDATE_PORTABLE_TARGET_ASSET_NAMES } from "@oscharko-dev/keiko-contracts/runtime/update-session";
import {
  fetchGitHubReleaseAsset,
  fetchWithPortableRetry,
  firstClassArchiveSetComplete,
} from "./update-preflight-portable-shared.js";
import {
  type PortableSidecarRuntimeVerification,
  verifyPortableManifestSidecars,
} from "./update-portable-sidecar-verification.js";
import { isStableVersion } from "./update-preflight-registry.js";
import {
  COMMIT_SHA,
  MAX_ARCHIVE_BYTES,
  MAX_UNCOMPRESSED_BYTES,
  MAX_PORTABLE_MANIFEST_BYTES,
  MAX_RELEASE_METADATA_BYTES,
  PACKAGE_NAME,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
  digestField,
  fieldEquals,
  manifestArchiveSha,
  parseJsonRecord,
  recordAt,
  runtimeFor,
  sha256Bytes,
  signatureKind,
  type GitHubAsset,
  type PortableRelease,
  type PortableUpdateStageInput,
  type PortableUpdateStagerOptions,
  type TextAsset,
  PortableUpdateStagingError,
  reportPortableProgress,
} from "./update-portable-staging-shared.js";
import {
  portableManifestGenerationSchemaVerified,
  verifiedWindowsGenerationManifestBinding,
  type WindowsGenerationBinding,
} from "./update-portable-windows-generation.js";

export interface PortableStageAssets {
  readonly release: PortableRelease;
  readonly archive: GitHubAsset;
  readonly manifest: TextAsset;
  readonly sidecars: readonly PortableSidecarRuntimeVerification[];
  readonly nativePlatformVerificationRequired: boolean;
  readonly windowsGeneration?: WindowsGenerationBinding | undefined;
}

function safePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function safeDownloadUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const url = new URL(value);
  const prefix = "/oscharko-dev/keiko/releases/download/";
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  return url.hostname === "github.com" && url.pathname.toLowerCase().startsWith(prefix)
    ? value
    : undefined;
}

function parseAsset(value: unknown): GitHubAsset | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = safePositiveInteger(record.id);
  const name = typeof record.name === "string" && record.name.length > 0 ? record.name : undefined;
  const size = safePositiveInteger(record.size);
  const downloadUrl = safeDownloadUrl(record.browser_download_url);
  return id === undefined || name === undefined || size === undefined || downloadUrl === undefined
    ? undefined
    : { id, name, size, downloadUrl };
}

function parseAssets(value: unknown): readonly GitHubAsset[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const assets = value.map(parseAsset);
  return assets.every((asset): asset is GitHubAsset => asset !== undefined) ? assets : undefined;
}

function releaseRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function releaseMatches(record: Record<string, unknown>, targetVersion: string): boolean {
  return (
    record.draft !== true &&
    record.prerelease !== true &&
    record.tag_name === `v${targetVersion}` &&
    isStableVersion(targetVersion)
  );
}

function parseRelease(value: unknown, targetVersion: string): PortableRelease | undefined {
  const record = releaseRecord(value);
  if (record === undefined || !releaseMatches(record, targetVersion)) return undefined;
  const id = safePositiveInteger(record.id);
  const assets = parseAssets(record.assets);
  return id === undefined || assets === undefined ? undefined : { id, targetVersion, assets };
}

function candidatePortable(
  input: PortableUpdateStageInput,
  target: UpdatePortableTarget,
): NonNullable<PortableUpdateStageInput["candidate"]["portable"]> {
  const portable = input.candidate.portable;
  if (
    input.candidate.targetVersion !== input.targetVersion ||
    input.candidate.release.source !== "github-release" ||
    input.candidate.release.tag !== `v${input.targetVersion}` ||
    input.candidate.install.installKind !== "portable-managed" ||
    input.candidate.install.portableTarget !== target ||
    portable?.target !== target ||
    !portable.checksumVerified
  ) {
    throw new PortableUpdateStagingError(
      "portable-preflight-ineligible",
      "portable candidate identity is invalid",
    );
  }
  return portable;
}

function assertCandidateAsset(
  asset: GitHubAsset,
  expected: { readonly id: number; readonly name: string; readonly size?: number },
): void {
  if (
    asset.id !== expected.id ||
    asset.name !== expected.name ||
    (expected.size !== undefined && asset.size !== expected.size)
  ) {
    throw new PortableUpdateStagingError(
      "portable-verification-failed",
      "portable candidate asset identity changed",
    );
  }
}

function assetByName(release: PortableRelease, name: string): GitHubAsset {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (asset === undefined) {
    throw new PortableUpdateStagingError("portable-verification-failed", "required asset missing");
  }
  return asset;
}

function assertFirstClassArchiveSetComplete(release: PortableRelease): void {
  if (!firstClassArchiveSetComplete(release.assets)) {
    throw new PortableUpdateStagingError(
      "portable-verification-failed",
      "portable release asset set is incomplete",
    );
  }
}

function manifestName(target: UpdatePortableTarget): string {
  return `${target}-portable-manifest.json`;
}

function checksumName(target: UpdatePortableTarget): string {
  return `${target}-SHA256SUMS.txt`;
}

function fetchOptions(
  options: PortableUpdateStagerOptions,
  extra: { readonly accept: string; readonly maxBytes: number; readonly signal?: AbortSignal },
): Parameters<typeof gatewayFetch>[1] {
  const egress = options.egress?.();
  return {
    method: "GET",
    headers: { Accept: extra.accept, "User-Agent": "Keiko" },
    timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
    maxResponseBytes: extra.maxBytes,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(egress === undefined ? {} : { egress }),
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
  };
}

async function fetchRelease(
  options: PortableUpdateStagerOptions,
  input: PortableUpdateStageInput,
): Promise<PortableRelease> {
  const portable = input.candidate.portable;
  if (portable === undefined) {
    throw new PortableUpdateStagingError(
      "portable-preflight-ineligible",
      "portable candidate identity is missing",
    );
  }
  const response = await fetchWithPortableRetry(
    () =>
      gatewayFetch(
        `https://api.github.com/repos/oscharko-dev/keiko/releases/${String(portable.releaseId)}`,
        fetchOptions(options, {
          accept: "application/vnd.github+json",
          maxBytes: MAX_RELEASE_METADATA_BYTES,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
      ),
    { signal: input.signal },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new PortableUpdateStagingError(
      "portable-download-failed",
      "release metadata unavailable",
    );
  }
  const release = parseRelease(
    await readJsonCapped(response, MAX_RELEASE_METADATA_BYTES),
    input.targetVersion,
  );
  if (release === undefined) {
    throw new PortableUpdateStagingError(
      "portable-preflight-ineligible",
      "release is not eligible",
    );
  }
  if (release.id !== portable.releaseId) {
    throw new PortableUpdateStagingError(
      "portable-verification-failed",
      "portable release identity changed",
    );
  }
  return release;
}

async function fetchPortableAssetResponse(
  options: PortableUpdateStagerOptions,
  asset: GitHubAsset,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetchGitHubReleaseAsset(asset.downloadUrl, (url) =>
      fetchWithPortableRetry(
        () =>
          gatewayFetch(
            url,
            fetchOptions(options, {
              accept: "application/octet-stream",
              maxBytes,
              ...(signal === undefined ? {} : { signal }),
            }),
          ),
        { signal },
      ),
    );
  } catch {
    throw new PortableUpdateStagingError("portable-download-failed", "asset redirect failed");
  }
}

export async function fetchPortableAssetBytes(
  options: PortableUpdateStagerOptions,
  asset: GitHubAsset,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetchPortableAssetResponse(options, asset, maxBytes, signal);
  if (!response.ok) {
    throw new PortableUpdateStagingError("portable-download-failed", "asset download failed");
  }
  return readBytesCapped(response, maxBytes);
}

export async function fetchPortableAssetToFile(
  options: PortableUpdateStagerOptions,
  asset: GitHubAsset,
  destination: string,
  input: PortableUpdateStageInput,
): Promise<string> {
  const response = await fetchPortableAssetResponse(
    options,
    asset,
    archiveSizeLimit(asset),
    input.signal,
  );
  if (!response.ok || response.body === null) {
    throw new PortableUpdateStagingError("portable-download-failed", "asset download failed");
  }
  const hash = createHash("sha256");
  const progress = { completedBytes: 0, lastReportedBytes: 0, lastReportedAt: Date.now() };
  const source = webBodyChunks(response.body, input.signal);
  const meter = downloadMeter(hash, progress, asset, input);
  const destinationStream = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  const cancelSource = (): void => {
    void source.cancel().catch(() => undefined);
  };
  meter.once("error", cancelSource);
  destinationStream.once("error", cancelSource);
  try {
    await pipeline(Readable.from(source), meter, destinationStream, { signal: input.signal });
  } catch (error) {
    await source.cancel().catch(() => undefined);
    if (error instanceof PortableUpdateStagingError || input.signal?.aborted === true) throw error;
    throw new PortableUpdateStagingError("portable-download-failed", "asset download failed");
  } finally {
    meter.off("error", cancelSource);
    destinationStream.off("error", cancelSource);
  }
  if (progress.completedBytes !== asset.size) {
    throw new PortableUpdateStagingError("portable-download-failed", "asset is truncated");
  }
  reportDownloadProgress(input, progress.completedBytes, asset.size);
  return hash.digest("hex");
}

interface DownloadProgressState {
  completedBytes: number;
  lastReportedBytes: number;
  lastReportedAt: number;
}

function reportDownloadProgress(
  input: PortableUpdateStageInput,
  completedBytes: number,
  totalBytes: number,
): void {
  reportPortableProgress(input, { phase: "downloading", completedBytes, totalBytes });
}

function downloadMeter(
  hash: ReturnType<typeof createHash>,
  progress: DownloadProgressState,
  asset: GitHubAsset,
  input: PortableUpdateStageInput,
): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      progress.completedBytes += chunk.byteLength;
      if (progress.completedBytes > asset.size) {
        callback(new PortableUpdateStagingError("portable-download-failed", "asset is oversized"));
        return;
      }
      hash.update(chunk);
      const now = Date.now();
      if (
        progress.completedBytes - progress.lastReportedBytes >= 1024 * 1024 ||
        now - progress.lastReportedAt >= 1_000
      ) {
        reportDownloadProgress(input, progress.completedBytes, asset.size);
        progress.lastReportedBytes = progress.completedBytes;
        progress.lastReportedAt = now;
      }
      callback(null, chunk);
    },
  });
}

interface WebBodyChunkSource extends AsyncIterable<Uint8Array> {
  cancel(): Promise<void>;
}

function webBodyChunks(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): WebBodyChunkSource {
  const reader = body.getReader();
  let cleanEof = false;
  let cancellation: Promise<void> | undefined;
  const cancelReader = (): Promise<void> => {
    cancellation ??= reader.cancel();
    return cancellation;
  };
  const onAbort = (): void => {
    void cancelReader().catch(() => undefined);
  };
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    cancel: cancelReader,
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array, void, void> {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            cleanEof = true;
            return;
          }
          yield chunk.value;
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        try {
          if (!cleanEof) await cancelReader();
        } finally {
          reader.releaseLock();
        }
      }
    },
  };
}

async function fetchTextAsset(
  options: PortableUpdateStagerOptions,
  asset: GitHubAsset,
  signal?: AbortSignal,
): Promise<TextAsset> {
  const bytes = await fetchPortableAssetBytes(options, asset, MAX_PORTABLE_MANIFEST_BYTES, signal);
  return { text: new TextDecoder().decode(bytes), sha256: sha256Bytes(bytes) };
}

function targetChecksVerified(
  target: UpdatePortableTarget,
  checks: Record<string, unknown> | undefined,
): boolean {
  const keys = targetVerificationCheckKeys(target);
  return keys.every((key) => checks?.[key] === true);
}

function targetVerificationCheckKeys(target: UpdatePortableTarget): readonly string[] {
  if (target === "windows-x64") return ["publisherChainVerified", "timestampVerified"];
  if (target === "linux-x64") return ["provenanceVerified"];
  return ["developerIdVerified", "notarizationVerified", "stapleVerified", "assessmentVerified"];
}

function nativeSecurityVerified(
  manifest: Record<string, unknown>,
  target: UpdatePortableTarget,
): boolean {
  const security = recordAt(manifest, "security");
  const checks = recordAt(security, "verificationChecks");
  const macos = target.startsWith("macos-");
  return (
    fieldEquals(security, "verificationPolicy", "production") &&
    fieldEquals(security, "verificationStatus", "verified-production") &&
    fieldEquals(security, "signatureKind", signatureKind(target)) &&
    fieldEquals(security, "signatureVerified", true) &&
    fieldEquals(security, "notarizationRequired", macos) &&
    fieldEquals(security, "notarizationVerified", macos) &&
    targetChecksVerified(target, checks)
  );
}

function releaseTrustVerified(
  options: PortableUpdateStagerOptions,
  manifest: Record<string, unknown>,
): boolean {
  return verifyPortableReleaseTrust(manifest, {
    now: new Date(options.now?.() ?? Date.now()),
    trustedKeys: options.releaseTrustedKeys ?? KEIKO_PORTABLE_RELEASE_TRUSTED_KEYS,
  }).ok;
}

function updatePredicatesVerified(
  manifest: Record<string, unknown>,
  nativeVerified: boolean,
  releaseVerified: boolean,
): boolean {
  const update = recordAt(manifest, "updateEligibility");
  const predicates = recordAt(update, "requiredPredicates");
  return (
    fieldEquals(update, "stableOnly", true) &&
    fieldEquals(update, "rollbackSupported", false) &&
    fieldEquals(update, "eligibleAfterSetupOnly", true) &&
    fieldEquals(predicates, "artifactShaVerified", true) &&
    fieldEquals(predicates, "manifestReleaseImpactBound", true) &&
    fieldEquals(predicates, "platformSignatureLocallyVerified", nativeVerified) &&
    (nativeVerified || fieldEquals(predicates, "releaseTrustRequired", releaseVerified))
  );
}

function runtimeVerified(manifest: Record<string, unknown>, target: UpdatePortableTarget): boolean {
  const runtime = recordAt(manifest, "runtime");
  const expected = runtimeFor(target);
  return (
    fieldEquals(runtime, "nodePlatform", expected.platform) &&
    fieldEquals(runtime, "nodeArchitecture", expected.arch) &&
    digestField(runtime, "nodeArchiveSha256") !== undefined
  );
}

function reviewedBindingVerified(
  manifest: Record<string, unknown>,
  release: PortableRelease,
  archive: GitHubAsset,
  target: UpdatePortableTarget,
  nativeVerified: boolean,
): boolean {
  const impact = recordAt(manifest, "releaseImpact");
  const binding = recordAt(impact, "reviewedBinding");
  const sha256 = manifestArchiveSha(manifest);
  if (sha256 === undefined) return false;
  return [
    fieldEquals(impact, "entryPackageVersion", release.targetVersion) &&
      fieldEquals(impact, "entryReleaseTag", `v${release.targetVersion}`),
    fieldEquals(binding, "releaseId", release.id),
    fieldEquals(binding, "assetId", archive.id),
    fieldEquals(binding, "assetName", archive.name),
    fieldEquals(binding, "assetSizeBytes", archive.size),
    fieldEquals(binding, "platformTarget", target),
    fieldEquals(binding, "packageVersion", release.targetVersion),
    fieldEquals(binding, "archiveSha256", sha256),
    fieldEquals(binding, "platformSignatureLocallyVerified", nativeVerified),
  ].every(Boolean);
}

function releaseManifestVerified(
  record: Record<string, unknown> | undefined,
  release: PortableRelease,
): boolean {
  const commitSha = record?.commitSha;
  return [
    fieldEquals(record, "releaseId", release.id),
    fieldEquals(record, "releaseTag", `v${release.targetVersion}`),
    fieldEquals(record, "stable", true),
    typeof commitSha === "string" && COMMIT_SHA.test(commitSha),
  ].every(Boolean);
}

function artifactManifestVerified(
  record: Record<string, unknown> | undefined,
  archive: GitHubAsset,
  target: UpdatePortableTarget,
): boolean {
  const uncompressedSizeBytes = record?.uncompressedSizeBytes;
  return [
    fieldEquals(record, "platformTarget", target),
    fieldEquals(record, "assetName", archive.name),
    fieldEquals(record, "assetId", archive.id),
    fieldEquals(record, "sizeBytes", archive.size),
    fieldEquals(record, "archiveFormat", "zip"),
    typeof uncompressedSizeBytes === "number" &&
      Number.isSafeInteger(uncompressedSizeBytes) &&
      uncompressedSizeBytes > 0 &&
      uncompressedSizeBytes <= MAX_UNCOMPRESSED_BYTES,
  ].every(Boolean);
}

function manifestVerified(
  options: PortableUpdateStagerOptions,
  manifest: Record<string, unknown>,
  release: PortableRelease,
  archive: GitHubAsset,
  target: UpdatePortableTarget,
): boolean {
  const product = recordAt(manifest, "product");
  const releaseRecord = recordAt(manifest, "release");
  const artifact = recordAt(manifest, "artifact");
  const nativeVerified = nativeSecurityVerified(manifest, target);
  const releaseVerified = releaseTrustVerified(options, manifest);
  return [
    portableManifestGenerationSchemaVerified(manifest, target),
    fieldEquals(product, "packageName", PACKAGE_NAME),
    fieldEquals(product, "packageVersion", release.targetVersion),
    releaseManifestVerified(releaseRecord, release),
    artifactManifestVerified(artifact, archive, target),
    manifestArchiveSha(manifest) !== undefined &&
      runtimeVerified(manifest, target) &&
      (nativeVerified || releaseVerified) &&
      updatePredicatesVerified(manifest, nativeVerified, releaseVerified) &&
      reviewedBindingVerified(manifest, release, archive, target, nativeVerified),
  ].every(Boolean);
}

function checksumBindsArchive(text: string, sha256: string, assetName: string): boolean {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .includes(`${sha256}  ${assetName}`);
}

export function archiveSizeLimit(asset: GitHubAsset): number {
  if (asset.size > MAX_ARCHIVE_BYTES) {
    throw new PortableUpdateStagingError(
      "portable-verification-failed",
      "portable asset is too large",
    );
  }
  return asset.size;
}

interface CandidateTextEvidence {
  readonly manifest: TextAsset;
  readonly checksum: TextAsset;
}

interface CandidateManifestVerificationInput {
  readonly options: PortableUpdateStagerOptions;
  readonly manifestRecord: Record<string, unknown>;
  readonly release: PortableRelease;
  readonly archive: GitHubAsset;
  readonly evidence: CandidateTextEvidence;
  readonly target: UpdatePortableTarget;
  readonly portable: NonNullable<PortableUpdateStageInput["candidate"]["portable"]>;
  readonly archiveSha256: string;
}

function candidateManifestVerified(input: CandidateManifestVerificationInput): boolean {
  const { options, manifestRecord, release, archive, evidence, target, portable, archiveSha256 } =
    input;
  return [
    manifestVerified(options, manifestRecord, release, archive, target),
    recordAt(manifestRecord, "artifact")?.uncompressedSizeBytes === portable.uncompressedSizeBytes,
    archiveSha256 === portable.sha256,
    checksumBindsArchive(evidence.checksum.text, archiveSha256, archive.name),
  ].every(Boolean);
}

async function fetchCandidateTextEvidence(
  options: PortableUpdateStagerOptions,
  input: PortableUpdateStageInput,
  release: PortableRelease,
  target: UpdatePortableTarget,
): Promise<CandidateTextEvidence> {
  const portable = candidatePortable(input, target);
  const manifestAsset = assetByName(release, portable.manifestAssetName);
  const checksumAsset = assetByName(release, portable.checksumAssetName);
  assertCandidateAsset(manifestAsset, {
    id: portable.manifestAssetId,
    name: manifestName(target),
    size: portable.manifestSizeBytes,
  });
  assertCandidateAsset(checksumAsset, {
    id: portable.checksumAssetId,
    name: checksumName(target),
    size: portable.checksumSizeBytes,
  });
  const manifest = await fetchTextAsset(options, manifestAsset, input.signal);
  const checksum = await fetchTextAsset(options, checksumAsset, input.signal);
  if (
    portable.manifestAssetName !== manifestName(target) ||
    manifest.sha256 !== portable.manifestSha256 ||
    portable.checksumAssetName !== checksumName(target) ||
    checksum.sha256 !== portable.checksumSha256
  ) {
    throw new PortableUpdateStagingError(
      "portable-verification-failed",
      "portable candidate evidence identity changed",
    );
  }
  return { manifest, checksum };
}

function verifiedCandidateSidecars(
  options: PortableUpdateStagerOptions,
  input: PortableUpdateStageInput,
  release: PortableRelease,
  archive: GitHubAsset,
  evidence: CandidateTextEvidence,
  target: UpdatePortableTarget,
): readonly PortableSidecarRuntimeVerification[] {
  const portable = candidatePortable(input, target);
  const manifestRecord = parseJsonRecord(evidence.manifest.text);
  const archiveSha256 =
    manifestRecord === undefined ? undefined : manifestArchiveSha(manifestRecord);
  if (
    manifestRecord === undefined ||
    archiveSha256 === undefined ||
    !candidateManifestVerified({
      options,
      manifestRecord,
      release,
      archive,
      evidence,
      target,
      portable,
      archiveSha256,
    })
  ) {
    throw new PortableUpdateStagingError(
      "portable-verification-failed",
      "portable manifest is not verified",
    );
  }
  const sidecars = verifyPortableManifestSidecars(manifestRecord, target).sidecars;
  const actualSidecars = sidecars.map(({ summary }) => summary);
  if (JSON.stringify(actualSidecars) !== JSON.stringify(portable.sidecarRuntimes ?? [])) {
    throw new PortableUpdateStagingError(
      "portable-verification-failed",
      "portable candidate sidecar identity changed",
    );
  }
  return sidecars;
}

export async function resolvePortableStageAssets(
  options: PortableUpdateStagerOptions,
  input: PortableUpdateStageInput,
  target: UpdatePortableTarget,
): Promise<PortableStageAssets> {
  const portable = candidatePortable(input, target);
  const release = await fetchRelease(options, input);
  assertFirstClassArchiveSetComplete(release);
  const archive = assetByName(release, portable.assetName);
  assertCandidateAsset(archive, {
    id: portable.assetId,
    name: UPDATE_PORTABLE_TARGET_ASSET_NAMES[target],
    size: portable.sizeBytes,
  });
  const evidence = await fetchCandidateTextEvidence(options, input, release, target);
  const sidecars = verifiedCandidateSidecars(options, input, release, archive, evidence, target);
  const manifestRecord = parseJsonRecord(evidence.manifest.text);
  if (manifestRecord === undefined) {
    throw new PortableUpdateStagingError(
      "portable-verification-failed",
      "portable manifest is not verified",
    );
  }
  const windowsGeneration = verifiedWindowsGenerationManifestBinding(manifestRecord, target);
  return {
    release,
    archive,
    manifest: evidence.manifest,
    sidecars,
    nativePlatformVerificationRequired: nativeSecurityVerified(manifestRecord, target),
    ...(windowsGeneration === undefined ? {} : { windowsGeneration }),
  };
}
