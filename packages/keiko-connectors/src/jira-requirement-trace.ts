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
  /** Plain text appended to the description; starts with {@link JiraTraceRequest.footerStart}. */
  readonly footer: string;
  readonly footerStart: string;
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

/** The description with the footer in place of any earlier footer, or appended when there is none. */
export function descriptionWithFooter(
  description: string | undefined,
  trace: Pick<JiraTraceRequest, "footer" | "footerStart">,
): string {
  const text = description ?? "";
  const at = text.indexOf(trace.footerStart);
  const body = (at < 0 ? text : text.slice(0, at)).trimEnd();
  return body.length === 0 ? trace.footer : `${body}\n\n${trace.footer}`;
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

type Updates = readonly Record<string, unknown>[];

function labelUpdates(
  current: readonly string[],
  metadata: readonly JiraFieldMetadata[],
  trace: JiraTraceRequest,
): { readonly updates: Updates; readonly applied: boolean } {
  const canAdd = settable(metadata, "labels", "add");
  const canRemove = settable(metadata, "labels", "remove");
  const stale = current.filter(
    (label) =>
      !trace.labels.includes(label) &&
      trace.replaceLabelPrefixes.some((prefix) => label.startsWith(prefix)),
  );
  const add = trace.labels.filter((label) => !current.includes(label));
  const updates: Record<string, unknown>[] = [
    ...(canRemove ? stale.map((value) => ({ fieldId: "labels", operation: "remove", value })) : []),
    ...(canAdd ? add.map((value) => ({ fieldId: "labels", operation: "add", value })) : []),
  ];
  return { updates, applied: canAdd && (stale.length === 0 || canRemove) };
}

export type TracedEdit =
  | { readonly ok: true; readonly args: CatalogJsonObject }
  | { readonly ok: false; readonly attempt: JiraMutationAttempt };

interface MergedUpdates {
  readonly updates: readonly unknown[];
  readonly fits: boolean;
}

/** The model's own updates plus the label updates, unless together they exceed the bound. */
function mergeUpdates(
  args: CatalogJsonObject,
  labels: readonly Record<string, unknown>[],
): MergedUpdates {
  const own = asArray(args.updates ?? []) ?? [];
  const merged = [...own, ...labels];
  const fits = merged.length <= JIRA_METADATA_MAX_UPDATES;
  return { updates: fits ? merged : own, fits };
}

interface FooterPlan {
  readonly applied: boolean;
  readonly base: string | undefined;
}

/** The footer is written only into a plain-text description the instance lets the edit set. */
function planFooter(
  args: CatalogJsonObject,
  prior: Record<string, unknown>,
  metadata: readonly JiraFieldMetadata[],
): FooterPlan {
  const given = asRecord(args.fields ?? {})?.description;
  const base = typeof given === "string" ? given : prior.description;
  const plain = base === null || base === undefined || typeof base === "string";
  const applied =
    settable(metadata, "description", "set") &&
    (given === undefined || typeof given === "string") &&
    plain;
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
  const current = (asArray(prior.fields.labels) ?? []).filter(
    (label): label is string => typeof label === "string",
  );
  const labels = labelUpdates(current, metadata, trace);
  const { updates, fits } = mergeUpdates(args, labels.updates);
  const footer = planFooter(args, prior.fields, metadata);
  const applied = labels.applied && fits;
  trace.report?.({
    labelsApplied: applied,
    footerApplied: footer.applied,
    droppedLabels: applied ? [] : trace.labels,
  });
  const fields = asRecord(args.fields ?? {}) ?? {};
  return {
    ok: true,
    args: {
      ...args,
      ...(updates.length === 0 ? {} : { updates }),
      ...(footer.applied
        ? { fields: { ...fields, description: descriptionWithFooter(footer.base, trace) } }
        : {}),
    } as CatalogJsonObject,
  };
}
