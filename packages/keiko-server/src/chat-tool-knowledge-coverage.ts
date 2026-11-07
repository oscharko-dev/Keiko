import type { KnowledgeTurnCoverage } from "@oscharko-dev/keiko-contracts/runtime/knowledge-turn-coverage";
export {
  knowledgeTurnCoverage,
  knowledgeCoverageIssues,
  knowledgeCoverageReceipt,
  type KnowledgeTurnCoverage,
} from "@oscharko-dev/keiko-contracts/runtime/knowledge-turn-coverage";
import { logKnowledgeDocumentOperation } from "./knowledge-document-activity.js";

export function knowledgeCoverageCorrection(coverage: KnowledgeTurnCoverage): string | undefined {
  if (coverage.pendingPageCount === 0) return undefined;
  return `This turn still has ${String(coverage.pendingPageCount)} unfinished Knowledge page chain(s). Continue the returned nextCursor with the same selection before claiming whole-document or whole-Pod coverage. If the requested scope is narrower or a bound prevents completion, state that limit explicitly and label the result partial. Preserve source requirements and their acceptance criteria; separate proposed additions and targeted clarification questions. Fulfil the user's requested fields at the requested issue level.`;
}

export function logKnowledgeCoverage(
  correlationId: string,
  coverage: KnowledgeTurnCoverage | undefined,
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
    ...(coverage.draftBatchCoveredRequirementCount === undefined
      ? {}
      : { draftBatchCoveredRequirementCount: coverage.draftBatchCoveredRequirementCount }),
  });
}
