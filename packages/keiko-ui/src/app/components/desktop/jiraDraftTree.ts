// Presentation model of a proposed Jira backlog draft (#4178). The server parses and orders the
// draft authoritatively; this only shows the human what they approve and which items a
// deselection also leaves out, using the same rule: an item depends on its parent and linked items.
// Everything shown is read from the exact request the human approves: target project and issue
// type, the relation field and every field value, so two drafts that differ anywhere differ here.

interface JiraDraftTreeLink {
  readonly type: string;
  readonly direction: "inward" | "outward";
  /** Another draft item's ref, or an existing issue key. */
  readonly target: string;
  readonly existing: boolean;
}
/** A field value as the human reads it: text, or a list of values. */
export type JiraDraftValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "list"; readonly items: readonly JiraDraftListEntry[] };
/** A list entry keeps its 1-based place in the request, which is also its stable key. */
interface JiraDraftListEntry {
  readonly position: number;
  readonly value: JiraDraftValue;
}
interface JiraDraftField {
  readonly id: string;
  readonly value: JiraDraftValue;
}
export interface JiraDraftTreeItem {
  readonly ref: string;
  readonly summary: string;
  readonly projectId: string;
  readonly issueTypeId: string;
  /** Every field the item sets besides its summary, in request order. */
  readonly fields: readonly JiraDraftField[];
  readonly parentFieldId?: string;
  readonly parentRef?: string;
  readonly parentIssueKey?: string;
  readonly links: readonly JiraDraftTreeLink[];
  readonly children: readonly JiraDraftTreeItem[];
}
export interface JiraDraftTree {
  readonly roots: readonly JiraDraftTreeItem[];
  readonly refs: readonly string[];
}

type Raw = Readonly<Record<string, unknown>>;
function record(value: unknown): Raw | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Raw)
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function linkOf(value: unknown): JiraDraftTreeLink | undefined {
  const raw = record(value);
  const type = text(raw?.type);
  const direction = raw?.direction;
  const ref = text(raw?.ref);
  const target = ref ?? text(raw?.issueKey);
  if (type === undefined || target === undefined) return undefined;
  if (direction !== "inward" && direction !== "outward") return undefined;
  return { type, direction, target, existing: ref === undefined };
}
interface FlatItem extends Omit<JiraDraftTreeItem, "children"> {
  readonly linkRefs: readonly string[];
}
function linksOf(value: unknown): readonly JiraDraftTreeLink[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const links = value.map(linkOf);
  return links.every((link) => link !== undefined) ? links : undefined;
}
type Parent = Pick<JiraDraftTreeItem, "parentFieldId" | "parentRef" | "parentIssueKey">;
/** No parent is fine; a parent that names no field or no single target is not readable. */
function parentOf(value: unknown): Parent | undefined {
  if (value === undefined) return {};
  const parent = record(value);
  const parentFieldId = text(parent?.fieldId);
  const parentRef = text(parent?.ref);
  const parentIssueKey = text(parent?.issueKey);
  if (parentFieldId === undefined || (parentRef === undefined) === (parentIssueKey === undefined))
    return undefined;
  return {
    parentFieldId,
    ...(parentRef === undefined ? {} : { parentRef }),
    ...(parentIssueKey === undefined ? {} : { parentIssueKey }),
  };
}

// An object with one identifying member reads as that member (a user or option); anything else
// stays exact as compact JSON, so no member is hidden.
const IDENTIFYING_MEMBERS: ReadonlySet<string> = new Set([
  "displayName",
  "name",
  "value",
  "key",
  "accountId",
  "id",
]);
function identifying(value: unknown): string | undefined {
  const entries = Object.entries(record(value) ?? {});
  const [only] = entries;
  return entries.length === 1 &&
    only !== undefined &&
    IDENTIFYING_MEMBERS.has(only[0]) &&
    typeof only[1] === "string"
    ? only[1]
    : undefined;
}
function valueOf(value: unknown): JiraDraftValue {
  if (typeof value === "string") return { kind: "text", text: value };
  if (Array.isArray(value) && value.length > 0)
    return {
      kind: "list",
      items: value.map((entry, index) => ({ position: index + 1, value: valueOf(entry) })),
    };
  return { kind: "text", text: identifying(value) ?? JSON.stringify(value) };
}
function fieldsOf(fields: Raw): readonly JiraDraftField[] {
  return Object.entries(fields)
    .filter(([id]) => id !== "summary")
    .map(([id, value]) => ({ id, value: valueOf(value) }));
}
type Identity = Pick<JiraDraftTreeItem, "ref" | "summary" | "projectId" | "issueTypeId">;
function identityOf(raw: Raw | undefined, fields: Raw | undefined): Identity | undefined {
  const ref = text(raw?.ref);
  const summary = text(fields?.summary);
  const projectId = text(raw?.projectId);
  const issueTypeId = text(raw?.issueTypeId);
  return ref === undefined ||
    summary === undefined ||
    projectId === undefined ||
    issueTypeId === undefined
    ? undefined
    : { ref, summary, projectId, issueTypeId };
}
function itemOf(value: unknown): FlatItem | undefined {
  const raw = record(value);
  const fields = record(raw?.fields);
  const identity = identityOf(raw, fields);
  const links = linksOf(raw?.links);
  const parent = parentOf(raw?.parent);
  if (identity === undefined || fields === undefined || links === undefined || parent === undefined)
    return undefined;
  return {
    ...identity,
    fields: fieldsOf(fields),
    links,
    linkRefs: links.filter((link) => !link.existing).map((link) => link.target),
    ...parent,
  };
}

/** The draft as a parent tree, or undefined when the arguments are not a readable draft. */
export function jiraDraftTree(args: unknown): JiraDraftTree | undefined {
  const items = record(args)?.items;
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const flat = items.map(itemOf);
  if (!flat.every((item) => item !== undefined)) return undefined;
  const refs = flat.map((item) => item.ref);
  if (new Set(refs).size !== refs.length) return undefined;
  const known = new Set(refs);
  const build = (item: FlatItem, path: ReadonlySet<string>): JiraDraftTreeItem => {
    const { linkRefs: _linkRefs, ...rest } = item;
    const within = new Set([...path, item.ref]);
    const children = flat
      .filter((child) => child.parentRef === item.ref && !within.has(child.ref))
      .map((child) => build(child, within));
    return { ...rest, children };
  };
  const roots = flat
    .filter((item) => item.parentRef === undefined || !known.has(item.parentRef))
    .map((item) => build(item, new Set()));
  // A cycle the server refuses anyway would hide items; show the exact request instead.
  return countItems(roots) === refs.length ? { roots, refs } : undefined;
}
function countItems(items: readonly JiraDraftTreeItem[]): number {
  return items.reduce((total, item) => total + 1 + countItems(item.children), 0);
}

/** Every ref that depends on a deselected one, through parents and links, transitively. */
export function jiraDraftExcluded(
  args: unknown,
  deselected: ReadonlySet<string>,
): ReadonlySet<string> {
  const items = record(args)?.items;
  const flat = Array.isArray(items) ? items.map(itemOf) : [];
  const dependencies = new Map(
    flat
      .filter((item): item is FlatItem => item !== undefined)
      .map((item) => [
        item.ref,
        [...(item.parentRef === undefined ? [] : [item.parentRef]), ...item.linkRefs],
      ]),
  );
  const excluded = new Set([...deselected].filter((ref) => dependencies.has(ref)));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [ref, needs] of dependencies)
      if (!excluded.has(ref) && needs.some((need) => excluded.has(need))) {
        excluded.add(ref);
        grew = true;
      }
  }
  return excluded;
}
