import type {
  UpdatePortableSidecarFailureCode,
  UpdatePortableSidecarVerificationStatus,
  UpdatePortableTarget,
  UpdateRemediationStatus,
  UpdateRuntimeEventType,
  UpdateRuntimeWarningCode,
  UpdateStateStore,
} from "@oscharko-dev/keiko-contracts";
import type { ReleaseImpactRemediation } from "@oscharko-dev/keiko-contracts/release-impact";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";

import { correlationIdOrUnknown } from "./correlation.js";
import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";

export interface UpdateRuntimeActivityFields {
  readonly eventId: string;
  readonly type: UpdateRuntimeEventType;
  readonly occurredAt: string;
  readonly targetVersion?: string;
  readonly snapshotId?: string;
  readonly portableStageId?: string;
  readonly portableActivationId?: string;
  readonly portableTarget?: UpdatePortableTarget;
  readonly portableAssetName?: string;
  readonly portableAssetSha256?: string;
  readonly portableAssetSizeBytes?: number;
  readonly portableSidecarName?: string;
  readonly portableSidecarKind?: string;
  readonly portableSidecarVersion?: string;
  readonly portableSidecarTarget?: UpdatePortableTarget;
  readonly portableSidecarPayloadSha256?: string;
  readonly portableSidecarPayloadSha256Prefix?: string;
  readonly portableSidecarStatus?: UpdatePortableSidecarVerificationStatus;
  readonly portableSidecarFailureCode?: UpdatePortableSidecarFailureCode;
  readonly store?: UpdateStateStore;
  readonly remediation?: ReleaseImpactRemediation;
  readonly status?: UpdateRemediationStatus | "succeeded" | "failed" | "blocked";
  readonly warningCode?: UpdateRuntimeWarningCode;
  readonly historical?: boolean;
  readonly sourceSchemaVersion?: number;
  readonly legacyEventId?: string;
}

const UPDATE_RUNTIME_EVENT_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "update.runtime.event",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "update-runtime-activity.updateRuntimeActivityEvent",
  fields: {
    eventId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    type: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "update-offered",
        "user-confirmed",
        "preflight-result",
        "snapshot-created",
        "package-update-result",
        "portable-download-result",
        "portable-sidecar-verification-result",
        "portable-staging-result",
        "portable-activation-result",
        "portable-relaunch-result",
        "remediation-completed",
        "remediation-failed",
        "remediation-deferred",
      ],
    },
    occurredAt: { type: "string", dataClass: "opaque-id", required: true, maxLength: 32 },
    targetVersion: { type: "string", dataClass: "safe-version", required: false, maxLength: 64 },
    snapshotId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    portableStageId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    portableActivationId: {
      type: "string",
      dataClass: "opaque-id",
      required: false,
      maxLength: 128,
    },
    portableTarget: {
      type: "string",
      dataClass: "safe-platform-class",
      required: false,
      values: ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"],
    },
    portableAssetName: {
      type: "string",
      dataClass: "opaque-id",
      required: false,
      maxLength: 128,
    },
    portableAssetSha256: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    portableAssetSizeBytes: { type: "integer", dataClass: "count", required: false },
    portableSidecarName: {
      type: "string",
      dataClass: "opaque-id",
      required: false,
      maxLength: 128,
    },
    portableSidecarKind: {
      type: "string",
      dataClass: "opaque-id",
      required: false,
      maxLength: 64,
    },
    portableSidecarVersion: {
      type: "string",
      dataClass: "safe-version",
      required: false,
      maxLength: 64,
    },
    portableSidecarTarget: {
      type: "string",
      dataClass: "safe-platform-class",
      required: false,
      values: ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"],
    },
    portableSidecarPayloadSha256: {
      type: "string",
      dataClass: "digest",
      required: false,
      maxLength: 64,
    },
    portableSidecarPayloadSha256Prefix: {
      type: "string",
      dataClass: "digest",
      required: false,
      maxLength: 12,
    },
    portableSidecarStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["verified", "failed"],
    },
    portableSidecarFailureCode: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "sidecar-metadata-malformed",
        "sidecar-missing-required",
        "sidecar-platform-mismatch",
        "sidecar-payload-outside-root",
        "sidecar-payload-missing",
        "sidecar-digest-mismatch",
        "sidecar-license-evidence-incomplete",
        "sidecar-sbom-evidence-incomplete",
        "sidecar-signing-unverified",
        "sidecar-release-impact-binding-mismatch",
      ],
    },
    store: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "ui-layout",
        "server-runtime",
        "durable-config",
        "evidence",
        "memory-vault",
        "local-knowledge",
        "workspace-references",
        "package-install",
      ],
    },
    remediation: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "no-action-required",
        "restart-required",
        "repair-required",
        "local-knowledge-reindex-required",
        "migration-required",
        "manual-review-required",
      ],
    },
    status: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["pending", "running", "completed", "failed", "deferred", "succeeded", "blocked"],
    },
    warningCode: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "audit-persistence-failed",
        "state-snapshot-unavailable",
        "manual-review-required",
        "remediation-execution-failed",
        "remediation-outcome-uncertain",
      ],
    },
    historical: { type: "boolean", dataClass: "closed-enum", required: false },
    sourceSchemaVersion: { type: "integer", dataClass: "count", required: false },
    legacyEventId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    failureKind: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    frames: {
      type: "string-array",
      dataClass: "safe-platform-class",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["update-runtime"],
  proofIds: ["update.runtime.event.body-free"],
  releaseImpact: "patch",
});

