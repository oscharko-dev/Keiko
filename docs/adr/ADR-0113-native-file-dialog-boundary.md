# ADR-0113: Native file dialog boundary for local path selection

## Status

Accepted (Epic #1941, 2026-07-05)

## Date

2026-07-05

## Version

0.2.11

## Context

Epic #1941 introduces native operating-system file and folder selection while preserving Keiko's
npm-delivered Browser/PWA plus local Node BFF architecture. Browser APIs cannot provide trusted
absolute local paths to the BFF, but the local Node process already owns Keiko's governed
filesystem authority. A user-triggered Browse action therefore needs a narrow server-side adapter
that can open the platform dialog and return content-free selected paths for normal Keiko
validation.

This decision records the first-child reuse review and boundary decision before implementation
children add contracts, routes, platform adapters, UI wiring, packaging, or closeout evidence.

Existing capability review:

- Files BFF policy already accepts arbitrary absolute roots through `resolveRoot` in
  `packages/keiko-server/src/files.ts`, including absolute-path checks, realpath resolution,
  symlink containment, deny-list checks, and metadata redaction. Native dialog selections must reuse
  or factor this policy rather than create a second filesystem policy.
- The in-app directory/file flows already exist in `NewWindowDialog.tsx` (`DirectoryPicker` and
  `FilePicker`) and `LocalFileBrowserDialog.tsx`. Native selection is an accelerator for the same
  fields and selected-source state, not a replacement for fallback browsing.
- The UI already has typed same-origin clients in `packages/keiko-ui/src/lib/api.ts`. The native
  client may be added there or in a small adjacent module only if it keeps the shared API module
  maintainable. It must preserve JSON, CSRF, no body logging, and stable `ApiError` behavior.
- `packages/keiko-server/src/routes.ts` centralizes route registration, error envelopes, and
  correlation-aware route context. The native route must be a normal BFF route and inherit the
  existing host/origin, content-type, CSRF, no-store, and correlation conventions.
- Terminal and command-runner surfaces already have fixed-purpose execution boundaries. They are
  not the picker implementation surface because their authority is command execution, workspace
  command policy, output streaming, and evidence. A file dialog is a human interaction primitive
  with a different lifetime, cancellation model, output schema, and security review target.
- Package and contract gates already exist through `keiko-contracts`, package-surface checks,
  `check:shell-spawn-guardrails`, `check:error-observability`, and `arch:check`. The native dialog
  feature must add to those gates rather than add a parallel release or evidence system.

## Decision

Keiko will implement native file and folder selection as a dedicated local BFF capability with a
fixed-purpose platform adapter. The browser may request a picker and render the typed result, but it
does not execute commands, inspect the filesystem directly, or decide whether selected paths are
authorized.

### D1 - Dedicated native-dialog boundary

The BFF owns a new route, expected to be `POST /api/native-file-dialog/open`, backed by a
`native-file-dialog` server module. The route accepts a typed request with mode, optional title,
optional default path, and optional filters. It returns either user cancellation or validated
content-free selections.

This route is not part of terminal, command-runner, Git delivery, browser CDP, task-workspace, or
container execution. The adapter exposes only `open-file`, `open-files`, and `open-directory`.
There is no generic executable, argv, script, shell, terminal, or command text field in the
contract.

### D2 - Validation and projection reuse

Selections returned by a platform adapter are untrusted until the BFF validates them. The route
must enforce:

- absolute path shape and NUL rejection,
- selected path count for the requested mode,
- file versus directory kind,
- existence and realpath resolution,
- symlink and containment semantics matching the Files BFF where a selected path becomes a Files
  root or file target,
- existing deny-list and metadata redaction checks,
- stable error envelopes with no raw stderr, raw selected paths, home directories, or private file
  names in diagnostics, evidence, test names, or issue comments.

Where the existing `resolveRoot`, `pathIsDenied`, `FilesError`, and redactor flow cannot be reused
directly, child issue 2 must factor a small shared helper instead of duplicating policy.

### D3 - Platform adapters

The macOS adapter may invoke `/usr/bin/osascript` with `shell: false`, a static JXA or AppleScript
program, and JSON configuration passed on stdin.

The Windows adapter may invoke PowerShell with `-NoProfile`, `-STA`, fixed script content, and JSON
configuration passed on stdin. Folder selection should prefer the modern Common Item Dialog when it
can remain maintainable and testable.

Every adapter must enforce timeout, maximum stdout bytes, maximum stderr bytes, maximum selected
paths, malformed-output handling, and cancellation as a typed success result.

### D4 - Fallback policy

Unsupported platforms, unavailable adapters, denied policy results, timeout, malformed output, or
operator-disabled native dialogs must leave the existing in-app picker path available. Browser UI
code treats native selection as a preferred first attempt, then falls back to `DirectoryPicker`,
`FilePicker`, or `LocalFileBrowserDialog` as appropriate.

Cancellation is normal user intent. It does not show an internal error and does not mutate the
current field or source selection.

### D5 - State, evidence, and diagnostics

Native selection does not create a new persistent store. Existing path-owning state may receive the
same values it already accepts when the user types or selects through the in-app picker. Evidence,
diagnostics, release artifacts, and tests must remain content-free and must not persist raw selected
paths or adapter stderr.

### D6 - Implementation sequence and write ownership

Epic #1941 must proceed through child issues in this order:

1. Architecture and reuse review: this ADR plus any child issue body updates.
2. Contract and BFF route foundation: `keiko-contracts`, server route, validation, fake adapter
   seam, focused server tests.
3. macOS adapter: macOS-specific server module, fixed script asset or embedded script, adapter
   tests, manual macOS QA notes.
4. Windows adapter: Windows-specific server module, fixed script asset or embedded script, adapter
   tests, manual Windows QA notes.
5. UI integration: typed UI client and native-first Browse behavior in `NewWindowDialog`,
   `LocalFileBrowserDialog`, and Quality Intelligence source selection.
6. Packaging and docs: package-surface updates, packaged script inclusion if file-backed,
   troubleshooting documentation, release-impact metadata.
7. Verification and closeout: deterministic route/UI/browser smoke tests with the native route
   stubbed, manual macOS and Windows evidence, final known limitations.

No two parallel implementation agents may own the same file scope.

## Security and threat model

Threats addressed by this boundary:

- repurposing Browse into arbitrary command execution,
- shell injection through user-controlled titles, default paths, filters, or selected paths,
- path policy bypass through symlink, relative path, denied path, or wrong-kind selection,
- privacy leakage through diagnostics, raw stderr, evidence, screenshots, test fixture names, or
  issue comments,
- denial of service through concurrent native dialogs, hung platform helpers, or oversized stdout,
- UI confusion where cancellation is reported as a failure or fallback mutates state unexpectedly.

Controls:

- fixed binary and fixed argv,
- `shell: false`,
- JSON stdin for user-controlled configuration,
- route-level single-flight guard with `409 NATIVE_DIALOG_ALREADY_OPEN`,
- timeout and output caps,
- stable browser-visible error codes,
- redacted operator diagnostics keyed by correlation id,
- deterministic fake adapter seams for CI,
- manual platform QA for real Finder and Windows dialogs.

## Consequences

### Positive

- Keiko can offer native Finder and Windows picker UX while remaining npm-delivered and browser/BFF
  based.
- The feature reuses the existing Files policy and UI fallback surfaces instead of introducing a
  parallel filesystem subsystem.
- The adapter boundary is narrow enough for targeted security review and deterministic tests.

### Negative

- The feature adds platform-specific adapter maintenance.
- Real native-dialog behavior cannot be a deterministic CI gate and requires manual macOS and
  Windows evidence.
- Some locked-down or non-interactive environments will continue to rely on the in-app picker.

### Neutral

- Linux is unsupported in the first delivery wave unless a later child issue explicitly scopes a
  portal or desktop-environment adapter.
- macOS privacy/TCC and Windows interactive-session limits are platform limitations to document, not
  route failures to hide.

## Compatibility with existing ADRs

- ADR-0021: preserves the bundled npm delivery model.
- ADR-0024: preserves the Browser/PWA UI and does not introduce Electron, Tauri, Wails, or a native
  installer.
- ADR-0027: keeps selected paths in existing path-owning state only.
- ADR-0030: keeps the browser presentation-only for filesystem authority and preserves governed
  command boundaries.
- ADR-0048: keeps evidence confidential and content-free.
- ADR-0099: follows the dedicated fixed-purpose local authority pattern rather than terminal reuse.

## Related

- Epic #1941: Native OS file and folder picker for the local Node BFF
- `packages/keiko-server/src/files.ts`
- `packages/keiko-server/src/routes.ts`
- `packages/keiko-ui/src/lib/api.ts`
- `packages/keiko-ui/src/app/components/desktop/modals/NewWindowDialog.tsx`
- `packages/keiko-ui/src/app/components/desktop/local-files/LocalFileBrowserDialog.tsx`
