// Backlog drafts (#4178, Epic #4173): many related issues proposed together, approved once and
// created in dependency order. This module owns only Jira behavior — parsing, ordering, the
// human's deselection, each item's draft identity and the reconcile-then-create step. Durability,
// approval and authority stay server-owned: every item runs as its own journaled `jira.create`.

import {
  JIRA_DRAFT_ITEMS_MAX,
  JIRA_FIELD_ID_PATTERN,
  isJiraDraftRef,
  isSafeAtlassianIdentifier,
  type AtlassianConnectorWriteFailureReason,
  type JiraFieldMetadata,
  type JiraMutationAttempt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { compareByCodeUnit } from "./adf-to-text.js";
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
interface ParsedJiraDraftItem {
  readonly ref: string;
  readonly projectId: string;
  readonly issueTypeId: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly parent?: JiraDraftParent;
  readonly links: readonly JiraDraftLink[];
  /** Explicit source requirements the item derives from; the server validates and traces them. */
  readonly requirementIds?: readonly string[];
}
export interface JiraDraftItem extends ParsedJiraDraftItem {
  /** The deterministic label this item leaves on its issue; see `withIdentities`. */
  readonly identity: string;
  /**
   * Another item of the same draft has the same project, issue type, summary and parent. Without a
   * labels field those are all Jira can be searched for, so the two cannot be told apart.
   */
  readonly unlabelledTwin: boolean;
}
/** Items in dependency order: every referenced item precedes the items that reference it. */
export interface JiraDraft {
  readonly items: readonly JiraDraftItem[];
}

/** References per item; one item may derive from several requirements. */
export const JIRA_REQUIREMENT_IDS_MAX = 8;
const FIELD_ID = new RegExp(JIRA_FIELD_ID_PATTERN, "u");
const NUMERIC_ID = /^\d{1,32}$/u;
const ITEM_KEYS: ReadonlySet<string> = new Set([
  "ref",
  "projectId",
  "issueTypeId",
  "fields",
  "parent",
  "links",
  "requirementIds",
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
const REQUIREMENT_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,80}$/u;
/** Up to {@link JIRA_REQUIREMENT_IDS_MAX} plain reference strings; `undefined` when malformed. */
export function parseRequirementIds(value: unknown): readonly string[] | null | undefined {
  if (value === undefined) return null;
  const list = asArray(value);
  if (
    list === undefined ||
    list.length === 0 ||
    list.length > JIRA_REQUIREMENT_IDS_MAX ||
    !list.every((entry) => typeof entry === "string" && REQUIREMENT_ID_PATTERN.test(entry))
  )
    return undefined;
  return list as readonly string[];
}

interface ItemRelations {
  readonly parent: JiraDraftParent | null;
  readonly links: ParsedJiraDraftItem["links"];
  readonly requirementIds: readonly string[] | null;
}

function parseRelations(raw: Record<string, unknown>): ItemRelations | undefined {
  const parent = parseParent(raw.parent);
  const links = parseLinks(raw.links);
  const requirementIds = parseRequirementIds(raw.requirementIds);
  return parent === undefined || links === undefined || requirementIds === undefined
    ? undefined
    : { parent, links, requirementIds };
}

function parseItem(value: unknown): ParsedJiraDraftItem | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !onlyKeys(raw, ITEM_KEYS)) return undefined;
  const { ref, projectId, issueTypeId } = raw;
  const relations = parseRelations(raw);
  if (
    relations === undefined ||
    !isJiraDraftRef(ref) ||
    !numericId(projectId) ||
    !numericId(issueTypeId)
  )
    return undefined;
  const { parent, links, requirementIds } = relations;
  const fields = itemFields(raw.fields, parent);
  if (fields === undefined) return undefined;
  return {
    ref,
    projectId,
    issueTypeId,
    fields,
    links,
    ...(parent === null ? {} : { parent }),
    ...(requirementIds === null ? {} : { requirementIds }),
  };
}

