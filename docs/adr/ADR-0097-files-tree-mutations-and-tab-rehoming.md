# ADR-0097: Editor file-tree mutations (create / rename / delete) and open-tab re-homing

## Status

Accepted (Editor hardening Wave 1, 2026-06-27)

## Version

0.1.0

## Context

The Keiko editor's Files widget was read-only: it could browse, preview, open, and show Git status /
diff, but users could not create, rename, or delete files or folders — the most-requested gap toward a
VS Code-like editing experience. The only existing filesystem mutation was the editor save
(`PATCH /api/files/content`). At the same time, the editor layout state machine had no way to update an
open tab when its file moved or was removed on disk, so any future rename/delete would leave stale tabs
that 404 on the next load.

The constraint is that file mutations are destructive and security-sensitive, and the editor already
has a hardened read surface (`packages/keiko-server/src/files.ts`) whose containment model must be
reused rather than re-implemented: a realpath-resolved root, per-target containment checks that catch
symlink escape, a segment-wise case-insensitive deny-list (`.git`, `node_modules`, `.ssh`, `.env`,
secrets, build output), and metadata redaction. New mutation code must compose those primitives and add
no new trust.

## Decision

### D1 — Three server endpoints reusing the read-surface containment model

Add `POST /api/files/create`, `POST /api/files/rename`, and `POST /api/files/delete`, all wrapped by
the existing `runFilesHandler` → `FilesError` discipline and registered as state-changing methods so the
server's CSRF + JSON gate (`x-keiko-csrf`, `application/json`) applies automatically. No mutation is
exposed on `GET`.

- **create** validates a single safe leaf name, resolves the **parent** directory through the same
  realpath / containment / deny machinery as the read surface (the parent must already exist), and
  creates the entry atomically without overwriting: `writeFile(path, "", { flag: "wx" })` (`O_CREAT |
  O_EXCL`) for a file, non-recursive `mkdir` for a folder. `O_EXCL` is load-bearing — it refuses both an
  existing entry and a final-segment symlink, closing the create-time TOCTOU window without a
  check-then-write race.
- **rename** resolves the source with the existing `resolveInsideRoot` (must exist, be contained, be
  non-denied) and the destination as a creation target (parent contained, leaf valid). It rejects the
  root itself, symlinks, a move of a folder into its own subtree, and any pre-existing destination —
  with one exception: a pure case-only rename on a case-insensitive filesystem, allowed iff the
  destination's realpath equals the source's (realpath identity, never a raw string compare).
- **delete** resolves the target with `resolveInsideRoot`, rejects the root and symlinks, and removes the
  entry (`rm`, recursive for a directory). Containment + the deny-list bound the blast radius; rejecting
  symlinks guarantees `rm` never recurses through a link out of the root.

A single `mapNodeFsError` translates Node errnos (`EEXIST` / `ENOTEMPTY` → 409, `ENOENT` → 404,
`EACCES` / `EPERM` → 403, `EXDEV` → 400, …) into `FilesError`s without ever echoing the absolute path or
the raw OS message, preserving the non-probeable error discipline.

### D2 — Wire types in `keiko-contracts`, server types kept local (existing pattern)

`FilesCreateRequest`, `FilesRenameRequest`, `FilesDeleteRequest`, and the shared `FilesMutationResponse`
(`{ root, path, previousPath?, kind }`) are defined in `@oscharko-dev/keiko-contracts/bff-wire` for the
UI client. The server keeps a structurally-identical local response type, matching the pre-existing
duplication pattern for the other `Files*` shapes.

### D3 — Two reducer actions re-home open tabs

The editor layout reducer gains `rename-file` (`{ from, to }`) and `remove-file` (`{ file }}`), both
prefix-aware so a folder rename/delete carries every open descendant. `rename-file` substitutes the
identifier across every pane's `openFiles` / `tabOrder` / `activeFile` (de-duping a collision with an
already-open path) and returns the input unchanged on a no-op; `remove-file` folds the existing
`closeTab` over every matching pane, reusing its active-tab fallback and single-tab pane collapse. The
host (`EditorWidget`) dispatches these on a successful mutation and drops the stale hot-exit snapshot.
A renamed open buffer reloads from disk (a clean buffer), so the stale dirty marker is correctly pruned
by `reconcileEditorDirtyByPane`. Preserving an in-memory dirty buffer across a rename is deferred to
Wave 2 (see the parity roadmap).

### D4 — UI reuses existing classes; no `globals.css` change

The New File / New Folder toolbar buttons reuse the hover-revealed `.files-refresh` icon-button style
with an inline horizontal offset; the right-click context menu reuses the `.edm-item` menu-item style
with an inline popover container; the inline name editor reuses `.files-root-input`; the delete confirm
reuses the editor's `.ed-dialog-backdrop` / `.ed-dirty-dialog` classes. No `globals.css` rule is added,
so the SHA-pinned #1300 visual-regression proof gate is untouched. Mutations are also reachable by
keyboard (`F2` to rename, `Delete` to remove the focused row).

## Consequences

- Users get create / rename / delete / folder-create with VS Code-like ergonomics, and open tabs follow
  a rename or close on a delete instead of going stale.
- The security envelope is unchanged: every mutation is contained, deny-checked on both ends,
  non-destructive by default, symlink- and root-safe, CSRF-gated, and non-probeable on error.
- Known limitation: an out-of-app rename/delete is not reflected until refresh (no watcher), and a dirty
  buffer's unsaved edits are not carried across a rename. Both are tracked in the parity roadmap.

## Verification

- Server unit tests cover create no-overwrite, deny on both ends of rename, root/symlink rejection,
  move-into-self rejection, recursive folder delete, missing-entry 404, and errno mapping without path
  leakage.
- Contract reducer tests cover prefix rename across panes, collision merge, active-tab fallback,
  remove-everywhere with pane collapse, and referential no-op.
- UI tests cover create-and-open, folder create, context-menu rename, confirm-gated delete, and a failed
  create surfacing the error without closing the inline editor.
