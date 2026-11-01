// Traceability of a derived backlog item back to its source requirements (#4179, Epic #4173).
//
// The model names the requirements an item derives from in an explicit `requirementIds` argument.
// Keiko validates every reference against the inventory it read, then writes the trace itself,
// deterministically: labels that make the link queryable in Jira (document scope, requirement,
// content revision) and a plain-text footer with the source location and digests. Nothing is
// scraped from free text, and a reference that is unknown or ambiguous is refused, never guessed.

import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { redact } from "@oscharko-dev/keiko-security";

import { stripUnsafeFormatChars } from "./assertions.js";
import {
  REQUIREMENT_DIGEST_SHORT_LENGTH,
  type RequirementCriterion,
  type RequirementInventoryEntry,
} from "./requirementInventory.js";

export const REQUIREMENT_TRACE_MARKER_LABEL = "keiko-requirement";
export const REQUIREMENT_DOCUMENT_LABEL_PREFIX = "keiko-doc-";
export const REQUIREMENT_LABEL_PREFIX = "keiko-req-";
export const REQUIREMENT_REVISION_LABEL_PREFIX = "keiko-rev-";
const CRITERION_LABEL_PREFIX = "keiko-ac-";
/** The first lines of the footer; a later edit replaces everything from here to the end. */
export const REQUIREMENT_TRACE_FOOTER_START = "----\nKeiko traceability";
export const REQUIREMENT_REFERENCES_MAX = 8;

export function shortRequirementDigest(digest: string): string {
  return digest.slice(0, REQUIREMENT_DIGEST_SHORT_LENGTH);
}

export function requirementLabel(id: string): string {
  return `${REQUIREMENT_LABEL_PREFIX}${id}`;
}
export function revisionLabel(digest: string): string {
  return `${REQUIREMENT_REVISION_LABEL_PREFIX}${shortRequirementDigest(digest)}`;
}
export function documentLabel(documentScope: string): string {
  return `${REQUIREMENT_DOCUMENT_LABEL_PREFIX}${documentScope}`;
}

/** The reference a model passes back: `<document scope>:<id>`, optionally `/AC<n>`. */
export function requirementReference(
  entry: Pick<RequirementInventoryEntry, "documentScope" | "id">,
): string {
  return `${entry.documentScope}:${entry.id}`;
}

export interface RequirementTraceSource {
  readonly documentName: string;
  /** Content hash of the document version the inventory was read from. */
  readonly documentDigest: string;
  readonly pageLabel?: string;
}

/** An inventory entry together with what the footer needs to say about its source. */
export interface RequirementTraceUnit {
  readonly entry: RequirementInventoryEntry;
  readonly source: RequirementTraceSource;
  readonly findings: readonly string[];
}

export interface ResolvedRequirementReference<
  Unit extends RequirementTraceUnit = RequirementTraceUnit,
> {
  readonly unit: Unit;
  readonly criterion?: RequirementCriterion;
}
export interface RequirementReferenceProblem {
  readonly reference: string;
  readonly reason: "malformed" | "unknown" | "ambiguous";
  /** For an ambiguous reference: the scoped references that match. */
  readonly candidates?: readonly string[];
}
export type RequirementReferenceResolution<
  Unit extends RequirementTraceUnit = RequirementTraceUnit,
> =
  | { readonly ok: true; readonly resolved: readonly ResolvedRequirementReference<Unit>[] }
  | { readonly ok: false; readonly problems: readonly RequirementReferenceProblem[] };

const REFERENCE_SHAPE = /^(?:([0-9a-f]{8}):)?(.+?)(?:\/AC(\d{1,3}))?$/u;

function resolveOne<Unit extends RequirementTraceUnit>(
  reference: string,
  units: readonly Unit[],
): ResolvedRequirementReference<Unit> | RequirementReferenceProblem {
  const shape = REFERENCE_SHAPE.exec(reference.trim());
  const id = shape?.[2];
  if (shape === null || id === undefined) return { reference, reason: "malformed" };
  const matches = units.filter(
    (unit) =>
      unit.entry.id === id && (shape[1] === undefined || unit.entry.documentScope === shape[1]),
  );
  const [only] = matches;
  if (only === undefined) return { reference, reason: "unknown" };
  if (matches.length > 1)
    return {
      reference,
      reason: "ambiguous",
      candidates: matches.map((unit) => requirementReference(unit.entry)).sort(compareStrings),
    };
  if (shape[3] === undefined) return { unit: only };
  const criterion = only.entry.acceptanceCriteria.find(
    (candidate) => candidate.id === `${id}/AC${shape[3] ?? ""}`,
  );
  return criterion === undefined ? { reference, reason: "unknown" } : { unit: only, criterion };
}

/**
 * Validates the explicit references of one item against the inventory. Every reference must name
 * exactly one requirement; an id that exists in several documents needs its document scope.
 */
export function resolveRequirementReferences<Unit extends RequirementTraceUnit>(
  references: readonly string[],
  units: readonly Unit[],
): RequirementReferenceResolution<Unit> {
  if (references.length === 0 || references.length > REQUIREMENT_REFERENCES_MAX)
    return { ok: false, problems: [{ reference: "", reason: "malformed" }] };
  const resolved: ResolvedRequirementReference<Unit>[] = [];
  const problems: RequirementReferenceProblem[] = [];
  for (const reference of references) {
    const one = resolveOne(reference, units);
    if ("reason" in one) problems.push(one);
    else resolved.push(one);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, resolved };
}

