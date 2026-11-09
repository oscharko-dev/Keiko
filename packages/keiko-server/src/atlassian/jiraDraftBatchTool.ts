import { randomBytes } from "node:crypto";
import {
  executeJiraDraftStageTool,
  readJiraCreateTemplateRules,
  resolveJiraDraftPlacement,
  type JiraCreateTemplateRules,
  type JiraDraftPlacement,
  type StagedJiraDraft,
  type JiraDraftBatchExecutor,
  type JiraDraftToolDeps,
  type JiraManagedConnection,
} from "@oscharko-dev/keiko-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  countJiraTemplateViolations,
  JIRA_TEMPLATE_RULE_IDS,
  type JiraTemplateRuleId,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { requirementReference } from "@oscharko-dev/keiko-quality-intelligence";
import type { UiHandlerDeps } from "../deps.js";
import { openKnowledgeStoreForDeps } from "../local-knowledge-store-open.js";
import {
  type RequirementCollection,
  chatKnowledgeScopes,
  collectForTurn,
  contentRedact,
  selectUnits,
} from "../requirement-inventory.js";
import { requireDispatch } from "../tool-catalog/catalogToolErrors.js";
import type { CatalogHandlerContext } from "../tool-catalog/catalogToolPorts.js";
import type { JiraChatCatalogConsumer } from "./jiraChatCatalogConsumer.js";
import {
  runJiraDraftBatch,
  type DraftBatchInput,
  type DraftBatchObservation,
  type DraftBatchPorts,
  type DraftBatchResult,
  type DraftBatchStageOutcome,
} from "./jiraDraftBatch.js";
import {
  recordJiraDraftBatchActivity,
  type JiraDraftBatchActivity,
  type JiraDraftBatchRefusal,
} from "./jiraDraftBatchActivity.js";
import {
  parseJiraDraftBatchArguments,
  type JiraDraftBatchArguments,
} from "./jiraDraftBatchArguments.js";
import { JIRA_DRAFT_BATCH_FAILED_REFS_MAX } from "./jiraDraftBatchDescriptor.js";
import { createBatchModel, type BatchModel } from "./jiraDraftBatchModel.js";
import type { DraftBatchRequirement } from "./jiraDraftBatchPrompt.js";

export type JiraDraftBatchContext = CatalogHandlerContext<JiraChatCatalogConsumer>;

const TITLE_CHARS_MAX = 200;
const SECTION_CHARS_MAX = 300;
/** One requirement's text in a page prompt; a small model must fit several in one window. */
const REQUIREMENT_TEXT_CHARS_MAX = 1500;
const RULES_CHARS_MAX = 3000;
const REJECTION_CHARS_MAX = 2000;
const REF_PREFIX_HEAD = "b";

function refused(
  refusal: JiraDraftBatchRefusal,
  guidance?: string,
  facts: CatalogJsonObject = {},
): ManagedMcpToolResult {
  return {
    isError: true,
    data: {
      outcome: refusal === "invalid-input" ? "rejected" : "failed",
      reason: refusal,
      ...(guidance === undefined ? {} : { guidance }),
      ...facts,
    },
  };
}

const REFUSAL_GUIDANCE: Partial<Record<JiraDraftBatchRefusal, string>> = {
  "invalid-input":
    "Send projectId (project key such as KER, or numeric id; letters, digits and underscore only), granularity, and create; issueTypeId (name or id) is optional.",
  "project-not-found":
    "Jira has no project with that key or id that this connection can read. Ask the user for the project key and call again.",
  "draft-unavailable":
    "That draft no longer exists (drafts expire when idle). Call again without draftId and with the same requirements filter as the call that started it: the requirements drafted before existed only in that draft, so the whole selection is drafted again.",
  "draft-mismatch":
    "That draft was started in another project or issue type. Use the same projectId and issueTypeId as before, or call without draftId to start a new draft.",
  "no-usable-issue-type":
    "This project offers no issue type for drafting (only subtask types). Tell the user and ask for another project.",
  "issue-type-not-found":
    "The project has no such issue type. Call again with one of availableIssueTypes, or omit issueTypeId.",
  "no-knowledge-pod":
    "This Chat has no Knowledge Pod with requirements. Ask the user to attach the Pod with the requirement document.",
  "requirements-cut":
    "The Knowledge Pods hold more requirements than Keiko can list at once. Narrow the batch with requirements.documents, ids, priorities or query.",
  "no-requirements":
    "No requirement matches the requirements filter. Call again and omit requirements to draft all of them.",
};

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

