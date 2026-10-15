import { groupConnectedContextOmissions } from "@oscharko-dev/keiko-contracts/bff-wire";
import { CANDIDATE_OMISSION_REASONS } from "@oscharko-dev/keiko-contracts/connected-context";
import type { GroundedAnswerContextPackSummary } from "@/lib/types";
import type { OptionalWidgetTranslate, WidgetMessageKey } from "@/lib/optional-widget-i18n";

const OMISSION_LABEL_KEYS: ReadonlyMap<string, WidgetMessageKey> = new Map([
  ["outside-scope", "grounded.omission.outside-scope"],
  ["binary", "grounded.omission.binary"],
  ["generated", "grounded.omission.generated"],
  ["ignored", "grounded.omission.ignored"],
  ["size-exceeded", "grounded.omission.size-exceeded"],
  ["near-duplicate", "grounded.omission.near-duplicate"],
  ["low-relevance", "grounded.omission.low-relevance"],
  ["redacted-only", "grounded.omission.redacted-only"],
  ["budget-exhausted", "grounded.omission.budget-exhausted"],
  ["tool-unavailable", "grounded.omission.tool-unavailable"],
  ["unsupported-format", "grounded.omission.unsupported-format"],
  ["no-text-layer", "grounded.omission.no-text-layer"],
  ["malformed-document", "grounded.omission.malformed-document"],
  ["encrypted-document", "grounded.omission.encrypted-document"],
]);

export function connectedOmissionLabel(reason: string, t: OptionalWidgetTranslate): string {
  const key = OMISSION_LABEL_KEYS.get(reason);
  return key === undefined ? reason.replaceAll("-", " ") : t(key);
}

export function connectedPromptEvidenceSummary(
  pack: GroundedAnswerContextPackSummary,
  citations: number,
  t: OptionalWidgetTranslate,
): string {
  const omitted = groupConnectedContextOmissions(pack.omittedCounts);
  return t(citations === 1 ? "grounded.promptCounters.one" : "grounded.promptCounters.other", {
    citations,
    inPrompt: pack.filesInPrompt ?? t("grounded.promptCounters.unrecorded"),
    ranking: omitted.ranking,
    eligibility: omitted.eligibility,
  });
}

export function connectedOmissionTooltip(
  pack: GroundedAnswerContextPackSummary,
  t: OptionalWidgetTranslate,
): string {
  return CANDIDATE_OMISSION_REASONS.map(
    (reason) => `${connectedOmissionLabel(reason, t)}: ${String(pack.omittedCounts[reason])}`,
  ).join(" · ");
}

const INACTIVE_RERANKER = new Set(["disabled", "applied"]);
const SCOPE_CONTEXT_NOTICES: Record<
  NonNullable<GroundedAnswerContextPackSummary["scopeContextState"]>,
  WidgetMessageKey
> = {
  applied: "grounded.retrieval.scopeApplied",
  overflow: "grounded.retrieval.scopeOverflow",
  "gate-refused": "grounded.retrieval.scopeRefused",
  "incomplete-traversal": "grounded.retrieval.scopeIncomplete",
};

export function connectedRetrievalNotices(
  pack: GroundedAnswerContextPackSummary,
  t: OptionalWidgetTranslate,
): readonly string[] {
  const notices: string[] = [];
  if (pack.semanticProviderDisposition === "used") notices.push(t("grounded.retrieval.semantic"));
  else if (
    pack.semanticProviderDisposition !== undefined &&
    pack.semanticProviderDisposition !== "not-evaluated"
  )
    notices.push(t("grounded.retrieval.lexical"));
  if (pack.reranker !== undefined && !INACTIVE_RERANKER.has(pack.reranker.status))
    notices.push(t("grounded.retrieval.reranker"));
  if (pack.scopeContextState !== undefined)
    notices.push(t(SCOPE_CONTEXT_NOTICES[pack.scopeContextState]));
  if (pack.selectionConfidence === "low") notices.push(t("grounded.retrieval.lowConfidence"));
  return notices;
}
