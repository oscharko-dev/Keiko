// Activity Log evidence of the review model policy (ADR-0182 `review.model-policy.*`, Issue #4137).
//
// A model-policy read, a saved settings change and every refusal (a settings write, a run start or
// dry run, a pair qualification, an invalid operator value at startup) are reconstructable from these
// lines alone. Every field is a closed value, a count, a flag or a digest (ADR-0173 D4): model ids
// appear only as digests, never a rules path, a repository root or any other free text.

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  ReviewModelPolicyRefusalReason,
  ReviewModelRole,
  ReviewOperatorConfigIssue,
  ReviewPairStatus,
  ReviewResolvedRole,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import type { ServerLogSink } from "../../observability/index.js";
import { COUNT_FIELD, REVIEW_OPERATION, reviewEvidenceDigest } from "../activity-log.js";

// Literal copies of the contract vocabularies (the op-catalog generator reads registrations as
// closed literals); `activity-log.test.ts` pins each one to its contract constant.
export const MODEL_POLICY_LOG_REFUSAL_REASONS = [
  "not-configured",
  "not-tool-capable",
  "tool-verification-stale",
  "window-unknown",
  "window-too-small",
  "not-coding-safe",
  "outside-allowlist",
  "policy-locked",
  "invalid-operator-value",
  "rules-path-invalid",
  "revision-conflict",
  "request-invalid",
] as const;
export const MODEL_POLICY_LOG_SOURCES = ["operator", "user", "recommendation", "none"] as const;
export const MODEL_POLICY_LOG_PAIR_STATUSES = [
  "unmeasured",
  "seed-qualified",
  "seed-failed",
  "collecting",
  "measured-passed",
  "measured-failed",
] as const;
export const MODEL_POLICY_LOG_OPERATOR_KEYS = [
  "review",
  "enabled",
  "reviewerModelId",
  "counterCheckerModelId",
  "allowedReviewModelIds",
  "lockModelPolicy",
  "rulesFilePath",
  "repositories",
] as const;
const ROLE_STATES = ["eligible", "busy", "temporarily-unavailable", "refused"] as const;
const REFUSAL_STAGES = ["startup", "settings-update", "run-start", "qualification"] as const;
export type ReviewModelPolicyRefusalStage = (typeof REFUSAL_STAGES)[number];

const MODEL_POLICY_OPERATION = {
  ...REVIEW_OPERATION,
  failureClasses: ["review-model-policy"],
} as const;

const FLAG = { type: "boolean", dataClass: "closed-enum", required: true } as const;
const OPTIONAL_FLAG = { ...FLAG, required: false } as const;
const OPTIONAL_COUNT = { ...COUNT_FIELD, required: false } as const;
const OPTIONAL_DIGEST = {
  type: "string",
  dataClass: "digest",
  required: false,
  maxLength: 64,
} as const;
const SOURCE = {
  type: "string",
  dataClass: "closed-enum",
  required: false,
  values: MODEL_POLICY_LOG_SOURCES,
} as const;
const ROLE_STATE = {
  type: "string",
  dataClass: "closed-enum",
  required: false,
  values: ROLE_STATES,
} as const;
const OPTIONAL_REASON = {
  type: "string",
  dataClass: "closed-enum",
  required: false,
  values: MODEL_POLICY_LOG_REFUSAL_REASONS,
} as const;

// The resolved roles: source, state, closed refusal reason and model digest of each (absent while
// the area is switched off, when nothing is resolved).
const ROLE_FIELDS = {
  reviewerSource: SOURCE,
  reviewerState: ROLE_STATE,
  reviewerReason: OPTIONAL_REASON,
  reviewerModelDigest: OPTIONAL_DIGEST,
  counterCheckerSource: SOURCE,
  counterCheckerState: ROLE_STATE,
  counterCheckerReason: OPTIONAL_REASON,
  counterCheckerModelDigest: OPTIONAL_DIGEST,
} as const;

const REVIEW_MODEL_POLICY_RESOLVED = defineActivityLogOperation({
  ...MODEL_POLICY_OPERATION,
  op: "review.model-policy.resolved",
  emitter: "review/policy/activity-log.logReviewModelPolicyResolved",
  fields: {
    enabled: FLAG,
    ...ROLE_FIELDS,
    locked: OPTIONAL_FLAG,
    allowlistActive: OPTIONAL_FLAG,
    singleModel: OPTIONAL_FLAG,
    pairStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: MODEL_POLICY_LOG_PAIR_STATUSES,
    },
    optionCount: OPTIONAL_COUNT,
    eligibleReviewerCount: OPTIONAL_COUNT,
    eligibleCounterCheckerCount: OPTIONAL_COUNT,
    invalidOperatorKeyCount: OPTIONAL_COUNT,
  },
  lifecycle: "state",
  analyzerProjection: "timeline",
  proofIds: ["review.model-policy.resolved.line"],
});

const REVIEW_MODEL_POLICY_UPDATED = defineActivityLogOperation({
  ...MODEL_POLICY_OPERATION,
  op: "review.model-policy.updated",
  emitter: "review/policy/activity-log.logReviewModelPolicyUpdated",
  fields: {
    ...ROLE_FIELDS,
    revision: COUNT_FIELD,
    modelsChanged: FLAG,
    rulesPathChanged: FLAG,
    rulesPathSet: FLAG,
  },
  lifecycle: "end",
  analyzerProjection: "timeline",
  proofIds: ["review.model-policy.updated.line"],
});

