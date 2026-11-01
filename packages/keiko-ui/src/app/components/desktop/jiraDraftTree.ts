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
/**
 * A field value as the human reads it, never as JSON: text, a list, a named group of members (every
 * member stays visible), an explicit clearing or an empty collection. Past the nesting bound the
 * remaining subtree is flattened into dotted-path members, so no approved leaf is ever unseen.
 */
export type JiraDraftValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "list"; readonly items: readonly JiraDraftListEntry[] }
  | { readonly kind: "group"; readonly members: readonly JiraDraftMember[] }
  | { readonly kind: "cleared" }
  | { readonly kind: "empty" };
/** A named member of a group value, in request order. */
interface JiraDraftMember {
  readonly name: string;
  readonly value: JiraDraftValue;
}
/** A list entry keeps its 1-based place in the request, which is also its stable key. */
interface JiraDraftListEntry {
  readonly position: number;
  readonly value: JiraDraftValue;
}
export interface JiraDraftField {
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
  /** Requirement references the item carries into its trace footer, as the model named them. */
  readonly requirementIds: readonly string[];
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
function requirementIdsOf(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as readonly string[])
    : undefined;
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

// An object with one identifying member reads as that member (a user or option); any other object
// is a group that names every member, so no member is hidden.
const IDENTIFYING_MEMBERS: ReadonlySet<string> = new Set([
  "displayName",
  "name",
  "value",
  "key",
  "accountId",
  "id",
]);
// Deeper than any Jira field value; past it the subtree is laid out flat, one dotted path per leaf.
const VALUE_DEPTH_MAX = 6;
function scalarOf(value: unknown): JiraDraftValue | undefined {
  if (typeof value === "string") return { kind: "text", text: value };
  if (value === null || value === undefined) return { kind: "cleared" };
  if (typeof value === "number" || typeof value === "boolean")
    return { kind: "text", text: String(value) };
  return undefined;
}
/** Children of a collection in request order, each under its dotted path (lists by 1-based place). */
function childrenOf(path: string, value: unknown): readonly [string, unknown][] {
  const children: readonly [string, unknown][] = Array.isArray(value)
    ? value.map((entry, index): [string, unknown] => [`${path}.${index + 1}`, entry])
    : Object.entries(record(value) ?? {}).map(([name, entry]): [string, unknown] => [
        `${path}.${name}`,
        entry,
      ]);
  return children;
}
/** Every leaf under a value as a dotted-path member; iterative, so a hostile depth cannot overflow. */
function flattened(value: unknown): readonly JiraDraftMember[] {
  const members: JiraDraftMember[] = [];
  const pending: [string, unknown][] = childrenOf("", value).toReversed();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [path, entry] = next;
    const scalar = scalarOf(entry);
    const children = scalar === undefined ? childrenOf(path, entry) : [];
    if (scalar !== undefined) members.push({ name: path.slice(1), value: scalar });
    else if (children.length === 0) members.push({ name: path.slice(1), value: { kind: "empty" } });
    else pending.push(...children.toReversed());
  }
  return members;
}
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
function collectionOf(value: unknown, depth: number): JiraDraftValue {
  if (Array.isArray(value))
    return value.length === 0
      ? { kind: "empty" }
      : {
          kind: "list",
          items: value.map((entry, index) => ({
            position: index + 1,
            value: valueAt(entry, depth + 1),
          })),
        };
  const members = Object.entries(record(value) ?? {});
  return members.length === 0
    ? { kind: "empty" }
    : {
        kind: "group",
        members: members.map(([name, member]) => ({ name, value: valueAt(member, depth + 1) })),
      };
}
function valueAt(value: unknown, depth: number): JiraDraftValue {
  const scalar = scalarOf(value);
  if (scalar !== undefined) return scalar;
  if (typeof value !== "object") return { kind: "empty" };
  if (depth > VALUE_DEPTH_MAX) return { kind: "group", members: flattened(value) };
  const name = identifying(value);
  return name === undefined ? collectionOf(value, depth) : { kind: "text", text: name };
}
/** A request value as the human reads it; shared by every Jira approval rendering. */
export function jiraDraftValueOf(value: unknown): JiraDraftValue {
  return valueAt(value, 0);
}
function fieldsOf(fields: Raw): readonly JiraDraftField[] {
  return Object.entries(fields)
    .filter(([id]) => id !== "summary")
    .map(([id, value]) => ({ id, value: jiraDraftValueOf(value) }));
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
  const requirementIds = requirementIdsOf(raw?.requirementIds);
  if (
    identity === undefined ||
    fields === undefined ||
    links === undefined ||
    parent === undefined ||
    requirementIds === undefined
  )
    return undefined;
  return {
    ...identity,
    fields: fieldsOf(fields),
    links,
    requirementIds,
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
