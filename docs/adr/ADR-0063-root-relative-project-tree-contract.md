# ADR-0063: Root-relative project-tree file-identifier contract

## Status

Accepted (Issue #1374, Epic #1491).

## Context

The Files browser and the agent-native editor exchange file identifiers with the BFF as two
separate fields: an absolute `root` (the selected workspace root) and a `path` that is interpreted
relative to that root. The server enforces this strictly — `keiko-server/src/files.ts`
`normalizeRelativePath` rejects any absolute `path` with `400 BAD_PATH`
("The path must be relative to the selected root.") before touching the filesystem, and a containment
+ realpath + deny-list pipeline rejects traversal and symlink escapes.

The contract was, however, **implicit**. The wire types in `keiko-contracts/src/bff-wire.ts`
(`FilesTreeEntry.path`, `FilesContentResponse.path`, `FilesWriteRequest.path`, …) carried a bare,
undocumented `readonly path: string`, and the browser performed the absolute → root-relative
conversion in **two divergent places**:

- `EditorWidget.normalizeEditorFile` did a real root-prefix strip but, when a candidate did not live
  under the configured root, returned the **raw absolute path** — which then reached
  `fetchFilesContent(root, path)` and produced the user-visible "absolute-path editor load failure".
- `workspaceActions.normalizeEditorOpenPath` only stripped a leading slash, so an absolute path that
  re-included the root (`/repo/src/a.ts`) became a malformed non-root-relative `repo/src/a.ts`.

There was no single, tested definition of "a valid root-relative file identifier", and no contract
the editor compiled against. Issue #1374 requires hardening arbitrary-folder opening **without
introducing a new workspace or project-tree subsystem**.

## Decision

### D1 — One tested contract module, reusing the existing guard

Add a pure, strict-leaf contract module `keiko-contracts/src/editor-workspace-path.ts` that owns the
root-relative file-identifier contract:

- `isRootRelativeFileIdentifier(value)` — the single guard, delegating to the existing
  `isContainedAgentPath` (the agent-action surface's root-relative predicate) so one definition of
  "contained, root-relative" governs the file tree, the editor, and agent actions.
- `resolveWorkspaceFileIdentifier(root, candidate)` — turns a possibly-absolute candidate (any
  separator) into a discriminated result: `empty` | `root` | `relative` (root-relative) |
  `outside-root`. It **never** returns an absolute path.
- `selectWorkspaceFileTarget(root, candidate)` — resolves the `{ root, file }` pair the editor should
  open. A relative or absolute-inside-root candidate keeps `root`; a single absolute file outside it
  selects its containing directory as the root; an unresolvable candidate yields `null` for a clear
  non-blocking state.

The module imports no other `@oscharko-dev/keiko-*` package and touches no IO/clock/crypto (ADR-0019
leaf rules), so it is safe in the browser bundle.

### D2 — Single-source the browser conversion

`EditorWidget.normalizeEditorFile` and `workspaceActions.toRootRelativeOpenPath` are both routed
through the contract. An absolute path outside the root now resolves to "" / a non-blocking state in
the editor, and the chat repository-reference path keeps its established leading-slash
"from-the-repo-root" semantics (coerced under the selected root, never re-anchored to a different
machine root). The editor can no longer hand the BFF an absolute identifier.

### D3 — Document the invariant on the wire types, do not loosen the server

The `bff-wire.ts` Files section now documents that `root` is absolute and every `path` is
root-relative, and that the directory-picker (`FilesDirectoryListing`) is the lone absolute-path
shape whose entries must be converted before reuse as a file id. The strict server rejection is kept
as-is: the fix is client-side normalization plus documentation, not a widening of the server's
accepted input.

## Consequences

- The "absolute-path editor load failure" is closed at its source: opening the current repo, a nested
  project folder, or a single file keeps every load root-relative.
- The contract is executable and tested (`editor-workspace-path.test.ts`), and the server half is
  pinned by a content/tree absolute-rejection test in `files.test.ts`.
- No new subsystem is introduced (AC5): the change reuses `isContainedAgentPath`, the existing
  `bff-wire` Files shapes, and the existing FilesWidget/editor components.

## Limitations

- Root-prefix matching is lexical and case-insensitive (preserving the editor's historic behavior and
  the common macOS/Windows case-insensitive filesystem); it does not resolve symlinks. Server-side
  realpath containment remains the authority for symlink-escape protection.
- Containing-root derivation for a single absolute file is a client convenience; the BFF still
  validates and may reject the derived root (deny-list, not-a-directory), surfaced as a non-blocking
  state.

## Alternatives considered

- **Refactor `keiko-server/src/files.ts` to reuse `keiko-workspace` containment helpers.** Deferred:
  a large, security-sensitive change to the strict server that is not required to satisfy any
  acceptance criterion, and the server already rejects absolute identifiers correctly.
- **Make the BFF accept absolute `path` identifiers.** Rejected: it would widen the containment
  surface and weaken the security posture; the contract keeps the server strict and fixes the client.
- **A new branded `RootRelativePath` type / new project-tree subsystem.** Rejected per AC5; a small
  reused guard plus documentation is sufficient.
