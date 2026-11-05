import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { canonicalise } from "@oscharko-dev/keiko-security";
import { logKnowledgeDocumentOperation } from "./knowledge-document-activity.js";

const TOOLS = new Set([
  "keiko.knowledge.requirements",
  "keiko.knowledge.documents",
  "keiko.knowledge.review",
]);
function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
interface Stream {
  readonly cursor: string | undefined;
  readonly continuous: boolean;
}
interface Tally {
  observed: boolean;
  documents: number;
  requirements: number;
  unavailable: number;
  scopeRefusals: number;
  failedOperations: number;
  omittedRequirements: number;
  readonly reviewTargets: Set<string>;
  readonly truncatedRequirements: Set<string>;
  readonly unavailableSources: Set<string>;
  readonly read: Set<string>;
  readonly missingCriteria: Set<string>;
  readonly reviewed: Map<
    string,
    { readonly revision: string; readonly textRevision: string; readonly complete: boolean }
  >;
  readonly streams: Map<string, Stream>;
}
export interface KnowledgeTurnCoverage {
  readonly documentCount: number;
  readonly requirementCount: number;
  readonly readRequirementCount: number;
  readonly sourceCriteriaMissingCount: number;
  readonly reviewedDocumentCount: number;
  readonly unavailableDocumentCount: number;
  readonly pendingPageCount: number;
  readonly requestedReviewDocumentCount: number;
  readonly refusedScopeCount: number;
  readonly failedOperationCount: number;
  readonly omittedRequirementCount: number;
  readonly truncatedRequirementCount: number;
}

/** A cursor is only a position; cumulative coverage requires an observed, continuous page chain. */
function observeStream(
  tally: Tally,
  exchange: ChatToolExchange,
  data: Readonly<Record<string, unknown>>,
): void {
  const cursor = exchange.call.arguments.cursor === "" ? undefined : exchange.call.arguments.cursor;
  const selection = effectiveSelection(exchange.call.arguments, data);
  const key = `${exchange.result?.toolRef?.canonicalId ?? ""}|${canonicalise(selection)}`;
  const previous = tally.streams.get(key);
  tally.streams.set(key, {
    cursor: typeof data.nextCursor === "string" ? data.nextCursor : undefined,
    continuous:
      cursor === undefined || (previous?.continuous === true && previous.cursor === cursor),
  });
}

function effectiveSelection(
  args: Readonly<Record<string, unknown>>,
  data: Readonly<Record<string, unknown>>,
): object {
  return Object.fromEntries(
    Object.entries({ ...args, view: data.view }).filter(
      ([key, value]) =>
        key !== "cursor" &&
        key !== "limit" &&
        value !== "" &&
        (!Array.isArray(value) || value.length > 0),
    ),
  );
}

function observeReview(
  tally: Tally,
  coverage: Readonly<Record<string, unknown>> | undefined,
): void {
  if (
    typeof coverage?.documentScope !== "string" ||
    typeof coverage.revisionDigest !== "string" ||
    typeof coverage.textRevision !== "string"
  )
    return;
  tally.reviewed.set(coverage.documentScope, {
    revision: coverage.revisionDigest,
    textRevision: coverage.textRevision,
    complete: coverage.documentReviewComplete === true,
  });
}

function changedReviewSource(
  item: Readonly<Record<string, unknown>>,
  review: { readonly revision: string; readonly textRevision: string },
): boolean {
  return (
    (typeof item.revisionDigest === "string" && item.revisionDigest !== review.revision) ||
    (typeof item.textRevision === "string" && item.textRevision !== review.textRevision)
  );
}

function invalidateChangedReviews(tally: Tally, data: Readonly<Record<string, unknown>>): void {
  if (!Array.isArray(data.items) || data.view === "units") return;
  for (const value of data.items) {
    const item = record(value);
    if (typeof item?.documentScope !== "string") continue;
    const review = tally.reviewed.get(item.documentScope);
    if (review === undefined) continue;
    if (changedReviewSource(item, review)) tally.reviewed.delete(item.documentScope);
  }
}

function missingSourceCriteria(item: Readonly<Record<string, unknown>>): boolean {
  return (
    Array.isArray(item.acceptanceCriteria) &&
    item.acceptanceCriteria.length === 0 &&
    item.criteriaTruncated !== true
  );
}
function observeItems(tally: Tally, data: Readonly<Record<string, unknown>>): void {
  if (data.view !== "units" || !Array.isArray(data.items)) return;
  for (const value of data.items) {
    const item = record(value);
    if (typeof item?.reference !== "string") continue;
    tally.read.add(item.reference);
    if (item.criteriaTruncated === true || item.statementTruncated === true)
      tally.truncatedRequirements.add(item.reference);
    if (missingSourceCriteria(item)) tally.missingCriteria.add(item.reference);
  }
}
function observeReviewTarget(tally: Tally, exchange: ChatToolExchange): void {
  if (
    exchange.result?.toolRef?.canonicalId === "keiko.knowledge.review" &&
    typeof exchange.call.arguments.documentScope === "string"
  )
    tally.reviewTargets.add(exchange.call.arguments.documentScope);
}
function observe(tally: Tally, exchange: ChatToolExchange): void {
  const result = exchange.result;
  if (result === undefined || !TOOLS.has(result.toolRef?.canonicalId ?? "")) return;
  tally.observed = true;
  observeReviewTarget(tally, exchange);
  const data = record(result.data);
  if (result.status !== "completed" || data?.outcome !== "succeeded") {
    tally.failedOperations++;
    return;
  }
  observeUnavailableSources(tally, data);
  observeCounts(tally, record(data.totals));
  invalidateChangedReviews(tally, data);
  observeReview(tally, record(data.coverage));
  observeItems(tally, data);
  observeStream(tally, exchange, data);
}
function observeUnavailableSources(tally: Tally, data: Readonly<Record<string, unknown>>): void {
  if (!Array.isArray(data.items)) return;
  for (const value of data.items) {
    const item = record(value);
    if (item?.sourceUnavailable === true && typeof item.documentScope === "string")
      tally.unavailableSources.add(item.documentScope);
  }
}
function unavailableDocuments(totals: Readonly<Record<string, unknown>> | undefined): number {
  return count(totals?.documentsNotExtracted) + count(totals?.documentsOmitted);
}
function observeCounts(tally: Tally, totals: Readonly<Record<string, unknown>> | undefined): void {
  tally.documents = Math.max(
    tally.documents,
    count(totals?.documentCount),
    count(totals?.documentsScanned) + unavailableDocuments(totals),
  );
  tally.requirements = Math.max(tally.requirements, count(totals?.detectedCount));
  tally.omittedRequirements = Math.max(tally.omittedRequirements, count(totals?.unitsOmitted));
  tally.scopeRefusals = Math.max(
    tally.scopeRefusals,
    Array.isArray(totals?.refusals) ? totals.refusals.length : 0,
  );
  tally.unavailable = Math.max(tally.unavailable, unavailableDocuments(totals));
}

