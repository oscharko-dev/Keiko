# ADR-0018: Terminal Tool Boundary and Permitted-Command Policy

## Status

Accepted (2026-06-01)

## Context

Issue #78 (parent epic #61, sibling to the Browser tool in #76 and the Files explorer in #67/#75)
replaces the unbounded interactive PTY surface in `src/ui/terminal.ts` with a bounded,
permitted-command execution surface. The PTY surface (`PtyTerminalSessionManager`, WebSocket upgrade
handler, `installedShells` discovery) is explicitly excluded by the issue because an interactive
shell accepts any command the user types, making an allowlist unenforceable at the protocol level.

Three forces shape the decision space.

**The ADR-0006 sandbox boundary is a hard reuse constraint.** `runCommand` in `src/tools/exec.ts`
already enforces: a deny-by-default `CommandRule` allowlist checked before any spawn; a
workspace-rooted cwd validated via `resolveWithinWorkspace` + `containedRealPathInfo`; a
`SandboxPolicy` covering env allowlist, timeout, output cap, termination grace, and network policy;
no-shell spawn (`{ shell: false }`); process-group kill on timeout/abort; and stdout/stderr
redacted against `collectSensitiveEnvValues`. AC2 ("all limits from `src/tools/` honored without
weakening") is satisfied structurally by routing every UI execution through `runCommand` unchanged.

**The ADR-0011 zero-new-runtime-dep invariant is a hard constraint.** `node-pty` is the sole import
of `node-pty` in the codebase — only `src/ui/terminal.ts` imports it (verified by grep). `xterm`
and `@xterm/addon-fit` are imported only from
`ui/app/components/desktop/widgets/cards/TerminalWidget.tsx`. Removing the PTY surface allows all
three packages to be dropped. Removing is a subtractive change: no new runtime dep is introduced
and the `package.json` dependency surface shrinks. ADR-0011 D1 explicitly permits subtractive dep
changes.

**The regulated-audience trust model demands an auditable, static command surface.** A developer
in a banking or insurance pilot must be able to justify every command that ran in the tool to a
compliance reviewer. A PTY allows arbitrary commands and produces no structured audit trail. A
bounded exec surface produces one `terminal-execution` evidence entry per invocation, redacted by
construction, with counts but never raw args.

The existing BFF and audit infrastructure (`deepRedactStrings`, `EvidenceStore`, the
CSRF-guarded POST + SSE pattern) is composed unchanged. The terminal tool adds a thin policy layer
on top of `runCommand`; it does not invent new safety mechanisms.

## Decision

### D1 — Execution model: synchronous `runCommand` per HTTP request, no persistent shell, no PTY

We will execute each terminal command by calling `runCommand` (`src/tools/exec.ts`) directly from
a BFF route handler. The HTTP POST blocks until the command exits (or times out or is aborted),
then returns the complete, redacted output in the response body.

PTY-based execution is eliminated for two reasons that are specific to this issue's scope. First,
a PTY presents the user with an interactive shell prompt where any command can be typed — the
allowlist in `src/tools/terminal-policy.ts` can gate the API entry point, but it cannot control
what the user types once a shell process is running. Second, the issue explicitly excludes
"Unrestricted interactive shell access" from scope; a PTY's value is precisely that interactivity.
The synchronous `runCommand` model enforces the allowlist structurally: the route handler
receives `{ command, args }`, validates them against the allowlist before spawning anything, and
never exposes a shell REPL.

The `node-pty` import in `src/ui/terminal.ts` is the only import of `node-pty` in the codebase.
`xterm` and `@xterm/addon-fit` are the only imports from those packages in `ui/`. Once the PTY
surface is removed, all three can be removed from `package.json` and `ui/package.json` respectively.

Multi-step pipelines, cd-persisting sessions, and streaming partial output chunks before command
completion are explicitly deferred (D11). Each of these would require either a persistent shell
process (PTY) or rewriting `runCommand` to stream — both of which are out of scope per AC2.

### D2 — Project-root boundary: two-tier containment with project-scoped pre-check

We will apply a two-tier cwd containment that reuses the existing `runCommand` boundary and adds
one project-scoped pre-check above it.

**Tier 1 — `runCommand`'s existing boundary (reused unchanged).** `runCommand` calls
`resolveCwd(deps, cwd)` which applies `resolveWithinWorkspace` (lexical containment against the
workspace root) followed by `containedRealPathInfo` (symlink realpath containment) and
`isDenied` (always-on deny list covering `.env*`, `.git/**`, `node_modules/**`, etc.).
`src/tools/exec.ts:239–251` is the definitive implementation. This tier is not modified.

**Tier 2 — project-scoped pre-checks (new, in the BFF manager).** The request body carries a
`projectId`. The BFF manager resolves `projectId → workspaceRoot` via the ADR-0013 `ProjectStore`
(`src/ui/store/**`). If the project is not found, or if the stored root no longer resolves on disk,
the handler returns `PROJECT_NOT_FOUND` (D10) before any spawn. The manager then asserts that the
requested `cwd` (after `resolveWithinWorkspace` against the project root) is contained within that
project's `workspaceRoot` — i.e., not a sibling project's directory. This is an additive check
above Tier 1: it prevents a request with a valid `cwd` in one project from being executed in the
context of a different project, closing an inter-project path confusion class that `runCommand`'s
workspace root check does not address (because `runCommand`'s workspace root is caller-supplied).

The same Tier 2 boundary is applied to path-bearing command operands for `cat`, `head`, `tail`,
`wc`, `ls`, `tree`, `grep`, and the starting path operands of `find`. Operands are lexically
resolved against the validated `cwd`, then realpath-checked via `containedRealPathInfo` to reject
symlink escapes and always-denied paths. Tool-local root shifters such as `git -C` and `npm
--prefix` are denied rather than re-rooted.

The workspace root that is passed to `runCommand`'s `deps.workspace` is always the project's
resolved root from `ProjectStore`, never the request body. The request body `cwd` is validated
lexically against the project root before being passed as `runCommand`'s `cwd`.

### D3 — Permitted-command allowlist policy

We will define a `readonly CommandRule[]` constant named `TERMINAL_COMMAND_RULES` in a new module
`src/tools/terminal-policy.ts`. This module is the single source of truth for the terminal tool's
permitted surface; it does not replace or modify `DEFAULT_COMMAND_RULES` (which remains the
model-facing harness default).

`TERMINAL_COMMAND_RULES` extends the logic from `CommandRule` in `src/tools/types.ts`. For commands
that `CommandRule` cannot express as subcommand allowlists (e.g. `find`'s flag-based denial), the
terminal policy module exports a separate `isTerminalCommandAllowed(command, args)` decision
function that runs the `CommandRule` check first, then applies command-specific arg inspection for
commands where flag-level policy is required. The function is pure and has no side effects.

The allowlist is minimal and conservative. Each entry below is independently justified:

| Command | Arg policy | Security rationale |
|---------|------------|--------------------|
| `ls` | Flags accepted; non-flag path operands must resolve inside the selected project root. | Read-only directory listing. No write, network, or exec capability. Operand containment prevents outside-project inspection. |
| `cat` | Path operands must resolve inside the selected project root. | File content view. Write impossible without shell redirection; `shell: false` prevents redirection. Operand containment prevents outside-project reads. |
| `head` | Flags such as `-n` accepted; path operands must resolve inside the selected project root. | First-N-lines view. Same isolation as `cat`. |
| `tail` | Flags such as `-n` accepted; path operands must resolve inside the selected project root. | Last-N-lines view. Same isolation as `cat`. |
| `wc` | Flags accepted except `--files0-from`; path operands must resolve inside the selected project root. | Count-only output; operand containment prevents outside-project filesystem inspection. `--files0-from` can read an unbounded path list and is denied. |
| `find` | No `allowedSubcommands`. `denyFlags`: `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprint0`, `-fprintf`, `-fls`, `-files0-from`. Starting path operands before the expression must resolve inside the selected project root. | `-exec`/`-execdir`/`-ok`/`-okdir` execute arbitrary commands. `-delete` mutates the filesystem. `-fprint*`/`-fprintf`/`-fls` write to a file path, and `-files0-from` reads traversal roots from a file. |
| `grep` | Flags accepted. Pattern-file operands supplied via `-f`/`--file`, `--exclude-from` files, and search path operands must resolve inside the selected project root. | Read-only pattern search. `shell: false` prevents shell-expansion side-effects. Operand containment prevents `grep -r` from traversing outside the project. |
| `tree` | Path operands must resolve inside the selected project root. `-o`/`--output` denied. | Directory structure visualization. `-o` writes output to a file and bypasses reviewed write paths, so it is denied. |
| `git` | `allowedSubcommands`: `status`, `diff`, `log`, `show`, `rev-parse`, `ls-files`, `describe`, `blame`, `cat-file`, `branch`, `remote`. Global/root-shifting flags denied: `-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--exec-path`. Unsafe flags denied: `--ext-diff`, `--textconv`, `--output`, `--no-index`, `--contents`. `branch` allows listing flags only and denies mutation flags/positionals. `remote` allows flags only, such as `-v`; `remote show` is denied. | Extends the harness `DEFAULT_COMMAND_RULES` git allowlist with tightly gated `branch` and `remote`. Root-shifting, config injection, external diff helpers, output-file writes, network-capable remote subcommands, and branch mutations are denied. |
| `node` | Only `--version` and `-v` accepted. All other args denied. Enforced in `isTerminalCommandAllowed` via positional check. | `node -e`/`node <file>` executes arbitrary JavaScript — arbitrary code execution equivalent to a shell. Only the version flag is safe. |
| `npm` | `allowedSubcommands`: `ls`, `list`, `help`. Denied flags: `-c`, `--call`, `--prefix`, `--global`, `-g`, `--location`. | `install`, `run`, `exec`, `ci`, `publish` and all mutation subcommands are excluded by omission. Registry/network-capable inspection commands (`view`, `info`, `outdated`, `ping`) are excluded for the MVP no-egress posture. Root-shifting flags are denied. |
| `pwd` | No subcommand or flag gating. | Outputs only the current directory path. |
| `echo` | All args accepted. | Echoes its arguments. `shell: false` prevents `echo $SECRET` from expanding env vars; output is still Layer-1 redacted by `runCommand`. |

### D4 — Explicit deny list (representative, not exhaustive)

The allowlist in D3 is the gate. The deny list documents commands that were explicitly considered
and excluded, and the concrete harm each could cause if allowed.

| Command | Concrete harm if allowed |
|---------|--------------------------|
| `rm` | Deletes files; direct filesystem mutation outside `WorkspaceWriter`. |
| `mv`, `cp` | Moves/copies files; `cp` can exfiltrate files outside workspace. |
| `chmod`, `chown` | Changes permissions; could make `.git/hooks` scripts executable. |
| `curl`, `wget` | Outbound network; data exfiltration, malware download. Removing the "no allowed tool has network capability" mitigation that ADR-0006 D2 Dim 4 relies on. |
| `nc`, `ssh`, `scp` | Network channel or remote shell; direct data exfiltration path. |
| `sudo` | Privilege escalation to root. |
| `sh`, `bash`, `zsh`, `fish`, `dash` | Shell interpreter; any command can be run inside it, bypassing the allowlist entirely. |
| `python`, `python3`, `ruby`, `perl`, `php` | Script interpreters; arbitrary code execution equivalent to a shell. |
| `env` | `env CMD ARGS` form executes a command; equivalent to a shell escape. |
| `xargs` | Feeds input to another command; allows arbitrary command execution from controlled input. |
| `kill`, `pkill`, `killall` | Signals processes; can terminate the BFF process itself. |
| `git push/commit/add/fetch/pull/reset/checkout/merge/rebase/clean/config` | Git write/mutation subcommands; repository manipulation without the patch workflow. Excluded by `allowedSubcommands` in D3. |
| `npm install/run/exec/ci/publish/init` | Package mutation, arbitrary script execution via `package.json#scripts`. Excluded by omission from `allowedSubcommands`. |
| `npx` | Executes npm packages including remote ones; arbitrary code execution. |
| `node <file>`, `node -e` | Arbitrary JS execution. Only `--version`/`-v` are allowed (D3). |

### D5 — Limits passthrough: `SandboxPolicy` applied unchanged via `runCommand`

Every `SandboxPolicy` field is passed to `runCommand` unmodified. The terminal manager accepts an
optional injected `SandboxPolicy` for tests, but production construction uses
`DEFAULT_SANDBOX_POLICY` from `src/tools/types.ts:52–58`:

| Field | Default value | Source |
|-------|---------------|--------|
| `envAllowlist` | `DEFAULT_ENV_ALLOWLIST` | `src/tools/types.ts:35` |
| `network` | `"inherit"` | `src/tools/types.ts:53` — Wave 1 honest limit, unchanged |
| `maxOutputBytes` | `262_144` (256 KB) | `src/tools/types.ts:55` |
| `defaultTimeoutMs` | `30_000` (30 s) | `src/tools/types.ts:56` |
| `terminationGraceMs` | `2_000` (2 s) | `src/tools/types.ts:57` |

The BFF route handler accepts an optional `timeoutMs` in the request body for commands where the
user expects a different duration. If supplied, it is passed as `RunCommandInput.timeoutMs` and
clamped to `[1_000, defaultTimeoutMs]` — a caller cannot exceed the policy's default ceiling. This
is the same per-invocation override pattern used by verification steps.

No `SandboxPolicy` field is weakened. The harness `commandExecutions` counter is not applicable
here (the terminal tool does not run through a harness session). The `TerminalExecutionManager`
tracks its own in-flight count (D9) for resource bounding.

### D6 — Redaction: two layers applied at distinct points

Redaction is applied twice, at different points, to different threat surfaces. Neither replaces
the other; both are required.

**Layer 1 — `runCommand` env-value redaction (existing, unchanged).** `runCommand` calls
`collectSensitiveEnvValues(processEnv, policy.envAllowlist)` to collect all parent env values not
in the allowlist (values ≥ 6 chars), then passes them as `additionalSecrets` to `redact()` when
building `CommandResult.stdout` and `CommandResult.stderr`. This scrubs env-value secrets that
might have leaked into command output. The `TRUNCATED_OUTPUT_MARKER` constant replaces all output
when `maxOutputBytes` is exceeded — there is no partial prefix that could contain a half-secret.
Layer 1 is in `src/tools/exec.ts` and is not modified.

**Layer 2 — audit redaction at evidence-persist time (ADR-0010 pattern).** Before calling
`EvidenceStore.put`, the terminal evidence appender applies `deepRedactStrings` to any string
fields destined for the evidence manifest. This second pass catches structural patterns (Bearer
tokens, `sk-` keys, GitHub/AWS/Slack/Google tokens, PEM markers — the `redact()` built-in
patterns) plus configured literals and env values. Layer 2 is in `src/audit/redaction.ts` and is
reused unchanged.

The two layers are complementary: Layer 1 covers env-value secrets in live command output; Layer 2
covers structural patterns in persisted evidence. Both run unconditionally on every execution.

The evidence entry (D11 shape) contains zero output bytes: `stdout` and `stderr` are not included
in the `EvidenceManifest`. They are returned to the calling client in the synchronous POST response
body (already Layer-1 redacted) but are never written to disk. This removes a redaction-at-rest
surface entirely.

### D7 — Harness/SSE event shape

Four `terminal:*` events are emitted on the SSE channel `/api/terminal/events` (D8). Each event
carries only metadata; output bytes are not included. A client that wants output reads the
synchronous POST response.

| Event type | Fields |
|------------|--------|
| `terminal:execution-started` | `executionId: string`, `projectId: string`, `command: string` (bare name only — never args), `argCount: number`, `startedAt: number` (epoch-ms), optional `requestId: string` echoed from the POST body |
| `terminal:execution-completed` | `executionId: string`, `exitCode: number \| null`, `durationMs: number`, `truncated: boolean`, `timedOut: boolean`, `stdoutByteLength: number`, `stderrByteLength: number`, optional `requestId: string` |
| `terminal:execution-failed` | `executionId: string`, `code: TerminalErrorCode` (D10), `message: string` (static string only — never a raw OS or Node.js error message), optional `requestId: string` |
| `terminal:execution-cancelled` | `executionId: string`, optional `requestId: string` |

The `command` field in `terminal:execution-started` is the allowlist-validated bare name (e.g.
`"git"`, `"grep"`). Args are not emitted in any event: they may contain workspace-relative paths
that reveal project structure. `argCount` is sufficient for the audit trail.

The SSE channel is session-less and multiplexed: all in-flight executions across all browser tabs
share one channel per BFF process. This mirrors the `browser:*` event channel design in ADR-0017 D7.
The optional `requestId` lets a widget correlate a POST it initiated with the global event stream
before enabling cancellation controls.

Events are not `HarnessEvent` objects. They do not carry `schemaVersion`, `runId`, `fingerprint`,
or `seq`. The terminal tool does not flow through the harness state machine (ADR-0004 confirms why;
the harness has its own `runCommand` path for workflow tool calls). Terminal events are BFF-layer
metadata, not harness audit events.

### D8 — BFF route family: `/api/terminal/*`

The terminal route family is rebuilt from scratch. PTY-only routes (`GET /api/terminal/shells`,
`POST /api/terminal/sessions`, `DELETE /api/terminal/sessions/:id`, WebSocket upgrade
`/api/terminal/sessions/:id/io`) are removed. The WebSocket upgrade handler in `src/ui/server.ts`
is removed at the same time.

| Method | Pattern | CSRF | Purpose |
|--------|---------|------|---------|
| GET | `/api/terminal/policy` | No | Return the permitted-command summary for UI display: `{ commands: string[], limits: { maxOutputBytes, defaultTimeoutMs } }`. No secrets. Read-only. |
| GET | `/api/terminal/directories` | No | Query: `?projectId=<id>`. List subdirectories of the project root for the cwd picker. Reuses the `listDirectories` helper preserved from `terminal.ts`. |
| POST | `/api/terminal/executions` | Yes | Body: `{ projectId, command, args: string[], cwd?: string, timeoutMs?: number, requestId?: string }`. Runs the command via `runCommand`, persists evidence, emits SSE events, returns `{ executionId, exitCode, stdout, stderr, durationMs, truncated, timedOut }`. All output is Layer-1 redacted by `runCommand`. |
| DELETE | `/api/terminal/executions/:executionId` | Yes | Aborts an in-flight execution via its `AbortController`. Returns `{ ok: true }` if found; `EXECUTION_NOT_FOUND` (D10) if not. |
| GET | `/api/terminal/events` | No | SSE channel for `terminal:*` events. Multiplexed across all executions. Follows the same STREAMING sentinel return pattern as `/api/runs/:runId/events` (ADR-0011 D5). |

The CSRF guard applies to POST and DELETE routes, consistent with every other state-changing route
in the BFF (ADR-0011 D5). GET routes are read-only and do not require a CSRF token.

`src/ui/routes.ts` registers the five routes after the existing `/api/browser/*` block.

### D9 — Lifecycle: per-request execution, in-memory map keyed by executionId

Executions are not sessions. There is no persistent connection, no idle timer, and no browser
reconnection. The lifecycle is:

1. `POST /api/terminal/executions` arrives; the handler validates the request (D2 + D3), creates
   an `AbortController`, adds `{ controller, projectId }` to the in-memory `Map<string, InFlightExecution>`
   keyed by a fresh `randomUUID()` executionId, emits `terminal:execution-started`, and awaits
   `runCommand`.
2. `runCommand` resolves (completes, times out, or is cancelled by abort).
3. The manager persists the evidence entry, emits the completion/failure/cancel event, returns the
   HTTP response, and removes the executionId from the map. Evidence persistence is fail-closed:
   if the ledger write fails, the execution is surfaced as `EVIDENCE_WRITE_FAILED` instead of a
   normal success.

The map holds only executions that are currently running. An executionId is valid only while its
`runCommand` call is in flight. Once the command settles (any path), the entry is deleted and a
subsequent `DELETE` for that executionId returns `EXECUTION_NOT_FOUND`. There is no execution
history in memory.

A maximum of `MAX_CONCURRENT_EXECUTIONS = 8` in-flight executions is enforced at the route handler
level. A request arriving when the limit is reached is rejected with `EXECUTION_LIMIT_EXCEEDED`
(HTTP 429) without spawning anything. This is a BFF-process-wide resource bound, not per-project.

### D10 — Typed failure modes

`TerminalErrorCode` is a discriminated string union defined in `src/ui/terminal-errors.ts`.

| Code | Trigger | HTTP status |
|------|---------|-------------|
| `PROJECT_NOT_FOUND` | `projectId` not found in `ProjectStore` | 404 |
| `COMMAND_DENIED` | `isTerminalCommandAllowed` returns false (allowlist or denied flag check) | 403 |
| `CWD_OUTSIDE_PROJECT` | `cwd` escapes the project's `workspaceRoot` (lexical or realpath check) | 403 |
| `CWD_DENIED` | `cwd` matches the always-on deny list in `runCommand` (`.git/hooks`, `node_modules`, etc.) | 403 |
| `EXECUTION_NOT_FOUND` | `DELETE` on an unknown or already-completed `executionId` | 404 |
| `EXECUTION_LIMIT_EXCEEDED` | In-flight count at `MAX_CONCURRENT_EXECUTIONS` | 429 |
| `TIMEOUT` | `runCommand` rejects with `CommandTimeoutError` (`src/tools/errors.ts`) | 408 |
| `CANCELLED` | `runCommand` rejects with `CommandCancelledError` (abort signalled via DELETE) | 499 |
| `EXECUTABLE_NOT_FOUND` | `runCommand` denies because the bare name is not on `PATH` | 404 |
| `EVIDENCE_WRITE_FAILED` | Evidence ledger write failed or the evidence store is unavailable | 500 |
| `INTERNAL` | Any other spawn failure or unmapped error from `runCommand` | 500 |

All `INTERNAL` error responses use a static, generic message. The raw Node.js or OS error is
logged server-side only and is never serialized into the HTTP response body.

The `terminal:execution-failed` SSE event carries the same `TerminalErrorCode` and a static message
string, consistent with ADR-0017 D10's `browser:error` pattern of never surfacing raw error messages.

### D11 — MVP scope vs follow-up issues

**MVP (Issue #78):**

- Replace `PtyTerminalSessionManager` with `TerminalExecutionManager` in `src/ui/terminal.ts`.
- Remove all PTY imports (`node-pty`, WebSocket streaming for terminal).
- Remove PTY routes and the WebSocket upgrade handler from `src/ui/server.ts`.
- Implement `TERMINAL_COMMAND_RULES` and `isTerminalCommandAllowed` in `src/tools/terminal-policy.ts`.
- BFF route family `/api/terminal/*` (five routes, D8).
- `TerminalErrorCode` discriminated union in `src/ui/terminal-errors.ts`.
- `buildTerminalEvidenceEntry` in `src/ui/terminal-evidence.ts`.
- Rewrite `TerminalWidget.tsx`: allowed-command selector (from `/api/terminal/policy`), args
  input, cwd picker (from `/api/terminal/directories`), Run button, output panel with
  exit-code/timing/truncation badges, SSE subscription for live status.
- Remove `node-pty` from `package.json` (only import: `src/ui/terminal.ts`).
- Remove `@xterm/xterm` + `@xterm/addon-fit` from `ui/package.json` (only imports:
  `TerminalWidget.tsx`).
- Evidence entry per execution in `EvidenceManifest` (additive, `evidenceSchemaVersion` stays `"1"`).

**Explicit follow-ups (not in #78):**

- Multi-step command pipelines (`cmd1 | cmd2`): requires shell or `runCommand` streaming rewrite.
- cd-persisting sessions: requires persistent shell or explicit session-state management.
- Streaming partial stdout/stderr chunks before command completion: requires streaming support in
  `runCommand`; AC2 forbids weakening.
- Per-project policy overrides (different allowed commands per project): global allowlist for MVP.
- Output side-files for large output (> `maxOutputBytes`): truncation marker is sufficient for MVP.
- Shell-like quoted-argument parsing in the UI: the backend accepts `args: string[]`; the MVP
  widget intentionally uses a simple whitespace split and keeps complex argument construction out
  of scope.

## Consequences

### Positive

- **The allowlist is the only path to command execution.** A user cannot run any command not in
  `TERMINAL_COMMAND_RULES` regardless of how the request is constructed, because `runCommand`
  checks `isCommandAllowed` before any spawn (`src/tools/exec.ts:401–409`). There is no fallback,
  override, or escape hatch.
- **All ADR-0006 sandbox guarantees apply without modification.** Env allowlist, ephemeral HOME,
  workspace-rooted cwd, no-shell spawn, output cap, process-group kill, and stdout/stderr
  redaction are inherited by composition, not reimplemented.
- **Removing PTY eliminates a large, unsafe surface.** `node-pty`, `xterm`, and `@xterm/addon-fit`
  are all removed from the dependency tree. The package surface shrinks and the interactive-shell
  attack class is removed structurally.
- **Every execution is evidence.** The `terminal-execution` entry records command name, arg count,
  exit code, duration, and byte counts without persisting output.
- **Zero new runtime dependencies.** ADR-0011's invariant is preserved; the dep graph shrinks.

### Negative

- **No interactive shell.** Multi-step workflows require multiple sequential POST requests with no
  piping between commands.
- **No cd persistence.** Every execution must specify its cwd explicitly.
- **No streaming output.** Large commands produce no visible output until they complete or hit the
  output cap.
- **Shell quoting is not interpreted by the widget.** Arguments containing spaces must be supplied
  through a future richer UI affordance; the backend contract remains explicit `args: string[]`.

### Neutral

- **`evidenceSchemaVersion` stays `"1"`.** Terminal executions are stored as standard
  `EvidenceManifest` records with `run.taskType: "terminal-execution"`. Existing manifests without
  that task type remain valid.
- **`TerminalExecutionManager` is injectable.** Optional `terminal?: TerminalExecutionManager`
  in `UiHandlerDeps` — tests that do not exercise terminal routes compile unaffected.
- **`node-pty` removal is the only `package.json` change for MVP.** It reduces installed size and
  removes a native addon that can fail to build on certain Node/OS combinations.

## Alternatives Considered

### Alternative 1: Keep PTY and add the allowlist as a pre-spawn gate on shell input

Allow the PTY to start a shell session but check the user's input against the allowlist before
passing each line to the PTY's stdin.

- **Pros**: preserves the interactive UX; command history, tab completion, multi-step pipelines,
  and cd persistence all continue to work.
- **Cons**: the PTY presents the user with a full shell interpreter. The shell processes the user's
  line before any tool code does: variable expansion (`$PATH`), command substitution (`` `cmd` ``,
  `$(cmd)`), aliases, shell functions, and shell builtins (including `cd`, `source`, `.`, `exec`)
  are all evaluated by the shell before the line leaves the PTY. A user can type
  `git$'\x20'push` or `eval rm -rf .` to bypass a text-match gate. The allowlist is not
  enforceable at the PTY protocol level.
- **Why rejected**: ADR-0006 D1 reaches the same conclusion for the model-facing surface: "shell
  execution is incompatible with fail-closed security." The PTY approach makes the allowlist a
  cosmetic control. The issue's "Out of Scope: Unrestricted interactive shell access" explicitly
  prohibits this design.

### Alternative 2: Run the PTY inside a Docker/firejail/bwrap container

Keep the PTY but wrap it in a container that enforces a syscall allowlist (seccomp) and a
filesystem read-only overlay.

- **Pros**: full interactive UX; OS-level enforcement rather than application-level.
- **Cons**: ADR-0006 D7 explicitly defers container/process-isolation to a later wave and
  establishes the `SandboxPolicy.network` + injectable `SpawnFn` seam for that wave. Adding a
  container layer for one feature contradicts that decision and adds an OS-dependent install
  requirement (`bwrap` is not available on macOS; `firejail` is Linux-only; Docker requires a
  running daemon). This also violates ADR-0006's honest-limits framing — it would claim stronger
  isolation than the rest of the system provides.
- **Why rejected**: contradicts ADR-0006 D7; introduces an OS-dependent install requirement that
  breaks macOS support; does not follow the `SandboxPolicy.network`/`SpawnFn` seam already
  designed for the container wave.

### Alternative 3: Use a restricted shell (`rbash`, `lshell`, `scponly`)

Launch a restricted shell that disables certain builtins and PATH manipulation.

- **Pros**: closer to the interactive shell UX; `rbash` is built into bash on most systems.
- **Cons**: restricted shells restrict the shell's own capabilities but do NOT enforce which
  executables the user can run — any binary on `PATH` is reachable. `rbash` prevents `PATH`
  mutation but the existing `PATH` already contains `rm`, `curl`, `ssh`, and every other binary
  the deny list targets. `lshell` is a third-party package (violates ADR-0011). None of these
  enforce arg patterns (e.g., blocking `find -exec`).
- **Why rejected**: restricted shells do not enforce a command allowlist or arg-pattern policy.
  ADR-0006 D1's no-shell spawn is the correct primitive; a restricted shell reintroduces a shell
  interpreter between the policy check and the spawn.

### Alternative 4: Stream partial stdout/stderr via WebSocket (allowlist-gated, no PTY)

Keep the WebSocket upgrade infrastructure but replace the PTY with a `runCommand`-based backend,
streaming `stdout`/`stderr` data chunks as they arrive.

- **Pros**: the user sees output as it appears; large commands are more usable.
- **Cons**: `runCommand` in `src/tools/exec.ts` buffers all output internally before returning a
  `CommandResult`. Streaming would require a new streaming API in `exec.ts` — modifying a
  reviewed, accepted boundary layer. AC2 ("all limits honored without weakening") implies that
  `runCommand` is used as-is. The output cap and `TRUNCATED_OUTPUT_MARKER` are designed for
  buffered, atomic delivery; streaming a partial cap mid-stream changes that contract.
- **Why rejected**: modifies `src/tools/exec.ts`, violating AC2. Streaming output is explicitly
  listed in D11 as a follow-up issue. The synchronous HTTP model is simpler to audit and test.

### Alternative 5: Expose terminal commands as harness workflow invocations

Route terminal commands through the harness (`createSession`) as a new `TaskType: "terminal"`,
reusing the existing run registry, `RunRecord` type, and SSE run events.

- **Pros**: terminal executions would appear as run cards in the chat view (ADR-0015); the harness
  already has `runCommand` for its own tool use.
- **Cons**: the harness is designed for multi-step model-agent sessions with a state machine,
  cost tracking, and a `RunManifest`. A single command invocation has none of those properties.
  Forcing it into `RunRecord` would require nullable fields throughout the harness model, enlarging
  coupling. The harness `commandExecutions` counter and `maxCommandExecutions` limit are calibrated
  for agentic use, not direct user invocations. This mirrors the reason ADR-0017 D8 rejected
  folding browser sessions into `/api/runs/:runId/*`.
- **Why rejected**: violates the single-reason-to-change principle for `RunRecord`; couples
  terminal-command lifecycle to the harness state machine unnecessarily. The terminal tool is a
  BFF-level surface; the harness has its own `runCommand` path for agent tool use (ADR-0006).

## Implementation Plan

The following sketch defines file ownership and the test surface. It does not specify function
signatures or implementation logic; that is the developer's responsibility.

```
src/tools/
  terminal-policy.ts      — TERMINAL_COMMAND_RULES: readonly CommandRule[]
                            isTerminalCommandAllowed(command: string, args: readonly string[]): boolean

tests/tools/
  terminal-policy.test.ts — Per-rule boundary tests: each command with an allowed invocation,
                            a denied-flag invocation, a denied-subcommand invocation, and (for
                            find/node) an arg-level denial. Mutation-robust: each rule must
                            fail on a single-line weakening.

src/ui/
  terminal.ts             — REWRITE. Remove all node-pty imports and PtyTerminalSessionManager.
                            Keep: TerminalExecutionManager, execute(...), abort(executionId),
                            subscribe(handler), listDirectories(...). Drop TerminalSessionManager,
                            installedShells, WebSocket helpers.
  terminal-errors.ts      — TerminalErrorCode (D10) discriminated union + typed error classes.
  terminal-evidence.ts    — buildTerminalEvidenceEntry(result): TerminalEvidenceEntry
                            appendTerminalEvidence(store, runId, entry): void
  deps.ts                 — Replace terminal?: TerminalSessionManager with
                            terminal?: TerminalExecutionManager.
  routes.ts               — Remove PTY routes. Register five /api/terminal/* routes (D8).
  server.ts               — Remove WebSocket upgrade handler for terminal.

tests/ui/
  terminal.test.ts        — REWRITE. Cover: allowlist accept/deny, cwd containment (D2 Tier 1
                            and Tier 2), redaction in response + evidence (D6 both layers),
                            SSE emission (D7), abort lifecycle (D9), limits passthrough
                            (timeout, truncation, output cap).
  routes.test.ts          — Update: add new terminal routes, remove PTY routes.

ui/app/components/desktop/widgets/cards/
  TerminalWidget.tsx      — REWRITE: remove xterm/WebSocket. Add allowed-command dropdown
                            (from /api/terminal/policy), args input, cwd picker
                            (from /api/terminal/directories), Run button, output panel,
                            SSE subscription to /api/terminal/events.
  TerminalWidget.test.tsx — happy path + denied command + cwd outside project + abort.

package.json              — Remove node-pty (only import: src/ui/terminal.ts, confirmed by grep).
ui/package.json           — Remove @xterm/xterm + @xterm/addon-fit (only imports:
                            TerminalWidget.tsx, confirmed by grep).
```

The evidence entry is a standard `EvidenceManifest` with `evidenceSchemaVersion: "1"` and
`run.taskType: "terminal-execution"`. Terminal-specific command data is represented by one
`commandExecutions` record; args and output are deliberately excluded:

```
{
  evidenceSchemaVersion: "1",
  run: {
    runId: executionId,
    fingerprint: executionId,
    taskType: "terminal-execution",
    outcome: "completed" | "failed" | "cancelled" | "limit-exceeded",
    ...
  },
  model: { modelId: "terminal-tool", costClass: "unknown" },
  usageTotals: { promptTokens: 0, completionTokens: 0, requestCount: 0, totalLatencyMs: 0 },
  context: { workspaceRoot: projectId, entries: [], ... },
  commandExecutions: [
    {
      executable: command,   // bare name only ("git", "grep")
      argCount: number,      // never the args themselves
      exitCode: number | null,
      timedOut: boolean,
      durationMs: number
    }
  ]
}
```

Output text is never embedded in the evidence entry. It is returned to the calling client in the
synchronous POST response (already Layer-1 redacted) and is not written to disk.

`TerminalExecutionManager` is injectable via `UiHandlerDeps` (optional field, same pattern as
`browser?: BrowserSessionManager` in ADR-0017) so tests never touch a real spawn.

## Compliance With Prior ADRs

**ADR-0006 (Safe Tool Execution and Sandbox Boundary):** `runCommand` is used unchanged.
`src/tools/exec.ts` is not modified. The terminal tool layer is a thin policy wrapper (D3) plus
evidence appender (D6) plus SSE emitter (D7) that calls `runCommand` with the full
`SandboxPolicy`. No `SandboxPolicy` field is weakened. `TERMINAL_COMMAND_RULES` is a new, separate
constant that does not replace or modify `DEFAULT_COMMAND_RULES`. The deny-by-default invariant is
preserved: any command not in `TERMINAL_COMMAND_RULES` is denied before any spawn is attempted.

**ADR-0010 (Audit Ledger and Evidence Manifests):** Each execution appends a standard
`EvidenceManifest` with `run.taskType: "terminal-execution"` via `buildTerminalEvidenceEntry` +
`appendTerminalEvidence`. Output bytes are not embedded (keeps manifests small; removes
redaction-at-rest surface). The second redaction pass via `deepRedactStrings` applies to all string
fields before persist (D6 Layer 2). `evidenceSchemaVersion` stays `"1"`; `src/audit/types.ts` is
extended only to recognize the terminal task type.

**ADR-0011 (Wave-1 User Interface and Packaging):** Zero new runtime dependencies are added. The
removal of `node-pty`, `@xterm/xterm`, and `@xterm/addon-fit` is subtractive, which ADR-0011
explicitly permits. The BFF route shape, CSRF token pattern, and SSE STREAMING sentinel are all
reused unchanged. `UiHandlerDeps` gains an optional `terminal?: TerminalExecutionManager` field;
existing tests that do not supply it continue to compile.

**ADR-0013 (UI-Local Persistence):** No schema changes. Executions are ephemeral (D9). The
`ProjectStore` is read (not modified) to resolve the workspace root for D2 Tier 2.

**ADR-0014 (Workspace Shell Architecture):** `TerminalWidget`'s mount point in
`ui/app/components/desktop/widgets/index.tsx` is unchanged. Only the widget's internals are
rewritten.

## Open Questions / Out of Scope

**Quoted argument parsing.** The backend contract is explicit `args: string[]`, but the MVP widget
uses whitespace splitting for user input. That means paths or patterns containing spaces require a
future richer UI affordance rather than shell-style quoting. This is a usability limitation, not a
sandbox relaxation, because the backend revalidates the final array.

**`echo` and literal secrets.** With `shell: false`, `echo $SECRET` does not expand the variable.
Layer-1 redaction scrubs known env-value patterns. A user who deliberately types a literal secret
as an arg will see it in output; the redaction layer catches known patterns but not novel ones.
This inherits the same honest bound as ADR-0006 D5 and is not a new limitation introduced here.

**Per-project policy overrides.** The global `TERMINAL_COMMAND_RULES` applies to all projects. A
follow-up issue could introduce per-project `TerminalPolicyOverride` stored in the SQLite database.

## Related

- ADR-0004: Agent Harness Boundary — confirms terminal commands do not flow through the harness
  state machine; the harness has its own `runCommand` path for agent tool use.
- ADR-0005: Repository Context and Workspace Access Layer — `resolveWithinWorkspace`,
  `containedRealPathInfo`, `isDenied` reused by `runCommand`'s cwd validation (D2 Tier 1).
- ADR-0006: Safe Tool Execution and Sandbox Boundary — `runCommand`, `CommandRule`, `SandboxPolicy`,
  `isCommandAllowed`, `collectSensitiveEnvValues`; the deny-by-default invariant, env allowlist,
  ephemeral HOME, no-shell spawn, and redaction contract all apply unchanged.
- ADR-0010: Audit Ledger and Evidence Manifests — `EvidenceManifest` additive kind field,
  `createAuditRedactor`/`deepRedactStrings` redaction pipeline (D6 Layer 2).
- ADR-0011: Wave-1 User Interface and Packaging — zero-dep invariant, BFF route shape, CSRF guard,
  SSE pattern, DNS-rebinding defense.
- ADR-0013: UI-Local SQLite Persistence — `ProjectStore` used for D2 Tier 2 project root
  resolution. No schema change.
- ADR-0014: Keiko Workspace Shell Architecture — `TerminalWidget` mount point unchanged.
- ADR-0017: Browser Tool Boundary and BYO-Chrome Integration — sibling surface; D7 SSE event
  metadata-only pattern, D9 in-memory map lifecycle, D10 typed failure mode table all mirror
  this ADR's approach.
- Issue #61: Parent epic — local workspace shell.
- Issue #78: Terminal tool boundary and permitted-command policy (this ADR).
- OWASP Command Injection: https://owasp.org/www-community/attacks/Command_Injection
- Node.js `child_process` security: https://nodejs.org/api/child_process.html#security-considerations

## Date

2026-06-01
