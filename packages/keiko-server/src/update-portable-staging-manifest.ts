import {
  gatewayFetch,
  readBytesCapped,
  readJsonCapped,
} from "@oscharko-dev/keiko-model-gateway/internal/http";
import {
  UPDATE_PORTABLE_TARGET_ASSET_NAMES,
  type UpdatePortableTarget,
} from "@oscharko-dev/keiko-contracts";
import { isStableVersion } from "./update-preflight-registry.js";
import {
  COMMIT_SHA,
  MAX_PORTABLE_MANIFEST_BYTES,
  MAX_RELEASE_METADATA_BYTES,
  PACKAGE_NAME,
  RELEASE_URL,
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
} from "./update-portable-staging-shared.js";

export interface PortableStageAssets {
  readonly release: PortableRelease;
  readonly archive: GitHubAsset;
  readonly manifest: TextAsset;
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

function assetByName(release: PortableRelease, name: string): GitHubAsset {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (asset === undefined) {
    throw new PortableUpdateStagingError("portable-verification-failed", "required asset missing");
  }
  return asset;
}

function manifestName(target: UpdatePortableTarget): string {
  return `${target}-portable-manifest.json`;
}

function checksumName(target: UpdatePortableTarget): string {
  return `${target}-SHA256SUMS.txt`;
}

const MAX_ASSET_REDIRECTS = 3;

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
  const response = await gatewayFetch(
    RELEASE_URL,
    fetchOptions(options, {
      accept: "application/vnd.github+json",
      maxBytes: MAX_RELEASE_METADATA_BYTES,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
  );
  if (!response.ok) {
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
  return release;
}

function safeRedirectUrl(currentUrl: string, response: Response): string | undefined {
  if (response.status < 300 || response.status >= 400) return undefined;
  const location = response.headers.get("location");
  if (location === null || location.trim().length === 0) return undefined;
  const url = new URL(location, currentUrl);
  const githubOwned =
    url.hostname === "github.com" || url.hostname.endsWith(".githubusercontent.com");
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || !githubOwned) {
    throw new PortableUpdateStagingError(
      "portable-download-failed",
      "asset redirect target is unsafe",
    );
  }
  return url.toString();
}

async function fetchPortableAssetResponse(
  options: PortableUpdateStagerOptions,
  asset: GitHubAsset,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Response> {
  let currentUrl = asset.downloadUrl;
  for (let redirectCount = 0; redirectCount <= MAX_ASSET_REDIRECTS; redirectCount += 1) {
    const response = await gatewayFetch(
      currentUrl,
      fetchOptions(options, {
        accept: "application/octet-stream",
        maxBytes,
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    const nextUrl = safeRedirectUrl(currentUrl, response);
    if (nextUrl === undefined) return response;
    currentUrl = nextUrl;
  }
  throw new PortableUpdateStagingError("portable-download-failed", "asset redirect limit exceeded");
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
  const keys =
    target === "windows-x64"
      ? ["publisherChainVerified", "timestampVerified"]
      : ["developerIdVerified", "notarizationVerified", "stapleVerified", "assessmentVerified"];
  return keys.every((key) => checks?.[key] === true);
}

function securityVerified(
  manifest: Record<string, unknown>,
  target: UpdatePortableTarget,
): boolean {
  const security = recordAt(manifest, "security");
  const checks = recordAt(security, "verificationChecks");
  const macos = target !== "windows-x64";
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

function updatePredicatesVerified(manifest: Record<string, unknown>): boolean {
  const update = recordAt(manifest, "updateEligibility");
  const predicates = recordAt(update, "requiredPredicates");
  return (
    fieldEquals(update, "stableOnly", true) &&
    fieldEquals(update, "rollbackSupported", false) &&
    fieldEquals(update, "eligibleAfterSetupOnly", true) &&
    fieldEquals(predicates, "artifactShaVerified", true) &&
    fieldEquals(predicates, "manifestReleaseImpactBound", true) &&
    fieldEquals(predicates, "platformSignatureLocallyVerified", true)
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
    fieldEquals(binding, "platformSignatureLocallyVerified", true),
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
  return [
    fieldEquals(record, "platformTarget", target),
    fieldEquals(record, "assetName", archive.name),
    fieldEquals(record, "assetId", archive.id),
    fieldEquals(record, "sizeBytes", archive.size),
    fieldEquals(record, "archiveFormat", "zip"),
  ].every(Boolean);
}

function manifestVerified(
  manifest: Record<string, unknown>,
  release: PortableRelease,
  archive: GitHubAsset,
  target: UpdatePortableTarget,
): boolean {
  const product = recordAt(manifest, "product");
  const releaseRecord = recordAt(manifest, "release");
  const artifact = recordAt(manifest, "artifact");
  return [
    manifest.schemaVersion === 1,
    fieldEquals(product, "packageName", PACKAGE_NAME),
    fieldEquals(product, "packageVersion", release.targetVersion),
    releaseManifestVerified(releaseRecord, release),
    artifactManifestVerified(artifact, archive, target),
    manifestArchiveSha(manifest) !== undefined &&
      runtimeVerified(manifest, target) &&
      securityVerified(manifest, target) &&
      updatePredicatesVerified(manifest) &&
      reviewedBindingVerified(manifest, release, archive, target),
  ].every(Boolean);
}

function checksumBindsArchive(text: string, sha256: string, assetName: string): boolean {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .includes(`${sha256}  ${assetName}`);
}

export function archiveSizeLimit(asset: GitHubAsset): number {
  if (asset.size > 512 * 1024 * 1024) {
    throw new PortableUpdateStagingError(
      "portable-verification-failed",
      "portable asset is too large",
    );
  }
  return asset.size;
}

export async function resolvePortableStageAssets(
  options: PortableUpdateStagerOptions,
  input: PortableUpdateStageInput,
  target: UpdatePortableTarget,
): Promise<PortableStageAssets> {
  const release = await fetchRelease(options, input);
  const archive = assetByName(release, UPDATE_PORTABLE_TARGET_ASSET_NAMES[target]);
  const manifest = await fetchTextAsset(
    options,
    assetByName(release, manifestName(target)),
    input.signal,
  );
  const checksum = await fetchTextAsset(
    options,
    assetByName(release, checksumName(target)),
    input.signal,
  );
  const manifestRecord = parseJsonRecord(manifest.text);
  const archiveSha256 =
    manifestRecord === undefined ? undefined : manifestArchiveSha(manifestRecord);
  if (
    manifestRecord === undefined ||
    archiveSha256 === undefined ||
    !manifestVerified(manifestRecord, release, archive, target) ||
    !checksumBindsArchive(checksum.text, archiveSha256, archive.name)
  ) {
    throw new PortableUpdateStagingError(
      "portable-verification-failed",
      "portable manifest is not verified",
    );
  }
  return { release, archive, manifest };
}