/** Trusted tool identity and structured receipts only; neither answer wording nor document text. */
export function knowledgeTurnCoverage(
  exchanges: readonly ChatToolExchange[],
): KnowledgeTurnCoverage | undefined {
  const tally: Tally = {
    observed: false,
    documents: 0,
    requirements: 0,
    unavailable: 0,
    scopeRefusals: 0,
    failedOperations: 0,
    omittedRequirements: 0,
    reviewTargets: new Set(),
    truncatedRequirements: new Set(),
    unavailableSources: new Set(),
    read: new Set(),
    missingCriteria: new Set(),
    reviewed: new Map(),
    streams: new Map(),
  };
  for (const exchange of exchanges) observe(tally, exchange);
  if (!tally.observed) return undefined;
  return {
    documentCount: tally.documents,
    requirementCount: tally.requirements,
    readRequirementCount: tally.read.size,
    sourceCriteriaMissingCount: tally.missingCriteria.size,
    reviewedDocumentCount: [...tally.reviewed.values()].filter((review) => review.complete).length,
    unavailableDocumentCount: Math.max(tally.unavailable, tally.unavailableSources.size),
    requestedReviewDocumentCount: tally.reviewTargets.size,
    refusedScopeCount: tally.scopeRefusals,
    failedOperationCount: tally.failedOperations,
    omittedRequirementCount: tally.omittedRequirements,
    truncatedRequirementCount: tally.truncatedRequirements.size,
    pendingPageCount: [...tally.streams.values()].filter(
      (stream) => stream.cursor !== undefined || !stream.continuous,
    ).length,
  };
}

export function knowledgeCoverageCorrection(coverage: KnowledgeTurnCoverage): string | undefined {
  if (coverage.pendingPageCount === 0) return undefined;
  return `This turn still has ${String(coverage.pendingPageCount)} unfinished Knowledge page chain(s). Continue the returned nextCursor with the same selection before claiming whole-document or whole-Pod coverage. If the requested scope is narrower or a bound prevents completion, state that limit explicitly and label the result partial. Preserve source requirements and their acceptance criteria; separate proposed additions and targeted clarification questions. Fulfil the user's requested fields at the requested issue level.`;
}

function countNote(notes: string[], count: number, label: string): void {
  if (count > 0) notes.push(`${label}: ${String(count)}.`);
}

/** Surface observed gaps; a complete metadata inventory does not imply a semantic-review task. */
export function knowledgeCoverageNote(coverage: KnowledgeTurnCoverage | undefined): string {
  if (coverage === undefined) return "";
  const notes: string[] = [];
  countNote(notes, coverage.pendingPageCount, "Unfinished Knowledge page chains");
  countNote(notes, coverage.unavailableDocumentCount, "Unavailable or omitted documents");
  countNote(notes, coverage.refusedScopeCount, "Unavailable selected Knowledge scopes");
  countNote(notes, coverage.failedOperationCount, "Knowledge operations without usable results");
  countNote(notes, coverage.omittedRequirementCount, "Requirements omitted by read bounds");
  countNote(
    notes,
    coverage.truncatedRequirementCount,
    "Requirement items with truncated source fields",
  );
  countNote(
    notes,
    coverage.sourceCriteriaMissingCount,
    "Read requirements without detected source acceptance criteria",
  );
  if (coverage.reviewedDocumentCount < coverage.requestedReviewDocumentCount)
    notes.push(
      `Explicit document reviews completed: ${String(coverage.reviewedDocumentCount)}/${String(coverage.requestedReviewDocumentCount)}.`,
    );
  return notes.length === 0 ? "" : `\n\nSource coverage: ${notes.join(" ")}`;
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
  });
}

/** Compaction retains the next page and explicit coverage instead of losing the continuation. */
export function knowledgeCoverageReceipt(exchange: ChatToolExchange): object | undefined {
  if (exchange.result === undefined || !TOOLS.has(exchange.result.toolRef?.canonicalId ?? ""))
    return undefined;
  const data = record(exchange.result.data);
  return data === undefined
    ? undefined
    : {
        view: data.view,
        totals: data.totals,
        coverage: data.coverage,
        nextCursor: data.nextCursor,
      };
}