const UPDATE_LEGACY_SNAPSHOT_IMPORTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "update.runtime.legacy-snapshot-imported",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "update-runtime-activity.updateLegacySnapshotImportedEvent",
  fields: {
    historical: { type: "boolean", dataClass: "closed-enum", required: true },
    sourceSchemaVersion: { type: "integer", dataClass: "count", required: true },
    importId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    sourceDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    importedIdSetDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    importedCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["update-runtime-legacy-import"],
  proofIds: ["update.runtime.legacy-snapshot-imported.count"],
  releaseImpact: "patch",
});

export function updateRuntimeActivityEvent(
  correlationId: string | undefined,
  fields: UpdateRuntimeActivityFields,
  failure?: unknown,
): SecurityLogEvent {
  const failed = fields.status === "failed" || fields.portableSidecarStatus === "failed";
  const failureKind =
    fields.portableSidecarFailureCode ?? fields.warningCode ?? `${fields.type}-failed`;
  return activityLogEvent(
    UPDATE_RUNTIME_EVENT_OPERATION,
    {
      level: failed ? "warn" : "info",
      correlationId: correlationIdOrUnknown(correlationId),
      ...(failed ? { errorKind: updateRuntimeErrorKind(fields) } : {}),
    },
    {
      ...fields,
      ...(failed
        ? {
            failureKind,
            frames: keikoStackFrames(failure),
            causeChain: causeChain(failure),
          }
        : {}),
      completeness: "complete",
      loss: "none",
    },
  );
}

const UPDATE_RUNTIME_WARNING_ERROR_KIND: Readonly<
  Record<UpdateRuntimeWarningCode, ActivityLogErrorKind>
> = {
  "audit-persistence-failed": "durability-failed",
  "state-snapshot-unavailable": "unavailable",
  "manual-review-required": "conflict",
  "remediation-execution-failed": "internal",
  "remediation-outcome-uncertain": "conflict",
};

const UPDATE_RUNTIME_TYPE_ERROR_KIND: Readonly<
  Partial<Record<UpdateRuntimeEventType, ActivityLogErrorKind>>
> = {
  "portable-download-result": "unavailable",
  "portable-staging-result": "write-failed",
};

function updateRuntimeErrorKind(fields: UpdateRuntimeActivityFields): ActivityLogErrorKind {
  const failure = fields.portableSidecarFailureCode;
  if (failure !== undefined) {
    if (failure === "sidecar-payload-outside-root") return "unsafe-target";
    if (failure === "sidecar-payload-missing") return "unavailable";
    return "validation-failed";
  }
  if (fields.warningCode !== undefined)
    return UPDATE_RUNTIME_WARNING_ERROR_KIND[fields.warningCode];
  return UPDATE_RUNTIME_TYPE_ERROR_KIND[fields.type] ?? "internal";
}

export function updateLegacySnapshotImportedEvent(input: {
  readonly importId: string;
  readonly sourceDigest: string;
  readonly importedIdSetDigest: string;
  readonly importedCount: number;
}): SecurityLogEvent {
  return activityLogEvent(
    UPDATE_LEGACY_SNAPSHOT_IMPORTED_OPERATION,
    { level: "info", correlationId: correlationIdOrUnknown(undefined) },
    {
      historical: true,
      sourceSchemaVersion: 1,
      ...input,
      completeness: "complete",
      loss: "none",
    },
  );
}
