import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";
import type { PortableReleaseTrustFailureReason } from "@oscharko-dev/keiko-security/portable-release-trust";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import type { ServerLogSink } from "./observability/index.js";
import type {
  PortableAssetRedirectFailureReason,
  PortableFetchFailureReason,
} from "./update-preflight-portable-shared.js";

export type PortableFetchAssetKind =
  "release-evidence" | "release-metadata" | "manifest" | "checksum";

type PortableEvidenceAssetKind = Extract<PortableFetchAssetKind, "manifest" | "checksum">;
type ReleaseTrustFailureReason = PortableReleaseTrustFailureReason | "missing";

const PORTABLE_ASSET_REDIRECT_REFUSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "update.portable-asset.redirect-refused",
  category: "security",
  owner: "keiko-server",
  emitter: "update-preflight-activity.recordPortableRedirectRefusal",
  fields: {
    assetKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["manifest", "checksum"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "missing-location",
        "malformed-location",
        "unsafe-target",
        "loop",
        "limit",
        "unsafe-origin",
      ],
    },
    target: {
      type: "string",
      dataClass: "safe-platform-class",
      required: true,
      values: ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["portable-update-evidence"],
  proofIds: ["update.portable-asset.redirect-refused.reason"],
  releaseImpact: "patch",
});

const PORTABLE_FETCH_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "update.portable-fetch.failed",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "update-preflight-activity.recordPortableFetchFailure",
  fields: {
    assetKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["release-evidence", "release-metadata", "manifest", "checksum"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["deadline-exceeded", "request-aborted", "network-unavailable", "unexpected-failure"],
    },
    target: {
      type: "string",
      dataClass: "safe-platform-class",
      required: true,
      values: ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["portable-update-evidence"],
  proofIds: ["update.portable-fetch.failed.reason"],
  releaseImpact: "patch",
});

const RELEASE_TRUST_VERIFY_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "update.release-trust.verify",
  category: "security",
  owner: "keiko-server",
  emitter: "update-preflight-activity.recordReleaseTrustVerification",
  fields: {
    status: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["succeeded", "failed"],
    },
    target: {
      type: "string",
      dataClass: "safe-platform-class",
      required: true,
      values: ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "key-untrusted",
        "metadata-expired",
        "metadata-malformed",
        "metadata-rollback",
        "signature-invalid",
        "missing",
      ],
    },
    keyId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    metadataVersion: { type: "integer", dataClass: "count", required: false },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["portable-release-trust"],
  proofIds: ["update.release-trust.verify.status"],
  releaseImpact: "patch",
});

function portableFetchErrorKind(reason: PortableFetchFailureReason): ActivityLogErrorKind {
  switch (reason) {
    case "deadline-exceeded":
      return "timeout";
    case "request-aborted":
      return "cancelled";
    case "network-unavailable":
      return "unavailable";
    case "unexpected-failure":
      return "internal";
  }
}

export function recordPortableRedirectRefusal(
  sink: ServerLogSink | undefined,
  target: UpdatePortableTarget,
  assetKind: PortableEvidenceAssetKind,
  reason: PortableAssetRedirectFailureReason,
): void {
  sink?.write(
    activityLogEvent(
      PORTABLE_ASSET_REDIRECT_REFUSED_OPERATION,
      { level: "warn", correlationId: UNKNOWN_CORRELATION_ID, errorKind: "unsafe-target" },
      { assetKind, reason, target, completeness: "complete", loss: "none" },
    ),
  );
}

export function recordPortableFetchFailure(
  sink: ServerLogSink | undefined,
  target: UpdatePortableTarget,
  assetKind: PortableFetchAssetKind,
  reason: PortableFetchFailureReason,
): void {
  sink?.write(
    activityLogEvent(
      PORTABLE_FETCH_FAILED_OPERATION,
      {
        level: "warn",
        correlationId: UNKNOWN_CORRELATION_ID,
        errorKind: portableFetchErrorKind(reason),
      },
      { assetKind, reason, target, completeness: "complete", loss: "none" },
    ),
  );
}

export function recordReleaseTrustFailure(
  sink: ServerLogSink | undefined,
  target: UpdatePortableTarget,
  reason: ReleaseTrustFailureReason,
): void {
  sink?.write(
    activityLogEvent(
      RELEASE_TRUST_VERIFY_OPERATION,
      { level: "warn", correlationId: UNKNOWN_CORRELATION_ID, errorKind: "validation-failed" },
      { status: "failed", target, reason, completeness: "complete", loss: "none" },
    ),
  );
}

export function recordReleaseTrustSuccess(
  sink: ServerLogSink | undefined,
  target: UpdatePortableTarget,
  trust: { readonly keyId: string; readonly metadataVersion: number },
): void {
  sink?.write(
    activityLogEvent(
      RELEASE_TRUST_VERIFY_OPERATION,
      { correlationId: UNKNOWN_CORRELATION_ID },
      {
        status: "succeeded",
        target,
        keyId: trust.keyId,
        metadataVersion: trust.metadataVersion,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
