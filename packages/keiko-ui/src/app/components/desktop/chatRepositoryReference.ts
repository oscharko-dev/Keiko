// GEN-MAINT-COMPLEXITY-003 — pure repository-reference string helpers extracted verbatim from
// ChatWindow. These normalize repository roots/paths, insert and remove `@path` mentions in the
// composer draft, and detect mention paths in free text. They are pure functions of string args with
// no React, DOM, or domain-type coupling, so ChatWindow imports them back from this testable leaf.
//
// NOTE: `connectedRepositoryRoots` was intentionally left in ChatWindow — it depends on the `Chat`
// domain type and the `effectiveConnectedScopes`/`rootDisplayName` helpers that stay there, so it is
// not a clean pure leaf and moving it would pull the chat domain type into this module.

export function normalizedRepositoryRoot(root: string): string {
  return root.replace(/\\/gu, "/").replace(/\/+$/u, "");
}

export function repositoryRootContains(parentRoot: string, childRoot: string): boolean {
  const parent = normalizedRepositoryRoot(parentRoot);
  const child = normalizedRepositoryRoot(childRoot);
  return parent.length > 0 && child.length > parent.length && child.startsWith(`${parent}/`);
}

export function omitAncestorRepositoryRoots(roots: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const root of roots) {
    const trimmed = root.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique.filter(
    (root) =>
      !unique.some((candidate) => candidate !== root && repositoryRootContains(root, candidate)),
  );
}

export function normalizedRepositoryPath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\/+/u, "").replace(/\/+$/u, "");
}

export function appendRepositoryReference(draft: string, path: string): string {
  const mention = `@${path}`;
  if (draft.split(/\s+/u).includes(mention)) return draft;
  const trimmed = draft.trimEnd();
  return trimmed.length === 0 ? mention : `${trimmed} ${mention}`;
}

export function repositoryReferenceId(root: string, path: string): string {
  return `${root}\u0001${path}`;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function repositoryReferenceMentionPattern(path: string): RegExp {
  return new RegExp(`(^|\\s)@${escapeRegExp(path)}(?=$|\\s)`, "gu");
}

export function removeRepositoryReferenceFromDraft(draft: string, path: string): string {
  const next = draft
    .replace(repositoryReferenceMentionPattern(path), "$1")
    .replace(/[ \t]{2,}/gu, " ");
  return next.trim().length === 0 ? "" : next;
}

const COMPOSER_REPOSITORY_REFERENCE_PATTERN =
  /(^|\s)@((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9][A-Za-z0-9]{0,15})(?=$|\s)/gu;

export function repositoryReferenceMentionPaths(draft: string): readonly string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  COMPOSER_REPOSITORY_REFERENCE_PATTERN.lastIndex = 0;
  for (;;) {
    const match = COMPOSER_REPOSITORY_REFERENCE_PATTERN.exec(draft);
    if (match === null) break;
    const path = normalizedRepositoryPath(match[2] ?? "");
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}
