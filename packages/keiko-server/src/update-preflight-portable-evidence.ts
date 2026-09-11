import { createHash } from "node:crypto";
import {
  KEIKO_PORTABLE_RELEASE_TRUSTED_KEYS,
  verifyPortableReleaseTrust,
  type PortableReleaseTrustFailureReason,
  type PortableReleaseTrustVerification,
} from "@oscharko-dev/keiko-security/portable-release-trust";
import { gatewayFetch, readBytesCapped } from "@oscharko-dev/keiko-model-gateway/internal/http";
import {
  type UpdatePreflightBlocker,
  type UpdatePreflightPortableInstallability,
  type UpdatePortableSidecarSummary,
  type UpdatePortableTarget,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import { currentGatewayEgressConfig } from "./deps.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import {
  type GitHubAsset,
  PortableAssetRedirectError,
  type PortableRelease,
  fetchGitHubReleaseAsset,
  fetchWithPortableRetry,
  firstClassArchiveSetComplete,
  portableBlocker,
  portableFetchFailureReason,
  requiredAssetName,
} from "./update-preflight-portable-shared.js";
import { isRecord } from "./update-preflight-registry.js";
import {
  PortableSidecarVerificationError,
  verifyPortableManifestSidecars,
} from "./update-portable-sidecar-verification.js";
import { portableManifestGenerationSchemaVerified } from "./update-portable-windows-generation.js";

const MAX_PORTABLE_MANIFEST_BYTES = 256_000;
const MAX_CHECKSUM_BYTES = 32_000;
const UPDATE_PREFLIGHT_TIMEOUT_MS = 8_000;
const PORTABLE_EVIDENCE_DEADLINE_MS = 30_000;
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
  readonly releaseTrust?: {
    readonly keyId: string;
    readonly metadataVersion: number;
  };
  readonly uncompressedSizeBytes: number;
  readonly sidecarRuntimes: readonly UpdatePortableSidecarSummary[];
}

class PortableSigningVerificationError extends Error {
  constructor(readonly trustReason: PortableReleaseTrustFailureReason | "missing") {
    super("portable release trust is not verified");
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
  deadlineAt: number,
): Promise<TextAsset | undefined> {
  const response = await fetchGitHubReleaseAsset(asset.downloadUrl, (url) =>
    fetchWithPortableRetry(
      () =>
        gatewayFetch(url, {
          method: "GET",
          headers: { Accept: "application/octet-stream", "User-Agent": "Keiko" },
          fetchImpl: deps.gatewayReadinessFetch,
          timeoutMs: Math.max(1, Math.min(UPDATE_PREFLIGHT_TIMEOUT_MS, deadlineAt - Date.now())),
          maxResponseBytes: maxBytes,
          egress: currentGatewayEgressConfig(deps),
        }),
      { deadlineAt },
    ),
  );
  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }
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
  if (target === "windows-x64") return "authenticode";
  return target === "linux-x64" ? "github-oidc-attested" : "developer-id-notarized";
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
  const checks = security === undefined ? undefined : recordAt(security, "verificationChecks");
  const macos = target.startsWith("macos-");
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

function releaseTrustVerification(
  deps: UiHandlerDeps,
  manifest: Record<string, unknown>,
): PortableReleaseTrustVerification {
  return verifyPortableReleaseTrust(manifest, {
    now: new Date(deps.updatePortableReleaseNow?.() ?? Date.now()),
    trustedKeys: deps.updatePortableReleaseTrustedKeys ?? KEIKO_PORTABLE_RELEASE_TRUSTED_KEYS,
  });
}

function validManifestBooleans(
  manifest: Record<string, unknown>,
  nativeVerified: boolean,
  releaseTrustVerified: boolean,
): boolean {
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
    fieldEquals(predicates, "platformSignatureLocallyVerified", nativeVerified),
    nativeVerified || fieldEquals(predicates, "releaseTrustRequired", releaseTrustVerified),
  ]);
}

function artifactSha256(manifest: Record<string, unknown>): string | undefined {
  const artifact = recordAt(manifest, "artifact");
  if (artifact === undefined) return undefined;
  const sha256 = artifact.sha256;
  return typeof sha256 === "string" && HEX_SHA256.test(sha256) ? sha256 : undefined;
}

