// Source trace of Jira items created or edited from requirements (#4179, Epic #4173).
//
// An item names the requirements it derives from in an explicit `requirementIds` argument. The
// references are validated against the units the Chat's Knowledge Pods hold; an unknown or
// ambiguous reference refuses the write before anything is sent. Nothing is read from the item's
// summary, labels or description.

import {
  REQUIREMENT_TRACE_FOOTER_END,
  REQUIREMENT_TRACE_FOOTER_START,
  REQUIREMENT_REVISION_LABEL_PREFIX,
  requirementTrace,
  resolveRequirementReferences,
  type RequirementReferenceProblem,
  type RequirementTraceUnit,
} from "@oscharko-dev/keiko-quality-intelligence";
import type { JiraTraceOutcome, JiraTraceRequest } from "@oscharko-dev/keiko-connectors";
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

export type TraceResolution =
  | { readonly ok: true; readonly trace: ItemTrace }
  | {
      readonly ok: false;
      readonly reason: "no-knowledge-pod" | "unavailable" | "references";
      readonly problems: readonly RequirementReferenceProblem[];
    };

export interface TraceSession {
  readonly resolve: (references: readonly string[]) => TraceResolution;
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

function resolveAgainst(
  opened: Opened,
  references: readonly string[],
  redact: (value: string) => string,
): TraceResolution {
  const resolution = resolveRequirementReferences(references, opened.collection.units);
  if (!resolution.ok) return { ok: false, reason: "references", problems: resolution.problems };
  const located = resolution.resolved.map((item) => ({
    ...item,
    unit: withPage(opened.store, item.unit),
  }));
  const { labels, footer } = requirementTrace(located, redact);
  return {
    ok: true,
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
  return {
    resolve: (references): TraceResolution => {
      if (failed) return { ok: false, reason: "unavailable", problems: [] };
      try {
        opened ??= openCollection(deps, turn);
        if (opened === "no-knowledge-pod")
          return { ok: false, reason: "no-knowledge-pod", problems: [] };
        return resolveAgainst(opened, references, redact);
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
        return { ok: false, reason: "unavailable", problems: [] };
      }
    },
    close: (): void => {
      if (opened !== undefined && opened !== "no-knowledge-pod") opened.close();
      opened = undefined;
    },
  };
}

// ─── Results and evidence ────────────────────────────────────────────────────

export function traceRefusalData(
  resolution: Extract<TraceResolution, { ok: false }>,
  ref?: string,
): CatalogJsonObject {
  return {
    reason: "field-validation",
    requirementRefusal: resolution.reason,
    requirementProblems: resolution.problems.map((problem): CatalogJsonObject => ({
      ...(ref === undefined ? {} : { ref }),
      reference: problem.reference.slice(0, 80),
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
    referenceProblemCount: tally.problems,
    labelsAppliedCount: tally.labelsApplied,
    footerAppliedCount: tally.footersApplied,
    droppedLabelCount: tally.droppedLabels,
    unavailable: tally.unavailable,
  });
}
