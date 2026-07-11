# ADR-0127: Editor Git reads, diff rendering, and conflict-editing semantics

## Status

Accepted (Issue #2227, Epic #2093, 2026-07-10).

## Amends

This decision extends, additively, ADR-0098's governed Git Client read surface and ADR-0059's
agent-editor public contracts. Existing status, raw unified-diff, Git delivery, patch-preview, and
editor save contracts remain unchanged. No existing route is removed or reshaped.

It composes ADR-0019's package direction, ADR-0058's editor host boundary, and ADR-0125's rule that
editor capabilities use the existing governance vocabulary and keep delivery separately approved.
It does not introduce editor-side Git execution or Git mutation authority.

ADR-0127 was allocated after checking `docs/adr/`, the open Issue #2227 allocation record, and its
statement that no open pull request claimed the number on 2026-07-10. ADR-0126 was the previous
allocated record.

## Context

Epic #2093 makes the built-in editor source-control-aware without moving staging, commit, push,
pull-request, or merge authority out of the governed Git Client. The existing `GET /api/git/diff`
response carries bounded raw unified-diff text. The only structured parser is client-side
`diffParser.ts`, whose `DiffFile -> DiffHunk -> DiffLine` vocabulary is not a shared wire contract.
There is no blame contract.

Two rendering engines also serve materially different inputs. `KeikoDiffEditor` wraps Monaco's
diff editor and consumes complete `original` and `modified` text sides. Patch preview can provide
those sides because `PatchPreviewFile` carries both. Git and inline-peek reads have unified hunks,
not trustworthy complete sides: context can be omitted, byte caps can truncate a patch, binary
files have no text side, and a hunk cannot reconstruct untouched content. Inventing either side
would produce a misleading review.

The existing render budgets are deliberately aligned: `diffParser.ts` caps raw diffs at 512 KiB
and 400 files, while `DEFAULT_PATCH_PREVIEW_LIMITS` caps patch preview at 512 KiB total and 400
files. This decision preserves that alignment and adds structural limits for nested payloads.

Conflict markers create a separate trust concern. A resolution action is based on an observed
buffer range, but the buffer can change before the action executes. Resolution therefore needs a
closed grammar, normal undo semantics, and stale-action rejection; it must never imply a disk save.

## Decision

### D1 - One bounded editor Git read contract

`packages/keiko-contracts/src/git-editor.ts` owns schema version `"1"` and the shared structured
diff and blame vocabulary. It is a leaf contract containing pure types, frozen runtime witnesses,
strict guards, and throw-free parsers only. Issue #2228 implements the server producers in the
existing `/api/git/*` route family; it does not create another Git subsystem.

Structured diff requests select exactly one scope:

- `staged` means index versus `HEAD`; every returned file has `layer: "staged"`.
- `unstaged` means worktree versus index; every returned file has `layer: "worktree"`.

The response parser rejects mixed or inconsistent layers. A partially staged file is represented by
the results of separate staged and unstaged reads, never by collapsing both layers into one hunk.
Each file carries workspace-relative `path`, optional `oldPath` only for a rename, status, binary
state, hunks, line counts, and an explicit `truncated` marker. Binary files carry no hunks and zero
text line counts. Rename and binary are orthogonal, so a renamed binary file remains representable.
Each hunk carries parsed old/new start and count coordinates plus an explicit truncation marker.
Only complete, header-consistent hunks are actionable: when process output ends mid-record or
mid-hunk, Issue #2228 drops the incomplete tail or returns it as explicitly truncated and
non-actionable. The response exposes true pre-cap `totalFiles` and `totalBytes` plus the applied
fixed caps.

The concrete structured-diff caps are:

- raw unified-diff input: 512 KiB;
- files per response: 400;
- hunks per file: 256;
- lines per hunk: 2,048;
- hunk-header characters: 512;
- line-text characters: 16,384; and
- workspace-relative path bytes: 4,096.

`GitEditorDiffLine` preserves the existing client `DiffLine` shape and exact coordinate grammar:
context has both positive line numbers, addition has only a positive new number, deletion has only a
positive old number, and metadata has neither. `GitEditorDiffHunk` and `GitEditorDiffFile` preserve
the existing client family as structural supertypes while adding bounded Git metadata. The
co-located type assertion mirrors the current client declarations because the contracts leaf cannot
import `keiko-ui`; Issue #2232 replaces that mirror by migrating the client to these shared types.

Blame is a separate bounded request/response. A line carries only its positive line number, a
lower-case SHA-1 or SHA-256 hash, bounded author display name, UTC author time, and bounded commit
summary. An all-zero SHA is the explicit uncommitted-line sentinel. Author email and raw source-line
text are excluded. The response exposes `totalLines`, `totalBytes`, and `truncated`; caps are 256
KiB, 2,000 lines, 256 author characters, and 512 summary characters. Blame flows only to the
requesting local UI and is never copied into evidence, audit records, diagnostics, or model context
unless the separately governed Issue #2234 projection explicitly selects a bounded field.

All four wire parsers (diff request/response and blame request/response) are deterministic,
closed-shape, all-errors-collected at the envelope level, and throw-free even for accessor-hostile
input. Paths reject absolute, backslash-shaped, empty-segment, dot-segment, traversal-shaped, NUL,
and over-cap values. Issue #2228 parses unified diff server-side at the existing Git route boundary,
after `keiko-git` membership and containment checks and before returning this contract. Blame needs
no subcommand allowlist widening. Issue #2228 nevertheless hardens every local read against
execution-capable repository configuration: fixed Git arguments override `core.fsmonitor=false`,
diff keeps `--no-ext-diff --no-textconv`, and blame uses `--no-textconv`. The existing
forbidden-option family remains in force, and `LC_ALL=C` stabilizes machine parsing.

### D2 - Two rendering engines behind one contract and visual language

Keiko retains a justified two-engine split:

- Monaco `KeikoDiffEditor` remains the renderer for full before/after patch-review inputs. It keeps
  syntax-aware side-by-side/inline comparison, patch-review accessibility, and navigation where
  complete sides are already available.
- A bounded hunk renderer serves unified Git Client diffs and editor inline peeks. It consumes the
  shared `GitEditorDiffFile/Hunk/Line` vocabulary and never fabricates omitted file content.

There is no sides-returning Git route. Reconstructing full sides from unified hunks is unsafe, while
reading full files merely to force Monaco onto Git peeks would broaden repository-content transfer,
increase memory cost, and blur truncation. Issue #2228 therefore returns structured hunks only.

Issue #2232 consolidates the existing `diffParser.ts`/`diffView.tsx` path onto the shared contract
and gives both engines one visual language: the same file/status/binary/truncation chrome, add/delete/
context/meta semantics, token meanings, keyboard terminology, empty and error states, and truthful
cap disclosures. The engines may differ only where input capability requires it: full-side Monaco
features cannot appear on a hunk-only input. The 512 KiB/400-file alignment is frozen across both
paths and may be revised only by a later recorded decision with performance evidence.

### D3 - Closed conflict grammar and buffer-only resolution

Issue #2231 recognizes conflict blocks only when marker lines begin at column one and form this
non-nested grammar in the current in-memory buffer:

```text
<<<<<<< [ours label]
ours lines
[||||||| base label
base lines]
=======
theirs lines
>>>>>>> [theirs label]
```

The labels are optional, untrusted display text. An incomplete, nested, duplicated, reversed, or
otherwise ambiguous marker sequence is not actionable and fails closed as malformed. A normal
two-way block has no base section; a diff3 block may have exactly one `|||||||` base section between
ours and the separator. Marker-looking text away from column one is ordinary source text.

Resolution operations replace exactly one recognized block in the buffer:

- **ours** keeps only the ours lines;
- **theirs** keeps only the theirs lines; and
- **both** keeps ours followed by theirs, preserving each side's order and inserting no synthetic
  conflict marker or base content.

Each operation is one standard Monaco buffer edit with normal undo stops. It neither calls a file
API nor marks the underlying Git index resolved. The buffer becomes dirty through the existing
editor state machine, and the local human must explicitly save through the existing governed save
flow. Navigation and highlighting are read-only projections over the latest buffer parse.

Every actionable block carries a locally computed SHA-256 digest over its exact marker-inclusive
buffer slice and boundaries. Immediately before applying ours/theirs/both, the editor recomputes
that digest against the current buffer version. A mismatch rejects the stale action without editing,
rescans the buffer, and asks the caller to act on the new block. The digest is a concurrency token,
not authority and not repository evidence; diagnostics may report only a mismatch reason and
correlation identifier, never the block body or digest input.

## Human-control invariant

None of these decisions grants Git mutation or implicit persistence:

- D1 adds bounded reads only. Git still executes server-side after selected-root membership and
  containment checks; payload content stays in the requesting local UI and out of audit evidence.
- D2 adds no content-reconstruction route. Each renderer receives only the input shape it can
  represent truthfully, and binary/truncated states remain explicit.
- D3 changes only the in-memory editor buffer through the existing undoable edit path. Saving is a
  separate explicit human action; staging, committing, pushing, pull-request creation, and merging
  remain governed Git Client delivery actions.
- A stale conflict digest fails closed and cannot widen authority or silently overwrite newer buffer
  content.

## Consequences

- Issue #2228 implements the contained structured-diff and blame producers, enforces all D1 caps,
  parses unified diff server-side, preserves staged/worktree layer separation, neutralizes
  execution-capable repository-local read configuration, and returns content-free structured
  errors. It may extend the shared fixed local-read invocation profile but adds no client-controlled
  Git options and no sides-returning route.
- Issue #2229 consumes staged and unstaged D1 reads for distinct gutter markers and uses D2's hunk
  renderer for inline peek, including binary and truncation states.
- Issue #2230 consumes the privacy-minimized D1 blame payload and links commit identity to the
  existing Git Client without exposing author email or raw source text.
- Issue #2231 implements D3's parser, navigation, digest revalidation, and undoable buffer edits;
  explicit save remains the only disk-write transition.
- Issue #2232 performs D2's shared-type and visual-language migration and the editor/Git Client
  interlock. It retains Monaco for full-side patch review and the bounded hunk engine for Git/peek.
- Issue #2233 reuses D1's status/layer semantics for tree decoration; it does not derive status by
  reparsing diff content in the browser.
- Issue #2234 may project bounded read-only conflict/diff/blame context into the existing governed
  coding context. It must not include author email, raw blame source lines, or Git write authority.
- Issue #2235 verifies the complete read/peek/blame/conflict flow, accessibility, performance,
  truncation disclosures, and the explicit-save boundary.
- `scripts/check-contract-boundaries.mjs` does not yet pin `git-editor.ts`, matching ADR-0126's
  recorded status for its new editor contract files. Extending that script remains a separate
  hardening follow-up; code review and the package boundary own the contract until then.