type Collected =
  | {
      readonly ok: true;
      readonly requirements: readonly DraftBatchRequirement[];
      readonly cut: boolean;
      /** References that more than one requirement carried; only the first was kept. */
      readonly duplicateRefs: readonly string[];
      /** The selection holds every requirement of the Pods' uncut collection, filtered or not. */
      readonly wholeCollection: boolean;
      /** Requirements the cut collection did not list; a filter cannot prove them unselected. */
      readonly omittedCount: number;
      /** The filter provably saw every requirement it could select. */
      readonly selectionComplete: boolean;
    }
  | {
      readonly ok: false;
      readonly refusal: JiraDraftBatchRefusal;
      /** Model-facing facts that let one retry succeed; counts and scope ids only. */
      readonly facts?: CatalogJsonObject;
    };

/** Document scopes a refusal names to the model. */
const SCOPES_NAMED_MAX = 20;

/** What the Pod holds without the model's filter, so a filter that matched nothing can be fixed. */
function unfilteredFacts(
  units: Parameters<typeof selectUnits>[0],
  guidance: string,
): CatalogJsonObject {
  const scopes = [...new Set(units.map(({ entry }) => entry.documentScope))];
  return {
    availableRequirementCount: units.length,
    availableDocuments: scopes.slice(0, SCOPES_NAMED_MAX),
    guidance,
  };
}

/** The selected requirements as the model reads them, redacted under the Chat content policy. */
function selectedRequirements(
  units: Parameters<typeof selectUnits>[0],
  args: JiraDraftBatchArguments,
  redact: (value: string) => string,
  drafted: ReadonlySet<string>,
): {
  readonly requirements: readonly DraftBatchRequirement[];
  readonly duplicateRefs: string[];
  /** Selected requirements the continued draft already holds; a re-run never drafts them twice. */
  readonly alreadyDrafted: number;
  /** Every requirement the filter selected, duplicates and already drafted ones included. */
  readonly selectedCount: number;
  /** Documents that share a selected requirement ID, when no documents filter chose one. */
  readonly ambiguousDocuments: readonly string[];
} {
  let alreadyDrafted = 0;
  const byRef = new Map<string, DraftBatchRequirement>();
  const duplicateRefs = new Set<string>();
  const selectedUnits = selectUnits(units, args.filter, redact);
  const ambiguousDocuments =
    args.filter.documents === undefined ? sharedIdDocuments(selectedUnits) : [];
  for (const { entry } of selectedUnits) {
    const ref = requirementReference(entry);
    if (drafted.has(ref)) {
      alreadyDrafted += 1;
      continue;
    }
    if (byRef.has(ref)) {
      duplicateRefs.add(ref);
      continue;
    }
    byRef.set(ref, {
      ref,
      title: clip(redact(entry.title), TITLE_CHARS_MAX),
      section: clip(entry.sectionPath.map((part) => redact(part)).join(" > "), SECTION_CHARS_MAX),
      text: clip(redact(entry.statement), REQUIREMENT_TEXT_CHARS_MAX),
      criteria: entry.acceptanceCriteria.map((item) => redact(item.text)),
    });
  }
  return {
    requirements: [...byRef.values()],
    duplicateRefs: [...duplicateRefs],
    alreadyDrafted,
    selectedCount: selectedUnits.length,
    ambiguousDocuments,
  };
}

/**
 * The documents that hold one requirement ID more than once among the selection, such as the same
 * requirements document as Markdown, DOCX and PDF. Drafting all of them would create every issue
 * once per document, so the documents filter has to choose (#4288).
 */