/** The draft items this item cannot be created before. */
export function jiraDraftDependencies(
  item: Pick<ParsedJiraDraftItem, "parent" | "links">,
): readonly string[] {
  const refs = [item.parent?.ref, ...item.links.map((link) => link.ref)];
  return [...new Set(refs.filter((ref): ref is string => ref !== undefined))];
}
/** Stable dependency order (Kahn); undefined for an unknown reference, a self-reference or a cycle. */
function dependencyOrder(
  items: readonly ParsedJiraDraftItem[],
): readonly ParsedJiraDraftItem[] | undefined {
  const refs = new Set(items.map((item) => item.ref));
  const pending = new Map(items.map((item) => [item.ref, jiraDraftDependencies(item)]));
  for (const [ref, dependencies] of pending)
    if (dependencies.some((dependency) => dependency === ref || !refs.has(dependency)))
      return undefined;
  const ordered: ParsedJiraDraftItem[] = [];
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
  return ordered === undefined ? undefined : { items: withIdentities(ordered) };
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
/** A relation is what it points at: an existing issue's key, or the identity of a draft item. */
function relationScope(related: JiraDraftTarget, identities: ReadonlyMap<string, string>): string {
  return related.issueKey === undefined
    ? `item:${identities.get(related.ref ?? "") ?? ""}`
    : `issue:${related.issueKey}`;
}
function identitySignature(
  item: ParsedJiraDraftItem,
  identities: ReadonlyMap<string, string>,
): string {
  return canonicalise({
    projectId: item.projectId,
    issueTypeId: item.issueTypeId,
    summary: normalizedSummary(item.fields),
    parent:
      item.parent === undefined
        ? null
        : { fieldId: item.parent.fieldId, scope: relationScope(item.parent, identities) },
    links: item.links
      .map((link) =>
        canonicalise({
          type: link.type,
          direction: link.direction,
          scope: relationScope(link, identities),
        }),
      )
      .sort(compareByCodeUnit),
  });
}
/**
 * The deterministic identity each draft item leaves on its issue (items arrive in dependency
 * order, so a referenced item's identity exists before the items that reference it). It depends on
 * where the issue is created, what it is called and what it hangs from — its parent and relations,
 * resolved to the target issue's key or the target item's own identity — but not on the
 * conversation or the draft-local `ref`, so re-running the same draft later reconciles to the
 * issue that exists instead of creating a second one. Items identical in all of that are told
 * apart by their order of occurrence, so two identical siblings stay two issues.
 */
function withIdentities(ordered: readonly ParsedJiraDraftItem[]): readonly JiraDraftItem[] {
  const identities = new Map<string, string>();
  const occurrences = new Map<string, number>();
  const identified = ordered.map((item) => {
    const signature = identitySignature(item, identities);
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    const digest = sha256Hex(
      occurrence === 0 ? signature : canonicalise({ signature, occurrence }),
    );
    const identity = `${JIRA_DRAFT_IDENTITY_PREFIX}${digest.slice(0, 20)}`;
    identities.set(item.ref, identity);
    return { ...item, identity };
  });
  const searchable = identified.map((item) => unlabelledSignature(item, identities));
  const counts = new Map<string, number>();
  for (const signature of searchable) counts.set(signature, (counts.get(signature) ?? 0) + 1);
  return identified.map((item, index) => ({
    ...item,
    unlabelledTwin: (counts.get(searchable[index] ?? "") ?? 0) > 1,
  }));
}
/** What an unlabelled identity search can tell apart: links and order are invisible to it. */
function unlabelledSignature(
  item: ParsedJiraDraftItem,
  identities: ReadonlyMap<string, string>,
): string {
  return canonicalise({
    projectId: item.projectId,
    issueTypeId: item.issueTypeId,
    summary: normalizedSummary(item.fields),
    parent: item.parent === undefined ? null : relationScope(item.parent, identities),
  });
}
export function jiraDraftIdentity(item: JiraDraftItem): string {
  return item.identity;
}

/** The key of an issue a relation names; a draft item's key is known once it exists. */
function relatedKey(
  related: JiraDraftTarget,
  keys: ReadonlyMap<string, string>,
): string | undefined {
  return related.issueKey ?? (related.ref === undefined ? undefined : keys.get(related.ref));
}
/** The key the item's parent has, or undefined without a parent or while the parent has no key. */
export function jiraDraftParentKey(
  item: JiraDraftItem,
  keys: ReadonlyMap<string, string>,
): string | undefined {
  return item.parent === undefined ? undefined : relatedKey(item.parent, keys);
}

/** Relations resolved to issue keys; undefined while a referenced item has no key. */
export function resolveJiraDraftItem(
  item: JiraDraftItem,
  keys: ReadonlyMap<string, string>,
): CatalogJsonObject | undefined {
  const parentKey = jiraDraftParentKey(item, keys);
  const links = item.links.map((link) => ({
    type: link.type,
    direction: link.direction,
    issueKey: relatedKey(link, keys),
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
function identityQuery(item: JiraDraftItem, labelled: boolean): string {
  const scope = `project = ${item.projectId} AND issuetype = ${item.issueTypeId}`;
  if (labelled) return `${scope} AND labels = ${jqlString(item.identity)}`;
  // Without a labels field the exact summary is the identity; Jira's text match is only a filter.
  const phrase = '"' + normalizedSummary(item.fields) + '"';
  return `${scope} AND summary ~ ${jqlString(phrase)}`;
}
/** What the search reads back: the summary, and the parent field an unlabelled match must share. */
function searchFields(item: JiraDraftItem, labelled: boolean): string {
  return labelled || item.parent === undefined ? "summary" : `summary,${item.parent.fieldId}`;
}
function issueKeyOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const key = asRecord(value)?.key;
  return typeof key === "string" ? key : undefined;
}
function sameUnlabelledIssue(
  fields: Readonly<Record<string, unknown>>,
  item: JiraDraftItem,
  parentKey: string | undefined,
): boolean {
  if (normalizedSummary(fields) !== normalizedSummary(item.fields)) return false;
  return (
    item.parent === undefined ||
    (parentKey !== undefined && issueKeyOf(fields[item.parent.fieldId]) === parentKey)
  );
}
interface FoundIssue {
  readonly key: string;
  readonly id: string;
}
/** A search candidate whose required identity (key and numeric id) was validated. */
interface Candidate extends FoundIssue {
  readonly fields: Readonly<Record<string, unknown>>;
}
function candidateOf(value: unknown): Candidate | undefined {
  const issue = asRecord(value);
  const key = issue?.key;
  const id = issue?.id;
  if (!isSafeAtlassianIdentifier(key) || !numericId(id)) return undefined;
  return { key, id, fields: asRecord(issue?.fields) ?? {} };
}
/** Every candidate of a page with its identity, or undefined while any one of them lacks it. */
function candidatesOf(issues: readonly unknown[]): readonly Candidate[] | undefined {
  const candidates = issues.map(candidateOf);
  return candidates.every((candidate) => candidate !== undefined) ? candidates : undefined;
}
function matchingIssues(
  candidates: readonly Candidate[],
  item: JiraDraftItem,
  labelled: boolean,
  parentKey: string | undefined,
): readonly FoundIssue[] {
  return candidates
    .filter((candidate) => labelled || sameUnlabelledIssue(candidate.fields, item, parentKey))
    .map(({ key, id }) => ({ key, id }));
}

/** Candidates are read in pages of this size, up to the page ceiling below (500 candidates). */
export const JIRA_DRAFT_SEARCH_PAGE_SIZE = 50;
export const JIRA_DRAFT_SEARCH_PAGES_MAX = 10;
type Candidates =
  | { readonly ok: true; readonly candidates: readonly Candidate[] }
  | { readonly ok: false; readonly attempt: JiraMutationAttempt };
function refusedSearch(reason: AtlassianConnectorWriteFailureReason): Candidates {
  return { ok: false, attempt: { ok: false, reason } };
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
interface SearchPage {
  /** The candidate count the page states, or null when it states none. */
  readonly total: number | null;
  readonly size: number;
}
function pageSize(value: unknown): number | undefined {
  const size = value === undefined ? JIRA_DRAFT_SEARCH_PAGE_SIZE : count(value);
  return size === 0 ? undefined : size;
}
function pageTotal(value: unknown): number | null | undefined {
  return value === undefined ? null : count(value);
}
function consistentPage(
  startAt: number,
  served: number,
  size: number,
  total: number | null,
): boolean {
  if (served > size) return false;
  if (total === null) return true;
  // A page that ends before the total is reached must have served something, or the search stalls.
  return startAt + served <= total && (served > 0 || startAt >= total);
}
/**
 * The page's own statement of where it starts, how large a page Jira honours and how many
 * candidates exist, or undefined when that statement is missing, malformed or contradicts the
 * request or the page it came with. Such a page proves nothing about absence.
 */
function readSearchPage(
  body: Readonly<Record<string, unknown>> | undefined,
  startAt: number,
  served: number,
): SearchPage | undefined {
  const size = pageSize(body?.maxResults);
  const total = pageTotal(body?.total);
  if (body?.startAt !== startAt || size === undefined || total === undefined) return undefined;
  return consistentPage(startAt, served, size, total)
    ? { total, size: Math.min(size, JIRA_DRAFT_SEARCH_PAGE_SIZE) }
    : undefined;
}
/** Where the next page starts, or undefined once the search is complete. */
function nextPageStart(page: SearchPage, startAt: number, served: number): number | undefined {
  if (served === 0) return undefined;
  const reached = startAt + served;
  // Without a total, a page shorter than the size Jira honours is the last one.
  if (page.total === null) return served < page.size ? undefined : reached;
  return reached < page.total ? reached : undefined;
}
/**
 * Every candidate of the search, page by page. A search that cannot be completed within the page
 * ceiling, or whose pages contradict themselves, is refused: deciding an item is absent from part
 * of the candidates would create a duplicate of an issue on a page that was never read.
 */
async function collectCandidates(
  request: JiraMutationRequest,
  base: URLSearchParams,
  startAt: number,
  collected: readonly Candidate[],
): Promise<Candidates> {
  const params = new URLSearchParams(base);
  params.set("startAt", String(startAt));
  const response = await request(`search?${params.toString()}`, "GET");
  if (!response.ok) return refusedSearch(response.reason);
  const issues = asArray(response.body?.issues);
  const page =
    issues === undefined ? undefined : readSearchPage(response.body, startAt, issues.length);
  const candidates = issues === undefined ? undefined : candidatesOf(issues);
  if (issues === undefined || page === undefined || candidates === undefined)
    return refusedSearch("malformed-payload");
  const all = [...collected, ...candidates];
  const next = nextPageStart(page, startAt, issues.length);
  if (next === undefined) return { ok: true, candidates: all };
  if (next >= JIRA_DRAFT_SEARCH_PAGES_MAX * JIRA_DRAFT_SEARCH_PAGE_SIZE)
    return refusedSearch("bounds-exceeded");
  return collectCandidates(request, base, next, all);
}

// Merging twins would create one issue where the draft asked for two, and a rerun could not tell
// which existing issue is which; refusing before anything is sent keeps both outcomes honest.
const UNLABELLED_TWIN: JiraMutationAttempt = {
  ok: false,
  reason: "conflict",
  detail: {
    messages: [
      "This create screen offers no labels field, so items with the same summary and parent cannot be told apart. Give each item a distinct summary.",
    ],
  },
};
export type JiraDraftReconciliation =
  | { readonly kind: "absent" }
  | { readonly kind: "existing"; readonly attempt: JiraMutationAttempt }
  | { readonly kind: "refused"; readonly attempt: JiraMutationAttempt };
/**
 * Finds the issue this item already created. One match reconciles to it without sending
 * anything; several matches, or a search too large to read completely, refuse the item rather
 * than guess. Without a labels field the item's parent (its resolved key) tells siblings apart.
 */
export async function reconcileJiraDraftItem(
  request: JiraMutationRequest,
  item: JiraDraftItem,
  metadata: readonly JiraFieldMetadata[],
  parentKey: string | undefined,
): Promise<JiraDraftReconciliation> {
  const labelled = labelsWritable(metadata);
  if (!labelled && item.unlabelledTwin) return { kind: "refused", attempt: UNLABELLED_TWIN };
  if (!labelled && item.parent !== undefined && parentKey === undefined) return { kind: "absent" };
  const base = new URLSearchParams({
    jql: identityQuery(item, labelled),
    fields: searchFields(item, labelled),
    maxResults: String(JIRA_DRAFT_SEARCH_PAGE_SIZE),
  });
  const candidates = await collectCandidates(request, base, 0, []);
  if (!candidates.ok) return { kind: "refused", attempt: candidates.attempt };
  const found = matchingIssues(candidates.candidates, item, labelled, parentKey);
  if (found.length > 1) return { kind: "refused", attempt: { ok: false, reason: "conflict" } };
  const issue = found[0];
  return issue === undefined
    ? { kind: "absent" }
    : {
        kind: "existing",
        attempt: { ok: true, receipt: { issueKey: issue.key, issueId: issue.id } },
      };
}
