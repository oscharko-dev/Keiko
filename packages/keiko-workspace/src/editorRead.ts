// The editor lane's door out of this package — reachable only through the
// `@oscharko-dev/keiko-workspace/internal/editor-read` export subpath (ADR-0005 read boundary).
//
// The public barrel deliberately exposes exactly ONE read, `readWorkspaceFile`, which redacts at
// the IO boundary: everything it feeds (context packs, retrieval, evidence atoms, the workspace
// index, audit summaries, diagnostics) must be safe to persist and to show an operator.
//
// An editor surface that WRITES the file back cannot use that read. Workspace search & replace
// derives its match ranges, its base-content hash, and its replacement text from what it reads, and
// the write preflight in `keiko-tools` compares the rendered diff against the RAW file. Deriving
// the edit from redacted text therefore produced a diff whose `-` lines never matched the file:
// every replace on a file containing so much as one secret-shaped assignment failed as a false
// write-conflict without writing anything, and the human approved a diff that highlighted the
// wrong text.
//
// Importing this module is an explicit statement that the caller is editor-owned and NON-evidence.
// Anything that feeds evidence, a manifest, an audit export, or a grounded answer must import the
// redacting read from the package root instead — and must redact before it emits.

export {
  readWorkspaceFileForEditing,
  type RawFileContent,
  type WorkspaceContentLane,
} from "./discovery.js";
