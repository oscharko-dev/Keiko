import { rmSync } from "node:fs";
import { join } from "node:path";
import type {
  UpdatePortableSidecarSummary,
  UpdatePortableStagingSummary,
  UpdatePortableTarget,
} from "@oscharko-dev/keiko-contracts";
import { compareSemver } from "./update-preflight-registry.js";
import {
  assertPortableDiskHeadroom,
  createPortableDownloadRoot,
  stageArchiveFile,
} from "./update-portable-staging-archive.js";
import {
  archiveSizeLimit,
  fetchPortableAssetToFile,
  resolvePortableStageAssets,
  type PortableStageAssets,
} from "./update-portable-staging-manifest.js";
import {
  assertAbort,
  manifestArchiveSha,
  parseJsonRecord,
  portableStageSummary,
  PORTABLE_OPERATION_TIMEOUT_MS,
  reportPortableProgress,
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
  const candidate = input.candidate.portable;
  if (!eligiblePortableInstall(input, portable, candidate)) {
    throw new PortableUpdateStagingError(
      "portable-preflight-ineligible",
      "portable install is not eligible",
    );
  }
  if (compareSemver(input.targetVersion, portable.packageVersion) <= 0) {
    throw new PortableUpdateStagingError(
      "portable-preflight-ineligible",
      "portable target is not newer",
    );
  }
  return portable.target;
}

function eligiblePortableInstall(
  input: PortableUpdateStageInput,
  portable: PortableUpdateStageInput["installMode"]["portable"],
  candidate: PortableUpdateStageInput["candidate"]["portable"],
): portable is NonNullable<PortableUpdateStageInput["installMode"]["portable"]> & {
  readonly packageVersion: string;
} {
  return (
    input.installMode.installKind === "portable-managed" &&
    portable?.updateEligible === true &&
    portable.stable === true &&
    typeof portable.packageVersion === "string" &&
    input.candidate.targetVersion === input.targetVersion &&
    input.candidate.currentVersion === portable.packageVersion &&
    candidate?.target === portable.target
  );
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
  const timeoutSignal = AbortSignal.timeout(PORTABLE_OPERATION_TIMEOUT_MS);
  const signal =
    input.signal === undefined ? timeoutSignal : AbortSignal.any([input.signal, timeoutSignal]);
  const operationInput = { ...input, signal };
  try {
    return await runPortableUpdateStage(options, operationInput);
  } catch (error) {
    if (signal.aborted) {
      if (input.signal?.aborted === true) {
        throw new PortableUpdateStagingError("cancelled", "portable staging was cancelled");
      }
      throw new PortableUpdateStagingError(
        "portable-staging-failed",
        "portable staging deadline exceeded",
      );
    }
    throw error;
  }
}

async function runPortableUpdateStage(
  options: PortableUpdateStagerOptions,
  input: PortableUpdateStageInput,
): Promise<UpdatePortableStagingSummary> {
  const target = resolveTarget(input);
  assertPortableDiskHeadroom(input, target, options.availableDiskBytes);
  const stageAssets = await resolvePortableStageAssets(options, input, target);
  const { stageId, sha256 } = await stageCandidateArchive(options, input, target, stageAssets);
  const { release, archive, manifest, sidecars } = stageAssets;
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

async function stageCandidateArchive(
  options: PortableUpdateStagerOptions,
  input: PortableUpdateStageInput,
  target: UpdatePortableTarget,
  stageAssets: PortableStageAssets,
): Promise<{ readonly stageId: string; readonly sha256: string }> {
  const { release, archive, manifest, sidecars, windowsGeneration } = stageAssets;
  archiveSizeLimit(archive);
  const downloadRoot = createPortableDownloadRoot(input, target);
  const archivePath = join(downloadRoot, "archive.zip");
  let sha256: string;
  let stageId: string;
  try {
    sha256 = await fetchPortableAssetToFile(options, archive, archivePath, input);
    if (sha256 !== manifestExpectedSha(manifest.text)) {
      throw new PortableUpdateStagingError(
        "portable-verification-failed",
        "portable archive hash mismatch",
      );
    }
    recordDownload(options, release.targetVersion, target, archive, sha256);
    assertAbort(input.signal);
    stageId = stageIdFor(input.sessionId, release.targetVersion, sha256);
    await stageArchiveFile({
      archivePath,
      session: input,
      target,
      targetVersion: release.targetVersion,
      stageId,
      sidecars,
      nativePlatformVerificationRequired: stageAssets.nativePlatformVerificationRequired,
      ...(windowsGeneration === undefined ? {} : { windowsGeneration }),
      ...(options.platformVerifier === undefined
        ? {}
        : { platformVerifier: options.platformVerifier }),
      ...(options.securityLogSink === undefined
        ? {}
        : { securityLogSink: options.securityLogSink }),
    });
    reportPortableProgress(input, {
      phase: "verifying",
      completedBytes: archive.size,
      totalBytes: archive.size,
    });
  } finally {
    rmSync(downloadRoot, { recursive: true, force: true });
  }
  return { stageId, sha256 };
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
