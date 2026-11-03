import {
  CODING_WORKBENCH_PROMPT_REFERENCES_MAX,
  isCodingWorkbenchPromptReferencePath,
  type CodingWorkbenchPromptReference,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

// Pure string helpers for the `@` file references of a Coding Workbench prompt (ADR-0137 D10). The
// draft holds the human's own text; the references are the files they picked from the task
// workspace's file search, kept by path relative to the run's workspace root. The server decides
// whether each path names a contained, non-sensitive text file; nothing here is authority.

/** The `@` token being typed: its range in the draft and the query after the `@`. */
export interface FileMention {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/** A search result reduced to what the picker shows and the prompt references. */
export interface FileReferenceOption {
  readonly path: string;
  readonly name: string;
  readonly directory: string;
}

/**
 * The mention the caret is inside, when there is one: an `@` at the start of the draft or after
 * whitespace or an opening bracket, followed by characters up to the caret that contain neither
 * whitespace nor another `@`. An `@` inside a word (an e-mail address, a decorator written without
 * a space) never opens the picker.
 */
export function fileMentionAtCursor(value: string, cursor: number): FileMention | null {
  const end = Math.max(0, Math.min(cursor, value.length));
  const prefix = value.slice(0, end);
  const start = prefix.lastIndexOf("@");
  if (start < 0) return null;
  const before = start === 0 ? "" : (prefix[start - 1] ?? "");
  if (before.length > 0 && !/[\s([{]/u.test(before)) return null;
  const query = prefix.slice(start + 1);
  if (/[\s@]/u.test(query)) return null;
  return { start, end, query };
}

/** How a picked path is written into the draft: quoted when it holds whitespace. */
export function fileMentionText(path: string): string {
  return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
}

/** The draft with the mention under the caret replaced by the picked file, and the new caret. */
export function insertFileMention(
  draft: string,
  mention: FileMention,
  path: string,
): { readonly value: string; readonly cursor: number } {
  const prefix = draft.slice(0, mention.start);
  const suffix = draft.slice(mention.end);
  const reference = fileMentionText(path);
  const needsSpace = suffix.length === 0 || !/^[\s.,;:!?)}\]]/u.test(suffix);
  const inserted = needsSpace ? `${reference} ` : reference;
  return { value: `${prefix}${inserted}${suffix}`, cursor: prefix.length + inserted.length };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function mentionPattern(path: string): RegExp {
  return new RegExp(
    String.raw`(^|[\s([{])${escapeRegExp(fileMentionText(path))}(?=$|[\s.,;:!?)\]}])`,
    "gu",
  );
}

/** Whether the draft still names the picked file as a whole token. */
export function draftMentionsPath(draft: string, path: string): boolean {
  return mentionPattern(path).test(draft);
}

/** The draft without the token that names `path`, with the whitespace around it collapsed. */
export function removeFileMention(draft: string, path: string): string {
  const next = draft.replace(mentionPattern(path), "$1").replace(/[ \t]{2,}/gu, " ");
  return next.trim().length === 0 ? "" : next;
}

/**
 * The references a draft sends: the picked files the draft still names, once each, in the order
 * they were picked, within the contract's bound. A file whose mention the human deleted from the
 * text is no longer referenced, so what is sent is what the message shows.
 */
export function referencesInDraft(
  draft: string,
  picked: readonly string[],
): readonly CodingWorkbenchPromptReference[] {
  const seen = new Set<string>();
  const references: CodingWorkbenchPromptReference[] = [];
  for (const path of picked) {
    if (seen.has(path) || !draftMentionsPath(draft, path)) continue;
    seen.add(path);
    references.push({ path });
    if (references.length === CODING_WORKBENCH_PROMPT_REFERENCES_MAX) break;
  }
  return references;
}

/** What the picker may add: a valid path that is not already picked, within the bound. */
export function canPickReference(picked: readonly string[], path: string): boolean {
  return (
    isCodingWorkbenchPromptReferencePath(path) &&
    !picked.includes(path) &&
    picked.length < CODING_WORKBENCH_PROMPT_REFERENCES_MAX
  );
}

function posixRoot(root: string): string {
  let end = root.replaceAll("\\", "/").length;
  const normalized = root.replaceAll("\\", "/");
  while (end > 0 && normalized[end - 1] === "/") end -= 1;
  return normalized.slice(0, end);
}

/**
 * A file search result as a path relative to the run's workspace root, or `null` when the result
 * lies outside it. The search may rebase a hit onto a nested Git root (`root` is then that nested
 * root and `path` is relative to it), so the path is joined back onto the searched root; a result
 * whose root is not the searched root or below it is dropped, never guessed.
 */
export function workspaceRelativeReferencePath(
  searchedRoot: string,
  result: { readonly root: string; readonly path: string },
): string | null {
  const base = posixRoot(searchedRoot);
  const root = posixRoot(result.root);
  const path = result.path.replaceAll("\\", "/");
  let relative: string;
  if (root === base) relative = path;
  else if (root.startsWith(`${base}/`)) relative = `${root.slice(base.length + 1)}/${path}`;
  else return null;
  return isCodingWorkbenchPromptReferencePath(relative) ? relative : null;
}

export function fileReferenceOption(
  searchedRoot: string,
  result: { readonly root: string; readonly path: string; readonly name: string },
): FileReferenceOption | null {
  const path = workspaceRelativeReferencePath(searchedRoot, result);
  if (path === null) return null;
  const slash = path.lastIndexOf("/");
  return { path, name: result.name, directory: slash < 0 ? "" : path.slice(0, slash) };
}