const REVIEW_MODEL_POLICY_REFUSED = defineActivityLogOperation({
  ...MODEL_POLICY_OPERATION,
  op: "review.model-policy.refused",
  emitter: "review/policy/activity-log.logReviewModelPolicyRefused",
  fields: {
    reason: { ...OPTIONAL_REASON, required: true },
    role: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["reviewer", "counter-checker", "none"],
    },
    stage: { type: "string", dataClass: "closed-enum", required: true, values: REFUSAL_STAGES },
    operatorKey: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: MODEL_POLICY_LOG_OPERATOR_KEYS,
    },
    operatorKeySource: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["file", "environment"],
    },
  },
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  proofIds: ["review.model-policy.refused.line"],
});

type RoleState = (typeof ROLE_STATES)[number];

function roleState(role: ReviewResolvedRole): RoleState {
  const state = role.state;
  if (state.status === "eligible") return state.hint === "busy" ? "busy" : "eligible";
  return state.status;
}

function roleFields(
  prefix: "reviewer" | "counterChecker",
  role: ReviewResolvedRole,
): Record<string, string> {
  return {
    [`${prefix}Source`]: role.source,
    [`${prefix}State`]: roleState(role),
    ...(role.state.status === "refused" ? { [`${prefix}Reason`]: role.state.reason } : {}),
    ...(role.modelId === null
      ? {}
      : { [`${prefix}ModelDigest`]: reviewEvidenceDigest("model", role.modelId) }),
  };
}

interface ReviewModelPolicyRoles {
  readonly reviewer: ReviewResolvedRole;
  readonly counterChecker: ReviewResolvedRole;
}

export interface ReviewModelPolicyResolvedLine extends ReviewModelPolicyRoles {
  readonly locked: boolean;
  readonly allowlistActive: boolean;
  readonly singleModel: boolean;
  readonly pairStatus: ReviewPairStatus;
  readonly optionCount: number;
  readonly eligibleReviewerCount: number;
  readonly eligibleCounterCheckerCount: number;
  readonly invalidOperatorKeyCount: number;
}

/** A model-policy read; `undefined` records that the area is switched off. */
export function logReviewModelPolicyResolved(
  log: ServerLogSink,
  correlationId: string,
  line: ReviewModelPolicyResolvedLine | undefined,
): void {
  if (line === undefined) {
    log.write(
      activityLogEvent(
        REVIEW_MODEL_POLICY_RESOLVED,
        { correlationId, level: "info" },
        { enabled: false },
      ),
    );
    return;
  }
  log.write(
    activityLogEvent(
      REVIEW_MODEL_POLICY_RESOLVED,
      { correlationId, level: "info" },
      {
        enabled: true,
        ...roleFields("reviewer", line.reviewer),
        ...roleFields("counterChecker", line.counterChecker),
        locked: line.locked,
        allowlistActive: line.allowlistActive,
        singleModel: line.singleModel,
        pairStatus: line.pairStatus,
        optionCount: line.optionCount,
        eligibleReviewerCount: line.eligibleReviewerCount,
        eligibleCounterCheckerCount: line.eligibleCounterCheckerCount,
        invalidOperatorKeyCount: line.invalidOperatorKeyCount,
      },
    ),
  );
}

export interface ReviewModelPolicyUpdatedLine extends ReviewModelPolicyRoles {
  readonly revision: number;
  readonly modelsChanged: boolean;
  readonly rulesPathChanged: boolean;
  readonly rulesPathSet: boolean;
}

export function logReviewModelPolicyUpdated(
  log: ServerLogSink,
  correlationId: string,
  line: ReviewModelPolicyUpdatedLine,
): void {
  log.write(
    activityLogEvent(
      REVIEW_MODEL_POLICY_UPDATED,
      { correlationId, level: "info" },
      {
        ...roleFields("reviewer", line.reviewer),
        ...roleFields("counterChecker", line.counterChecker),
        revision: line.revision,
        modelsChanged: line.modelsChanged,
        rulesPathChanged: line.rulesPathChanged,
        rulesPathSet: line.rulesPathSet,
      },
    ),
  );
}

export interface ReviewModelPolicyRefusedLine {
  readonly reason: ReviewModelPolicyRefusalReason;
  readonly role: ReviewModelRole | "none";
  readonly stage: ReviewModelPolicyRefusalStage;
  readonly operatorIssue?: ReviewOperatorConfigIssue | undefined;
}

function refusalErrorKind(
  reason: ReviewModelPolicyRefusalReason,
): "conflict" | "invalid-request" | "authority-denied" | "validation-failed" {
  if (reason === "revision-conflict") return "conflict";
  if (reason === "request-invalid" || reason === "rules-path-invalid") return "invalid-request";
  if (reason === "outside-allowlist" || reason === "policy-locked") return "authority-denied";
  return "validation-failed";
}

export function logReviewModelPolicyRefused(
  log: ServerLogSink,
  correlationId: string,
  line: ReviewModelPolicyRefusedLine,
): void {
  const issue = line.operatorIssue;
  log.write(
    activityLogEvent(
      REVIEW_MODEL_POLICY_REFUSED,
      { correlationId, level: "warn", errorKind: refusalErrorKind(line.reason) },
      {
        reason: line.reason,
        role: line.role,
        stage: line.stage,
        ...(issue === undefined ? {} : { operatorKey: issue.key, operatorKeySource: issue.source }),
      },
    ),
  );
}
