# ADR-0118: Native OS file/folder dialog boundary for local path selection

## Status

Accepted (Epic #1941, 2026-07-07)

## Context

Keiko is npm-delivered: a Browser/PWA UI served by the local Node BFF on one loopback origin, with
no Electron/Tauri/native installer (ADR-0021, ADR-0024). Browser APIs cannot return trusted
absolute local paths, so every "Browse" affordance so far was an in-app picker
(`DirectoryPicker`/`FilePicker` in `NewWindowDialog`, the shared `LocalFileBrowserDialog`) walking
the filesystem through `/api/files/*`. The local Node process already is Keiko's governed
filesystem authority (`resolveRoot`, deny-list, realpath, metadata redaction in
`packages/keiko-server/src/files.ts`), which makes it the correct — and only — place to open the
platform's native picker and validate what comes back.

Epic #1941 asked for Finder/Explorer-quality selection while keeping the npm distribution model.
The maintainer additionally decided during delivery: the native dialog **replaces** the in-app
pickers outright rather than layering on top of them — after the switch the in-app picker
components are deleted, and the fallback on unsupported platforms is **manual path entry**, which
every replaced surface already offered (with one deliberate exception, D4).

Existing capability review (Reuse gate):

- Root validation, deny-list, realpath/symlink handling, and metadata redaction already live in
  `files.ts` (`resolveRoot`, `pathIsDenied`, `FilesError`). The native route reuses `resolveRoot`
  verbatim for folder selections and mirrors the same chain for file selections (files.ts only
  models directory roots).
- Route conventions (host/origin check, JSON content-type, CSRF header, `no-store`,
  correlation-id minting, top-level catch with redacted operator diagnostics) are centralized in
  `server.ts`/`routes.ts`; the native route is a plain `API_ROUTES` entry and inherits all of it.
- Bounded child-process execution exists in `gitRoutes.ts` (fixed binary, `shell:false`,
  `windowsHide`, timeout, byte caps) and stdin delivery in `local-knowledge-ocr-runtime.ts`;
  neither is importable as a generic runner, so the adapter carries its own bounded runner
  modeled on both. Terminal/command-runner surfaces are NOT reused: their authority (allowlisted
  workspace command execution with evidence) is a different trust target than a fixed-purpose
  human-interaction primitive.
- The typed UI client pattern (`fetchJson` with automatic CSRF for state-changing calls, stable
  `ApiError`) lives in `packages/keiko-ui/src/lib/api.ts`; the native client extends it.

## Decision

### D1 — Dedicated fixed-purpose boundary

The BFF owns two routes: `POST /api/native-file-dialog/open` and
`GET /api/native-file-dialog/capability` (`packages/keiko-server/src/native-file-dialog/`). The
open contract is a closed mode set — `open-file`, `open-files`, `open-directory` — plus bounded
`title`, `defaultPath`, and extension `filters`. There is no executable, argv, script, or command
text field; the contract cannot express command execution. Requests are validated fail-closed in
`keiko-contracts` (`validateNativeFileDialogRequest`): bidi/zero-width stripping on the title,
NUL rejection on paths, size caps on every field, and errors that name the offending field but
never echo its value.

### D2 — Adapter output is untrusted until validated

Adapters return `{ cancelled, paths }`. Before any path reaches the browser the route enforces:
selection count per mode (`nativeFileDialogSelectionBounds`), NUL rejection, platform-absolute
shape, existence, expected kind (file vs directory), realpath, deny-list on BOTH the raw and the
resolved path, and metadata-redaction safety. Directory selections go through the exact
`resolveRoot` policy `/api/files/*` applies to roots; file selections mirror that chain. Failures
map to stable codes (`NATIVE_DIALOG_UNSUPPORTED` 501, `NATIVE_DIALOG_ALREADY_OPEN` 409,
`NATIVE_DIALOG_TIMEOUT` 504, `NATIVE_DIALOG_FAILED` 502, `NATIVE_DIALOG_INVALID_SELECTION` 422)
with generic messages; selected paths and adapter stderr never appear in error bodies, and
adapter failures emit a content-free operator diagnostic (exit code + byte counts) keyed by the
request correlation id.

### D3 — Platform adapters (fixed binary, fixed argv, stdin JSON)

macOS: `/usr/bin/osascript -l JavaScript -e <static JXA>` with the config as UTF-8 JSON on stdin.
`choose file`/`choose folder` are StandardAdditions user-interaction primitives (no TCC automation
grant); cancellation (AppleScript error −128) exits 0 with `cancelled: true`.

Windows: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -STA
-EncodedCommand <base64(utf16le(static script))>` with the config base64-wrapped on stdin (ASCII
bytes, codepage-independent). File modes use `System.Windows.Forms.OpenFileDialog`; the folder
mode uses the modern Explorer Common Item Dialog (`IFileOpenDialog`,
`FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR`) with all COM marshalling in an
embedded C# helper compiled via `Add-Type`, so PowerShell only hosts stdin/stdout.

Both scripts are deterministic TypeScript constants (`scripts.ts`) — nothing extra to package,
nothing that can drift from review. The shared runner enforces `shell:false`, `windowsHide`, a
10-minute interaction timeout with SIGTERM→SIGKILL escalation, stdout/stderr byte caps, and a
selection-count cap; spawn failures surface as typed adapter errors, never raw process output.
One dialog runs at a time per BFF process (injectable single-flight state; concurrent requests
get 409).

### D4 — Replacement, not fallback (maintainer decision)

All Browse surfaces call the shared UI client (`packages/keiko-ui/src/lib/native-file-dialog.ts`:
memoized capability + `pickWithNativeDialog` folding transport outcomes into
picked/cancelled/busy/unsupported/error) and the `useNativeFileDialogCapability` hook:

- `NewWindowDialog` directory config fields, the agent repository picker, and the unit-test
  source-file picker (native absolute paths are normalized repo-relative; out-of-workspace picks
  are refused with calm copy).
- Quality Intelligence `RunLauncher` folder/file source selection (an always-editable path input
  pairs with Browse; on unsupported platforms Browse is disabled with an explanatory note inviting
  manual entry).
- Local-knowledge `capsule-actions` (the chosen scope decides the mode; multi-file picks fold
  into shared root + relative files via `nativePathsToRootAndFiles`) and
  `source-rebind-control` (always a folder pick — the old picker's file branch also collapsed to
  the shared root).

The in-app pickers are deleted: `DirectoryPicker`, `FilePicker`, `LocalFileBrowserDialog`, their
tests, the `GET /api/files/directories` route, its handler/listing helpers in `files.ts`, the
`fetchFilesDirectories` client, and the `FilesDirectory*` wire types. `GET /api/files/tree` stays
(the Files explorer widget consumes it). Manual path entry remains first-class everywhere it
existed; clicking a path input no longer opens any picker.

### D5 — Capability is a server statement

`GET /api/native-file-dialog/capability` reports whether the BFF host platform has an adapter
(darwin/win32). The UI never infers OS support from user-agent sniffing — the server opens the
dialog, so the server platform is the truth. Unsupported platforms (Linux in this wave) keep
Browse visibly disabled with a note and rely on manual entry; a later xdg-desktop-portal adapter
can flip the capability without UI changes.

### D6 — State and evidence

No new persistent store: picked paths land in exactly the state slots the manual inputs already
own. The UI never logs selected paths; server diagnostics stay content-free; cancellation is a
typed success (`cancelled: true`) and never renders as an error.

## Security and threat model

Threats addressed: repurposing Browse into command execution (fixed binary/argv, closed contract,
stdin-only config); injection through title/defaultPath/filters (validation + stdin JSON, filter
extensions restricted to `[a-z0-9.+_-]`); path-policy bypass via symlink/relative/denied/
wrong-kind selections (D2 chain, deny on raw AND realpath); privacy leakage through errors,
diagnostics, or evidence (generic messages, content-free diagnostics, no path logging); DoS via
concurrent dialogs or a hung/flooding helper (single flight, timeout with kill escalation, byte
caps, selection cap); UI confusion (cancellation is a non-event; busy/unsupported have calm,
stable copy). Hostile-input tests cover NUL, relative paths, wrong kind, denied paths (raw and
symlink-target), malformed/oversized adapter output, timeouts, and concurrent opens.

## Consequences

Positive: platform-native selection UX with unchanged npm delivery; ONE validation policy for
natively picked and manually typed paths; less UI surface (an entire in-app browsing subsystem
deleted); a narrow, testable trust boundary.

Negative: platform-specific adapter maintenance; real dialog behavior is not CI-verifiable — CI
uses fake runners and a stubbed route (Playwright), real Finder/Explorer behavior is manual
platform QA; Linux/headless environments lose in-app browsing and must type paths until a portal
adapter ships.

Neutral: macOS TCC can allow selection yet deny later reads (a documented platform limitation,
not a picker failure); Windows dialogs require an interactive desktop session.

## Compatibility with existing ADRs

ADR-0021/ADR-0024 (npm delivery, Browser/PWA + local BFF) are preserved. ADR-0019 boundaries are
unchanged — contracts stay leaf and browser-safe. ADR-0016 deny-list semantics apply unchanged to
native selections. ADR-0018-adjacent execution surfaces (terminal/command-runner) are explicitly
NOT the implementation vehicle.

## Related

- Epic #1941 — native OS file and folder picker for the local Node BFF
- `packages/keiko-contracts/src/native-file-dialog.ts`
- `packages/keiko-server/src/native-file-dialog/{scripts,adapter,route}.ts`
- `packages/keiko-ui/src/lib/native-file-dialog.ts`
- `docs/troubleshooting/native-file-dialog.md`
