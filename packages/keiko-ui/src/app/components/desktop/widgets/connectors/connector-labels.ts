// Issue #2245 (Epic #2238) — pure enum → catalog-key mappings for the Atlassian connector surfaces.
//
// Every function returns a typed `MessageKey`, so the compiler proves each mapped key exists in the
// central catalog (a missing key fails typecheck, not at runtime). Keeping the mappings here — out
// of the components — keeps each component small (≤50 lines) and makes the closed-union coverage
// unit-testable without rendering. No user-facing string is authored here; only key selection.

import type {
  AtlassianConnectorActionType,
  AtlassianConnectorActionDisposition,
  AtlassianConnectorActionReviewReason,
  AtlassianConnectorActivityReasonCode,
  AtlassianConnectorProvider,
  AtlassianConnectorWriteFailureReason,
  AtlassianSyncFailureReason,
  AtlassianSyncJobStatus,
  CodingWorkbenchApprovalRisk,
} from "@oscharko-dev/keiko-contracts";
import type { MessageKey } from "@/lib/i18n-messages.en";
import type { AtlassianConnectorVerifyStatus } from "@/lib/atlassian-connectors-api";

// The `lk-badge` global design-system class (globals.css, never edited) renders these `data-state`
// values with distinct, theme-aware colours. Reused verbatim so connector pods share the exact
// readiness vocabulary of the #1856 Local Knowledge pod surfaces.
export type ConnectorBadgeState = "ready" | "indexing" | "stale" | "error" | "draft";

// Notice tone drives the component-scoped `data-tone` styling (mirrors the ConnectorPicker guidance
// tones). `ok` is the only positive state; everything actionable is `warning` or `danger`.
export type ConnectorTone = "ok" | "warning" | "danger" | "muted";

const PROVIDER_LABEL: Readonly<Record<AtlassianConnectorProvider, MessageKey>> = {
  confluence: "atlassianConnectors.provider.confluence",
  jira: "atlassianConnectors.provider.jira",
};

export function providerLabelKey(provider: AtlassianConnectorProvider): MessageKey {
  return PROVIDER_LABEL[provider];
}

const VERIFY_LABEL: Readonly<Record<AtlassianConnectorVerifyStatus, MessageKey>> = {
  ok: "atlassianConnectors.verify.ok.label",
  "auth-failed": "atlassianConnectors.verify.auth-failed.label",
  forbidden: "atlassianConnectors.verify.forbidden.label",
  unreachable: "atlassianConnectors.verify.unreachable.label",
  timeout: "atlassianConnectors.verify.timeout.label",
};

const VERIFY_COPY: Readonly<Record<AtlassianConnectorVerifyStatus, MessageKey>> = {
  ok: "atlassianConnectors.verify.ok.copy",
  "auth-failed": "atlassianConnectors.verify.auth-failed.copy",
  forbidden: "atlassianConnectors.verify.forbidden.copy",
  unreachable: "atlassianConnectors.verify.unreachable.copy",
  timeout: "atlassianConnectors.verify.timeout.copy",
};

const VERIFY_TONE: Readonly<Record<AtlassianConnectorVerifyStatus, ConnectorTone>> = {
  ok: "ok",
  "auth-failed": "danger",
  forbidden: "danger",
  unreachable: "warning",
  timeout: "warning",
};

export function verifyStatusLabelKey(status: AtlassianConnectorVerifyStatus): MessageKey {
  return VERIFY_LABEL[status];
}

export function verifyStatusCopyKey(status: AtlassianConnectorVerifyStatus): MessageKey {
  return VERIFY_COPY[status];
}

export function verifyStatusTone(status: AtlassianConnectorVerifyStatus): ConnectorTone {
  return VERIFY_TONE[status];
}

const SYNC_STATUS_LABEL: Readonly<Record<AtlassianSyncJobStatus, MessageKey>> = {
  pending: "atlassianConnectors.sync.status.pending",
  running: "atlassianConnectors.sync.status.running",
  succeeded: "atlassianConnectors.sync.status.succeeded",
  partial: "atlassianConnectors.sync.status.partial",
  failed: "atlassianConnectors.sync.status.failed",
  cancelled: "atlassianConnectors.sync.status.cancelled",
};

const SYNC_STATUS_BADGE: Readonly<Record<AtlassianSyncJobStatus, ConnectorBadgeState>> = {
  pending: "draft",
  running: "indexing",
  succeeded: "ready",
  partial: "stale",
  failed: "error",
  cancelled: "draft",
};

export function syncStatusLabelKey(status: AtlassianSyncJobStatus): MessageKey {
  return SYNC_STATUS_LABEL[status];
}

export function syncStatusBadgeState(status: AtlassianSyncJobStatus): ConnectorBadgeState {
  return SYNC_STATUS_BADGE[status];
}

