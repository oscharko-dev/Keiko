# @oscharko-dev/keiko-workspace

Workspace detection, bounded file discovery, and repository search for Keiko.

## Published exports

The export map is deliberately narrow. Anything not listed here is internal and may change without
notice; reaching into `dist/` directly is an ADR-0019 violation and is caught by `arch:check`.

| Subpath                  | What it is for                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `.`                      | The barrel. Workspace detection, discovery, search, and **redacted** file reads. This is what an ordinary consumer wants. |
| `./internal/fs`          | The filesystem seam, for callers that must inject their own `WorkspaceFs`.                                                |
| `./internal/editor-read` | The **raw** file read. See the boundary note below — do not reach for this without reading it.                            |
| `./testing`              | Fixture helpers for consumers' tests. Not shipped behaviour.                                                              |

### The two read lanes, and why they are separate

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

A raw read is **not** a relaxed read: it runs the identical security chain (workspace-boundary check,
deny list, realpath containment, hard-link alias check, size cap) and additionally refuses the
workspace index and any embedding path, so raw bytes can never reach a lexical index or a provider.

`editorRead.export.test.ts` exercises this subpath through the published export map rather than
relatively, so an export-map break fails there by name instead of surfacing as a resolution error in
a downstream package.
