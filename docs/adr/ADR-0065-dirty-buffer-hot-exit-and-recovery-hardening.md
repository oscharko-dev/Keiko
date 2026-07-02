# ADR-0065: Dirty-buffer, hot-exit, and recovery policy hardening

## Status

Accepted

## Context

Issue #1376 hardens the editor's protection of unsaved work across tab close, pane close, root
change, window close, reload, and disk-conflict scenarios. Most of the lifecycle already exists:

- `keiko-contracts/src/editor-dirty-close.ts` defines the dirty-close vocabulary — the
  `EditorDirtyCloseReason` union (`tab-close | pane-close | root-change | window-close |
  reload-file`), the `save | discard | cancel` decision, and the pure
  `createEditorDirtyCloseIntent` builder.
- `keiko-contracts/src/editor-hot-exit.ts` defines `EditorHotExitSnapshotV1`, the 24-hour TTL, and
  the snapshot validator/expiry helpers.
- `keiko-ui/.../editorHotExitStore.ts` persists only opaque snapshot references and metadata in
  IndexedDB with TTL pruning and an 8&nbsp;MiB total-size cap; content is stored behind the BFF-owned
  encrypted hot-exit vault.
- `keiko-ui/.../EditorWidget.tsx` owns the dirty-close policy: a single `requestDirtyClose` routes
  every wired close action into one modal `DirtyCloseDialog` (Save / Discard / Cancel), keeps the
  dialog open and the buffer non-closeable when a save fails, and guards page unload with a
  `beforeunload` listener attached only while a buffer is dirty.
- `keiko-ui/.../EditorRuntimeWidget.tsx` writes a hot-exit snapshot while a buffer is dirty, deletes
  it on save and when the buffer goes clean, and offers a recovery banner on load.

An adversarial audit of this surface against the issue's acceptance criteria confirmed five real
gaps and a set of untested invariants, all inside the editor's stated write-ownership (hot-exit
storage, the dirty-close dialog flow, the EditorWidget close/root-change paths, and tests):

1. The `reload-file` dirty-close reason was dead: the conflict "Reload from disk" action called the
   raw reload, overwriting a dirty buffer with disk content without routing through any policy
   surface (Deliverable D1).
2. An explicit Discard of a dirty close left the hot-exit snapshot in IndexedDB. The runtime widget
   that deletes the snapshot unmounts in the same React commit that clears the dirty flag, so its
   clean-delete effect never runs, and the discarded edits resurfaced as a recovery offer the next
   time the file opened (AC5).
3. `prune()` computed the stored total from existing snapshots only and ran before the `put`, so a
   fresh write could push total storage one full snapshot past the 8&nbsp;MiB cap (Deliverable D2).
4. The recovery-offer condition AND-ed a content comparison with a redundant content-hash
   comparison. The hash clause can only ever suppress a legitimate recovery offer (a false negative)
   when the client buffer hash and the server-issued version hash are produced over different
   normalizations (AC3).
5. The disk-conflict "Compare" affordance rendered a prose notice rather than a content comparison,
   over-promising the action (AC4).

The recovery surface (AC3/AC4), the snapshot delete-wiring (AC5), the dirty-close contract builder,
and the "no native `window.confirm` in close flows" guarantee (D4) had no executable coverage.

## Decision

### D1 — One dirty-close policy mediates every in-app destructive close, including reload

`requestDirtyClose` remains the single authority for tab close, pane close, and root change. The
previously dead `reload-file` reason is wired: the conflict reload now routes through an explicit
modal acknowledgement in `EditorRuntimeWidget` that reuses the same dialog surface (`ed-dialog`
classes, `role="dialog"`, `aria-modal`, focus + Escape) as the close flows. A clean buffer reloads
immediately; a dirty buffer cannot be discarded by a reload without the user confirming. Confirming
the reload also deletes the buffer's hot-exit snapshot, so the freshly loaded disk content is not
immediately re-offered as a recovery. No destructive in-app editor action overwrites a dirty buffer
without an explicit policy step.

The agent-conflict banner's reload (the `VERSION_MISMATCH` / `CONTENT_HASH_MISMATCH` path from the
agent-patch governance surface) is intentionally left on the direct reload: agent patch-application
policy is owned by a separate epic and is explicitly out of scope for this issue.

Window close is deliberately **not** wired to a blocking dialog. Unsaved work that survives a window
or page close is protected by the hot-exit snapshot (restored on reopen) plus the `beforeunload`
guard, which is the established hot-exit model. Routing in-app window-chrome close through a blocking
dialog would require editing the desktop window manager (`useWorkspace.ts`, `WindowFrame.tsx`) —
shared shell code outside this issue's write-ownership — and would contradict the snapshot-and-restore
contract. The `window-close` reason is retained in the contract for a future shell-level integration.

### D2 — The hot-exit snapshot lifecycle is bounded and discard-complete

