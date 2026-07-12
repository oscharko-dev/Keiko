# Workspace snippets

Keiko workspace snippets are a governed, workspace-scoped subset of TextMate snippets for the M7
editor platform epic (#2095 / #2323). They are designed for local productivity without adopting VS
Code's global snippet trust model or extension marketplace.

## Deliberate differences from VS Code

Keiko intentionally does **not** import VS Code user/global snippets, `.vscode/*` snippet files,
extension snippets, VSIX packages, JavaScript snippets, shell snippets, clipboard snippets, command
variables, regex transforms, or marketplace snippets. Snippets can only be created through Keiko's
workspace-snippet control plane and are stored in server-owned private state.

Supported snippet bodies are a bounded TextMate-style subset:

- literal text;
- numbered placeholders such as `${1:name}` and `$0`;
- a small safe variable set: `TM_FILENAME`, `TM_FILENAME_BASE`, `CURRENT_YEAR`,
  `CURRENT_MONTH`, and `CURRENT_DATE`.

The following are rejected before persistence:

- command execution syntax such as `$(` and backticks;
- `CLIPBOARD` and other environment or process variables;
- placeholder transforms such as `${1/(.*)/.../}`;
- active HTML (`script`, `iframe`, `object`, `embed`, `style`, and `javascript:` payloads);
- absolute paths and parent-directory path traversal in include/exclude scopes;
- collections that exceed the bounded size, prefix, language, or path-scope limits.

## Runtime behavior

The server owns the snippet revision, ETag, idempotency, validation, and content-free diagnostics.
Malformed or future-versioned private records fail closed as unavailable and do not destroy the last
valid record. Stale writes conflict through the revision/ETag contract; an idempotency key reused
with a different request body conflicts.

The editor renders snippets as a deterministic `workspace-snippet` completion source and passes them
to Monaco with the snippet insertion rule. That preserves Monaco placeholder traversal and final
`$0` behavior while keeping Keiko's server-side trust boundary intact.

Snippet completions are disabled when insertion is unsafe: unavailable state, unsupported scope,
read-only editor state, large-file degraded mode, or cancellation. Diagnostics and change events
only expose counts, revisions, hashes, fingerprints, and reason codes; they do not expose snippet
bodies, workspace paths, secrets, or user content.
