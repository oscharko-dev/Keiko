import type { ChatToolExchange } from "./bff-wire.js";
import { canonicalise } from "./canonical-json.js";

export const KNOWLEDGE_REVIEW_FAILURE_STAGES = [
  "model-output-invalid",
  "model-port-unavailable",
  "budget-port-unavailable",
] as const;
export type KnowledgeReviewFailureStage = (typeof KNOWLEDGE_REVIEW_FAILURE_STAGES)[number];
export const KNOWLEDGE_REVIEW_VALIDATION_REASONS = [
  "finish-reason",
  "tool-calls",
  "output-bound",
  "json-syntax",
  "review-shape",
  "complete-type",
  "findings-type",
  "findings-bound",
  "finding-shape",
  "finding-kind",
  "anchor-shape",
  "anchor-range",
  "proposal-bound",
  "question-bound",
  "conflict-anchors",
  "clarification-question",
] as const;
export type KnowledgeReviewValidationReason = (typeof KNOWLEDGE_REVIEW_VALIDATION_REASONS)[number];
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
interface ReviewCoverage {
  readonly revision: string;
  readonly textRevision: string;
  readonly fingerprint: string;
  readonly documentChars: number;
  readonly windows: Map<number, number>;
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
  readonly reviewed: Map<string, ReviewCoverage>;
  readonly streams: Map<string, Stream>;
  /** The latest draft batch's coverage of the whole collection; undefined when it covered less. */
  batchCovered: number | undefined;
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
  /**
   * Requirements a completed, unfiltered new draft batch of the turn read and drafted, all of the
   * collection. Keiko covered them itself, so an earlier partial page chain is not pending.
   */
  readonly draftBatchCoveredRequirementCount?: number;
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

interface ReviewRange {
  readonly start: number;
  readonly end: number;
  readonly documentChars: number;
}

function reviewRange(coverage: Readonly<Record<string, unknown>>): ReviewRange | undefined {
  const { characterStart: start, characterEnd: end, documentChars } = coverage;
  if (typeof start !== "number" || typeof end !== "number" || typeof documentChars !== "number")
    return undefined;
  if (
    ![start, end, documentChars].every(Number.isSafeInteger) ||
    start < 0 ||
    end <= start ||
    end > documentChars
  )
    return undefined;
  return { start, end, documentChars };
}

function sameReview(
  previous: ReviewCoverage | undefined,
  coverage: Readonly<Record<string, unknown>>,
  documentChars: number,
): previous is ReviewCoverage {
  return (
    previous !== undefined &&
    previous.fingerprint === coverage.reviewFingerprint &&
    previous.revision === coverage.revisionDigest &&
    previous.textRevision === coverage.textRevision &&
    previous.documentChars === documentChars
  );
}

function observeReview(
  tally: Tally,
  coverage: Readonly<Record<string, unknown>> | undefined,
): void {
  if (
    typeof coverage?.documentScope !== "string" ||
    typeof coverage.revisionDigest !== "string" ||
    typeof coverage.textRevision !== "string" ||
    typeof coverage.reviewFingerprint !== "string"
  )
    return;
  const range = reviewRange(coverage);
  if (range === undefined) return;
  const previous = tally.reviewed.get(coverage.documentScope);
  const windows = sameReview(previous, coverage, range.documentChars)
    ? previous.windows
    : new Map<number, number>();
  if (coverage.windowReviewComplete === true) windows.set(range.start, range.end);
  else windows.delete(range.start);
  tally.reviewed.set(coverage.documentScope, {
    revision: coverage.revisionDigest,
    textRevision: coverage.textRevision,
    fingerprint: coverage.reviewFingerprint,
    documentChars: range.documentChars,
    windows,
  });
}

/** Only settled windows in this turn contribute; the model cost cache supplies no coverage. */
function reviewComplete(review: ReviewCoverage): boolean {
  let end = 0;
  for (const [start, next] of [...review.windows].sort((left, right) => left[0] - right[0])) {
    if (start > end) return false;
    end = Math.max(end, next);
  }
  return end === review.documentChars;
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
const DRAFT_BATCH_TOOL = "keiko.jira.draft.batch";

/** A completed, unfiltered new batch that drafted every requirement of the collection. */
function wholeBatchCoverage(exchange: ChatToolExchange): number | undefined {
  const result = exchange.result;
  const data = result?.status === "completed" ? record(result.data) : undefined;
  if (data?.outcome !== "succeeded" || data.paused === true || data.wholeCollection !== true)
    return undefined;
  return everyRequirementCovered(data.requirementCount, data.coveredRequirementCount);
}
function everyRequirementCovered(selected: unknown, covered: unknown): number | undefined {
  if (typeof selected !== "number" || typeof covered !== "number" || selected <= 0)
    return undefined;
  return covered >= selected ? covered : undefined;
}

/** A draft batch settles the turn's batch coverage; every other exchange is a Knowledge receipt. */
function observeExchange(tally: Tally, exchange: ChatToolExchange): void {
  if (exchange.result?.toolRef?.canonicalId === DRAFT_BATCH_TOOL)
    tally.batchCovered = wholeBatchCoverage(exchange);
  else observe(tally, exchange);
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
  if (result.toolRef?.canonicalId === "keiko.knowledge.review")
    observeReview(tally, record(data.coverage));
  observeItems(tally, data);
  observeStream(tally, exchange, data);
}
function observeUnavailableSources(tally: Tally, data: Readonly<Record<string, unknown>>): void {
  const unavailableScopes = record(data.coverage)?.unavailableDocumentScopes;
  if (Array.isArray(unavailableScopes)) {
    for (const scope of unavailableScopes)
      if (typeof scope === "string") tally.unavailableSources.add(scope);
  }
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
    batchCovered: undefined,
  };
  for (const exchange of exchanges) observeExchange(tally, exchange);
  if (!tally.observed) return undefined;
  const covered = tally.batchCovered;
  return {
    documentCount: tally.documents,
    requirementCount: tally.requirements,
    readRequirementCount: tally.read.size,
    sourceCriteriaMissingCount: tally.missingCriteria.size,
    reviewedDocumentCount: [...tally.reviewed.values()].filter(reviewComplete).length,
    unavailableDocumentCount: Math.max(tally.unavailable, tally.unavailableSources.size),
    requestedReviewDocumentCount: tally.reviewTargets.size,
    refusedScopeCount: tally.scopeRefusals,
    failedOperationCount: tally.failedOperations,
    omittedRequirementCount: tally.omittedRequirements,
    truncatedRequirementCount: tally.truncatedRequirements.size,
    pendingPageCount:
      covered === undefined
        ? [...tally.streams.values()].filter(
            (stream) => stream.cursor !== undefined || !stream.continuous,
          ).length
        : 0,
    ...(covered === undefined ? {} : { draftBatchCoveredRequirementCount: covered }),
  };
}

export type KnowledgeCoverageIssue =
  | {
      readonly kind:
        | "pending-reads"
        | "unavailable-documents"
        | "refused-scopes"
        | "failed-operations"
        | "omitted-requirements"
        | "truncated-requirements"
        | "missing-criteria";
      readonly count: number;
    }
  | { readonly kind: "requested-reviews"; readonly completed: number; readonly requested: number };

/** Presentation kinds retain the same observed limits; metadata alone requests no semantic review. */
export function knowledgeCoverageIssues(
  coverage: KnowledgeTurnCoverage | undefined,
): readonly KnowledgeCoverageIssue[] {
  if (coverage === undefined) return [];
  const fields = [
    ["pendingPageCount", "pending-reads"],
    ["unavailableDocumentCount", "unavailable-documents"],
    ["refusedScopeCount", "refused-scopes"],
    ["failedOperationCount", "failed-operations"],
    ["omittedRequirementCount", "omitted-requirements"],
    ["truncatedRequirementCount", "truncated-requirements"],
    ["sourceCriteriaMissingCount", "missing-criteria"],
  ] as const;
  const issues: KnowledgeCoverageIssue[] = [];
  for (const [field, kind] of fields)
    if (coverage[field] > 0) issues.push({ kind, count: coverage[field] });
  if (coverage.reviewedDocumentCount < coverage.requestedReviewDocumentCount)
    issues.push({
      kind: "requested-reviews",
      completed: coverage.reviewedDocumentCount,
      requested: coverage.requestedReviewDocumentCount,
    });
  return issues;
}

function isCanonicalReviewFailure(result: ChatToolExchange["result"]): boolean {
  return (
    result?.toolRef?.canonicalId === "keiko.knowledge.review" &&
    result.toolRef.contractVersion === 2 &&
    result.status === "failed" &&
    result.reason === "provider-reported-error"
  );
}

/** Only the canonical v2 provider error can attest that its source was read before refusal. */
function reviewFailureReceipt(
  exchange: ChatToolExchange,
  data: Readonly<Record<string, unknown>>,
): object {
  if (
    !isCanonicalReviewFailure(exchange.result) ||
    data.outcome !== "failed" ||
    data.sourceAvailable !== true ||
    data.reason !== data.failureStage
  )
    return {};
  const stage = KNOWLEDGE_REVIEW_FAILURE_STAGES.find(
    (candidate) => candidate === data.failureStage,
  );
  const reason = KNOWLEDGE_REVIEW_VALIDATION_REASONS.find(
    (candidate) => candidate === data.validationReason,
  );
  if (stage === undefined || (data.validationReason !== undefined && reason === undefined))
    return {};
  return {
    failureStage: stage,
    sourceAvailable: true,
    ...(reason === undefined ? {} : { validationReason: reason }),
  };
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
        ...reviewFailureReceipt(exchange, data),
      };
}
