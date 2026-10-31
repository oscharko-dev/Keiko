// Backlog drafts (#4178, Epic #4173): many related issues proposed together, approved once and
// created in dependency order. This module owns only Jira behavior — parsing, ordering, the
// human's deselection, each item's draft identity and the reconcile-then-create step. Durability,
// approval and authority stay server-owned: every item runs as its own journaled `jira.create`.

import {
  JIRA_DRAFT_ITEMS_MAX,
  JIRA_FIELD_ID_PATTERN,
  isJiraDraftRef,
  isSafeAtlassianIdentifier,
  type JiraFieldMetadata,
  type JiraMutationAttempt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { JIRA_ISSUE_LINKS_MAX, parseJiraIssueLinks } from "./jira-issue-links.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

/** A relation names an item of the same draft (`ref`) or an existing issue (`issueKey`). */
export interface JiraDraftTarget {
  readonly ref?: string;
  readonly issueKey?: string;
}
/** The field that carries the item's parent: `parent` for a sub-task, an Epic Link field, … */
export interface JiraDraftParent extends JiraDraftTarget {
  readonly fieldId: string;
}
export interface JiraDraftLink extends JiraDraftTarget {
  readonly type: string;
  readonly direction: "inward" | "outward";
}
export interface JiraDraftItem {
  readonly ref: string;
  readonly projectId: string;
  readonly issueTypeId: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly parent?: JiraDraftParent;
  readonly links: readonly JiraDraftLink[];
}
/** Items in dependency order: every referenced item precedes the items that reference it. */
export interface JiraDraft {
  readonly items: readonly JiraDraftItem[];
}

const FIELD_ID = new RegExp(JIRA_FIELD_ID_PATTERN, "u");
const NUMERIC_ID = /^\d{1,32}$/u;
const ITEM_KEYS: ReadonlySet<string> = new Set([
  "ref",
  "projectId",
  "issueTypeId",
  "fields",
  "parent",
  "links",
]);
/** Jira's create screens carry `labels` by default; the identity label is Keiko's own. */
export const JIRA_DRAFT_IDENTITY_PREFIX = "keiko-draft-";

function numericId(value: unknown): value is string {
  return typeof value === "string" && NUMERIC_ID.test(value);
}
function onlyKeys(value: Readonly<Record<string, unknown>>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}
function target(value: Readonly<Record<string, unknown>>): JiraDraftTarget | undefined {
  const { ref, issueKey } = value;
  if (ref !== undefined && issueKey === undefined) return isJiraDraftRef(ref) ? { ref } : undefined;
  if (issueKey !== undefined && ref === undefined)
    return isSafeAtlassianIdentifier(issueKey) ? { issueKey } : undefined;
  return undefined;
}
function parseParent(value: unknown): JiraDraftParent | null | undefined {
  if (value === undefined) return null;
  const raw = asRecord(value);
  if (raw === undefined || !onlyKeys(raw, new Set(["fieldId", "ref", "issueKey"])))
    return undefined;
  const fieldId = raw.fieldId;
  const related = target(raw);
  if (typeof fieldId !== "string" || !FIELD_ID.test(fieldId) || related === undefined)
    return undefined;
  return { fieldId, ...related };
}
function parseLink(value: unknown): JiraDraftLink | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !onlyKeys(raw, new Set(["type", "direction", "ref", "issueKey"])))
    return undefined;
  const related = target(raw);
  if (related === undefined) return undefined;
  // The shared link parser owns type and direction validation; a stand-in key passes its check.
  const checked = parseJiraIssueLinks([
    { type: raw.type, direction: raw.direction, issueKey: related.issueKey ?? "DRAFT-1" },
  ]);
  const link = checked?.[0];
  return link === undefined
    ? undefined
    : { type: link.type, direction: link.direction, ...related };
}
function parseLinks(value: unknown): readonly JiraDraftLink[] | undefined {
  if (value === undefined) return [];
  const input = asArray(value);
  if (input === undefined || input.length > JIRA_ISSUE_LINKS_MAX) return undefined;
  const links = input.map(parseLink);
  return links.every((link) => link !== undefined) ? links : undefined;
}
function itemFields(
  value: unknown,
  parent: JiraDraftParent | null,
): Readonly<Record<string, unknown>> | undefined {
  const fields = asRecord(value);
  if (fields === undefined) return undefined;
  const routed = ["project", "issuetype", ...(parent === null ? [] : [parent.fieldId])];
  const summary = fields.summary;
  return routed.some((id) => Object.hasOwn(fields, id)) ||
    typeof summary !== "string" ||
    summary.trim().length === 0
    ? undefined
    : fields;
}
function parseItem(value: unknown): JiraDraftItem | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !onlyKeys(raw, ITEM_KEYS)) return undefined;
  const { ref, projectId, issueTypeId } = raw;
  const parent = parseParent(raw.parent);
  const links = parseLinks(raw.links);
  if (
    !isJiraDraftRef(ref) ||
    !numericId(projectId) ||
    !numericId(issueTypeId) ||
    parent === undefined ||
    links === undefined
  )
    return undefined;
  const fields = itemFields(raw.fields, parent);
  if (fields === undefined) return undefined;
  return { ref, projectId, issueTypeId, fields, links, ...(parent === null ? {} : { parent }) };
}

