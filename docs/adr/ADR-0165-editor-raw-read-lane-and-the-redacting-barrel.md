# ADR-0165 — The editor raw-read lane and the redacting barrel

- Status: Accepted
- Date: 2026-07-31
- Epic: [#2802](https://github.com/oscharko-dev/Keiko/issues/2802)
- Amends:
  [ADR-0005](ADR-0005-repository-context-and-workspace-access.md) D2 — the workspace read is no
  longer a single always-redacting function
- Constrains:
  [ADR-0019](ADR-0019-modular-package-architecture.md) trust-4/trust-5 (file patches route through
  `keiko-tools`) and [ADR-0006](ADR-0006-safe-tool-execution-and-sandbox-boundary.md)'s egress posture, neither
  of which is widened

## Context

ADR-0005 D2 established one workspace read, `readWorkspaceFile`, which redacts at the IO boundary.
That single-lane shape was correct while every consumer was a **reader**: context packs, retrieval,
evidence atoms, the workspace index, audit summaries, and diagnostics all persist or display what
they read, so redacting once at the boundary made a secret structurally unable to reach any of them.

The 0.3.0 audit of workspace search & replace found that the same function cannot serve a surface
that **writes the file back**. Redaction rewrites a matched region to a token of a different length
and collapses a multi-line private-key block into a single line. Every match offset, line number,
and base-content hash computed over redacted text therefore addresses different bytes than the file
on disk, while the write preflight in `keiko-tools` renders its diff against the raw file. The
observed failure was not theoretical: on any file containing so much as one secret-shaped
assignment, every replace failed as a false write-conflict without writing anything, and the diff
presented for human approval highlighted the wrong text — a governance defect, because the human
approved something other than what would have been written.

Three shapes were considered and rejected:

- **Redact-and-remap.** Keep one read and translate offsets across the redaction. This makes the
  correctness of every edit depend on a bidirectional mapping that must stay exact under multi-line
  collapse; a mapping bug writes to the wrong bytes silently. It moves a boundary problem into an
  arithmetic problem and is strictly harder to review.
- **A flag on the existing read.** `readWorkspaceFile(ws, path, { redact: false })` is one token
  away from any evidence-lane call site, invisible in review, and returns the same type either way.
- **Relaxing the barrel.** Exporting the raw read from the package root would make the unredacted
  read the thing autocomplete offers first.

## Decision

### D1 — Two named lanes over one guard chain

`keiko-workspace` has exactly two content reads, and they differ in **one** step:

| Lane     | Entry point                   | Reachable from            | Payload                | Redaction |
| -------- | ----------------------------- | ------------------------- | ---------------------- | --------- |
| Evidence | `readWorkspaceFile`           | the package barrel        | `FileContent.text`     | yes       |
| Editor   | `readWorkspaceFileForEditing` | `./internal/editor-read`  | `RawFileContent.rawText` | no      |

Both call one `resolveReadableWorkspaceFile`, which runs, in order: workspace-boundary resolution,
deny-list check on the lexical relative path, realpath containment, the symlinked-root deny check,
the deny-list check again on the realpath-relative path, hard-link alias refusal, and the size cap.
The evidence lane is literally the editor lane plus `redact()`. **A raw read is not a relaxed read**;
it is the same read without the final redaction, and any future guard added to that chain protects
both lanes by construction.

### D2 — Containment is structural, not another runtime check

Two properties keep the raw lane from being picked up by an evidence-lane caller:

1. **It is a separate export subpath, not a barrel export.** `./internal/editor-read` must be named
   deliberately; it can never be reached by autocompleting `@oscharko-dev/keiko-workspace`.
2. **Its return type is structurally incompatible.** `RawFileContent`'s payload field is `rawText`,
   not `text`, so it cannot be substituted where a redacted `FileContent` is expected and `.text` on
   a raw read does not compile. The type system refuses the substitution rather than a reviewer
   having to notice it.

This ADR states the limit of that containment plainly, because overstating it would be worse than
not writing it down. **There is no deny rule that recognises "an index path" or "an embedding
path".** The deny list is a secrets-and-credential-store list. A caller that imports the raw lane and
then persists what it read has defeated the boundary, and no runtime guard in this package will stop
it. Containment here is a review-time property enforced by the module graph and the type checker,
not a runtime one.

The module-graph half of that containment is machine-enforced by the
`adr-0165-editor-read-allowed-callers` dependency-cruiser rule, alongside its two negative fixtures
under
[`tests/architecture/fixtures/editor-read-allowed-callers/`](../../tests/architecture/fixtures/editor-read-allowed-callers/):
`bad-import.ts` (imports through `editorRead.ts`) and `bad-discovery-import.ts` (deep-imports
`discovery.ts`, where `readWorkspaceFileForEditing` is actually defined and from which `editorRead.ts`
re-exports it). Both paths reach the same raw function, so both files are targets of the rule: only
`packages/keiko-server/src/editor/**` (today: `workspaceSearchRoutes.ts`) and the
`packages/keiko-workspace/src/**` package's own files may import either; any other production
import fires the rule and turns `npm run arch:check` red. This does not weaken the review-time
framing — it just refuses to trust silence on a boundary an unreviewed code change could otherwise
cross undetected between reviews. The rule name is registered in
[`scripts/arch-check-negative.mjs`](../../scripts/arch-check-negative.mjs)'s expected count (`2`, one
per fixture) and in
[`tests/architecture/severity-gate.test.ts`](../../tests/architecture/severity-gate.test.ts)'s
required-trust-rules list so a downgrade or accidental removal shows up as a named failure, not a
silent drift.