function sharedIdDocuments(selected: Parameters<typeof selectUnits>[0]): readonly string[] {
  const scopesById = new Map<string, Set<string>>();
  for (const { entry } of selected) {
    const scopes = scopesById.get(entry.id) ?? new Set<string>();
    scopes.add(entry.documentScope);
    scopesById.set(entry.id, scopes);
  }
  const shared = new Set<string>();
  for (const scopes of scopesById.values()) {
    if (scopes.size < 2) continue;
    for (const scope of scopes) shared.add(scope);
  }
  return [...shared].sort(compareText);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function ambiguousRequirements(documents: readonly string[], count: number): Collected {
  return {
    ok: false,
    refusal: "requirements-ambiguous",
    facts: {
      availableRequirementCount: count,
      availableDocuments: documents.slice(0, SCOPES_NAMED_MAX),
      guidance:
        "The same requirement IDs appear in several of availableDocuments, for example one requirements document in several formats. Call again with requirements.documents naming the one document to draft from, keeping the other filters; name several documents only when they hold different requirements.",
    },
  };
}

function noRequirements(
  count: number,
  units: Parameters<typeof selectUnits>[0],
  args: JiraDraftBatchArguments,
  alreadyDrafted: number,
): Collected {
  let guidance = REFUSAL_GUIDANCE["no-requirements"] ?? "";
  if (alreadyDrafted > 0)
    guidance =
      "Every selected requirement is already in this draft. Tell the user the draft is complete.";
  else if (args.filtered && count > 0)
    guidance = `No requirement matched the requirements filter. Omit requirements to draft all ${String(count)}.`;
  return { ok: false, refusal: "no-requirements", facts: unfilteredFacts(units, guidance) };
}

/** A cut collection proves a selection only for documents it read in full. */
function selectionProven(
  collection: RequirementCollection,
  args: JiraDraftBatchArguments,
): boolean {
  if (collection.cutReasons.length === 0 && collection.unitsOmitted === 0) return true;
  const named = args.filter.documents;
  if (named === undefined) return false;
  if (
    collection.cutReasons.some(
      (reason) => reason === "document-bound" || reason === "scope-refused",
    )
  )
    return false;
  return named.every((scope) =>
    collection.documents.some(
      (document) => document.documentScope === scope && document.unitsOmitted === 0,
    ),
  );
}

function collectRequirements(
  deps: UiHandlerDeps,
  context: JiraDraftBatchContext,
  args: JiraDraftBatchArguments,
  drafted: ReadonlySet<string>,
): Collected {
  const scopes = chatKnowledgeScopes(deps.store.findChatById(context.chatId));
  if (scopes.length === 0) return { ok: false, refusal: "no-knowledge-pod" };
  requireDispatch(context.beforeEffect(), "denied", "effect-denied");
  const session = openKnowledgeStoreForDeps(deps, { recover: false });
  try {
    const collection = collectForTurn(session.store, scopes, context.chatId, context.userMessageId);
    if (collection.units.length === 0 && collection.refusals.length > 0)
      return { ok: false, refusal: "scope-unavailable" };
    const cut = collection.cutReasons.length > 0 || collection.unitsOmitted > 0;
    if (cut && !args.filtered) return { ok: false, refusal: "requirements-cut" };
    const selected = selectedRequirements(collection.units, args, contentRedact(deps), drafted);
    if (selected.ambiguousDocuments.length > 0)
      return ambiguousRequirements(selected.ambiguousDocuments, selected.selectedCount);
    if (selected.requirements.length > 0)
      return {
        ok: true,
        cut,
        requirements: selected.requirements,
        duplicateRefs: selected.duplicateRefs,
        // A filter naming every document of the Pod still drafts the whole collection (#4292).
        wholeCollection: !cut && selected.selectedCount === collection.units.length,
        omittedCount: collection.unitsOmitted,
        selectionComplete: selectionProven(collection, args),
      };
    return noRequirements(collection.units.length, collection.units, args, selected.alreadyDrafted);
  } finally {
    session.close();
  }
}

/**
 * The rules the model is told: compact JSON, and when they run long whole templates are dropped
 * from the end, never cut inside one, so the model always reads valid JSON.
 */
export function rulesText(rules: JiraCreateTemplateRules): string {
  if (rules.facts.length === 0) return "{}";
  const all = JSON.stringify(rules.facts);
  if (all.length <= RULES_CHARS_MAX) return all;
  const kept: unknown[] = [];
  for (const fact of rules.facts) {
    if (JSON.stringify([...kept, fact]).length > RULES_CHARS_MAX) break;
    kept.push(fact);
  }
  if (kept.length > 0) return JSON.stringify(kept);
  const first = JSON.stringify(rules.facts.slice(0, 1));
  return first.length <= RULES_CHARS_MAX * 3 ? first : "{}";
}

/** Reasons after which staging the same page again cannot succeed. */
const PERMANENT_STAGE_REASONS: ReadonlySet<string> = new Set([
  "unsupported-deployment",
  "draft-not-found",
  "draft-changed",
  "draft-invalid",
  "connection-changed",
  "duplicate-ref",
  "too-large",
  "invalid-input",
  "effect-denied",
]);
/** Template rules about what only Keiko sets: labels, parent and the template itself. */
const KEIKO_RULE_IDS: ReadonlySet<string> = new Set([
  "label-missing",
  "label-pattern",
  "label-count",
  "parent-missing",
  "template-unreadable",
  "field-unavailable",
]);
const KEIKO_FIELD_IDS: ReadonlySet<string> = new Set([
  "labels",
  "parent",
  "project",
  "issuetype",
  "issuelinks",
]);

/** Who can correct a refusal: Keiko-owned content never improves with a new model answer. */
function rejectionOwner(data: CatalogJsonObject): "keiko" | "model" {
  if (data.requirementRefusal !== undefined || data.requirementProblems !== undefined)
    return "keiko";
  if (data.reason === "invalid-input") return "keiko";
  if (typeof data.fieldId === "string" && KEIKO_FIELD_IDS.has(data.fieldId)) return "keiko";
  const violations = Array.isArray(data.violations) ? (data.violations as unknown[]) : [];
  const keiko = violations.some(
    (violation) =>
      typeof violation === "object" &&
      violation !== null &&
      KEIKO_RULE_IDS.has(String((violation as { ruleId?: unknown }).ruleId)),
  );
  return keiko ? "keiko" : "model";
}

/** What one staged page came to, in the words the batch engine acts on. */
function stageOutcome(result: ManagedMcpToolResult): DraftBatchStageOutcome {
  const { data } = result;
  const { draftId, draftDigest, itemCount, pageCount } = data;
  if (
    data.outcome === "succeeded" &&
    typeof draftId === "string" &&
    typeof draftDigest === "string" &&
    typeof itemCount === "number" &&
    typeof pageCount === "number"
  )
    return { kind: "staged", draftId, draftDigest, itemCount, pageCount };
  if (data.outcome === "rejected" || data.reason === "invalid-input")
    return {
      kind: "rejected",
      guidance: rejectionGuidance(data),
      owner: rejectionOwner(data),
      violationRuleCounts: rejectionRuleCounts(data),
    };
  const reason = typeof data.reason === "string" ? data.reason : "stage-failed";
  return { kind: "fatal", reason, transient: !PERMANENT_STAGE_REASONS.has(reason) };
}

function rejectionRuleCounts(
  data: CatalogJsonObject,
): Partial<Readonly<Record<JiraTemplateRuleId, number>>> {
  const violations: { readonly ruleId: JiraTemplateRuleId }[] = [];
  const candidates: readonly unknown[] = Array.isArray(data.violations) ? data.violations : [];
  for (const violation of candidates) {
    if (
      violation === null ||
      typeof violation !== "object" ||
      Array.isArray(violation) ||
      !("ruleId" in violation)
    )
      continue;
    const ruleId = JIRA_TEMPLATE_RULE_IDS.find((candidate) => candidate === violation.ruleId);
    if (ruleId !== undefined) violations.push({ ruleId });
  }
  return countJiraTemplateViolations(violations);
}

const REJECTION_KEYS = [
  "ref",
  "violations",
  "fieldId",
  "validation",
  "messages",
  "requirementRefusal",
  "requirementProblems",
] as const;

function rejectionGuidance(data: CatalogJsonObject): string {
  const facts: Record<string, unknown> = {};
  for (const key of REJECTION_KEYS) if (data[key] !== undefined) facts[key] = data[key];
  const guidance = typeof data.guidance === "string" ? data.guidance : "";
  return clip(`${guidance} ${JSON.stringify(facts)}`.trim(), REJECTION_CHARS_MAX);
}

interface BatchRun {
  readonly deps: UiHandlerDeps;
  readonly context: JiraDraftBatchContext;
  readonly args: JiraDraftBatchArguments;
  readonly startedAt: number;
  /** Set by the stage port when the draft itself cannot continue; cleared by a staged page. */
  fatalReason?: string | undefined;
  /** References more than one requirement carried: only the first was drafted, all are reported. */
  duplicateRefs: readonly string[];
  /** The selection held every requirement of the Pods' uncut collection. */
  wholeCollection: boolean;
  /** The filter provably saw every requirement it could select. */
  selectionComplete: boolean;
  /** Requirements a cut collection did not list. */
  omittedCount: number;
}

function record(run: BatchRun, activity: JiraDraftBatchActivity): void {
  recordJiraDraftBatchActivity(run.deps.activityLog, run.context.correlationId, activity);
}

function observation(run: BatchRun, observed: DraftBatchObservation): void {
  if (observed.kind === "outline")
    record(run, {
      phase: "outline",
      outcome: observed.outcome,
      requirementCount: observed.requirementCount,
      groupCount: observed.groupCount,
    });
  else
    record(run, {
      phase: "page",
      outcome: observed.outcome,
      pageItemCount: observed.itemCount,
      plannedItemTokens: observed.plannedItemTokens,
      ...(observed.completionTokens === undefined
        ? {}
        : { completionTokens: observed.completionTokens }),
      ...(observed.parseAttemptCount === undefined
        ? {}
        : { parseAttemptCount: observed.parseAttemptCount }),
      ...(observed.stageAttemptCount === undefined
        ? {}
        : { stageAttemptCount: observed.stageAttemptCount }),
      ...(observed.guidanceDigest === undefined ? {} : { guidanceDigest: observed.guidanceDigest }),
      ...(observed.violationRuleCounts === undefined
        ? {}
        : { violationRuleCounts: observed.violationRuleCounts }),
    });
}

async function stagePage(
  run: BatchRun,
  connection: JiraManagedConnection,
  draft: JiraDraftToolDeps<JiraDraftBatchContext>,
  items: readonly CatalogJsonObject[],
  draftId: string | undefined,
): Promise<DraftBatchStageOutcome> {
  run.context.signal.throwIfAborted();
  const page = { ...(draftId === undefined ? {} : { draftId }), items } as CatalogJsonObject;
  // The pages carry the requirement document's own text, so Keiko's verbatim criteria keep the
  // document's `[n]` markers; the outer Chat's citation namespace never rewrites them (F17).
  const batchContext: JiraDraftBatchContext = { ...run.context, citationSources: undefined };
  const outcome = stageOutcome(
    await executeJiraDraftStageTool(page, batchContext, connection, draft),
  );
  run.fatalReason = outcome.kind === "fatal" ? outcome.reason : undefined;
  return outcome;
}

function resultGuidance(run: BatchRun, result: DraftBatchResult, failedCount: number): string {
  const { args } = run;
  const drafted = result.progress.draftedCount;
  if (failedCount > 0) return partialGuidance(run, result, drafted);
  if (!run.selectionComplete)
    return `The draft holds the ${String(drafted)} requirements Keiko could list, but ${String(run.omittedCount)} requirements were not listed, so the requirements filter may have missed some. Tell the user; Keiko does not offer to create the issues. Narrow requirements.documents to whole documents and draft again.`;
  return completeGuidance(args.create);
}

function completeGuidance(create: boolean): string {
  return create
    ? "The draft is complete. Keiko now asks the user to approve creating the issues in Jira; do not call jira.draft. Tell the user how many issues were drafted from how many requirements."
    : "The draft is complete and saved for review. Tell the user how many issues were drafted from how many requirements, and that nothing was created in Jira.";
}

/** The one unambiguous way to continue: the same call again, with the same draft. */
function deadlineGuidance(result: DraftBatchResult, drafted: number): string {
  return [
    `Time ran out: ${String(drafted)} of ${String(result.progress.plannedCount)} issues are drafted and saved; ${String(remainingCount(result))} requirements are not drafted yet.`,
    "Tell the user, then call jira_draft_batch again now with the same draftId and the same requirements filter as before (requirements already in the draft are skipped); Keiko offers the approval once the whole draft is complete.",
    "If the draft is gone, call without draftId and with requirements.documents, ids, priorities and query set to selectionDocuments, selectionIds, selectionPriorities and selectionQuery (omit each one absent here): the requirements drafted so far existed only in that draft, so the whole selection is drafted again. Never start a new draft with only the requirements that were not drafted yet.",
  ].join(" ");
}

function partialGuidance(run: BatchRun, result: DraftBatchResult, drafted: number): string {
  if (result.stopReason === "stage-rejection-unchanged")
    return `${String(drafted)} of ${String(result.progress.plannedCount)} issues are drafted and saved. The corrected page received the same stage refusal again, so Keiko stopped without splitting it further. Report failedRequirementRefs and review the refused content and applicable rules before another attempt.`;
  const notes = [
    result.stopReason === "deadline"
      ? deadlineGuidance(result, drafted)
      : `${String(drafted)} of ${String(result.progress.plannedCount)} issues are drafted. Report failedRequirementRefs to the user and offer to retry them with requirements.ids and the same draftId.`,
    result.stopReason === "model-failed"
      ? "The model failed part-way; the issues drafted before are saved."
      : "",
    result.tooLargeCount > 0
      ? `${String(result.tooLargeCount)} issues have acceptance criteria too long for one Jira description; suggest splitting those requirements.`
      : "",
    run.duplicateRefs.length > 0
      ? `${String(run.duplicateRefs.length)} requirements share a reference with another one and were not drafted; they are listed in failedRequirementRefs.`
      : "",
  ];
  return notes.filter((note) => note !== "").join(" ");
}

function remainingCount(result: DraftBatchResult): number {
  return result.deferredRequirementRefs.length;
}

function failedRefs(run: BatchRun, result: DraftBatchResult): readonly string[] {
  return [...new Set([...run.duplicateRefs, ...result.failedRequirementRefs])];
}

/** A new draft whose selection held the Pods' whole requirement collection (#4292). */
function readWholeCollection(run: BatchRun): boolean {
  return run.wholeCollection && run.args.draftId === undefined;
}

/** Facts that keep an incomplete selection from reading as a clean batch. */
function selectionFacts(run: BatchRun): CatalogJsonObject {
  return {
    ...(run.selectionComplete
      ? {}
      : { selectionIncomplete: true, omittedRequirementCount: run.omittedCount }),
  };
}

/**
 * The requirements filter of the call, so a paused draft that is lost can be drafted again in
 * full from the result alone; no recovery state is kept between calls (F27, F33).
 */
function originalRequirements(args: JiraDraftBatchArguments): CatalogJsonObject {
  const { documents, ids, priorities, query } = args.filter;
  return {
    ...(documents === undefined ? {} : { selectionDocuments: [...documents] }),
    ...(ids === undefined ? {} : { selectionIds: [...ids] }),
    ...(priorities === undefined ? {} : { selectionPriorities: [...priorities] }),
    ...(query === undefined ? {} : { selectionQuery: query }),
  };
}

function resultReason(
  succeeded: boolean,
  result: DraftBatchResult,
  fatal: string | undefined,
): CatalogJsonObject {
  if (succeeded && result.stopReason !== "stage-rejection-unchanged") return {};
  return { reason: fatal ?? result.stopReason ?? "nothing-drafted" };
}

function resultData(run: BatchRun, result: DraftBatchResult): CatalogJsonObject {
  const { progress } = result;
  const failedCount =
    Math.max(0, progress.plannedCount - progress.draftedCount) + run.duplicateRefs.length;
  const succeeded = progress.draftedCount > 0 && result.draftId !== undefined;
  const fatal = run.fatalReason;
  return {
    outcome: succeeded ? "succeeded" : "failed",
    ...resultReason(succeeded, result, fatal),
    ...(result.draftId === undefined ? {} : { draftId: result.draftId }),
    ...(result.draftDigest === undefined ? {} : { draftDigest: result.draftDigest }),
    newDraft: run.args.draftId === undefined,
    itemCount: result.itemCount,
    pageCount: result.pageCount,
    unresolvedRefCount: 0,
    unresolvedRefs: [],
    plannedCount: progress.plannedCount,
    draftedCount: progress.draftedCount,
    failedCount,
    requirementCount: progress.requirementCount + run.duplicateRefs.length,
    coveredRequirementCount: progress.coveredRequirementCount,
    wholeCollection: readWholeCollection(run),
    ...selectionFacts(run),
    failedRequirementRefs: failedRefs(run, result).slice(0, JIRA_DRAFT_BATCH_FAILED_REFS_MAX),
    createRequested: run.args.create,
    ...(result.stopReason === "deadline"
      ? {
          paused: true,
          remainingCount: remainingCount(result),
          ...originalRequirements(run.args),
        }
      : {}),
    guidance: succeeded ? resultGuidance(run, result, failedCount) : failureGuidance(result, fatal),
  };
}

function failureGuidance(result: DraftBatchResult, fatal: string | undefined): string {
  if (result.stopReason === "stage-rejection-unchanged")
    return "The corrected page received the same stage refusal again. Nothing was drafted; Keiko stopped without splitting it further. Report the refusal and review the content and applicable rules before another attempt.";
  if (fatal === "too-large")
    return "The backlog is larger than one draft can hold. Tell the user the items already written are saved and offer to draft the rest as a second batch with fewer requirements.";
  if (result.stopReason === "deadline")
    return "Time ran out before anything could be drafted. Tell the user in plain language that nothing was created and offer to try again.";
  if (result.stopReason === "model-failed")
    return "The model failed before anything could be drafted. Tell the user in plain language that nothing was created and offer to try again.";
  return "Nothing was drafted. Tell the user in plain language and offer to retry with fewer requirements.";
}

function completedOutcome(
  data: CatalogJsonObject,
  failedCount: number,
): "failed" | "partial" | "succeeded" {
  if (data.outcome === "failed") return "failed";
  return failedCount > 0 ? "partial" : "succeeded";
}

function completionActivity(
  run: BatchRun,
  result: DraftBatchResult,
  data: CatalogJsonObject,
): JiraDraftBatchActivity {
  const failedCount = Number(data.failedCount);
  const stop = result.stopReason;
  return {
    phase: "completed",
    outcome: completedOutcome(data, failedCount),
    ...(stop === undefined || stop === "no-requirements" ? {} : { stopReason: stop }),
    ...(result.error === undefined ? {} : { error: result.error }),
    granularity: run.args.granularity,
    requirementCount: Number(data.requirementCount),
    plannedCount: result.progress.plannedCount,
    draftedCount: result.progress.draftedCount,
    failedCount,
    itemCount: result.itemCount,
    createRequested: run.args.create,
    durationMs: Date.now() - run.startedAt,
  };
}

function refusalResult(
  run: BatchRun,
  refusal: JiraDraftBatchRefusal,
  facts: CatalogJsonObject = {},
): ManagedMcpToolResult {
  const available = facts.availableRequirementCount;
  record(run, {
    phase: "refused",
    refusal,
    granularity: run.args.granularity,
    ...(typeof available === "number" ? { requirementCount: available } : {}),
    createRequested: run.args.create,
    durationMs: Date.now() - run.startedAt,
  });
  return refused(refusal, REFUSAL_GUIDANCE[refusal], facts);
}

/** The draft a resumed batch continues, only for the Chat that started it. */
function continuedDraft(
  draft: JiraDraftToolDeps<JiraDraftBatchContext>,
  context: JiraDraftBatchContext,
  args: JiraDraftBatchArguments,
): StagedJiraDraft | undefined {
  return args.draftId === undefined
    ? undefined
    : draft.store.peek(args.draftId, draft.owner(context));
}

/** Requirements a continued draft already holds, so a resumed batch drafts only the rest. */
function draftedRefs(current: StagedJiraDraft | undefined): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const item of current?.items ?? [])
    if (Array.isArray(item.requirementIds))
      for (const ref of item.requirementIds as unknown[])
        if (typeof ref === "string") refs.add(ref);
  return refs;
}

