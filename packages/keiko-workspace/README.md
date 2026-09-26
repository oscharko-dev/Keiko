# @oscharko-dev/keiko-workspace

Workspace detection, bounded file discovery, and repository search for Keiko.

## Published exports

The export map is deliberately narrow. Anything not listed here is internal and may change without
notice; reaching into `dist/` directly is an ADR-0019 violation and is caught by `arch:check`.

| Subpath                          | What it is for                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `.`                              | The barrel. Workspace detection, discovery, search, and **redacted** file reads. This is what an ordinary consumer wants. |
| `./internal/fs`                  | The filesystem seam, for callers that must inject their own `WorkspaceFs`.                                                |
| `./internal/editor-read`         | The **raw** file read. See the boundary note below — do not reach for this without reading it.                            |
| `./internal/owned-root`          | Exact-root containment for the import-policy-approved managed-workspace owners.                                           |
| `./internal/owned-root-mint`     | Capability minting, restricted to the server lifecycle owner by `arch:check`.                                             |
| `./internal/owned-root-preserve` | Exact-authority propagation through reviewed filesystem wrappers; never widening.                                         |
| `./internal/realpath-policy`     | Positive canonical/deny predicates shared by server-owned read lanes without growing the public barrel.                   |
| `./testing`                      | Fixture helpers for consumers' tests. Not shipped behaviour.                                                              |

### Filesystem-port contract

`WorkspaceFs` is a read-only workspace-content port. Custom adapters must keep persistence and
writes in their owning store or tool boundary; the former optional `makeDir` and `writeFileUtf8`
members are no longer part of this interface. Every bounded byte, prefix, range, or reusable-reader
call also requires an explicit `WorkspaceHardLinkPolicy` (`"allow"` or `"reject"`). This is a
deliberate trust decision at the calling lane, not an adapter default: evidence and ordinary
workspace reads use `"reject"`; only a separately verified owning lane may choose `"allow"`.

### The two read lanes, and why they are separate

The decision, its rejected alternatives, and the exact limit of what the split guarantees are
recorded in [ADR-0165](../../docs/adr/ADR-0165-editor-raw-read-lane-and-the-redacting-barrel.md),
which amends ADR-0005 D2. Read it before adding a caller on the raw lane.

`readWorkspaceFile` (on the barrel) returns **redacted** bytes: a secret-shaped value in the file is
replaced before it reaches the caller. That is the evidence lane, and it is the default on purpose —
workspace content flows into manifests, diagnostics, and model context, none of which may carry a
secret.

`readWorkspaceFileForEditing` (on `./internal/editor-read`) returns the **raw** bytes. The editor's
search-and-replace needs them: redaction rewrites a matched region to a token of a different length,
and collapses a multi-line private-key block into one line, so every match offset and line number
computed over redacted text addresses the wrong bytes of the real file. A replace built on those
coordinates either fails as a false write-conflict or, worse, writes to the wrong place.

Two properties keep that from becoming a leak:

- **It is a separate subpath, not a barrel export.** A caller has to name the raw lane deliberately;
  it can never be picked up by autocompleting the package barrel.
- **Its return type is structurally incompatible.** The raw read yields `RawFileContent` whose payload
  field is `rawText`, not `text`, so it cannot be substituted where a redacted `FileContent` is
  expected — the type system refuses it rather than a reviewer having to notice.

A raw read is **not** a relaxed read: it runs the identical security chain as the redacted lane —
workspace-boundary check, deny list, realpath containment, hard-link alias check, size cap. Both
reads share one `resolveReadableWorkspaceFile`; the raw lane skips `redact()` and nothing else.

What keeps raw bytes out of an index, a manifest, or a grounded answer is therefore **structural,
not another path check**: the deliberate subpath and the incompatible payload field above. There is
no deny rule that recognises "an index path" — a caller that imports the raw lane and then persists
what it read has defeated the boundary, and no runtime guard will stop it. That is why importing
`./internal/editor-read` is an assertion the reviewer has to accept, and why redaction is required
at the surface that emits rather than here.

`editorRead.export.test.ts` exercises this subpath through the published export map rather than
relatively, so an export-map break fails there by name instead of surfacing as a resolution error in
a downstream package.