**The public search-lane selector is also machine-enforced (#3411).** `searchText` and
`readExcerpt` accept `deps.contentLane` through the public barrel. The import graph alone cannot
see that capability; the previous known gap (#2908 / PR #3295) allowed a future caller to select
raw text without importing a guarded module. `adr-0165-raw-coordinate-owner` in the existing
[`check-import-policy.mjs`](../../scripts/check-import-policy.mjs) AST gate now rejects references
to the `contentLane` property outside `packages/keiko-workspace/src/**` and the exact existing
`packages/keiko-server/src/editor/workspaceSearchRoutes.ts` owner. Literal, shorthand, indirect
value, property assignment and computed literal spellings are covered. This is a source-policy
boundary, not arbitrary runtime data-flow analysis; unsafe dynamic reflection is not sanctioned.

The permanent `raw-coordinate-owner/bad-search-lane.ts` architecture fixture reproduces a coding
handler selecting raw text through that public barrel. Before the gate amendment, the targeted
suite reports six failed negative assertions; afterward it passes and `arch:check:negative`
requires the named rule to fire exactly once. Module-graph raw-read restrictions remain unchanged:
a coding server handler gains no permission to import `editorRead.ts` or `discovery.ts`.

### D3 — Importing the subpath is a scoped assertion

Importing `./internal/editor-read` asserts that the caller is **an allowed raw-coordinate owner
and non-evidence**. Existing Editor ownership remains. Under
[ADR-0175 D8](ADR-0175-canonical-governed-tool-catalog.md#d8--raw-coordinate-lane-and-delivery-dependency),
#3386 H1 may add bounded coding-search coordinate computation only **inside the existing workspace
owner**, reusing this exact guard chain. There is no new raw-read server caller or public raw
barrel. Raw lines/offsets are computed transiently before separate display-snippet redaction;
redaction may shorten text or collapse lines and therefore cannot define source coordinates.
The server handler receives bounded coordinates and separately redacted display data. Query,
path, snippet, symbol and file content are forbidden in durable activity evidence. H1 must prove
multiline-secret coordinate correctness, containment/link/deny/size limits and evidence redaction
through the real workspace producer; the architecture fixture alone makes no runtime claim.

The #3411 ADR/gate PR must merge to dev before H1 starts. #3414 consumes the resulting lane and
cannot retroactively authorize a wider one.

Anything that feeds evidence, a manifest, an audit export, a diagnostic, the workspace index, or a
grounded answer imports the redacting read from the package root instead, and redacts before it
emits. Redaction for those surfaces is owed at the surface that emits, not at this read.

The existing boundaries are unchanged and not widened by this ADR: file patches still route through
`keiko-tools` (ADR-0019 trust-4/trust-5), generated code still runs behind the sandbox egress
boundary (ADR-0006), and no raw content is added to any manifest, evidence atom, or diagnostic.

### D4 — The export surface is pinned by a test that resolves it

`packages/keiko-workspace/src/editorRead.export.test.ts` imports through the published subpath
rather than relatively, so a broken or renamed `exports` entry fails there by name instead of
surfacing as a module-resolution error in a downstream package. It pins the happy-path raw read, the
`rawText` / `text` incompatibility in both directions, and that the raw lane still refuses traversal.
Every other test in the package imports the lane relatively, which exercises the function but not
the export map.

## Consequences

- Workspace search & replace derives its ranges, base hash, and replacement text from the same bytes
  the write preflight compares against, so a file containing secret-shaped text edits correctly and
  the human approves the diff that will actually be written.
- The package's public barrel still exposes exactly one read, and it still redacts. An evidence-lane
  caller written without knowledge of this ADR gets the safe lane by default.
- A new unredacted read now exists in the repository. Its safety rests on the module graph, the type
  system, and review — reviewers of any new `./internal/editor-read` import must confirm the caller
  is an allowed coordinate owner and never persists, logs, embeds, or emits raw content.
- Adding a guard to `resolveReadableWorkspaceFile` protects both lanes; adding one only to
  `readWorkspaceFile` protects neither the editor lane nor, therefore, the write path.

## Alternatives considered

See the three rejected shapes in Context: offset remapping (moves a boundary problem into
error-prone arithmetic), a boolean flag on the single read (invisible at the call site, same return
type), and exporting the raw read from the barrel (makes the unredacted read the default discovery).

## References

- [ADR-0005](ADR-0005-repository-context-and-workspace-access.md) — the original single redacting
  workspace read this ADR amends
- [ADR-0006](ADR-0006-safe-tool-execution-and-sandbox-boundary.md) — the egress boundary, unchanged
- [ADR-0019](ADR-0019-modular-package-architecture.md) — package boundaries; patches route through
  `keiko-tools`
- `packages/keiko-workspace/README.md` — the consumer-facing statement of the two lanes
