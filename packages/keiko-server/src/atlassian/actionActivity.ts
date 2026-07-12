// Content-free activity emission for governed connector actions (Issue #2244, ADR-0128 D6).
//
// Every action attempt — allowed (executed), review-required (pending created / approved-and-
// executed / rejected), denied (policy or envelope authority), and provider-failure — emits
// exactly ONE `AtlassianConnectorActivityRecord` through these helpers into the same bounded
// per-process activity ring the sync lane already writes (`atlassianSyncJobRegistry`), so one
// connector-scoped trail serves reads and writes alike. Records carry identifiers, closed
// enums, and durations only: the D4 action row is derived from the contract tables, the target
// is an issue key/page id/scope key (never a body), and the reason is exactly one closed code.

import { randomUUID } from "node:crypto";
import {
  ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK,
  ATLASSIAN_CONNECTOR_ACTION_CLASS,
  ATLASSIAN_CONNECTOR_ACTION_PROVIDER,
  ATLASSIAN_CONNECTOR_ACTION_REQUIRED_SCOPE,
  ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
  type AtlassianConnectorActionDisposition,
  type AtlassianConnectorActionReviewReason,
  type AtlassianConnectorActionType,
  type AtlassianConnectorActivityOutcome,
  type AtlassianConnectorActivityReasonCode,
  type AtlassianConnectorPendingApproval,
} from "@oscharko-dev/keiko-contracts";
import { errorBody, type RouteResult } from "../routes.js";
import {
  atlassianActionApprovalRegistry,
  ATLASSIAN_ACTION_APPROVAL_TTL_MS,
  type PendingAtlassianActionPayload,
} from "./actionApprovals.js";
import type { AtlassianActionAuthorityContext } from "./actionPolicy.js";
import { atlassianSyncJobRegistry } from "./syncService.js";

export interface AtlassianActionActivityInput {
  readonly connectorId: string;
  readonly actionType: AtlassianConnectorActionType;
  readonly disposition: AtlassianConnectorActionDisposition;
  readonly outcome: AtlassianConnectorActivityOutcome;
  readonly reasonCode?: AtlassianConnectorActivityReasonCode | undefined;
  readonly targetRef?: string | undefined;
  readonly correlationId: string;
  readonly durationMs: number;
  readonly occurredAt?: number | undefined;
  // `search-issues-live` only (Issue #2248, ADR-0128 D6): sha256 hex of the executed JQL —
  // never the query text — plus the returned result count and issue keys on success.
  readonly jqlDigest?: string | undefined;
  readonly resultCount?: number | undefined;
  readonly resultIssueKeys?: readonly string[] | undefined;
}

// One record per attempt; provider and action class are pinned by the D4 tables so a record can
// never mislabel a write as a read.
export function recordAtlassianActionActivity(input: AtlassianActionActivityInput): void {
  atlassianSyncJobRegistry.recordActivity({
    schemaVersion: ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
    activityId: randomUUID(),
    occurredAt: input.occurredAt ?? Date.now(),
    connectorId: input.connectorId,
    provider: ATLASSIAN_CONNECTOR_ACTION_PROVIDER[input.actionType],
    actionType: input.actionType,
    actionClass: ATLASSIAN_CONNECTOR_ACTION_CLASS[input.actionType],
    disposition: input.disposition,
    outcome: input.outcome,
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
    ...(input.targetRef === undefined ? {} : { targetRef: input.targetRef }),
    correlationId: input.correlationId,
    durationMs: input.durationMs,
    ...(input.jqlDigest === undefined ? {} : { jqlDigest: input.jqlDigest }),
    ...(input.resultCount === undefined ? {} : { resultCount: input.resultCount }),
    ...(input.resultIssueKeys === undefined ? {} : { resultIssueKeys: input.resultIssueKeys }),
  });
}

export interface BuildPendingApprovalInput {
  readonly connectorId: string;
  readonly actionType: AtlassianConnectorActionType;
  readonly reviewReason: AtlassianConnectorActionReviewReason;
  readonly targetRef?: string | undefined;
  readonly correlationId: string;
  readonly requestedAt: number;
}

