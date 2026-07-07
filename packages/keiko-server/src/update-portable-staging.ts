import type {
  UpdatePortableSidecarSummary,
  UpdatePortableStagingSummary,
  UpdatePortableTarget,
} from "@oscharko-dev/keiko-contracts";
import { compareSemver } from "./update-preflight-registry.js";
import { stageArchiveBytes } from "./update-portable-staging-archive.js";
import {
  archiveSizeLimit,
  fetchPortableAssetBytes,
  resolvePortableStageAssets,
} from "./update-portable-staging-manifest.js";
import {
  assertAbort,
  manifestArchiveSha,
  parseJsonRecord,
  portableStageSummary,
  sha256Bytes,
  stageIdFor,
  type GitHubAsset,
  type PortableUpdateStageInput,
  type PortableUpdateStager,
  type PortableUpdateStagerOptions,
  PortableUpdateStagingError,
} from "./update-portable-staging-shared.js";
import { PortableSidecarVerificationError } from "./update-portable-sidecar-verification.js";

export {
  PortableUpdateStagingError,
  type PortableUpdateStageInput,
  type PortableUpdateStager,
  type PortableUpdateStagerOptions,
} from "./update-portable-staging-shared.js";

function resolveTarget(input: PortableUpdateStageInput): UpdatePortableTarget {
  const portable = input.installMode.portable;
  if (
    input.installMode.installKind !== "portable-managed" ||
    portable?.updateEligible !== true ||
    portable.stable !== true
  ) {
    throw new PortableUpdateStagingError(
      "portable-preflight-ineligible",
      "portable install is not eligible",
    );
  }
  if (
    portable.packageVersion === undefined ||
    compareSemver(input.targetVersion, portable.packageVersion) <= 0
  ) {
    throw new PortableUpdateStagingError(
      "portable-preflight-ineligible",
      "portable target is not newer",
    );
  }
  return portable.target;
}

function manifestExpectedSha(text: string): string {
  const record = parseJsonRecord(text);
  const sha256 = record === undefined ? undefined : manifestArchiveSha(record);
  if (sha256 === undefined) {
    throw new PortableUpdateStagingError(
      "portable-verification-failed",
      "portable manifest is malformed",
    );
  }
  return sha256;
}

function recordDownload(
  options: PortableUpdateStagerOptions,
  targetVersion: string,
  target: UpdatePortableTarget,
  archive: GitHubAsset,
  sha256: string,
): void {
  options.localState?.recordAuditEvent("portable-download-result", {
    targetVersion,
    store: "package-install",
    status: "succeeded",
    portableTarget: target,
    portableAssetName: archive.name,
    portableAssetSha256: sha256,
    portableAssetSizeBytes: archive.size,
  });
}

function recordStage(
  options: PortableUpdateStagerOptions,
  summary: UpdatePortableStagingSummary,
): void {
  const localState = options.localState;
  if (localState === undefined) return;
  const current = localState.readRuntimeState();
  localState.writeRuntimeState({
    ...current,
    targetVersion: summary.packageVersion,
    portableStage: summary,
  });
  localState.recordAuditEvent("portable-staging-result", {
    targetVersion: summary.packageVersion,
    store: "package-install",
    status: "succeeded",
    portableStageId: summary.stageId,
    portableTarget: summary.target,
    portableAssetName: summary.assetName,
    portableAssetSha256: summary.sha256,
    portableAssetSizeBytes: summary.sizeBytes,
  });
  for (const sidecar of summary.sidecarRuntimes ?? []) {
    recordSidecarVerification(options, summary.packageVersion, sidecar);
  }
}

function recordFailure(options: PortableUpdateStagerOptions, targetVersion: string): void {
  options.localState?.recordAuditEvent("portable-staging-result", {
    targetVersion,
    store: "package-install",
    status: "failed",
  });
}

function recordSidecarVerification(
  options: PortableUpdateStagerOptions,
  targetVersion: string,
  summary: UpdatePortableSidecarSummary,
): void {
  options.localState?.recordAuditEvent("portable-sidecar-verification-result", {
    targetVersion,
    store: "package-install",
    status: summary.status === "verified" ? "succeeded" : "failed",
    portableSidecarName: summary.name,
    portableSidecarKind: summary.kind,
    portableSidecarVersion: summary.upstreamVersion,
    portableSidecarTarget: summary.platformTarget,
    portableSidecarPayloadSha256: summary.payloadSha256,
    portableSidecarPayloadSha256Prefix: summary.payloadSha256Prefix,
    portableSidecarStatus: summary.status,
    ...(summary.failureCode === undefined
      ? {}
      : { portableSidecarFailureCode: summary.failureCode }),
  });
}

function recordSidecarFailure(
  options: PortableUpdateStagerOptions,
  targetVersion: string,
  error: PortableSidecarVerificationError,
): void {
  if (error.sidecarSummary !== undefined) {
    recordSidecarVerification(options, targetVersion, error.sidecarSummary);
    return;
  }
  options.localState?.recordAuditEvent("portable-sidecar-verification-result", {
    targetVersion,
    store: "package-install",
    status: "failed",
    portableSidecarStatus: "failed",
    portableSidecarFailureCode: error.failureCode,
  });
}

async function stagePortableUpdate(
  options: PortableUpdateStagerOptions,
  input: PortableUpdateStageInput,
): Promise<UpdatePortableStagingSummary> {
  const target = resolveTarget(input);
  const stageAssets = await resolvePortableStageAssets(options, input, target);
  const { release, archive, manifest, sidecars } = stageAssets;
  const archiveBytes = await fetchPortableAssetBytes(
    options,
    archive,
    archiveSizeLimit(archive),
    input.signal,
  );
  const sha256 = sha256Bytes(archiveBytes);
  if (sha256 !== manifestExpectedSha(manifest.text)) {
    throw new PortableUpdateStagingError(
      "portable-verification-failed",
      "portable archive hash mismatch",
    );
  }
  recordDownload(options, release.targetVersion, target, archive, sha256);
  assertAbort(input.signal);
  const stageId = stageIdFor(input.sessionId, release.targetVersion, sha256);
  await stageArchiveBytes({
    bytes: archiveBytes,
    session: input,
    target,
    targetVersion: release.targetVersion,
    stageId,
    sidecars,
    ...(options.platformVerifier === undefined
      ? {}
      : { platformVerifier: options.platformVerifier }),
  });
  const summary = portableStageSummary({
    stageId,
    release,
    archive,
    target,
    sha256,
    manifestSha256: manifest.sha256,
    sidecarRuntimes: sidecars.map((sidecar) => sidecar.summary),
  });
  recordStage(options, summary);
  return summary;
}

export function createPortableUpdateStager(
  options: PortableUpdateStagerOptions,
): PortableUpdateStager {
  return {
    async stage(input): Promise<UpdatePortableStagingSummary> {
      try {
        return await stagePortableUpdate(options, input);
      } catch (error) {
        if (error instanceof PortableSidecarVerificationError) {
          recordSidecarFailure(options, input.targetVersion, error);
          recordFailure(options, input.targetVersion);
          throw new PortableUpdateStagingError(error.reason, error.message);
        }
        recordFailure(options, input.targetVersion);
        if (error instanceof PortableUpdateStagingError) throw error;
        throw new PortableUpdateStagingError("portable-staging-failed", "portable staging failed");
      }
    },
  };
}
