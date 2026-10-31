// Presentation model of a proposed Jira backlog draft (#4178). The server parses and orders the
// draft authoritatively; this only shows the human what they approve and which items a
// deselection also leaves out, using the same rule: an item depends on its parent and linked items.

export interface JiraDraftTreeLink {
  readonly type: string;
  readonly direction: "inward" | "outward";
  /** Another draft item's ref, or an existing issue key. */
  readonly target: string;
  readonly existing: boolean;
}
export interface JiraDraftTreeItem {
  readonly ref: string;
  readonly summary: string;
  /** Field ids the item sets besides its summary, for an honest "more fields" hint. */
  readonly otherFieldCount: number;
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
function parentOf(value: unknown): Pick<JiraDraftTreeItem, "parentRef" | "parentIssueKey"> {
  const parent = record(value);
  const parentRef = text(parent?.ref);
  const parentIssueKey = text(parent?.issueKey);
  return {
    ...(parentRef === undefined ? {} : { parentRef }),
    ...(parentIssueKey === undefined ? {} : { parentIssueKey }),
  };
}
function itemOf(value: unknown): FlatItem | undefined {
  const raw = record(value);
  const ref = text(raw?.ref);
  const fields = record(raw?.fields);
  const summary = text(fields?.summary);
  const links = linksOf(raw?.links);
  if (ref === undefined || fields === undefined || summary === undefined || links === undefined)
    return undefined;
  return {
    ref,
    summary,
    otherFieldCount: Object.keys(fields).filter((id) => id !== "summary").length,
    links,
    linkRefs: links.filter((link) => !link.existing).map((link) => link.target),
    ...parentOf(raw?.parent),
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
