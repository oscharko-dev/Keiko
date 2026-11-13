import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  AtlassianCredentialMetadata,
  JiraHumanInputBinding,
} from "@oscharko-dev/keiko-connectors";
import type { AtlassianConnectionVerificationStatus } from "@oscharko-dev/keiko-contracts";
import { contentFreeErrorClass, emitServerDiagnostic } from "../diagnostics-log.js";
import { correlationIdOrUnknown, UNKNOWN_CORRELATION_ID } from "../correlation.js";
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
      values: ["verify", "sync", "request"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "ok",
        "auth-failed",
        "auth-unverified",
        "forbidden",
        "unreachable",
        "timeout",
        "redirect-refused",
        "invalid-response",
        "unsupported-version",
        "tls-failed",
        "sync-unsupported",
        "verification-aborted",
        "probe-inconclusive",
      ],
    },
    // What decided the credential's fate: the identity route's own 401, the same-generation
    // identity read that follows a 401 from any other route, or its short positive window.
    decision: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["identity-route", "probe", "probe-window", "probe-shared"],
    },
    // Why an identity read left a 401 unsettled (outcome `probe-inconclusive`).
    probeCause: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "timeout",
        "network",
        "http-429",
        "http-4xx",
        "http-5xx",
        "redirect",
        "invalid-body",
        "foreign-401",
        "captcha",
        "stale",
        "cancelled-or-expired",
        "probe-error",
      ],
    },
    routeClass: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["identity", "other"],
    },
    verificationState: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["applied", "stale"],
    },
    jiraCompatibility: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["verified", "unverified"],
    },
    restApi: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["v2"],
    },
    agileApi: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["unverified"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-credential-custody"],
  proofIds: [
    "atlassian.connection.checked.line",
    "atlassian.connection.checked.observed-authentication",
    "atlassian.connection.checked.compatibility",
  ],
  releaseImpact: "patch",
});

export type ProbeCause =
  | "timeout"
  | "network"
  | "http-429"
  | "http-4xx"
  | "http-5xx"
  | "redirect"
  | "invalid-body"
  | "foreign-401"
  | "captcha"
  | "stale"
  | "cancelled-or-expired"
  | "probe-error";

export interface ConnectionCheckDetail {
  readonly decision: "identity-route" | "probe" | "probe-window" | "probe-shared";
  readonly routeClass: "identity" | "other";
  readonly probeCause?: ProbeCause;
  /** The correlation of the caller whose identity read this line shares. */
  readonly parentCorrelationId?: string;
}

export function recordConnectionCheck(
  deps: Pick<AtlassianConnectorCredentialDeps, "activityLog" | "diagnostics">,
  correlationId: string,
  result:
    | AtlassianConnectionVerificationStatus
    | "sync-unsupported"
    | "verification-aborted"
    | "probe-inconclusive",
  verificationState?: "applied" | "stale",
  source: "verify" | "request" = "verify",
  jiraCompatibility?: "verified" | "unverified",
  detail?: ConnectionCheckDetail,
): void {
  const { parentCorrelationId, ...fields } = detail ?? {};
  try {
    deps.activityLog?.write(
      activityLogEvent(
        ATLASSIAN_CONNECTION_CHECKED_OPERATION,
        { correlationId, ...(parentCorrelationId === undefined ? {} : { parentCorrelationId }) },
        {
          action: result === "sync-unsupported" ? "sync" : source,
          outcome: result,
          ...(verificationState === undefined ? {} : { verificationState }),
          ...(jiraCompatibility === undefined ? {} : { jiraCompatibility }),
          ...fields,
          ...(jiraCompatibility === "verified" ? { restApi: "v2", agileApi: "unverified" } : {}),
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

const JIRA_HUMAN_INPUT_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "atlassian.jira.human-input",
  category: "security",
  owner: "keiko-server",
  emitter: "atlassian.credentialActivity.recordJiraHumanInput",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["requested", "provided", "cancelled", "consumed", "expired"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-credential-custody"],
  proofIds: ["atlassian.jira.human-input.line"],
  releaseImpact: "patch",
});
/** No submitted values, public request IDs, user labels or secret-derived digests. */
export function recordJiraHumanInput(
  deps: Pick<AtlassianConnectorCredentialDeps, "activityLog" | "diagnostics"> | undefined,
  correlationId: string,
  phase: "requested" | "provided" | "cancelled" | "consumed" | "expired",
  operationCorrelationId?: string,
): void {
  const parent = correlationIdOrUnknown(operationCorrelationId);
  const parentCorrelationId =
    phase === "provided" && parent !== UNKNOWN_CORRELATION_ID && parent !== correlationId
      ? parent
      : undefined;
  try {
    deps?.activityLog?.write(
      activityLogEvent(
        JIRA_HUMAN_INPUT_OPERATION,
        { correlationId, ...(parentCorrelationId === undefined ? {} : { parentCorrelationId }) },
        { phase },
      ),
    );
  } catch (error) {
    emitServerDiagnostic(deps?.diagnostics, {
      correlationId,
      timestamp: new Date().toISOString(),
      operation: "atlassian.jira.human-input",
      source: "atlassian.credential-activity.human-input",
      errorClass: contentFreeErrorClass(error),
      message: "jira-private-input-activity-log-failed",
    });
  }
}

/** Cleanup may not replace an already received native ACK/outcome with a local vault failure. */
export function cancelUnclaimedJiraHumanInput(
  deps: Pick<AtlassianConnectorCredentialDeps, "custody" | "diagnostics"> | undefined,
  requestId: string,
  binding: JiraHumanInputBinding,
): void {
  try {
    deps?.custody.humanInputs?.cancel(requestId, binding);
  } catch (error) {
    reportJiraHumanInputCleanupFailure(deps, binding, error);
  }
}
export function reportJiraHumanInputCleanupFailure(
  deps: Pick<AtlassianConnectorCredentialDeps, "diagnostics"> | undefined,
  binding: Pick<JiraHumanInputBinding, "operationCorrelationId">,
  error: unknown,
): void {
  emitServerDiagnostic(deps?.diagnostics, {
    correlationId: correlationIdOrUnknown(binding.operationCorrelationId),
    timestamp: new Date().toISOString(),
    operation: "atlassian.jira.human-input",
    source: "atlassian.credential-activity.human-input",
    errorClass: contentFreeErrorClass(error),
    message: "jira-private-input-cleanup-failed",
  });
}
