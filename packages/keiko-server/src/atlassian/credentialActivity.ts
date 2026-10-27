import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { AtlassianCredentialMetadata } from "@oscharko-dev/keiko-connectors";
import type { AtlassianConnectionVerificationStatus } from "@oscharko-dev/keiko-contracts";
import { contentFreeErrorClass, emitServerDiagnostic } from "../diagnostics-log.js";
import type { AtlassianConnectorCredentialDeps } from "./credentialRoutes.js";

const ATLASSIAN_CREDENTIAL_LISTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "atlassian.credential.listed",
  category: "setup",
  owner: "keiko-server",
  emitter: "atlassian.credentialActivity.recordCredentialsListed",
  fields: {
    visibleCount: { type: "number", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-credential-custody"],
  proofIds: ["atlassian.credential.listed.line"],
  releaseImpact: "patch",
});

export function recordCredentialsListed(
  deps: Pick<AtlassianConnectorCredentialDeps, "activityLog" | "diagnostics">,
  correlationId: string,
  visibleCount: number,
): void {
  try {
    deps.activityLog?.write(
      activityLogEvent(
        ATLASSIAN_CREDENTIAL_LISTED_OPERATION,
        { correlationId, status: 200 },
        { visibleCount, completeness: "complete", loss: "none" },
      ),
    );
  } catch (error) {
    emitServerDiagnostic(deps.diagnostics, {
      correlationId,
      timestamp: new Date().toISOString(),
      operation: "atlassian.credential.listed",
      source: "atlassian.credential-activity.record-list",
      errorClass: contentFreeErrorClass(error),
      message: "atlassian-credential-list-activity-log-failed",
    });
  }
}

const ATLASSIAN_CREDENTIAL_CREATED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "atlassian.credential.created",
  category: "setup",
  owner: "keiko-server",
  emitter: "atlassian.credentialActivity.recordCredentialCreated",
  fields: {
    provider: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["jira", "confluence"],
    },
    authScheme: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["basic-api-token", "bearer-pat"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-credential-custody"],
  proofIds: ["atlassian.credential.created.line"],
  releaseImpact: "patch",
});

const ATLASSIAN_CONNECTION_CHECKED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "atlassian.connection.checked",
  category: "setup",
  owner: "keiko-server",
  emitter: "atlassian.credentialActivity.recordConnectionCheck",
  fields: {
    action: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["verify", "sync"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "ok",
        "auth-failed",
        "forbidden",
        "unreachable",
        "timeout",
        "redirect-refused",
        "invalid-response",
        "unsupported-version",
        "tls-failed",
        "sync-unsupported",
        "verification-aborted",
      ],
    },
    verificationState: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["applied", "stale"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-credential-custody"],
  proofIds: ["atlassian.connection.checked.line"],
  releaseImpact: "patch",
});

export function recordConnectionCheck(
  deps: Pick<AtlassianConnectorCredentialDeps, "activityLog" | "diagnostics">,
  correlationId: string,
  result: AtlassianConnectionVerificationStatus | "sync-unsupported" | "verification-aborted",
  verificationState?: "applied" | "stale",
): void {
  try {
    deps.activityLog?.write(
      activityLogEvent(
        ATLASSIAN_CONNECTION_CHECKED_OPERATION,
        { correlationId },
        {
          action: result === "sync-unsupported" ? "sync" : "verify",
          outcome: result,
          ...(verificationState === undefined ? {} : { verificationState }),
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } catch (error) {
    emitServerDiagnostic(deps.diagnostics, {
      correlationId,
      timestamp: new Date().toISOString(),
      operation: "atlassian.connection.checked",
      source: "atlassian.credential-activity.record-check",
      errorClass: contentFreeErrorClass(error),
      message: "atlassian-connection-check-activity-log-failed",
    });
  }
}

export function recordCredentialCreated(
  deps: Pick<AtlassianConnectorCredentialDeps, "activityLog" | "diagnostics">,
  metadata: AtlassianCredentialMetadata,
  correlationId: string,
): void {
  try {
    deps.activityLog?.write(
      activityLogEvent(
        ATLASSIAN_CREDENTIAL_CREATED_OPERATION,
        { correlationId, status: 200 },
        {
          provider: metadata.provider,
          authScheme: metadata.authScheme,
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } catch (error) {
    // Custody already committed. A logging failure must not turn success into a retryable failure.
    emitServerDiagnostic(deps.diagnostics, {
      correlationId,
      timestamp: new Date().toISOString(),
      operation: "atlassian.credential.created",
      source: "atlassian.credential-activity.record-created",
      errorClass: contentFreeErrorClass(error),
      message: "atlassian-credential-created-activity-log-failed",
    });
  }
}

const ATLASSIAN_CREDENTIAL_UPDATED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "atlassian.credential.updated",
  category: "setup",
  owner: "keiko-server",
  emitter: "atlassian.credentialActivity.recordCredentialUpdated",
  fields: {
    action: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["rename", "replace-token", "rename-and-replace-token"],
    },
    authenticationGeneration: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-credential-custody"],
  proofIds: ["atlassian.credential.updated.line"],
  releaseImpact: "patch",
});

export function recordCredentialUpdated(
  deps: Pick<AtlassianConnectorCredentialDeps, "activityLog" | "diagnostics">,
  correlationId: string,
  authenticationGeneration: number,
  action: "rename" | "replace-token" | "rename-and-replace-token",
): void {
  try {
    deps.activityLog?.write(
      activityLogEvent(
        ATLASSIAN_CREDENTIAL_UPDATED_OPERATION,
        { correlationId, status: 200 },
        { action, authenticationGeneration, completeness: "complete", loss: "none" },
      ),
    );
  } catch (error) {
    emitServerDiagnostic(deps.diagnostics, {
      correlationId,
      timestamp: new Date().toISOString(),
      operation: "atlassian.credential.updated",
      source: "atlassian.credential-activity.record-updated",
      errorClass: contentFreeErrorClass(error),
      message: "atlassian-credential-updated-activity-log-failed",
    });
  }
}