/** A resumed batch writes into the draft's own project and issue type, never another. */
function placementMatches(
  current: StagedJiraDraft | undefined,
  placement: JiraDraftPlacement,
): boolean {
  const first = current?.items[0];
  return (
    first === undefined ||
    (first.projectId === placement.projectId && first.issueTypeId === placement.issueTypeId)
  );
}

/** The project and issue type as numeric ids, or the refusal that tells the model how to retry. */
async function resolvePlacement(
  run: BatchRun,
  connection: JiraManagedConnection,
): Promise<JiraDraftPlacement | ManagedMcpToolResult> {
  const { args, context } = run;
  const placement = await resolveJiraDraftPlacement(
    context,
    connection,
    args.projectId,
    args.issueTypeId,
  );
  if (placement.ok) return placement;
  if (placement.reason === "project-not-found") return refusalResult(run, "project-not-found");
  if (placement.reason === "no-usable-issue-type")
    return refusalResult(run, "no-usable-issue-type");
  if (placement.reason === "issue-type-not-found")
    return refusalResult(run, "issue-type-not-found", {
      availableIssueTypes: [...(placement.issueTypeNames ?? [])],
    });
  return refusalResult(run, "template-unavailable");
}

function batchInput(
  args: JiraDraftBatchArguments,
  placement: JiraDraftPlacement,
  requirements: readonly DraftBatchRequirement[],
  rules: JiraCreateTemplateRules,
  model: BatchModel,
): DraftBatchInput {
  return {
    requirements,
    granularity: args.granularity,
    instructions: {
      grouping: args.grouping,
      guidance: args.guidance,
      rules: rulesText(rules),
      requiredSections: rules.requiredSections,
      requiredFields: rules.requiredFields,
      requiredFieldNames: rules.requiredFieldNames,
    },
    placement: {
      projectId: placement.projectId,
      issueTypeId: placement.issueTypeId,
      requiredLabels: rules.requiredLabels,
      parent: args.parent,
    },
    maxOutputTokens: model.maxOutputTokens,
    maxInputTokens: model.maxInputTokens,
    refPrefix: `${REF_PREFIX_HEAD}${randomBytes(3).toString("hex")}`,
    draftId: args.draftId,
  };
}

