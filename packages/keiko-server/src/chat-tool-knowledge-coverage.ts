import type { KnowledgeTurnCoverage } from "@oscharko-dev/keiko-contracts/runtime/knowledge-turn-coverage";
export {
  knowledgeTurnCoverage,
  knowledgeCoverageIssues,
  knowledgeCoverageReceipt,
  type KnowledgeTurnCoverage,
} from "@oscharko-dev/keiko-contracts/runtime/knowledge-turn-coverage";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { JIRA_DRAFT_BATCH_TOOL_ID } from "./chat-tool-batch-draft.js";
import { logKnowledgeDocumentOperation } from "./knowledge-document-activity.js";

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * The requirements a completed draft batch of this turn covered, when it covered every one it
 * selected; none otherwise. Keiko read and drafted those requirements itself, so an earlier, partial
 * Knowledge read of the model is no unfinished coverage (#4292: after 370 drafted and created
 * issues the turn still asked the model to page through the requirements, one more 44 s round).
 */
export function draftBatchCoveredRequirements(
  exchanges: readonly ChatToolExchange[],
): number | undefined {
  for (let index = exchanges.length - 1; index >= 0; index -= 1) {
    const covered = completeBatchCoverage(exchanges[index]);
    if (covered !== undefined) return covered;
  }
  return undefined;
}

function completeBatchCoverage(exchange: ChatToolExchange | undefined): number | undefined {
  const result = exchange?.result;
  const done =
    result?.toolRef?.canonicalId === JIRA_DRAFT_BATCH_TOOL_ID && result.status === "completed";
  const data = done ? record(result.data) : undefined;
  if (data?.outcome !== "succeeded" || data.paused === true) return undefined;
  return everySelectedCovered(data.requirementCount, data.coveredRequirementCount);
}

function everySelectedCovered(selected: unknown, covered: unknown): number | undefined {
  if (typeof selected !== "number" || typeof covered !== "number" || selected <= 0)
    return undefined;
  return covered >= selected ? covered : undefined;
}

export function knowledgeCoverageCorrection(
  coverage: KnowledgeTurnCoverage,
  draftBatchCovered?: number,
): string | undefined {
  if (coverage.pendingPageCount === 0 || draftBatchCovered !== undefined) return undefined;
  return `This turn still has ${String(coverage.pendingPageCount)} unfinished Knowledge page chain(s). Continue the returned nextCursor with the same selection before claiming whole-document or whole-Pod coverage. If the requested scope is narrower or a bound prevents completion, state that limit explicitly and label the result partial. Preserve source requirements and their acceptance criteria; separate proposed additions and targeted clarification questions. Fulfil the user's requested fields at the requested issue level.`;
}

export function logKnowledgeCoverage(
  correlationId: string,
  coverage: KnowledgeTurnCoverage | undefined,
  draftBatchCovered?: number,
): void {
  if (coverage === undefined) return;
  logKnowledgeDocumentOperation(correlationId, {
    operation: "coverage",
    disposition: "served",
    documentCount: coverage.documentCount,
    returnedCount: coverage.readRequirementCount,
    sourceChars: 0,
    hasNextPage: coverage.pendingPageCount > 0,
    cached: false,
    requirementCount: coverage.requirementCount,
    readRequirementCount: coverage.readRequirementCount,
    reviewedDocumentCount: coverage.reviewedDocumentCount,
    pendingPageCount: coverage.pendingPageCount,
    ...(draftBatchCovered === undefined
      ? {}
      : { draftBatchCoveredRequirementCount: draftBatchCovered }),
  });
}
