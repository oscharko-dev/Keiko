import { createHash } from "node:crypto";
import { gatewayFetch, readBytesCapped } from "@oscharko-dev/keiko-model-gateway/internal/http";
import {
  type UpdatePreflightBlocker,
  type UpdatePreflightPortableInstallability,
  type UpdatePortableSidecarSummary,
  type UpdatePortableTarget,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import { currentGatewayEgressConfig } from "./deps.js";
import {
  type GitHubAsset,
  type PortableRelease,
  firstClassArchiveSetComplete,
  portableBlocker,
  requiredAssetName,
} from "./update-preflight-portable-shared.js";
import { isRecord } from "./update-preflight-registry.js";
import {
  PortableSidecarVerificationError,
  verifyPortableManifestSidecars,
} from "./update-portable-sidecar-verification.js";

const MAX_PORTABLE_MANIFEST_BYTES = 256_000;
const MAX_CHECKSUM_BYTES = 32_000;
const UPDATE_PREFLIGHT_TIMEOUT_MS = 8_000;
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
interface TextAsset {
  readonly text: string;
  readonly sha256: string;
}

interface PortableAssetResolution {
  readonly installability: UpdatePreflightPortableInstallability;
  readonly blockers: readonly UpdatePreflightBlocker[];
  readonly warnings: readonly string[];
}

interface ValidatedPortableManifest {
  readonly archiveSha256: string;
  readonly sidecarRuntimes: readonly UpdatePortableSidecarSummary[];
}

class PortableSigningVerificationError extends Error {
  constructor() {
    super("portable signing evidence is not verified");
    this.name = "PortableSigningVerificationError";
  }
}

function manifestAssetName(target: UpdatePortableTarget): string {
  return `${target}-portable-manifest.json`;
}

function checksumAssetName(target: UpdatePortableTarget): string {
  return `${target}-SHA256SUMS.txt`;
}

function assetByName(assets: readonly GitHubAsset[], name: string): GitHubAsset | undefined {
  return assets.find((asset) => asset.name === name);
}

async function fetchTextAsset(
  deps: UiHandlerDeps,
  asset: GitHubAsset,
  maxBytes: number,
): Promise<TextAsset | undefined> {
  const response = await gatewayFetch(asset.downloadUrl, {
    method: "GET",
    headers: { Accept: "application/octet-stream", "User-Agent": "Keiko" },
    fetchImpl: deps.gatewayReadinessFetch,
    timeoutMs: UPDATE_PREFLIGHT_TIMEOUT_MS,
    maxResponseBytes: maxBytes,
    egress: currentGatewayEgressConfig(deps),
  });
  if (!response.ok) return undefined;
  const bytes = await readBytesCapped(response, maxBytes);
  return {
    text: new TextDecoder().decode(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function manifestRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function recordAt(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function requiredPredicates(
  manifest: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const updateEligibility = recordAt(manifest, "updateEligibility");
  if (updateEligibility === undefined) return undefined;
  return recordAt(updateEligibility, "requiredPredicates");
}

function all(values: readonly boolean[]): boolean {
  return values.every(Boolean);
}

function fieldEquals(
  record: Record<string, unknown> | undefined,
  key: string,
  expected: unknown,
): boolean {
  if (record === undefined) return false;
  return record[key] === expected;
}

function stringFieldMatches(
  record: Record<string, unknown> | undefined,
  key: string,
  pattern: RegExp,
): boolean {
  if (record === undefined) return false;
  const value = record[key];
  return typeof value === "string" && pattern.test(value);
}

function signatureKind(target: UpdatePortableTarget): string {
  return target === "windows-x64" ? "authenticode" : "developer-id-notarized";
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
  const checks = security === undefined ? undefined : recordAt(security, "verificationChecks");
  const macos = target !== "windows-x64";
  return all([
    fieldEquals(security, "verificationPolicy", "production"),
    fieldEquals(security, "verificationStatus", "verified-production"),
    fieldEquals(security, "signatureKind", signatureKind(target)),
    fieldEquals(security, "signatureVerified", true),
    fieldEquals(security, "notarizationRequired", macos),
    fieldEquals(security, "notarizationVerified", macos),
    targetChecksVerified(target, checks),
  ]);
}

function validManifestBooleans(manifest: Record<string, unknown>): boolean {
  const release = recordAt(manifest, "release");
  const updateEligibility = recordAt(manifest, "updateEligibility");
  const predicates = requiredPredicates(manifest);
  return all([
    fieldEquals(release, "stable", true),
    fieldEquals(updateEligibility, "stableOnly", true),
    fieldEquals(updateEligibility, "rollbackSupported", false),
    fieldEquals(updateEligibility, "eligibleAfterSetupOnly", true),
    fieldEquals(predicates, "artifactShaVerified", true),
    fieldEquals(predicates, "manifestReleaseImpactBound", true),
    fieldEquals(predicates, "platformSignatureLocallyVerified", true),
  ]);
}

function artifactSha256(manifest: Record<string, unknown>): string | undefined {
  const artifact = recordAt(manifest, "artifact");
  if (artifact === undefined) return undefined;
  const sha256 = artifact.sha256;
  return typeof sha256 === "string" && HEX_SHA256.test(sha256) ? sha256 : undefined;
}

function validManifestIdentity(
  manifest: Record<string, unknown>,
  release: PortableRelease,
  archive: GitHubAsset,
  target: UpdatePortableTarget,
): boolean {
  const product = recordAt(manifest, "product");
  const artifact = recordAt(manifest, "artifact");
  const releaseRecord = recordAt(manifest, "release");
  return all([
    manifest.schemaVersion === 1 &&
      fieldEquals(product, "packageName", "@oscharko-dev/keiko") &&
      fieldEquals(product, "packageVersion", release.targetVersion),
    fieldEquals(releaseRecord, "releaseId", release.id),
    fieldEquals(releaseRecord, "releaseTag", `v${release.targetVersion}`),
    stringFieldMatches(releaseRecord, "commitSha", COMMIT_SHA),
    fieldEquals(artifact, "platformTarget", target),
    fieldEquals(artifact, "assetName", archive.name),
    fieldEquals(artifact, "assetId", archive.id),
    fieldEquals(artifact, "sizeBytes", archive.size),
    fieldEquals(artifact, "archiveFormat", "zip"),
    artifactSha256(manifest) !== undefined,
  ]);
}

function reviewedBindingValid(
  manifest: Record<string, unknown>,
  release: PortableRelease,
  archive: GitHubAsset,
  target: UpdatePortableTarget,
): boolean {
  const releaseImpact = recordAt(manifest, "releaseImpact");
  const binding =
    releaseImpact === undefined ? undefined : recordAt(releaseImpact, "reviewedBinding");
  const archiveSha256 = artifactSha256(manifest);
  return all([
    archiveSha256 !== undefined,
    fieldEquals(releaseImpact, "entryPackageVersion", release.targetVersion),
    fieldEquals(releaseImpact, "entryReleaseTag", `v${release.targetVersion}`),
    fieldEquals(binding, "releaseId", release.id),
    fieldEquals(binding, "releaseTag", `v${release.targetVersion}`),
    fieldEquals(binding, "assetId", archive.id),
    fieldEquals(binding, "assetName", archive.name),
    fieldEquals(binding, "assetSizeBytes", archive.size),
    fieldEquals(binding, "platformTarget", target),
    fieldEquals(binding, "packageVersion", release.targetVersion),
    fieldEquals(binding, "archiveSha256", archiveSha256),
    fieldEquals(binding, "platformSignatureLocallyVerified", true),
  ]);
}

function validateManifest(
  manifest: Record<string, unknown>,
  release: PortableRelease,
  archive: GitHubAsset,
  target: UpdatePortableTarget,
): ValidatedPortableManifest | undefined {
  const sha256 = artifactSha256(manifest);
  if (sha256 === undefined) return undefined;
  if (!validManifestIdentity(manifest, release, archive, target)) return undefined;
  if (!validManifestBooleans(manifest)) return undefined;
  if (!securityVerified(manifest, target)) throw new PortableSigningVerificationError();
  if (!reviewedBindingValid(manifest, release, archive, target)) return undefined;
  return {
    archiveSha256: sha256,
    sidecarRuntimes: verifyPortableManifestSidecars(manifest, target).summaries,
  };
}

function checksumIncludesArchive(checksums: string, sha256: string, assetName: string): boolean {
  return checksums
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .includes(`${sha256}  ${assetName}`);
}

function missingResolution(
  target: UpdatePortableTarget,
  message: string,
  code: UpdatePreflightBlocker["code"],
): PortableAssetResolution {
  return {
    installability: {
      source: "github-release-asset",
      target,
      requiredAssetName: requiredAssetName(target),
      status: "missing",
    },
    blockers: [portableBlocker(code, message)],
    warnings: [],
  };
}

async function readAssetSafely(
  deps: UiHandlerDeps,
  asset: GitHubAsset,
  maxBytes: number,
): Promise<TextAsset | undefined> {
  try {
    return await fetchTextAsset(deps, asset, maxBytes);
  } catch {
    return undefined;
  }
}

export async function resolvePortableAsset(
  deps: UiHandlerDeps,
  release: PortableRelease,
  target: UpdatePortableTarget,
): Promise<PortableAssetResolution> {
  if (!firstClassArchiveSetComplete(release.assets)) {
    return missingResolution(
      target,
      "The GitHub Release does not expose exactly the three reviewed portable ZIP assets.",
      "portable-asset-missing",
    );
  }
  return resolveTargetPortableAsset(deps, release, target);
}

async function resolveTargetPortableAsset(
  deps: UiHandlerDeps,
  release: PortableRelease,
  target: UpdatePortableTarget,
): Promise<PortableAssetResolution> {
  const archive = assetByName(release.assets, requiredAssetName(target));
  const manifestAsset = assetByName(release.assets, manifestAssetName(target));
  const checksumAsset = assetByName(release.assets, checksumAssetName(target));
  if (archive === undefined) {
    return missingResolution(
      target,
      "The matching portable ZIP asset is missing.",
      "portable-asset-missing",
    );
  }
  if (manifestAsset === undefined) {
    return missingResolution(
      target,
      "The matching portable manifest asset is missing.",
      "portable-manifest-missing",
    );
  }
  if (checksumAsset === undefined) {
    return missingResolution(
      target,
      "The matching portable checksum asset is missing.",
      "portable-checksum-missing",
    );
  }
  return resolvePortableEvidence(deps, release, target, archive, manifestAsset, checksumAsset);
}

async function resolvePortableEvidence(
  deps: UiHandlerDeps,
  release: PortableRelease,
  target: UpdatePortableTarget,
  archive: GitHubAsset,
  manifestAsset: GitHubAsset,
  checksumAsset: GitHubAsset,
): Promise<PortableAssetResolution> {
  const manifestText = await readAssetSafely(deps, manifestAsset, MAX_PORTABLE_MANIFEST_BYTES);
  const manifest = manifestText === undefined ? undefined : manifestRecord(manifestText.text);
  const validated = validateManifestSafely(manifest, release, archive, target);
  if (validated instanceof PortableSigningVerificationError) {
    return signingResolution(target);
  }
  if (validated instanceof PortableSidecarVerificationError) {
    return sidecarResolution(target);
  }
  if (manifestText === undefined || manifest === undefined || validated === undefined) {
    return malformedResolution(target, "The matching portable manifest is malformed.");
  }
  const checksum = await readAssetSafely(deps, checksumAsset, MAX_CHECKSUM_BYTES);
  if (
    checksum === undefined ||
    !checksumIncludesArchive(checksum.text, validated.archiveSha256, archive.name)
  ) {
    return checksumResolution(target, checksum === undefined ? "missing" : "mismatch");
  }
  return eligibleResolution(
    release,
    target,
    archive,
    manifestAsset,
    checksumAsset,
    manifestText.sha256,
    validated.archiveSha256,
    validated.sidecarRuntimes,
  );
}

function validateManifestSafely(
  manifest: Record<string, unknown> | undefined,
  release: PortableRelease,
  archive: GitHubAsset,
  target: UpdatePortableTarget,
):
  | ValidatedPortableManifest
  | PortableSigningVerificationError
  | PortableSidecarVerificationError
  | undefined {
  if (manifest === undefined) return undefined;
  try {
    return validateManifest(manifest, release, archive, target);
  } catch (error) {
    if (error instanceof PortableSigningVerificationError) return error;
    if (error instanceof PortableSidecarVerificationError) return error;
    throw error;
  }
}

function malformedResolution(
  target: UpdatePortableTarget,
  message: string,
): PortableAssetResolution {
  return {
    installability: {
      source: "github-release-asset",
      target,
      requiredAssetName: requiredAssetName(target),
      status: "malformed",
    },
    blockers: [portableBlocker("portable-manifest-malformed", message)],
    warnings: [],
  };
}

function checksumResolution(
  target: UpdatePortableTarget,
  reason: "missing" | "mismatch",
): PortableAssetResolution {
  return {
    installability: {
      source: "github-release-asset",
      target,
      requiredAssetName: requiredAssetName(target),
      status: "malformed",
    },
    blockers: [
      portableBlocker(
        reason === "missing" ? "portable-checksum-missing" : "portable-checksum-mismatch",
        reason === "missing"
          ? "The release verification file for this portable update could not be read."
          : "The release verification file does not match the downloaded update archive.",
      ),
    ],
    warnings: [],
  };
}

function signingResolution(target: UpdatePortableTarget): PortableAssetResolution {
  return {
    installability: {
      source: "github-release-asset",
      target,
      requiredAssetName: requiredAssetName(target),
      status: "malformed",
    },
    blockers: [
      portableBlocker(
        "portable-signing-unverified",
        "The portable update is missing verified signing or notarization evidence.",
      ),
    ],
    warnings: [],
  };
}

function sidecarResolution(target: UpdatePortableTarget): PortableAssetResolution {
  return {
    installability: {
      source: "github-release-asset",
      target,
      requiredAssetName: requiredAssetName(target),
      status: "malformed",
    },
    blockers: [
      portableBlocker(
        "portable-sidecar-verification-failed",
        "The matching portable sidecar payload metadata could not be verified.",
      ),
    ],
    warnings: [],
  };
}

function eligibleResolution(
  release: PortableRelease,
  target: UpdatePortableTarget,
  archive: GitHubAsset,
  manifestAsset: GitHubAsset,
  checksumAsset: GitHubAsset,
  manifestSha256: string,
  archiveSha256: string,
  sidecarRuntimes: readonly UpdatePortableSidecarSummary[],
): PortableAssetResolution {
  return {
    installability: {
      source: "github-release-asset",
      target,
      requiredAssetName: archive.name,
      status: "eligible",
      asset: {
        target,
        assetName: archive.name,
        assetId: archive.id,
        releaseId: release.id,
        sizeBytes: archive.size,
        sha256: archiveSha256,
        manifestAssetName: manifestAsset.name,
        manifestSha256,
        checksumAssetName: checksumAsset.name,
        checksumVerified: true,
        ...(sidecarRuntimes.length > 0 ? { sidecarRuntimes } : {}),
      },
    },
    blockers: [],
    warnings: [],
  };
}