const SYNC_REASON: Readonly<Record<AtlassianSyncFailureReason, MessageKey>> = {
  "auth-failed": "atlassianConnectors.sync.reason.auth-failed",
  "permission-denied": "atlassianConnectors.sync.reason.permission-denied",
  "rate-limited": "atlassianConnectors.sync.reason.rate-limited",
  timeout: "atlassianConnectors.sync.reason.timeout",
  unavailable: "atlassianConnectors.sync.reason.unavailable",
  "scope-exceeded": "atlassianConnectors.sync.reason.scope-exceeded",
  "bounds-exceeded": "atlassianConnectors.sync.reason.bounds-exceeded",
  cancelled: "atlassianConnectors.sync.reason.cancelled",
  "malformed-payload": "atlassianConnectors.sync.reason.malformed-payload",
};

export function syncFailureReasonKey(reason: AtlassianSyncFailureReason): MessageKey {
  return SYNC_REASON[reason];
}

const ACTION_LABEL: Readonly<Record<AtlassianConnectorActionType, MessageKey>> = {
  "sync-space": "atlassianConnectors.action.sync-space",
  "sync-project": "atlassianConnectors.action.sync-project",
  "search-issues-live": "atlassianConnectors.action.search-issues-live",
  "create-issue": "atlassianConnectors.action.create-issue",
  "update-issue-fields": "atlassianConnectors.action.update-issue-fields",
  "transition-issue": "atlassianConnectors.action.transition-issue",
  "add-issue-comment": "atlassianConnectors.action.add-issue-comment",
  "create-page": "atlassianConnectors.action.create-page",
  "update-page": "atlassianConnectors.action.update-page",
  "add-page-comment": "atlassianConnectors.action.add-page-comment",
};

export function actionTypeLabelKey(actionType: AtlassianConnectorActionType): MessageKey {
  return ACTION_LABEL[actionType];
}

const RISK_LABEL: Readonly<Record<CodingWorkbenchApprovalRisk, MessageKey>> = {
  low: "atlassianConnectors.risk.low",
  medium: "atlassianConnectors.risk.medium",
  high: "atlassianConnectors.risk.high",
  critical: "atlassianConnectors.risk.critical",
};

export function riskLabelKey(risk: CodingWorkbenchApprovalRisk): MessageKey {
  return RISK_LABEL[risk];
}

const DISPOSITION_LABEL: Readonly<Record<AtlassianConnectorActionDisposition, MessageKey>> = {
  allowed: "atlassianConnectors.disposition.allowed",
  "review-required": "atlassianConnectors.disposition.review-required",
  denied: "atlassianConnectors.disposition.denied",
};

export function dispositionLabelKey(disposition: AtlassianConnectorActionDisposition): MessageKey {
  return DISPOSITION_LABEL[disposition];
}

const REVIEW_REASON: Readonly<Record<AtlassianConnectorActionReviewReason, MessageKey>> = {
  "mode-approval-required": "atlassianConnectors.reviewReason.mode-approval-required",
  "deterministic-risk-approval-required":
    "atlassianConnectors.reviewReason.deterministic-risk-approval-required",
};

export function reviewReasonCopyKey(reason: AtlassianConnectorActionReviewReason): MessageKey {
  return REVIEW_REASON[reason];
}

const WRITE_FAILURE_REASON: Readonly<Record<AtlassianConnectorWriteFailureReason, MessageKey>> = {
  "auth-failed": "atlassianConnectors.result.reason.auth-failed",
  "permission-denied": "atlassianConnectors.result.reason.permission-denied",
  "not-found": "atlassianConnectors.result.reason.not-found",
  "rate-limited": "atlassianConnectors.result.reason.rate-limited",
  timeout: "atlassianConnectors.result.reason.timeout",
  unavailable: "atlassianConnectors.result.reason.unavailable",
  "malformed-payload": "atlassianConnectors.result.reason.malformed-payload",
  "bounds-exceeded": "atlassianConnectors.result.reason.bounds-exceeded",
  conflict: "atlassianConnectors.result.reason.conflict",
  "invalid-transition": "atlassianConnectors.result.reason.invalid-transition",
  "field-validation": "atlassianConnectors.result.reason.field-validation",
};

export function writeFailureReasonKey(reason: AtlassianConnectorWriteFailureReason): MessageKey {
  return WRITE_FAILURE_REASON[reason];
}

// Denied dispositions carry a content-free reason code. The registry's approve-time revalidation
// yields an authority or connector-scope reason; other closed reason codes fall back to a generic
// policy-denied line so no raw provider text is ever surfaced.
const DENIED_REASON: Partial<Record<AtlassianConnectorActivityReasonCode, MessageKey>> = {
  "authority-invalid": "atlassianConnectors.denied.reason.authority-invalid",
  "authority-expired": "atlassianConnectors.denied.reason.authority-expired",
  "authority-budget-exceeded": "atlassianConnectors.denied.reason.authority-budget-exceeded",
  "connector-access-denied": "atlassianConnectors.denied.reason.connector-access-denied",
  "connector-write-denied": "atlassianConnectors.denied.reason.connector-write-denied",
};

export function deniedReasonCopyKey(
  reasonCode: AtlassianConnectorActivityReasonCode | undefined,
): MessageKey {
  return (
    (reasonCode === undefined ? undefined : DENIED_REASON[reasonCode]) ??
    "atlassianConnectors.denied.reason.generic"
  );
}
