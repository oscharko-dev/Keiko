// The workspace members npm would install (ADR-0043 D17). npm installs what each member's own
// package.json declares, so the dependency bootstrap's source check has to reach every member npm
// would find. The `workspaces` patterns are resolved the way npm resolves them
// (@npmcli/map-workspaces): a pattern names folders, node_modules is never searched, and a wildcard
// never matches a dot-folder the pattern does not spell out. Where that is safe the result
// over-approximates npm's: a negated pattern only ever removes members, so it is ignored, and a
// wildcard matches without regard to letter case, as npm's does on macOS and Windows. What cannot be
// enumerated cannot be checked: glob syntax beyond `*` and `**`, a folder a symbolic link places
// outside the workspace, and a search past its bounds resolve to no answer, which the bootstrap
// refuses.
import { join } from "node:path";
import {
  isWithinWorkspace,
  type WorkspaceDirEntry,
  type WorkspaceFs,
  type WorkspaceStat,
} from "@oscharko-dev/keiko-workspace";

/** How far one resolution may search before it gives up rather than check a partial member list. */
export interface WorkspaceMemberLimits {
  // Folders visited across every pattern.
  readonly maxFolders: number;
  // Entries read from any one folder.
  readonly maxEntries: number;
}

export const WORKSPACE_MEMBER_LIMITS: WorkspaceMemberLimits = Object.freeze({
  maxFolders: 10_000,
  maxEntries: 10_000,
});

// Pattern syntax other than `*` and `**`: a one-character wildcard, a class, braces, an extglob.
const UNRESOLVED_GLOB = /[?[\]{}()]/u;
const NEGATION = /^!+/u;

type ParsedPattern =
  | { readonly kind: "adds"; readonly segments: readonly string[] }
  | { readonly kind: "removes" }
  | { readonly kind: "unresolved" };

interface Search {
  readonly fs: WorkspaceFs;
  readonly root: string;
  readonly limits: WorkspaceMemberLimits;
  readonly members: Set<string>;
  folders: number;
}

// Where a path leads: a folder to continue from, nothing npm would match, or a folder outside the
// workspace.
type Destination =
  | { readonly kind: "folder"; readonly path: string }
  | { readonly kind: "absent" }
  | { readonly kind: "outside" };

const ABSENT: Destination = Object.freeze({ kind: "absent" });
const OUTSIDE: Destination = Object.freeze({ kind: "outside" });

function folderAt(path: string): Destination {
  return { kind: "folder", path };
}

/**
 * The canonical folders `patterns` name below `root`: every workspace member npm would install, and
 * possibly more. Undefined when they cannot all be enumerated.
 */
export function workspaceMemberRoots(
  root: string,
  patterns: readonly string[],
  fs: WorkspaceFs,
  limits: WorkspaceMemberLimits = WORKSPACE_MEMBER_LIMITS,
): readonly string[] | undefined {
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realPath(root);
  } catch {
    return undefined;
  }
  const search: Search = { fs, root: canonicalRoot, limits, members: new Set(), folders: 0 };
  for (const pattern of patterns) {
    const parsed = parsePattern(pattern);
    if (parsed.kind === "removes") continue;
    if (parsed.kind === "unresolved" || !expand(search, canonicalRoot, parsed.segments)) {
      return undefined;
    }
  }
  return [...search.members];
}

// As npm reads a pattern: an odd number of leading `!` removes members, and a leading `./` or `/`
// and empty or `.` segments name nothing.
function parsePattern(pattern: string): ParsedPattern {
  const negations = NEGATION.exec(pattern)?.[0].length ?? 0;
  if (negations % 2 === 1) return { kind: "removes" };
  const body = pattern.slice(negations);
  if (UNRESOLVED_GLOB.test(body)) return { kind: "unresolved" };
  return { kind: "adds", segments: body.split("/").filter((part) => part !== "" && part !== ".") };
}