function batchPorts(
  run: BatchRun,
  connection: JiraManagedConnection,
  draft: JiraDraftToolDeps<JiraDraftBatchContext>,
  model: BatchModel,
): DraftBatchPorts {
  const { context } = run;
  return {
    generate: model.generate,
    stage: (items, draftId) => stagePage(run, connection, draft, items, draftId),
    progress: (progress): void => {
      context.reportBatchProgress?.(progress);
    },
    observe: (observed): void => {
      observation(run, observed);
    },
    signal: context.signal,
    budget: context.mutationGuard.executionBudget,
    remainingCalls: context.remainingModelCalls,
  };
}

async function runBatch(
  run: BatchRun,
  connection: JiraManagedConnection,
  draft: JiraDraftToolDeps<JiraDraftBatchContext>,
): Promise<ManagedMcpToolResult> {
  const { deps, context, args } = run;
  const current = continuedDraft(draft, context, args);
  if (args.draftId !== undefined && current === undefined)
    return refusalResult(run, "draft-unavailable");
  requireDispatch(context.beforeEffect(), "denied", "effect-denied");
  const placement = await resolvePlacement(run, connection);
  if ("data" in placement) return placement;
  if (!placementMatches(current, placement)) return refusalResult(run, "draft-mismatch");
  const collected = collectRequirements(deps, context, args, draftedRefs(current));
  if (!collected.ok) return refusalResult(run, collected.refusal, collected.facts);
  run.duplicateRefs = collected.duplicateRefs;
  run.wholeCollection = collected.wholeCollection;
  run.selectionComplete = collected.selectionComplete;
  run.omittedCount = collected.omittedCount;
  const model = createBatchModel(deps, context);
  if (typeof model === "string") return refusalResult(run, model);
  const rules = await readJiraCreateTemplateRules(
    context,
    connection,
    placement.projectId,
    placement.issueTypeId,
  );
  if (!rules.ok) return refusalResult(run, "template-unavailable");
  record(run, {
    phase: "started",
    granularity: args.granularity,
    requirementCount: collected.requirements.length,
    createRequested: args.create,
  });
  const ports = batchPorts(run, connection, draft, model);
  const result = await runJiraDraftBatch(
    batchInput(args, placement, collected.requirements, rules, model),
    ports,
  );
  const data = resultData(run, result);
  record(run, completionActivity(run, result, data));
  return { data, ...(data.outcome === "failed" ? { isError: true } : {}) };
}