function artifactUncompressedSize(manifest: Record<string, unknown>): number | undefined {
  const value = recordAt(manifest, "artifact")?.uncompressedSizeBytes;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2 ** 31
    ? value
    : undefined;
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
    portableManifestGenerationSchemaVerified(manifest, target) &&
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
  nativeVerified: boolean,
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
    fieldEquals(binding, "platformSignatureLocallyVerified", nativeVerified),
  ]);
}

function validateManifest(
  deps: UiHandlerDeps,
  manifest: Record<string, unknown>,
  release: PortableRelease,
  archive: GitHubAsset,
  target: UpdatePortableTarget,
): ValidatedPortableManifest | undefined {
  const sha256 = artifactSha256(manifest);
  const uncompressedSizeBytes = artifactUncompressedSize(manifest);
  const nativeVerified = nativeSecurityVerified(manifest, target);
  const releaseTrust = releaseTrustVerification(deps, manifest);
  if (sha256 === undefined || uncompressedSizeBytes === undefined) return undefined;
  if (!validManifestIdentity(manifest, release, archive, target)) return undefined;
  if (!nativeVerified && !releaseTrust.ok) {
    throw new PortableSigningVerificationError(releaseTrust.reason);
  }
  if (!validManifestBooleans(manifest, nativeVerified, releaseTrust.ok)) return undefined;
  if (!reviewedBindingValid(manifest, release, archive, target, nativeVerified)) return undefined;
  return {
    archiveSha256: sha256,
    ...(releaseTrust.ok
      ? {
          releaseTrust: {
            keyId: releaseTrust.keyId,
            metadataVersion: releaseTrust.metadataVersion,
          },
        }
      : {}),
    uncompressedSizeBytes,
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
  deadlineAt: number,
  target: UpdatePortableTarget,
  assetKind: "manifest" | "checksum",
): Promise<TextAsset | undefined> {
  try {
    return await fetchTextAsset(deps, asset, maxBytes, deadlineAt);
  } catch (error) {
    if (error instanceof PortableAssetRedirectError) {
      deps.activityLog?.write({
        category: "security",
        correlationId: UNKNOWN_CORRELATION_ID,
        level: "warn",
        op: "update.portable-asset.redirect-refused",
        extra: { assetKind, reason: error.reason, target },
      });
    } else {
      deps.activityLog?.write({
        category: "diagnostic",
        correlationId: UNKNOWN_CORRELATION_ID,
        errorKind: "PORTABLE_FETCH_FAILURE",
        level: "warn",
        op: "update.portable-fetch.failed",
        extra: { assetKind, reason: portableFetchFailureReason(error), target },
      });
    }
    return undefined;
  }
}

function readManifestAsset(
  deps: UiHandlerDeps,
  asset: GitHubAsset,
  deadlineAt: number,
  target: UpdatePortableTarget,
): Promise<TextAsset | undefined> {
  return readAssetSafely(deps, asset, MAX_PORTABLE_MANIFEST_BYTES, deadlineAt, target, "manifest");
}

function readChecksumAsset(
  deps: UiHandlerDeps,
  asset: GitHubAsset,
  deadlineAt: number,
  target: UpdatePortableTarget,
): Promise<TextAsset | undefined> {
  return readAssetSafely(deps, asset, MAX_CHECKSUM_BYTES, deadlineAt, target, "checksum");
}

export async function resolvePortableAsset(
  deps: UiHandlerDeps,
  release: PortableRelease,
  target: UpdatePortableTarget,
): Promise<PortableAssetResolution> {
  if (!firstClassArchiveSetComplete(release.assets)) {
    return missingResolution(
      target,
      "The GitHub Release does not expose a complete reviewed portable ZIP asset set.",
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
  const deadlineAt = Date.now() + PORTABLE_EVIDENCE_DEADLINE_MS;
  const manifestText = await readManifestAsset(deps, manifestAsset, deadlineAt, target);
  const manifest = manifestText === undefined ? undefined : manifestRecord(manifestText.text);
  const validated = validateManifestSafely(deps, manifest, release, archive, target);
  if (validated instanceof PortableSigningVerificationError) {
    recordReleaseTrustFailure(deps, target, validated.trustReason, manifest);
    return signingResolution(target);
  }
  if (validated instanceof PortableSidecarVerificationError) {
    return sidecarResolution(target);
  }
  if (manifestText === undefined || manifest === undefined || validated === undefined) {
    return malformedResolution(target, "The matching portable manifest is malformed.");
  }
  recordReleaseTrustSuccess(deps, target, validated.releaseTrust);
  const checksum = await readChecksumAsset(deps, checksumAsset, deadlineAt, target);
  if (
    checksum === undefined ||
    !checksumIncludesArchive(checksum.text, validated.archiveSha256, archive.name)
  ) {
    return checksumResolution(target, checksum === undefined ? "missing" : "mismatch");
  }
  return eligibleResolution({
    release,
    target,
    archive,
    manifestAsset,
    checksumAsset,
    manifestSha256: manifestText.sha256,
    checksumSha256: checksum.sha256,
    archiveSha256: validated.archiveSha256,
    uncompressedSizeBytes: validated.uncompressedSizeBytes,
    sidecarRuntimes: validated.sidecarRuntimes,
  });
}

function recordReleaseTrustFailure(
  deps: UiHandlerDeps,
  target: UpdatePortableTarget,
  reason: PortableReleaseTrustFailureReason | "missing",
  manifest: Record<string, unknown> | undefined,
): void {
  if (manifest?.releaseTrust === undefined) return;
  deps.activityLog?.write({
    category: "security",
    correlationId: UNKNOWN_CORRELATION_ID,
    level: "warn",
    op: "update.release-trust.verify",
    extra: { reason, status: "failed", target },
  });
}

function recordReleaseTrustSuccess(
  deps: UiHandlerDeps,
  target: UpdatePortableTarget,
  trust: ValidatedPortableManifest["releaseTrust"],
): void {
  if (trust === undefined) return;
  deps.activityLog?.write({
    category: "security",
    correlationId: UNKNOWN_CORRELATION_ID,
    op: "update.release-trust.verify",
    extra: { ...trust, status: "succeeded", target },
  });
}

function validateManifestSafely(
  deps: UiHandlerDeps,
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
    return validateManifest(deps, manifest, release, archive, target);
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
        "The portable update has neither valid Keiko release trust nor optional native signing evidence.",
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

function eligibleResolution(input: {
  readonly release: PortableRelease;
  readonly target: UpdatePortableTarget;
  readonly archive: GitHubAsset;
  readonly manifestAsset: GitHubAsset;
  readonly checksumAsset: GitHubAsset;
  readonly manifestSha256: string;
  readonly checksumSha256: string;
  readonly archiveSha256: string;
  readonly uncompressedSizeBytes: number;
  readonly sidecarRuntimes: readonly UpdatePortableSidecarSummary[];
}): PortableAssetResolution {
  return {
    installability: {
      source: "github-release-asset",
      target: input.target,
      requiredAssetName: input.archive.name,
      status: "eligible",
      asset: {
        target: input.target,
        assetName: input.archive.name,
        assetId: input.archive.id,
        releaseId: input.release.id,
        sizeBytes: input.archive.size,
        uncompressedSizeBytes: input.uncompressedSizeBytes,
        sha256: input.archiveSha256,
        manifestAssetName: input.manifestAsset.name,
        manifestAssetId: input.manifestAsset.id,
        manifestSizeBytes: input.manifestAsset.size,
        manifestSha256: input.manifestSha256,
        checksumAssetName: input.checksumAsset.name,
        checksumAssetId: input.checksumAsset.id,
        checksumSizeBytes: input.checksumAsset.size,
        checksumSha256: input.checksumSha256,
        checksumVerified: true,
        ...(input.sidecarRuntimes.length > 0 ? { sidecarRuntimes: input.sidecarRuntimes } : {}),
      },
    },
    blockers: [],
    warnings: [],
  };
}