/** The draft items this item cannot be created before. */
export function jiraDraftDependencies(item: JiraDraftItem): readonly string[] {
  const refs = [item.parent?.ref, ...item.links.map((link) => link.ref)];
  return [...new Set(refs.filter((ref): ref is string => ref !== undefined))];
}
/** Stable dependency order (Kahn); undefined for an unknown reference, a self-reference or a cycle. */
function dependencyOrder(items: readonly JiraDraftItem[]): readonly JiraDraftItem[] | undefined {
  const refs = new Set(items.map((item) => item.ref));
  const pending = new Map(items.map((item) => [item.ref, jiraDraftDependencies(item)]));
  for (const [ref, dependencies] of pending)
    if (dependencies.some((dependency) => dependency === ref || !refs.has(dependency)))
      return undefined;
  const ordered: JiraDraftItem[] = [];
  const placed = new Set<string>();
  while (ordered.length < items.length) {
    const next = items.find(
      (item) =>
        !placed.has(item.ref) && (pending.get(item.ref) ?? []).every((ref) => placed.has(ref)),
    );
    if (next === undefined) return undefined;
    placed.add(next.ref);
    ordered.push(next);
  }
  return ordered;
}

/** Validated draft in dependency order, or undefined for any malformed or cyclic input. */
export function parseJiraDraft(args: Readonly<Record<string, unknown>>): JiraDraft | undefined {
  if (!onlyKeys(args, new Set(["items"]))) return undefined;
  const input = asArray(args.items);
  if (input === undefined || input.length === 0 || input.length > JIRA_DRAFT_ITEMS_MAX)
    return undefined;
  const items = input.map(parseItem);
  if (!items.every((item) => item !== undefined)) return undefined;
  if (new Set(items.map((item) => item.ref)).size !== items.length) return undefined;
  const ordered = dependencyOrder(items);
  return ordered === undefined ? undefined : { items: ordered };
}

/** The human's deselection, extended to every item that depends on a deselected one. */
export function excludedJiraDraftRefs(
  draft: JiraDraft,
  deselected: readonly string[],
): ReadonlySet<string> {
  const excluded = new Set(
    deselected.filter((ref) => draft.items.some((item) => item.ref === ref)),
  );
  for (const item of draft.items)
    if (jiraDraftDependencies(item).some((ref) => excluded.has(ref))) excluded.add(item.ref);
  return excluded;
}

function normalizedSummary(fields: Readonly<Record<string, unknown>>): string {
  const summary = fields.summary;
  return typeof summary === "string" ? summary.trim().replace(/\s+/gu, " ") : "";
}
/**
 * The deterministic identity a draft item leaves on its issue. It depends on where the issue is
 * created and what it is called, not on the conversation, so re-running the same draft later
 * reconciles to the issue that exists instead of creating a second one.
 */
export function jiraDraftIdentity(item: JiraDraftItem): string {
  const digest = sha256Hex(
    canonicalise({
      projectId: item.projectId,
      issueTypeId: item.issueTypeId,
      summary: normalizedSummary(item.fields),
    }),
  );
  return `${JIRA_DRAFT_IDENTITY_PREFIX}${digest.slice(0, 20)}`;
}