// Walks a pattern's remaining segments from `folder`; false when the walk cannot be completed.
function expand(search: Search, folder: string, segments: readonly string[]): boolean {
  search.folders += 1;
  if (search.folders > search.limits.maxFolders) return false;
  const [head, ...rest] = segments;
  if (head === undefined) {
    search.members.add(folder);
    return true;
  }
  // npm ignores every match inside a node_modules folder.
  if (head === "node_modules") return true;
  if (head === "**") return expandGlobstar(search, folder, rest);
  if (head.includes("*")) return expandWildcard(search, folder, head, rest);
  return follow(search, destinationOf(search, join(folder, head)), rest);
}

// Nothing to match adds no member; a folder outside the workspace ends the walk.
function follow(search: Search, destination: Destination, rest: readonly string[]): boolean {
  if (destination.kind === "outside") return false;
  return destination.kind === "absent" || expand(search, destination.path, rest);
}

function destinationOf(search: Search, path: string): Destination {
  let stat: WorkspaceStat;
  try {
    stat = search.fs.stat(path);
  } catch {
    return ABSENT;
  }
  if (stat.isSymbolicLink) return linkedDestination(search, path);
  return stat.isDirectory ? folderAt(path) : ABSENT;
}

// A symbolic link leads where it resolves, which has to be inside the workspace; one that resolves to
// nothing, or to a file, is nothing npm would match.
function linkedDestination(search: Search, path: string): Destination {
  let target: string;
  try {
    target = search.fs.realPath(path);
  } catch {
    return ABSENT;
  }
  if (!isWithinWorkspace(search.root, target)) return OUTSIDE;
  return destinationOf(search, target);
}

function entryDestination(search: Search, folder: string, entry: WorkspaceDirEntry): Destination {
  const path = join(folder, entry.name);
  if (entry.isSymbolicLink) return linkedDestination(search, path);
  return entry.isDirectory ? folderAt(path) : ABSENT;
}

function expandWildcard(
  search: Search,
  folder: string,
  segment: string,
  rest: readonly string[],
): boolean {
  const entries = listed(search, folder);
  if (entries === undefined) return false;
  for (const entry of entries) {
    if (!wildcardAdmits(segment, entry.name)) continue;
    if (!follow(search, entryDestination(search, folder, entry), rest)) return false;
  }
  return true;
}

// `**` stands for the folder itself and every folder below it. Like npm's glob it never descends
// into a symbolic link, a dot-folder or node_modules; a linked folder can still be where the rest of
// the pattern starts.
function expandGlobstar(search: Search, folder: string, rest: readonly string[]): boolean {
  if (!expand(search, folder, rest)) return false;
  const entries = listed(search, folder);
  if (entries === undefined) return false;
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(folder, entry.name);
    const walked = entry.isSymbolicLink
      ? follow(search, linkedDestination(search, path), rest)
      : !entry.isDirectory || expand(search, path, ["**", ...rest]);
    if (!walked) return false;
  }
  return true;
}

// A folder's entries, or undefined when it cannot be read whole within the bounds.
function listed(search: Search, folder: string): readonly WorkspaceDirEntry[] | undefined {
  try {
    const entries = search.fs.readDir(folder, search.limits.maxEntries + 1);
    return entries.length > search.limits.maxEntries ? undefined : entries;
  } catch {
    return undefined;
  }
}

function wildcardAdmits(segment: string, name: string): boolean {
  if (name === "node_modules") return false;
  if (name.startsWith(".") && !segment.startsWith(".")) return false;
  return matchesWildcard(segment.toLowerCase(), name.toLowerCase());
}

// `*` stands for any run of characters within a name, and `segment` holds at least one. The greedy
// match below is linear in the name, where a regular expression built from a repository's own
// pattern could backtrack without bound.
function matchesWildcard(segment: string, name: string): boolean {
  const parts = segment.split("*");
  const first = parts[0] ?? "";
  const last = parts.at(-1) ?? "";
  if (name.length < first.length + last.length) return false;
  if (!name.startsWith(first) || !name.endsWith(last)) return false;
  const end = name.length - last.length;
  let position = first.length;
  for (const part of parts.slice(1, -1)) {
    const found = name.indexOf(part, position);
    if (found === -1 || found + part.length > end) return false;
    position = found + part.length;
  }
  return true;
}
