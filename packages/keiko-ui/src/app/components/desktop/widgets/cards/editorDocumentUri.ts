// GEN-MAINT-COMPLEXITY-001 — pure URI/id helpers extracted verbatim from EditorRuntimeWidget. These
// derive stable, filesystem-path-free Monaco model URIs, DOM-safe id segments, and the window-scoped
// session-cache key from a (root, file) pair. They are pure functions of string args with no DOM or
// React coupling, so EditorRuntimeWidget imports them back from this testable leaf.

export function safeDomIdSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/gu, "-");
  return safe.length > 0 ? safe : "editor";
}

export function rootHash(root: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < root.length; index += 1) {
    hash ^= root.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function encodePathSegments(path: string): string {
  return path
    .split(/[\\/]+/)
    .map(encodeURIComponent)
    .join("/");
}

/** A stable, window-scoped Monaco model URI for a (root, file) pair, without exposing a filesystem path. */
export function documentUri(root: string, file: string, modelScope: string): string {
  return `keiko-editor://workspace/${modelScope}/${rootHash(root)}/${encodePathSegments(file)}`;
}

export function documentSessionKey(root: string, file: string): string {
  return `${root}\u0000${file}`;
}
