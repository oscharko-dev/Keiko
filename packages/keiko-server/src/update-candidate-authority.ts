import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  UpdateCandidateClaim,
  UpdateCandidateInstallIdentity,
  UpdateCandidatePortableIdentity,
  UpdateCandidateSnapshot,
  UpdateInstallMode,
  UpdatePreflightReport,
  UpdateReleaseImpactInput,
  UpdateSessionStartRequest,
} from "@oscharko-dev/keiko-contracts";
import { UPDATE_CANDIDATE_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/update-candidate";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "./diagnostics-log.js";

const DEFAULT_CANDIDATE_TTL_MS = 10 * 60_000;

interface CandidateRecord {
  readonly snapshot: UpdateCandidateSnapshot;
  readonly installMode: UpdateInstallMode;
  readonly executionToken: string;
  readonly impact: UpdateReleaseImpactInput;
}

export type UpdateCandidateRejection =
  | "unknown"
  | "expired"
  | "replayed"
  | "claim-mismatch"
  | "current-version-changed"
  | "install-facts-changed";

export type UpdateCandidateConsumption =
  | {
      readonly ok: true;
      readonly snapshot: UpdateCandidateSnapshot;
      readonly installMode: UpdateInstallMode;
      readonly impact: UpdateReleaseImpactInput;
    }
  | { readonly ok: false; readonly reason: UpdateCandidateRejection };

export interface UpdateCandidateAuthority {
  readonly issue: (
    report: UpdatePreflightReport,
    installMode: UpdateInstallMode,
  ) => UpdateCandidateClaim | undefined;
  readonly consume: (
    claim: UpdateSessionStartRequest,
    currentVersion: string,
    installMode: UpdateInstallMode,
    freshReport?: UpdatePreflightReport,
  ) => UpdateCandidateConsumption;
}

export interface UpdateCandidateAuthorityOptions {
  readonly now?: (() => number) | undefined;
  readonly idFactory?: (() => string) | undefined;
  readonly tokenFactory?: (() => string) | undefined;
  readonly ttlMs?: number | undefined;
  readonly capacity?: number | undefined;
  readonly activityLog?: SecurityLogSink | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestUpdateCandidate(value: unknown): string {
  return createHash("sha256")
    .update("keiko-update-candidate-v1\n")
    .update(canonicalJson(value))
    .digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function emitCandidateEvent(
  sink: SecurityLogSink | undefined,
  event: Parameters<SecurityLogSink["write"]>[0],
  diagnostics: ServerDiagnosticSink | undefined,
): void {
  try {
    sink?.write(event);
  } catch (error) {
    emitServerDiagnostic(
      diagnostics,
      serverDiagnosticFromError({
        correlationId: event.correlationId ?? "update-candidate-activity",
        operation: "update.candidate.activity-log",
        source: "update-candidate-authority",
        error,
        redact: (): string => "A bounded update diagnostic failed.",
      }),
    );
  }
}

export function updateCandidateInstallIdentity(
  mode: UpdateInstallMode,
): UpdateCandidateInstallIdentity | undefined {
  if (mode.status !== "supported" || mode.installKind === undefined) return undefined;
  const identityFacts = {
    packageName: mode.packageName,
    installKind: mode.installKind,
    packageManager: mode.packageManager,
    installRoot: mode.installRoot,
    portable: mode.portable,
  };
  return {
    packageName: mode.packageName,
    installKind: mode.installKind,
    ...(mode.packageManager === undefined ? {} : { packageManager: mode.packageManager }),
    ...(mode.portable?.target === undefined ? {} : { portableTarget: mode.portable.target }),
    installIdentitySha256: digestUpdateCandidate(identityFacts),
  };
}

export function updateCandidateRuntimeRejection(
  snapshot: UpdateCandidateSnapshot,
  currentVersion: string,
  installMode: UpdateInstallMode,
):
  | Extract<UpdateCandidateRejection, "current-version-changed" | "install-facts-changed">
  | undefined {
  if (currentVersion !== snapshot.currentVersion) return "current-version-changed";
  return updateCandidateInstallIdentity(installMode)?.installIdentitySha256 ===
    snapshot.install.installIdentitySha256
    ? undefined
    : "install-facts-changed";
}

function portableIdentity(
  report: UpdatePreflightReport,
): UpdateCandidatePortableIdentity | undefined {
  const asset = report.portableAsset?.asset;
  if (report.portableAsset?.status !== "eligible" || asset === undefined) return undefined;
  return {
    target: asset.target,
    releaseId: asset.releaseId,
    assetId: asset.assetId,
    assetName: asset.assetName,
    sizeBytes: asset.sizeBytes,
    uncompressedSizeBytes: asset.uncompressedSizeBytes,
    sha256: asset.sha256,
    manifestAssetName: asset.manifestAssetName,
    manifestAssetId: asset.manifestAssetId,
    manifestSizeBytes: asset.manifestSizeBytes,
    manifestSha256: asset.manifestSha256,
    checksumAssetName: asset.checksumAssetName,
    checksumAssetId: asset.checksumAssetId,
    checksumSizeBytes: asset.checksumSizeBytes,
    checksumSha256: asset.checksumSha256,
    checksumVerified: asset.checksumVerified,
    ...(asset.sidecarRuntimes === undefined ? {} : { sidecarRuntimes: asset.sidecarRuntimes }),
  };
}

function candidateSnapshot(input: {
  readonly report: UpdatePreflightReport;
  readonly installMode: UpdateInstallMode;
  readonly candidateId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}): UpdateCandidateSnapshot | undefined {
  const { report } = input;
  const install = updateCandidateInstallIdentity(input.installMode);
  if (
    !report.oneClickEligible ||
    !report.updateAvailable ||
    report.targetVersion === undefined ||
    report.impact === undefined ||
    report.release === undefined ||
    install === undefined
  ) {
    return undefined;
  }
  const portable = portableIdentity(report);
  if (install.installKind === "portable-managed" && portable === undefined) return undefined;
  return {
    schemaVersion: UPDATE_CANDIDATE_SCHEMA_VERSION,
    candidateId: input.candidateId,
    currentVersion: report.currentVersion,
    targetVersion: report.targetVersion,
    channel: "stable",
    install,
    release: { source: report.release.source, tag: report.release.tag },
    releaseImpactDigest: digestUpdateCandidate(report.impact),
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    ...(portable === undefined ? {} : { portable }),
  };
}

function validTtl(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_CANDIDATE_TTL_MS;
}

function validCapacity(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 32;
}

function impactInput(report: UpdatePreflightReport): UpdateReleaseImpactInput | undefined {
  if (report.impact === undefined) return undefined;
  return {
    affectedStateStores: report.impact.affectedStateStores,
    stateImpact: report.impact.stateImpact,
    userActionRequired: report.impact.userActionRequired,
  };
}

function freshReportMatches(
  record: CandidateRecord,
  report: UpdatePreflightReport | undefined,
): boolean {
  if (report === undefined) return false;
  const snapshot = candidateSnapshot({
    report,
    installMode: record.installMode,
    candidateId: record.snapshot.candidateId,
    issuedAt: record.snapshot.issuedAt,
    expiresAt: record.snapshot.expiresAt,
  });
  return (
    snapshot !== undefined &&
    safeEqual(digestUpdateCandidate(snapshot), digestUpdateCandidate(record.snapshot))
  );
}

function claimMatches(claim: UpdateSessionStartRequest, record: CandidateRecord): boolean {
  const snapshot = record.snapshot;
  return (
    safeEqual(claim.confirmationDigest, digestUpdateCandidate(snapshot)) &&
    safeEqual(claim.executionToken, record.executionToken)
  );
}

// The returned closure deliberately keeps the bounded issued and consumed sets private.
// eslint-disable-next-line max-lines-per-function
export function createUpdateCandidateAuthority(
  options: UpdateCandidateAuthorityOptions = {},
): UpdateCandidateAuthority {
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? randomUUID;
  const tokenFactory = options.tokenFactory ?? ((): string => randomBytes(32).toString("hex"));
  const ttlMs = validTtl(options.ttlMs);
  const capacity = validCapacity(options.capacity);
  const activityLog = options.activityLog;
  const diagnostics = options.diagnostics;
  const records = new Map<string, CandidateRecord>();
  const consumed = new Map<string, number>();
  const pruneExpired = (): void => {
    const current = now();
    for (const [candidateId, record] of records) {
      if (Date.parse(record.snapshot.expiresAt) <= current) records.delete(candidateId);
    }
    for (const [candidateId, expiresAt] of consumed) {
      if (expiresAt <= current) consumed.delete(candidateId);
    }
  };
  const trimAfterInsertion = <T>(entries: Map<string, T>): void => {
    while (entries.size > capacity) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };
  return {
    issue(report, installMode): UpdateCandidateClaim | undefined {
      pruneExpired();
      const issuedAtMs = now();
      const candidateId = idFactory();
      const issuedAt = new Date(issuedAtMs).toISOString();
      const expiresAt = new Date(issuedAtMs + ttlMs).toISOString();
      const snapshot = candidateSnapshot({ report, installMode, candidateId, issuedAt, expiresAt });
      const impact = impactInput(report);
      if (snapshot === undefined || impact === undefined) return undefined;
      const executionToken = tokenFactory();
      if (!/^[0-9a-f]{64}$/u.test(executionToken)) {
        throw new TypeError("Update candidate token factory returned an invalid token.");
      }
      const confirmationDigest = digestUpdateCandidate(snapshot);
      records.set(candidateId, { snapshot, installMode, executionToken, impact });
      trimAfterInsertion(records);
      emitCandidateEvent(
        activityLog,
        {
          category: "diagnostic",
          op: "update.candidate.issued",
          correlationId: candidateId,
          extra: {
            candidateId,
            targetVersion: snapshot.targetVersion,
            installKind: snapshot.install.installKind,
            releaseImpactDigest: snapshot.releaseImpactDigest,
          },
        },
        diagnostics,
      );
      return {
        schemaVersion: UPDATE_CANDIDATE_SCHEMA_VERSION,
        candidateId,
        targetVersion: snapshot.targetVersion,
        confirmationDigest,
        executionToken,
        issuedAt,
        expiresAt,
      };
    },
    // Validation stays linear here so every destructive consume decision remains visible together.
    // eslint-disable-next-line max-lines-per-function
    consume(claim, currentVersion, installMode, freshReport): UpdateCandidateConsumption {
      const record = records.get(claim.candidateId);
      pruneExpired();
      if (record === undefined) {
        const reason = consumed.has(claim.candidateId) ? "replayed" : "unknown";
        emitCandidateEvent(
          activityLog,
          {
            category: "diagnostic",
            op: "update.candidate.rejected",
            correlationId: claim.requestId ?? claim.candidateId,
            extra: { candidateId: claim.candidateId, reason },
          },
          diagnostics,
        );
        return { ok: false, reason };
      }
      const reject = (reason: UpdateCandidateRejection): UpdateCandidateConsumption => {
        emitCandidateEvent(
          activityLog,
          {
            category: "diagnostic",
            op: "update.candidate.rejected",
            correlationId: claim.requestId ?? claim.candidateId,
            extra: { candidateId: claim.candidateId, reason },
          },
          diagnostics,
        );
        return { ok: false, reason };
      };
      if (!claimMatches(claim, record)) return reject("claim-mismatch");
      records.delete(claim.candidateId);
      consumed.set(claim.candidateId, Date.parse(record.snapshot.expiresAt) + ttlMs);
      trimAfterInsertion(consumed);
      if (now() >= Date.parse(record.snapshot.expiresAt)) return reject("expired");
      const runtimeRejection = updateCandidateRuntimeRejection(
        record.snapshot,
        currentVersion,
        installMode,
      );
      if (runtimeRejection !== undefined) return reject(runtimeRejection);
      if (!freshReportMatches(record, freshReport)) return reject("claim-mismatch");
      emitCandidateEvent(
        activityLog,
        {
          category: "diagnostic",
          op: "update.candidate.consumed",
          correlationId: claim.requestId ?? claim.candidateId,
          extra: {
            candidateId: claim.candidateId,
            targetVersion: record.snapshot.targetVersion,
            installKind: record.snapshot.install.installKind,
          },
        },
        diagnostics,
      );
      return {
        ok: true,
        snapshot: record.snapshot,
        installMode: record.installMode,
        impact: record.impact,
      };
    },
  };
}