// The content-free wire projection for one pending approval: the D4 row is derived from the
// contract tables, never caller-supplied.
export function buildAtlassianPendingApproval(
  input: BuildPendingApprovalInput,
): AtlassianConnectorPendingApproval {
  return {
    schemaVersion: ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
    approvalId: randomUUID(),
    connectorId: input.connectorId,
    provider: ATLASSIAN_CONNECTOR_ACTION_PROVIDER[input.actionType],
    actionType: input.actionType,
    actionClass: ATLASSIAN_CONNECTOR_ACTION_CLASS[input.actionType],
    requiredScope: ATLASSIAN_CONNECTOR_ACTION_REQUIRED_SCOPE[input.actionType],
    risk: ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK[input.actionType],
    reviewReason: input.reviewReason,
    ...(input.targetRef === undefined ? {} : { targetRef: input.targetRef }),
    correlationId: input.correlationId,
    requestedAt: input.requestedAt,
    expiresAt: input.requestedAt + ATLASSIAN_ACTION_APPROVAL_TTL_MS,
  };
}

// ─── Shared route outcomes (write-action and sync routes) ─────────────────────

// Records the one denied-attempt activity record and answers the disposition as 200-level data
// (mirroring the editor lane's not-run responses: a policy denial is an expected, renderable
// outcome, not a transport error).
export function deniedAtlassianActionResult(input: {
  readonly connectorId: string;
  readonly actionType: AtlassianConnectorActionType;
  readonly reasonCode: AtlassianConnectorActivityReasonCode;
  readonly targetRef?: string | undefined;
  readonly correlationId: string;
  readonly jqlDigest?: string | undefined;
}): RouteResult {
  recordAtlassianActionActivity({
    connectorId: input.connectorId,
    actionType: input.actionType,
    disposition: "denied",
    outcome: "denied",
    reasonCode: input.reasonCode,
    ...(input.targetRef === undefined ? {} : { targetRef: input.targetRef }),
    correlationId: input.correlationId,
    durationMs: 0,
    ...(input.jqlDigest === undefined ? {} : { jqlDigest: input.jqlDigest }),
  });
  return {
    status: 200,
    body: {
      disposition: "denied",
      reasonCode: input.reasonCode,
      correlationId: input.correlationId,
    },
  };
}

export interface CreatePendingApprovalResultInput {
  readonly connectorId: string;
  readonly actionType: AtlassianConnectorActionType;
  readonly reviewReason: AtlassianConnectorActionReviewReason;
  readonly targetRef?: string | undefined;
  readonly correlationId: string;
  readonly authority: AtlassianActionAuthorityContext;
  readonly authRef: string;
  readonly payload: PendingAtlassianActionPayload;
  readonly jqlDigest?: string | undefined;
}

// Creates the bounded pending-approval entry (NO executor or fetcher invocation happens here —
// the validated input parks server-side until approve/reject/expiry), records the one
// pending-review activity record, and answers 202 with the content-free approval projection.
export function createAtlassianPendingApprovalResult(
  input: CreatePendingApprovalResultInput,
): RouteResult {
  const approval = buildAtlassianPendingApproval({
    connectorId: input.connectorId,
    actionType: input.actionType,
    reviewReason: input.reviewReason,
    ...(input.targetRef === undefined ? {} : { targetRef: input.targetRef }),
    correlationId: input.correlationId,
    requestedAt: Date.now(),
  });
  const created = atlassianActionApprovalRegistry.create({
    approval,
    authority: input.authority,
    authRef: input.authRef,
    payload: input.payload,
  });
  if (!created.ok) {
    return {
      status: 429,
      body: errorBody(
        "APPROVALS_EXHAUSTED",
        "Too many pending connector action approvals; resolve or let them expire first.",
      ),
    };
  }
  recordAtlassianActionActivity({
    connectorId: input.connectorId,
    actionType: input.actionType,
    disposition: "review-required",
    outcome: "pending-review",
    reasonCode: input.reviewReason,
    ...(input.targetRef === undefined ? {} : { targetRef: input.targetRef }),
    correlationId: input.correlationId,
    durationMs: 0,
    ...(input.jqlDigest === undefined ? {} : { jqlDigest: input.jqlDigest }),
  });
  return {
    status: 202,
    body: { disposition: "review-required", approval, correlationId: input.correlationId },
  };
}
