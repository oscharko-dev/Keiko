import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  JIRA_DRAFT_DIGEST_PATTERN,
  JIRA_DRAFT_ID_PATTERN,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

/** The canonical tool id of the draft batch; the model-facing alias is `jira_draft_batch`. */
export const JIRA_DRAFT_BATCH_TOOL_ID = "keiko.jira.draft.batch";
/** The canonical tool id of the draft run Keiko offers to the human after a clean batch. */
export const JIRA_DRAFT_TOOL_ID = "keiko.jira.draft";

export const BATCH_DRAFT_SKIP_REASONS = [
  "not-completed",
  "not-requested",
  "items-failed",
  "refs-unresolved",
  "no-draft",
  "not-offered",
  "budget-exhausted",
  "turn-ended",
  "no-stored-result",
] as const;
export type BatchDraftSkipReason = (typeof BATCH_DRAFT_SKIP_REASONS)[number];

export type BatchDraftDecision =
  | {
      readonly kind: "offer";
      readonly draftId: string;
      readonly draftDigest: string;
    }
  | { readonly kind: "skip"; readonly reason: BatchDraftSkipReason };

const DRAFT_ID = new RegExp(JIRA_DRAFT_ID_PATTERN, "u");
const DRAFT_DIGEST = new RegExp(JIRA_DRAFT_DIGEST_PATTERN, "u");

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function draftReference(
  data: Readonly<Record<string, unknown>>,
): { readonly draftId: string; readonly draftDigest: string } | undefined {
  const { draftId, draftDigest } = data;
  return typeof draftId === "string" &&
    draftId.length === 36 &&
    DRAFT_ID.test(draftId) &&
    typeof draftDigest === "string" &&
    draftDigest.length === 64 &&
    DRAFT_DIGEST.test(draftDigest)
    ? { draftId, draftDigest }
    : undefined;
}

/**
 * Whether a settled draft batch earns Keiko's own offer of the approval: only a clean, complete
 * batch the human asked to create. A failed, partial or unresolved batch is reported to the human
 * and never offered, and a batch is judged from its stored, validated result alone.
 */
export function batchDraftDecision(exchange: ChatToolExchange): BatchDraftDecision {
  const result = exchange.result;
  const data = record(result?.data);
  if (
    result?.toolRef?.canonicalId !== JIRA_DRAFT_BATCH_TOOL_ID ||
    result.status !== "completed" ||
    data?.outcome !== "succeeded"
  )
    return { kind: "skip", reason: "not-completed" };
  const reason = cleanBatchSkip(data);
  if (reason !== undefined) return { kind: "skip", reason };
  const reference = draftReference(data);
  return reference === undefined
    ? { kind: "skip", reason: "no-draft" }
    : { kind: "offer", ...reference };
}
function cleanBatchSkip(data: Readonly<Record<string, unknown>>): BatchDraftSkipReason | undefined {
  if (data.createRequested !== true) return "not-requested";
  if (data.failedCount !== 0) return "items-failed";
  return data.unresolvedRefCount === 0 ? undefined : "refs-unresolved";
}
