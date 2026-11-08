// Source trace of Jira items created or edited from requirements (#4179, Epic #4173).
//
// An item names the requirements it derives from in an explicit `requirementIds` argument. The
// references are validated against the units the Chat's Knowledge Pods hold; an unknown or
// ambiguous reference refuses the write before anything is sent. References are never inferred
// from summary, labels or description. When supplied, the description is checked independently
// for preservation of the resolved source acceptance criteria.

import {
  REQUIREMENT_TRACE_FOOTER_END,
  REQUIREMENT_TRACE_FOOTER_START,
  REQUIREMENT_REVISION_LABEL_PREFIX,
  requirementTrace,
  requirementReference,
  resolveRequirementReferences,
  normaliseText,
  type RequirementReferenceProblem,
  type RequirementTraceUnit,
  type ResolvedRequirementReference,
} from "@oscharko-dev/keiko-quality-intelligence";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import type { JiraTraceOutcome, JiraTraceRequest } from "@oscharko-dev/keiko-connectors";
import {
  projectJiraDescriptionInput,
  JIRA_REQUIREMENT_REFERENCE_CHARS_MAX,
  readJiraDescriptionBlocks,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { KnowledgeStore } from "@oscharko-dev/keiko-local-knowledge";

import { correlationIdOrUnknown } from "./correlation.js";
import type { UiHandlerDeps } from "./deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { openKnowledgeStoreForDeps } from "./local-knowledge-store-open.js";
import {
  chatKnowledgeScopes,
  collectForTurn,
  contentRedact,
  pageLabelOf,
  type LocatedRequirementUnit,
  type RequirementCollection,
} from "./requirement-inventory.js";
import {
  logRequirementTrace,
  type RequirementTraceOperation,
} from "./requirement-inventory-activity.js";

/** The labels and footer of a validated item; the connector applies them and reports back. */
export type ItemTrace = Omit<JiraTraceRequest, "report">;

type TraceProblem =
  | RequirementReferenceProblem
  | {
      readonly reference: string;
      readonly reason: "acceptance-criteria-missing";
      readonly candidates?: never;
    };
interface TraceDescriptionCheck {
  readonly description: unknown;
}

export type TraceResolution =
  | { readonly ok: true; readonly trace: ItemTrace; readonly sourceDigest: string }
  | {
      readonly ok: false;
      readonly reason: "no-knowledge-pod" | "unavailable" | "references";
      readonly problems: readonly TraceProblem[];
    };

export interface TraceSession {
  readonly resolve: (
    references: readonly string[],
    description?: TraceDescriptionCheck,
  ) => TraceResolution;
  /** How many requirement units the Chat's Knowledge Pods hold; zero when none can be read. */
  readonly unitCount: () => number;
  readonly close: () => void;
}

export interface TraceTurn {
  readonly chatId: string;
  readonly userMessageId: string | undefined;
  readonly correlationId: string;
}

interface Opened {
  readonly store: KnowledgeStore;
  readonly close: () => void;
  readonly collection: RequirementCollection;
}

function openCollection(deps: UiHandlerDeps, turn: TraceTurn): Opened | "no-knowledge-pod" {
  const scopes = chatKnowledgeScopes(deps.store.findChatById(turn.chatId));
  if (scopes.length === 0) return "no-knowledge-pod";
  const session = openKnowledgeStoreForDeps(deps, { recover: false });
  try {
    const collection = collectForTurn(session.store, scopes, turn.chatId, turn.userMessageId);
    return {
      store: session.store,
      close: (): void => {
        session.close();
      },
      collection,
    };
  } catch (error) {
    session.close();
    throw error;
  }
}

function withPage(store: KnowledgeStore, unit: LocatedRequirementUnit): RequirementTraceUnit {
  const pageLabel = pageLabelOf(store, unit);
  return pageLabel === undefined ? unit : { ...unit, source: { ...unit.source, pageLabel } };
}

function criterionText(value: string): string {
  return normaliseText(value).replace(/\s+/gu, " ");
}

/**
 * The form a criterion takes in a persisted description: Keiko writes it as a Markdown bullet and
 * the description is serialized to Jira wiki, so the criterion goes through that same pipeline.
 * The raw collapsed text stays admissible for native wiki descriptions.
 */
function criterionForms(text: string): readonly string[] {
  if (text.length === 0) return [];
  const projected = projectJiraDescriptionInput({ format: "markdown", text: `- ${text}` });
  const blocks = readJiraDescriptionBlocks(projected?.text ?? "", "markdown");
  // No readable block (for example a literal `{code}` macro marker): it has no checkable
  // representation, so the caller refuses it instead of treating it as present.
  if (blocks.length === 0) return [];
  const converted = blocks.map((block) => criterionText(block)).join(" ");
  return converted === text ? [text] : [text, converted];
}

function acceptanceCriteriaProblems(
  resolved: readonly ResolvedRequirementReference[],
  description: TraceDescriptionCheck,
  redact: (value: string) => string,
): readonly TraceProblem[] {
  const projected = projectJiraDescriptionInput(description.description)?.text ?? "";
  const blocks = new Set(
    readJiraDescriptionBlocks(projected, "jira-wiki").map((block) =>
      criterionText(block.replaceAll(/\\([\\*_+^~{}[\]!|#?.>-])/gu, "$1")),
    ),
  );
  const criteria = new Map<string, string>();
  for (const item of resolved) {
    const required =
      item.criterion === undefined ? item.unit.entry.acceptanceCriteria : [item.criterion];
    for (const criterion of required)
      criteria.set(
        `${item.unit.entry.documentScope}:${criterion.id}`,
        criterionText(redact(criterion.text)),
      );
  }
  const forms = new Map(
    [...criteria].map(([reference, text]) => [reference, criterionForms(text)]),
  );
  const traceable = [...forms.values()].filter((options) => options.length > 0);
  const completeBlock =
    traceable.length > 0 &&
    [0, 1].some((index) =>
      blocks.has(traceable.map((options) => options[index] ?? options[0] ?? "").join(" ")),
    );
  return [...forms].flatMap(([reference, options]): TraceProblem[] =>
    options.length > 0 && (completeBlock || options.some((form) => blocks.has(form)))
      ? []
      : [{ reference, reason: "acceptance-criteria-missing" }],
  );
}

function resolveAgainst(
  opened: Opened,
  references: readonly string[],
  redact: (value: string) => string,
  description?: TraceDescriptionCheck,
): TraceResolution {
  const resolution = resolveRequirementReferences(references, opened.collection.units);
  if (!resolution.ok) return { ok: false, reason: "references", problems: resolution.problems };
  if (description !== undefined) {
    const problems = acceptanceCriteriaProblems(resolution.resolved, description, redact);
    if (problems.length > 0) return { ok: false, reason: "references", problems };
  }
  const located = resolution.resolved.map((item) => ({
    ...item,
    unit: withPage(opened.store, item.unit),
  }));
  const { labels, footer } = requirementTrace(located, redact);
  return {
    ok: true,
    sourceDigest: sha256Hex(
      canonicalise(
        located.map(({ unit, criterion }) => ({
          reference: requirementReference(unit.entry),
          requirementDigest: unit.entry.digest,
          source: unit.source,
          sectionPath: unit.entry.sectionPath,
          characterStart: unit.entry.characterStart,
          characterEnd: unit.entry.characterEnd,
          criterion: criterion?.id ?? null,
        })),
      ),
    ),
    trace: {
      labels,
      footer,
      footerStart: REQUIREMENT_TRACE_FOOTER_START,
      footerEnd: REQUIREMENT_TRACE_FOOTER_END,
      replaceLabelPrefixes: [REQUIREMENT_REVISION_LABEL_PREFIX],
    },
  };
}

/** One session per write call: the Pods are read at most once, and closed when the call is done. */
export function openTraceSession(deps: UiHandlerDeps, turn: TraceTurn): TraceSession {
  let opened: Opened | "no-knowledge-pod" | undefined;
  let failed = false;
  const redact = contentRedact(deps);
  const open = (): Opened | "no-knowledge-pod" | "unavailable" => {
    if (failed) return "unavailable";
    try {
      opened ??= openCollection(deps, turn);
      return opened;
    } catch (error) {
      failed = true;
      emitServerDiagnostic(
        deps.diagnostics,
        serverDiagnosticFromError({
          correlationId: correlationIdOrUnknown(turn.correlationId),
          operation: "knowledge.requirement-trace",
          source: "requirement-trace",
          error,
          redact: () => "server-operation-failed",
        }),
      );
      return "unavailable";
    }
  };
  return {
    resolve: (references, description): TraceResolution => {
      const current = open();
      if (current === "unavailable") return { ok: false, reason: "unavailable", problems: [] };
      if (current === "no-knowledge-pod")
        return { ok: false, reason: "no-knowledge-pod", problems: [] };
      return resolveAgainst(current, references, redact, description);
    },
    unitCount: (): number => {
      const current = open();
      return typeof current === "string" ? 0 : current.collection.units.length;
    },
    close: (): void => {
      if (opened !== undefined && opened !== "no-knowledge-pod") opened.close();
      opened = undefined;
    },
  };
}

// ─── Results and evidence ────────────────────────────────────────────────────

/** Fixed repair instructions; never substitute references or labels for the source criteria. */
export function traceRefusalGuidance(
  resolution: Extract<TraceResolution, { ok: false }>,
): string | undefined {
  if (!resolution.problems.some((problem) => problem.reason === "acceptance-criteria-missing"))
    return undefined;
  return (
    "Nothing was changed. Read the referenced requirements with knowledge.requirements. " +
    "Copy each missing acceptance criterion verbatim into fields.description. " +
    "Keep requirementIds beside fields; IDs, labels and paraphrases do not replace the literal criteria. " +
    "For a draft, stage the corrected traced items before submitting them. Do not remove requirementIds to bypass this refusal."
  );
}

export function traceRefusalData(
  resolution: Extract<TraceResolution, { ok: false }>,
  ref?: string,
): CatalogJsonObject {
  const guidance = traceRefusalGuidance(resolution);
  return {
    reason: "field-validation",
    requirementRefusal: resolution.reason,
    ...(guidance === undefined ? {} : { guidance }),
    requirementProblems: resolution.problems.map((problem): CatalogJsonObject => ({
      ...(ref === undefined ? {} : { ref }),
      reference: problem.reference.slice(0, JIRA_REQUIREMENT_REFERENCE_CHARS_MAX),
      reason: problem.reason,
      ...(problem.candidates === undefined
        ? {}
        : { candidates: [...problem.candidates].slice(0, 8) }),
    })),
  };
}

export function traceOutcomeData(
  outcome: JiraTraceOutcome | undefined,
): CatalogJsonObject | undefined {
  return outcome === undefined
    ? undefined
    : {
        labelsApplied: outcome.labelsApplied,
        footerApplied: outcome.footerApplied,
        droppedLabels: outcome.droppedLabels.slice(0, 16),
      };
}

export interface TraceTally {
  tracedItems: number;
  refusedItems: number;
  problems: number;
  acceptanceCriteriaMissing: number;
  labelsApplied: number;
  footersApplied: number;
  droppedLabels: number;
  unavailable: boolean;
}

export function newTally(): TraceTally {
  return {
    tracedItems: 0,
    refusedItems: 0,
    problems: 0,
    acceptanceCriteriaMissing: 0,
    labelsApplied: 0,
    footersApplied: 0,
    droppedLabels: 0,
    unavailable: false,
  };
}

export function tallyOutcome(tally: TraceTally, outcome: JiraTraceOutcome | undefined): void {
  tally.tracedItems += 1;
  if (outcome === undefined) return;
  if (outcome.labelsApplied) tally.labelsApplied += 1;
  if (outcome.footerApplied) tally.footersApplied += 1;
  tally.droppedLabels += outcome.droppedLabels.length;
}

export function tallyRefusal(
  tally: TraceTally,
  resolution: Extract<TraceResolution, { ok: false }>,
): void {
  tally.tracedItems += 1;
  tally.refusedItems += 1;
  tally.problems += resolution.problems.length;
  tally.acceptanceCriteriaMissing += resolution.problems.filter(
    (problem) => problem.reason === "acceptance-criteria-missing",
  ).length;
  if (resolution.reason === "unavailable") tally.unavailable = true;
}

export function logTrace(
  correlationId: string | undefined,
  operation: RequirementTraceOperation,
  tally: TraceTally,
): void {
  if (tally.tracedItems === 0) return;
  logRequirementTrace(correlationId, {
    operation,
    tracedItemCount: tally.tracedItems,
    refusedItemCount: tally.refusedItems,
    referenceProblemCount: tally.problems - tally.acceptanceCriteriaMissing,
    acceptanceCriteriaMissingCount: tally.acceptanceCriteriaMissing,
    labelsAppliedCount: tally.labelsApplied,
    footerAppliedCount: tally.footersApplied,
    droppedLabelCount: tally.droppedLabels,
    unavailable: tally.unavailable,
  });
}
