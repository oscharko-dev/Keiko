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
import type {
  AtlassianConnectorActionDisposition,
  AtlassianConnectorActionReviewReason,
  AtlassianConnectorActionType,
  AtlassianConnectorActivityOutcome,
  AtlassianConnectorActivityReasonCode,
  AtlassianConnectorPendingApproval,
} from "@oscharko-dev/keiko-contracts";
import {
  ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK,
  ATLASSIAN_CONNECTOR_ACTION_CLASS,
  ATLASSIAN_CONNECTOR_ACTION_PROVIDER,
  ATLASSIAN_CONNECTOR_ACTION_REQUIRED_SCOPE,
  ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { errorBody, type RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  contentPreviewFor,
  resolveAtlassianActionApprovalRegistry,
  ATLASSIAN_ACTION_APPROVAL_TTL_MS,
  type PendingAtlassianActionPayload,
} from "./actionApprovals.js";
import type { AtlassianActionAuthorityContext } from "./actionPolicy.js";
import { resolveAtlassianSyncJobRegistry } from "./syncService.js";

// KEIKO-0565 (PR #3289 review): every helper below takes the caller's own DI-scoped registries
// instead of reaching for the module-level singletons in actionApprovals.ts/syncService.ts — see
// resolveAtlassianActionApprovalRegistry's doc comment for why. Route handlers pass their own
// `UiHandlerDeps` directly; it structurally satisfies this narrower Pick.
export type AtlassianActivityRegistryDeps = Pick<
  UiHandlerDeps,
  "atlassianActionApprovalRegistry" | "atlassianSyncJobRegistry"
>;

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
export function recordAtlassianActionActivity(
  deps: AtlassianActivityRegistryDeps,
  input: AtlassianActionActivityInput,
): void {
  resolveAtlassianSyncJobRegistry(deps).recordActivity({
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
  // KEIKO-0186: bounded content preview (see contentPreviewFor), or undefined for a non-write
  // pending action and for a write action with nothing to preview. Passed through as-is — this
  // function stays payload-agnostic; the caller decides when there is content to derive one from.
  readonly contentPreview?: string | undefined;
  // KEIKO-0186 P1: true when the action HAD text but nothing presentable survived
  // sanitization/bounding (see contentPreviewFor's "unavailable" outcome and
  // isAtlassianContentPreviewUnpresentable). Mutually exclusive with contentPreview — the caller
  // must never pass both.
  readonly contentPreviewUnavailable?: true | undefined;
}

// The wire projection for one pending approval: the D4 row is derived from the contract tables,
// never caller-supplied. `contentPreview` is the one field this projection does NOT redact
// (KEIKO-0186) — see the interface's own doc comment for why that is deliberate and bounded.
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
    ...(input.contentPreview === undefined ? {} : { contentPreview: input.contentPreview }),
    ...(input.contentPreviewUnavailable === undefined
      ? {}
      : { contentPreviewUnavailable: input.contentPreviewUnavailable }),
  };
}

// ─── Shared route outcomes (write-action and sync routes) ─────────────────────

// Records the one denied-attempt activity record and answers the disposition as 200-level data
// (mirroring the editor lane's not-run responses: a policy denial is an expected, renderable
// outcome, not a transport error).
export function deniedAtlassianActionResult(
  deps: AtlassianActivityRegistryDeps,
  input: {
    readonly connectorId: string;
    readonly actionType: AtlassianConnectorActionType;
    readonly reasonCode: AtlassianConnectorActivityReasonCode;
    readonly targetRef?: string | undefined;
    readonly correlationId: string;
    readonly jqlDigest?: string | undefined;
  },
): RouteResult {
  recordAtlassianActionActivity(deps, {
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
// KEIKO-0339: emit exactly one activity record for the rejected attempt BEFORE the 429
// response so the "one record per attempt" invariant survives registry-capacity denials.
// The closed `approvals-registry-exhausted` reason distinguishes this from policy/authority
// denials in the D6 audit vocabulary.
function recordApprovalsExhausted(
  deps: AtlassianActivityRegistryDeps,
  input: CreatePendingApprovalResultInput,
): RouteResult {
  recordAtlassianActionActivity(deps, {
    connectorId: input.connectorId,
    actionType: input.actionType,
    disposition: "denied",
    outcome: "denied",
    reasonCode: "approvals-registry-exhausted",
    ...(input.targetRef === undefined ? {} : { targetRef: input.targetRef }),
    correlationId: input.correlationId,
    durationMs: 0,
    ...(input.jqlDigest === undefined ? {} : { jqlDigest: input.jqlDigest }),
  });
  return {
    status: 429,
    body: errorBody(
      "APPROVALS_EXHAUSTED",
      "Too many pending connector action approvals; resolve or let them expire first.",
    ),
  };
}

export function createAtlassianPendingApprovalResult(
  deps: AtlassianActivityRegistryDeps,
  input: CreatePendingApprovalResultInput,
): RouteResult {
  const preview =
    input.payload.kind === "write-action"
      ? contentPreviewFor(input.payload.action)
      : ({ status: "none" } as const);
  const approval = buildAtlassianPendingApproval({
    connectorId: input.connectorId,
    actionType: input.actionType,
    reviewReason: input.reviewReason,
    ...(input.targetRef === undefined ? {} : { targetRef: input.targetRef }),
    correlationId: input.correlationId,
    requestedAt: Date.now(),
    ...(preview.status === "available" ? { contentPreview: preview.text } : {}),
    ...(preview.status === "unavailable" ? { contentPreviewUnavailable: true as const } : {}),
  });
  const created = resolveAtlassianActionApprovalRegistry(deps).create({
    approval,
    authority: input.authority,
    authRef: input.authRef,
    payload: input.payload,
  });
  if (!created.ok) {
    return recordApprovalsExhausted(deps, input);
  }
  recordAtlassianActionActivity(deps, {
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
