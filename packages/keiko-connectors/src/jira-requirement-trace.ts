// Source traceability of created and edited issues (#4179, Epic #4173).
//
// The server validates an item's explicit `requirementIds` and hands the connector the resulting
// labels and footer. This module only applies them to what the current create or edit screen
// offers, and says exactly what it applied: a label the screen cannot take or a description it
// cannot write is reported as dropped, never counted as traced.

import type {
  JiraFieldMetadata,
  JiraMutationAttempt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { JIRA_METADATA_MAX_UPDATES } from "./jira-field-metadata.js";
import { readJiraMutationIssue } from "./jira-mutation-confirmation.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

/** What of the requested trace reached the issue. */
export interface JiraTraceOutcome {
  readonly labelsApplied: boolean;
  readonly footerApplied: boolean;
  readonly droppedLabels: readonly string[];
}

export interface JiraTraceRequest {
  readonly labels: readonly string[];
  /**
   * Plain text appended to the description; it starts with {@link JiraTraceRequest.footerStart}
   * and ends with the line {@link JiraTraceRequest.footerEnd}, so a later edit replaces exactly
   * that block and keeps every human paragraph around it.
   */
  readonly footer: string;
  readonly footerStart: string;
  readonly footerEnd: string;
  /** On an edit, existing labels with one of these prefixes that the trace does not keep are removed. */
  readonly replaceLabelPrefixes: readonly string[];
  /** Called once with the final outcome, whether or not the write later succeeds. */
  readonly report?: (outcome: JiraTraceOutcome) => void;
}

function settable(metadata: readonly JiraFieldMetadata[], id: string, operation: string): boolean {
  return metadata.some(
    (field) => field.id === id && (field.operations as readonly string[]).includes(operation),
  );
}

function joinParagraphs(parts: readonly string[]): string {
  return parts.filter((part) => part.trim().length > 0).join("\n\n");
}

/** The end of the owned block: the footer's last line, whole, after the footer's start. */
function footerBlockEnd(
  text: string,
  start: number,
  trace: Pick<JiraTraceRequest, "footerStart" | "footerEnd">,
): number | undefined {
  const marker = `\n${trace.footerEnd}`;
  let at = text.indexOf(marker, start + trace.footerStart.length);
  while (at >= 0) {
    const end = at + marker.length;
    if (end === text.length || text[end] === "\n") return end;
    at = text.indexOf(marker, end);
  }
  return undefined;
}

/**
 * The description with the footer block in place of an earlier one, or appended when there is none.
 * Only the earlier block itself, from its start line to its end line, is replaced: text before and
 * after it is kept. A start without an end is not an owned block, so it is left untouched.
 */
export function descriptionWithFooter(
  description: string | undefined,
  trace: Pick<JiraTraceRequest, "footer" | "footerStart" | "footerEnd">,
): string {
  const text = (description ?? "").replaceAll("\r\n", "\n");
  const start = text.indexOf(trace.footerStart);
  const end = start < 0 ? undefined : footerBlockEnd(text, start, trace);
  if (start < 0 || end === undefined) return joinParagraphs([text.trimEnd(), trace.footer]);
  return joinParagraphs([
    text.slice(0, start).trimEnd(),
    trace.footer,
    text.slice(end).replace(/^\n+/u, "").trimEnd(),
  ]);
}

type Fields = Readonly<Record<string, unknown>>;

/** Create: the labels and the footer the create screen offers; reports what was applied. */
export function traceCreateFields(
  fields: Fields,
  metadata: readonly JiraFieldMetadata[],
  trace: JiraTraceRequest,
): Fields {
  const present = Array.isArray(fields.labels) ? (fields.labels as readonly unknown[]) : [];
  const labelsApplied = settable(metadata, "labels", "set");
  const description = fields.description;
  const footerApplied =
    (typeof description === "string" || description === undefined) &&
    settable(metadata, "description", "set");
  let next: Fields = fields;
  if (labelsApplied)
    next = {
      ...next,
      labels: [...present, ...trace.labels.filter((label) => !present.includes(label))],
    };
  if (footerApplied)
    next = {
      ...next,
      description: descriptionWithFooter(
        typeof description === "string" ? description : undefined,
        trace,
      ),
    };
  trace.report?.({
    labelsApplied,
    footerApplied,
    droppedLabels: labelsApplied ? [] : trace.labels,
  });
  return next;
}

type Updates = readonly unknown[];

function isStale(label: string, trace: JiraTraceRequest): boolean {
  return (
    !trace.labels.includes(label) &&
    trace.replaceLabelPrefixes.some((prefix) => label.startsWith(prefix))
  );
}

function stringLabels(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((label) => typeof label === "string")
    ? value
    : undefined;
}

interface LabelChange {
  readonly operation: "add" | "remove";
  readonly value: string;
}

function labelChange(update: unknown): LabelChange | undefined {
  const raw = asRecord(update);
  if (raw?.fieldId !== "labels" || typeof raw.value !== "string") return undefined;
  return raw.operation === "add" || raw.operation === "remove"
    ? { operation: raw.operation, value: raw.value }
    : undefined;
}

/** The caller's own label update is dropped when the trace owns that label's final state. */
function ownsLabel(update: unknown, trace: JiraTraceRequest): boolean {
  const change = labelChange(update);
  if (change === undefined) return false;
  return change.operation === "remove"
    ? trace.labels.includes(change.value)
    : isStale(change.value, trace);
}

function labelsAfter(current: readonly string[], updates: Updates): readonly string[] {
  const labels = new Set(current);
  for (const update of updates) {
    const change = labelChange(update);
    if (change === undefined) continue;
    if (change.operation === "add") labels.add(change.value);
    else labels.delete(change.value);
  }
  return [...labels];
}

interface LabelPlan {
  readonly fields: Fields;
  readonly updates: Updates;
  readonly applied: boolean;
}

/** A replacement set from the caller keeps its human labels and gains the trace. */
function mergeIntoSet(
  fields: Fields,
  metadata: readonly JiraFieldMetadata[],
  trace: JiraTraceRequest,
): Pick<LabelPlan, "fields" | "applied"> {
  const given = stringLabels(fields.labels);
  if (given === undefined || !settable(metadata, "labels", "set"))
    return { fields, applied: false };
  const kept = given.filter((label) => !isStale(label, trace));
  const labels = [...kept, ...trace.labels.filter((label) => !kept.includes(label))];
  return { fields: { ...fields, labels }, applied: true };
}

/** The trace as add/remove updates relative to the labels the caller's own updates leave. */
function mergeIntoUpdates(
  current: readonly string[],
  own: Updates,
  metadata: readonly JiraFieldMetadata[],
  trace: JiraTraceRequest,
): Pick<LabelPlan, "updates" | "applied"> {
  const canAdd = settable(metadata, "labels", "add");
  const canRemove = settable(metadata, "labels", "remove");
  const kept = own.filter((update) => !ownsLabel(update, trace));
  const after = labelsAfter(current, kept);
  const stale = after.filter((label) => isStale(label, trace));
  const add = trace.labels.filter((label) => !after.includes(label));
  const updates = [
    ...kept,
    ...(canRemove ? stale.map((value) => ({ fieldId: "labels", operation: "remove", value })) : []),
    ...(canAdd ? add.map((value) => ({ fieldId: "labels", operation: "add", value })) : []),
  ];
  const fits = updates.length <= JIRA_METADATA_MAX_UPDATES;
  return {
    updates: fits ? updates : own,
    applied: fits && (add.length === 0 || canAdd) && (stale.length === 0 || canRemove),
  };
}

export type TracedEdit =
  | { readonly ok: true; readonly args: CatalogJsonObject }
  | { readonly ok: false; readonly attempt: JiraMutationAttempt };

/**
 * The trace labels merged into the caller's own label intent, so the edit stays one legal
 * mutation: a replacement set carries the trace, add/remove updates are completed by it. Labels
 * the read did not return are unavailable evidence: nothing is guessed from them.
 */
function planLabels(
  args: CatalogJsonObject,
  prior: Record<string, unknown>,
  metadata: readonly JiraFieldMetadata[],
  trace: JiraTraceRequest,
): LabelPlan {
  const fields = asRecord(args.fields ?? {}) ?? {};
  const own = asArray(args.updates ?? []) ?? [];
  if (Object.hasOwn(fields, "labels"))
    return { ...mergeIntoSet(fields, metadata, trace), updates: own };
  const current = stringLabels(prior.labels);
  if (current === undefined) return { fields, updates: own, applied: false };
  return { fields, ...mergeIntoUpdates(current, own, metadata, trace) };
}

interface FooterPlan {
  readonly applied: boolean;
  readonly base: string | undefined;
}

/**
 * The footer is written only into a plain-text description the instance lets the edit set, and
 * only over a description whose current value is known: a read that omits the field is unavailable
 * evidence, whereas an explicit `null` establishes an empty description.
 */
function planFooter(
  args: CatalogJsonObject,
  prior: Record<string, unknown>,
  metadata: readonly JiraFieldMetadata[],
): FooterPlan {
  const given = asRecord(args.fields ?? {})?.description;
  const known = Object.hasOwn(prior, "description") ? prior.description : undefined;
  const base = typeof given === "string" ? given : known;
  const plain =
    typeof given === "string" ||
    (given === undefined && (base === null || typeof base === "string"));
  const applied = settable(metadata, "description", "set") && plain;
  return { applied, base: typeof base === "string" ? base : undefined };
}

/**
 * Edit: the trace merged into the model's own arguments after one direct read of the issue's labels
 * and description, so an outdated revision label is replaced and the footer rewritten in place.
 */
export async function traceEditArguments(
  request: JiraMutationRequest,
  issueKey: string,
  args: CatalogJsonObject,
  metadata: readonly JiraFieldMetadata[],
  trace: JiraTraceRequest,
): Promise<TracedEdit> {
  const prior = await readJiraMutationIssue(request, issueKey, ["labels", "description"]);
  if (!prior.ok) return { ok: false, attempt: prior };
  const labels = planLabels(args, prior.fields, metadata, trace);
  const footer = planFooter(args, prior.fields, metadata);
  trace.report?.({
    labelsApplied: labels.applied,
    footerApplied: footer.applied,
    droppedLabels: labels.applied ? [] : trace.labels,
  });
  const fields = footer.applied
    ? { ...labels.fields, description: descriptionWithFooter(footer.base, trace) }
    : labels.fields;
  return {
    ok: true,
    args: {
      ...args,
      ...(Object.keys(fields).length === 0 ? {} : { fields }),
      ...(labels.updates.length === 0 ? {} : { updates: labels.updates }),
    } as CatalogJsonObject,
  };
}