// ─── Footer and labels ───────────────────────────────────────────────────────

/** Replaces a document-derived fragment by one line of plain text without wiki markup. */
function plain(value: string, redactor: (text: string) => string): string {
  return redactor(stripUnsafeFormatChars(value))
    .replaceAll(/[{}|~!^*_+?<>"'`[\]]/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function locationOf(unit: RequirementTraceUnit, redactor: (text: string) => string): string {
  const { entry, source } = unit;
  return [
    plain(source.documentName, redactor),
    ...entry.sectionPath.map((part) => plain(part, redactor)),
    ...(source.pageLabel === undefined ? [] : [`page ${plain(source.pageLabel, redactor)}`]),
  ].join(" · ");
}

function footerGroup(
  resolved: ResolvedRequirementReference,
  redactor: (text: string) => string,
): readonly string[] {
  const { unit, criterion } = resolved;
  const { entry } = unit;
  return [
    `Requirement: ${entry.id} · ${plain(entry.title, redactor)}`,
    `Reference: ${requirementReference(entry)}`,
    ...(criterion === undefined ? [] : [`Acceptance criterion: ${criterion.id}`]),
    `Source: ${locationOf(unit, redactor)}`,
    `Document digest: ${shortRequirementDigest(unit.source.documentDigest)}`,
    `Requirement digest: ${shortRequirementDigest(entry.digest)}`,
    `Quality findings: ${unit.findings.length === 0 ? "none" : unit.findings.join(", ")}`,
  ];
}

export interface RequirementTrace {
  readonly labels: readonly string[];
  /** Plain text; starts with {@link REQUIREMENT_TRACE_FOOTER_START}. */
  readonly footer: string;
}

/**
 * The labels and footer of an item derived from the resolved requirements. Every document-derived
 * fragment passes the redactor and is stripped of wiki markup (macros, mentions, links, images).
 */
export function requirementTrace(
  resolved: readonly ResolvedRequirementReference[],
  redactor: (text: string) => string = redact,
): RequirementTrace {
  const labels = new Set<string>([REQUIREMENT_TRACE_MARKER_LABEL]);
  for (const { unit, criterion } of resolved) {
    labels.add(documentLabel(unit.entry.documentScope));
    labels.add(requirementLabel(unit.entry.id));
    labels.add(revisionLabel(unit.entry.digest));
    if (criterion !== undefined)
      labels.add(`${CRITERION_LABEL_PREFIX}${criterion.id.replace("/", "-")}`);
  }
  const groups = resolved.map((item) => footerGroup(item, redactor).join("\n"));
  return {
    labels: [...labels],
    footer: `${REQUIREMENT_TRACE_FOOTER_START}\n${groups.join("\n\n")}`,
  };
}

// ─── Change queries ──────────────────────────────────────────────────────────

export interface RequirementChangeQuery {
  readonly purpose: "stale" | "removed" | "traced";
  readonly documentScope: string;
  readonly jql: string;
  /** The requirement ids the query covers (empty for `traced`). */
  readonly requirementIds: readonly string[];
}

function quoted(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

type Changeable = Pick<RequirementInventoryEntry, "id" | "digest" | "documentScope">;

function staleBatches(
  scope: string,
  entries: readonly Changeable[],
  jqlMaxChars: number,
): readonly RequirementChangeQuery[] {
  const queries: RequirementChangeQuery[] = [];
  let batch: Changeable[] = [];
  const build = (members: readonly Changeable[]): string =>
    `labels = "${documentLabel(scope)}" AND labels in (${quoted(members.map((m) => requirementLabel(m.id)))}) AND labels not in (${quoted(members.map((m) => revisionLabel(m.digest)))})`;
  const flush = (): void => {
    if (batch.length === 0) return;
    queries.push({
      purpose: "stale",
      documentScope: scope,
      jql: build(batch),
      requirementIds: batch.map((member) => member.id),
    });
    batch = [];
  };
  for (const entry of entries) {
    if (batch.length > 0 && build([...batch, entry]).length > jqlMaxChars) flush();
    batch.push(entry);
  }
  flush();
  return queries;
}

/**
 * Label-only JQL (without a project clause), batched to the JQL length bound: `stale` finds items
 * derived from an outdated revision of a requirement that still exists, `traced` lists every item of
 * a document for finding requirements without an item, and `removed` finds items whose requirement
 * is gone when the document's identifiers fit one query.
 */
export function requirementChangeQueries(
  entries: readonly Changeable[],
  jqlMaxChars = 1800,
): readonly RequirementChangeQuery[] {
  const byScope = new Map<string, Changeable[]>();
  for (const entry of entries) {
    const group = byScope.get(entry.documentScope) ?? [];
    group.push(entry);
    byScope.set(entry.documentScope, group);
  }
  const queries: RequirementChangeQuery[] = [];
  for (const [scope, group] of byScope) {
    queries.push(...staleBatches(scope, group, jqlMaxChars));
    const traced = `labels = "${documentLabel(scope)}"`;
    queries.push({ purpose: "traced", documentScope: scope, jql: traced, requirementIds: [] });
    const removed = `${traced} AND labels not in (${quoted(group.map((entry) => requirementLabel(entry.id)))})`;
    if (removed.length <= jqlMaxChars)
      queries.push({
        purpose: "removed",
        documentScope: scope,
        jql: removed,
        requirementIds: group.map((entry) => entry.id),
      });
  }
  return queries;
}