/** Relations resolved to issue keys; undefined while a referenced item has no key. */
export function resolveJiraDraftItem(
  item: JiraDraftItem,
  keys: ReadonlyMap<string, string>,
): CatalogJsonObject | undefined {
  const keyOf = (related: JiraDraftTarget): string | undefined =>
    related.issueKey ?? (related.ref === undefined ? undefined : keys.get(related.ref));
  const parentKey = item.parent === undefined ? undefined : keyOf(item.parent);
  const links = item.links.map((link) => ({
    type: link.type,
    direction: link.direction,
    issueKey: keyOf(link),
  }));
  if (
    (item.parent !== undefined && parentKey === undefined) ||
    links.some((link) => !link.issueKey)
  )
    return undefined;
  return {
    projectId: item.projectId,
    issueTypeId: item.issueTypeId,
    fields: {
      ...item.fields,
      ...(item.parent === undefined ? {} : { [item.parent.fieldId]: parentKey }),
    },
    ...(links.length === 0 ? {} : { links }),
  } as CatalogJsonObject;
}

function labelsWritable(metadata: readonly JiraFieldMetadata[]): boolean {
  return metadata.some((field) => field.id === "labels" && field.operations.includes("set"));
}
/** The item's fields with its identity label added, when the create screen offers labels. */
export function withJiraDraftIdentity(
  fields: Readonly<Record<string, unknown>>,
  metadata: readonly JiraFieldMetadata[],
  identity: string,
): Readonly<Record<string, unknown>> {
  if (!labelsWritable(metadata)) return fields;
  const labels = Array.isArray(fields.labels) ? (fields.labels as readonly unknown[]) : [];
  return labels.includes(identity) ? fields : { ...fields, labels: [...labels, identity] };
}

const JQL_BACKSLASH = String.raw`\\`;
const JQL_QUOTE = String.raw`\"`;
function jqlString(value: string): string {
  return `"${value.replaceAll("\\", JQL_BACKSLASH).replaceAll('"', JQL_QUOTE)}"`;
}
function identityQuery(item: JiraDraftItem, identity: string, labelled: boolean): string {
  const scope = `project = ${item.projectId} AND issuetype = ${item.issueTypeId}`;
  if (labelled) return `${scope} AND labels = ${jqlString(identity)}`;
  // Without a labels field the exact summary is the identity; Jira's text match is only a filter.
  const phrase = '"' + normalizedSummary(item.fields) + '"';
  return `${scope} AND summary ~ ${jqlString(phrase)}`;
}
interface FoundIssue {
  readonly key: string;
  readonly id: string;
}
function matchingIssues(
  issues: readonly unknown[],
  item: JiraDraftItem,
  labelled: boolean,
): readonly FoundIssue[] {
  const summary = normalizedSummary(item.fields);
  return issues.flatMap((value) => {
    const issue = asRecord(value);
    const key = issue?.key;
    const id = issue?.id;
    if (!isSafeAtlassianIdentifier(key) || !numericId(id)) return [];
    const same = labelled || normalizedSummary(asRecord(issue?.fields) ?? {}) === summary;
    return same ? [{ key, id }] : [];
  });
}

export type JiraDraftReconciliation =
  | { readonly kind: "absent" }
  | { readonly kind: "existing"; readonly attempt: JiraMutationAttempt }
  | { readonly kind: "refused"; readonly attempt: JiraMutationAttempt };
/**
 * Finds the issue this item already created. One match reconciles to it without sending
 * anything; several matches are ambiguous and refuse the item rather than guess.
 */
export async function reconcileJiraDraftItem(
  request: JiraMutationRequest,
  item: JiraDraftItem,
  metadata: readonly JiraFieldMetadata[],
): Promise<JiraDraftReconciliation> {
  const labelled = labelsWritable(metadata);
  const params = new URLSearchParams({
    jql: identityQuery(item, jiraDraftIdentity(item), labelled),
    fields: "summary",
    maxResults: "10",
  });
  const response = await request(`search?${params.toString()}`, "GET");
  if (!response.ok) return { kind: "refused", attempt: { ok: false, reason: response.reason } };
  const issues = asArray(response.body?.issues);
  if (issues === undefined)
    return { kind: "refused", attempt: { ok: false, reason: "malformed-payload" } };
  const found = matchingIssues(issues, item, labelled);
  if (found.length > 1) return { kind: "refused", attempt: { ok: false, reason: "conflict" } };
  const issue = found[0];
  return issue === undefined
    ? { kind: "absent" }
    : {
        kind: "existing",
        attempt: { ok: true, receipt: { issueKey: issue.key, issueId: issue.id } },
      };
}