/** `jira.draft-batch`: Keiko drives the whole draft; the model only writes the text of each page. */
export function createJiraDraftBatchExecutor(
  deps: UiHandlerDeps,
  draft: JiraDraftToolDeps<JiraDraftBatchContext>,
): JiraDraftBatchExecutor<JiraDraftBatchContext> {
  return async (rawArgs, context, connection) => {
    const startedAt = Date.now();
    const args = parseJiraDraftBatchArguments(rawArgs);
    if (args === undefined) {
      recordJiraDraftBatchActivity(deps.activityLog, context.correlationId, {
        phase: "refused",
        refusal: "invalid-input",
        durationMs: Date.now() - startedAt,
      });
      return refused("invalid-input", REFUSAL_GUIDANCE["invalid-input"]);
    }
    const run: BatchRun = {
      deps,
      context,
      args,
      startedAt,
      duplicateRefs: [],
      wholeCollection: false,
      selectionComplete: true,
      omittedCount: 0,
    };
    if (connection.deployment !== "data-center")
      return refusalResult(run, "unsupported-deployment");
    try {
      return await runBatch(run, connection, draft);
    } catch (error) {
      // A started batch always ends in one terminal line: a stop by the person is a closed
      // cancellation, anything else carries its frames and cause chain.
      record(run, {
        phase: "failed",
        granularity: args.granularity,
        ...(context.signal.aborted ? { stopReason: "cancelled" as const } : { error }),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  };
}