`prune()` reserves the incoming snapshot's bytes and excludes its same-key predecessor before
evicting oldest-first, so the post-write total honours the 8&nbsp;MiB cap. An explicit Discard
deletes the buffer's snapshot from the EditorWidget side, because the runtime widget that would
otherwise delete it has already unmounted with the closed tab. Window close intentionally does not
delete, preserving the snapshot for recovery.

All store writes and deletes are funnelled through a single promise chain (`serializeMutation`), so a
delete dispatched after a write runs after it rather than concurrently. This closes the discard race:
when an explicit Discard deletes a snapshot while the runtime's dirty-write effect still has a write
in flight for the same key, serialization makes the delete the last word so the discarded buffer is
not resurrected. Reads are not serialized.

The BFF write route rejects secret-shaped dirty buffers before they are written to the encrypted
hot-exit vault. A suppressed write deletes any previous snapshot for the same `(workspaceRoot,
relativePath)` and returns an explicit `suppressed` response; the UI treats that as a local index
delete, so a pasted token does not leave a stale recovery offer behind.

### D3 — Recovery is offered on content difference alone

The recovery-offer gate is the content comparison `snapshot.content !== diskContent`. The redundant
hash clause is removed: a content difference already implies a hash difference, and the clause could
only mask a real offer.

### D4 — Disk-conflict "Compare" is a real diff; no native dialogs remain

The disk-conflict recovery offers Compare, Keep local, Use disk, and Cancel. Compare opens a true
side-by-side diff through the same `EditorDiffSurface` used for agent-patch review, rather than a
prose notice. Its "on disk" side is the disk content captured when recovery was offered, not the live
buffer, so the comparison stays accurate even if the buffer is edited before Compare is opened.
Opening Compare moves focus to its primary action, and the recovery banner is suppressed while the
compare view is open so its actions are not duplicated. No editor close or reload flow uses
`window.confirm`/`alert`; every decision is a React modal.

### Known limitations

- Hot-exit snapshots are keyed by `(workspaceRoot, relativePath)` with no pane dimension. When the
  same file is open and dirty in two split panes, discarding one pane's close deletes the single
  shared snapshot; the other pane's runtime re-writes it on its next edit. This single-key design
  predates this issue.
- A single snapshot whose own bytes exceed the 8&nbsp;MiB cap is still written (eviction cannot make
  room for it). The per-file size guard in `EditorRuntimeWidget` blocks oversized writes upstream when
  the server supplies a limit; the cap remains a best-effort multi-file budget.
- Recovery is best effort for secret-shaped files by design: buffers containing recognized token,
  key, private-key, or credential-assignment shapes are not hot-exit persisted.

### D5 — Acceptance criteria gain executable coverage without touching `globals.css`

New unit/component tests cover the dirty-close contract builder (dedup/empty-drop/order/all reasons),
the prune cap accounting (incoming snapshot counted; an unrelated snapshot is not over-evicted against
an overwritten predecessor's bytes), the discard snapshot deletion (AC5), the reload-file confirmation
and its snapshot deletion (AC1/D1), the recovery offer including the content-hash false-negative guard
and the disk-baseline compare (AC3/AC4), `axe` checks for the new modal and compare panel, and a
regression asserting an in-app dirty close never calls `window.confirm` (D4). The gating
`release-smoke.spec.ts @smoke` browser test exercises the conflict reload-confirm, the dirty-tab-close
dialog with Cancel-preserves and Discard, and that no native confirm is used — the requested browser
evidence for the dirty-close and reload flows, against the real app. All UI changes reuse existing CSS
classes, so the visual-regression `globals.css` hash gate is not triggered. Tests assert on file paths
and markers only and never print buffer contents.

## Consequences

- Reloading from disk over a dirty conflict buffer now takes one extra confirmation click; the edits
  are no longer discarded implicitly.
- Discarded edits no longer reappear as a recovery offer on the next open.
- Hot-exit storage cannot exceed its cap by a write, and recovery is offered slightly more often
  (whenever content differs), which is the intended, safer direction.
- Hot-exit recovery is limited to a 24-hour window and excludes recognized secret-shaped dirty
  buffers; those exclusions trade convenience for the browser-state security boundary.
- In-app window-chrome close still relies on hot-exit + `beforeunload`; a future issue may wire the
  `window-close` reason once the shell exposes a per-window can-close hook.

## Alternatives considered

- **Wire `window-close` to the dirty-close dialog now.** Rejected: it requires editing the shared
  desktop window manager, outside this issue's write-ownership, and a blocking dialog on window
  close is contrary to the hot-exit-and-restore model that already protects the work.
- **Keep the conflict reload as an immediate overwrite (relying on the post-reload recovery banner).**
  Rejected: it leaves a destructive action outside the policy surface (D1) and discards the visible
  buffer before the user acknowledges the loss.
- **Keep "Compare" as the AC-permitted scoped-equivalent prose notice.** Rejected: a real diff was
  available by reusing `EditorDiffSurface` at no new subsystem cost and removes the over-promise.
