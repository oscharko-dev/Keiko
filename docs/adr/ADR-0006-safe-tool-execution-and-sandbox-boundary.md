# ADR-0006: Safe Tool Execution and Wave-1 Sandbox Boundary

## Status

Accepted

Accepted; module location superseded by ADR-0019 (monorepo split — code now under `packages/keiko-tools/src/**`). Dimension 4 (network isolation) is further superseded by ADR-0043, which enforces `network:"none"` via `keiko-sandbox` at the OS level rather than relying on convention alone.

> **Amended by the 0.3.0 release audit — governed git env lanes (2026-07-30; owner-approved in
> Issue #2864 on 2026-07-31).** D2 Dimension 1 below describes `DEFAULT_SANDBOX_POLICY`, which is
> unchanged and remains the profile for every tool that runs ON the workspace. Two additional,
> explicitly declared profiles now exist for governed git surfaces, which do not run on the
> workspace but act AS the local human against their
> own machine and their own remote (`GOVERNED_GIT_IDENTITY_SANDBOX_POLICY`,
> `GOVERNED_GIT_REMOTE_SANDBOX_POLICY`, `packages/keiko-contracts/src/tools.ts`). Under the default
> profile a governed `git commit` cannot read the user's identity or `commit.gpgsign`/
> `user.signingkey` — it lands under an auto-detected author, unsigned, and reports success — and
> `git push` / `gh api` have no SSH agent, no `~/.ssh`, no credential helper and no gh
> configuration, so governed push, pull request and merge cannot authenticate at all. The two lanes
> forward the account and agent state normal git credentials need, mirroring the grant
> `networkGitEnv` (keiko-git) has always made for clone/fetch/pull, and the remote lane additionally
> forwards the `GH_TOKEN`/`GITHUB_TOKEN` NAMES. Three properties bound the exception, all pinned by
> tests: (1) the credential names are declared on a separate `credentialEnvAllowlist`, never on
> `envAllowlist`, so their VALUES stay in the boundary's output scrub set and a token echoed by
> `gh` is redacted before it can reach a classifier, an error, an evidence record or a diagnostic;
> (2) a value too short to scrub safely is not forwarded at all; (3) the lanes pin every interactive
> credential path closed, so a missing credential fails rather than hangs. Nothing else changes: the
> same single spawn path, the same deny-by-default command allowlists, no-shell, cwd containment,
> byte cap, timeout, cancellation and redaction apply, and the four hard denials (no direct push to
> a protected branch, no force push, no admin bypass, no finding dismissal) are enforced by policy
> packs and argv builders, not by the child's environment. The "no credential-bearing variable is
> ever forwarded" and "no credential is available for exfiltration" statements below are therefore
> to be read as scoped to the default profile and every lane except governed remote delivery.

## Context

Issue #6 delivers the layer that lets a language model touch a developer's repository through a
controlled, auditable surface. In a regulated banking and insurance environment this layer is the
trust boundary between model output and the repository filesystem and process environment.
Three interlocking requirements make the design non-trivial.

**Fail-closed is mandatory.** Any failure mode that allows an unreviewed write or an unallowlisted
subprocess is a security failure, not a graceful degradation. Every gate in this layer defaults to
deny: commands are denied unless explicitly allowlisted, patches are not applied unless
`applyEnabled` is explicitly `true`, and the child process environment contains only a small named
allowlist of variables — never a spread of `process.env`.

**Zero new runtime dependencies (ADR-0001, load-bearing).** The zero-dependency constraint is not
merely a style preference; it is the supply-chain security posture required by ADR-0002. This rules
out shell-escaping libraries, diff libraries (e.g. `diff`, `patch-package`), process-tree killers
(`tree-kill`), and any abstraction that pulls in transitive npm packages. Every security mechanism
must be implemented with Node 22 built-ins.

**Deferred container isolation.** OS-level network and filesystem isolation (Docker, Firecracker,
gVisor) is the right long-term answer, but it requires operator infrastructure outside the Node
process and a multi-week integration effort. Shipping a typed seam now (`SandboxPolicy.network`,
`SandboxConfig`) means the stronger isolation layer can be added later without changing any tool
consumer.

**Continuity with ADR-0004 and ADR-0005.** ADR-0004 defined the `ToolPort` interface and deferred
real tool execution to this issue. ADR-0005 established a read-only `WorkspaceFs` port with a
two-tier path boundary (lexical containment + realpath at the IO edge). This issue completes those
seams: it implements `ToolPort`, adds the first write surface (`WorkspaceWriter`), and wires the
`commandExecutions` counter that ADR-0004's `loop.ts` already guards against.

**Module location.** All new code lives under `src/tools/**`, mirroring the existing
`src/gateway/**`, `src/harness/**`, and `src/workspace/**` conventions (typed errors with redacted
messages, a `types.ts` of interfaces plus frozen tables, a barrel `index.ts`). The four surgical
changes to the harness and gateway (`src/harness/ports.ts`, `src/harness/executor.ts`,
`src/gateway/redaction.ts`, `src/harness/emitter.ts`) are additive and non-breaking.

## Decision

### D1 — Deny-by-default command allowlist; bare-name PATH-resolved executables; no shell

We will enforce a frozen `DEFAULT_COMMAND_RULES` table that is the sole authority on which
executables and subcommands may be spawned. Every command dispatch checks
`isCommandAllowed(rules, executable, args)` — a PURE function in `sandbox.ts` — before any spawn
is attempted (`src/tools/sandbox.ts:90`). A denied command raises `CommandDeniedError` and the
`SpawnFn` is never called (`src/tools/exec.ts:242–248`).

The allowlist is minimal and justified:

| Executable | Policy | Rationale |
|---|---|---|
| `npm` | allowlist: audit/ls/list/outdated/view/info/help/ping; `-c`/`--call` denied | Read-only npm inspection only; install/script/account/registry mutation is excluded by omission |
| `git` | allowlist: status/diff/log/show/rev-parse/ls-files/describe/blame/cat-file | Read-only git only; push/reset/checkout/commit/merge/rebase/clean/config/remote are all denied |

**What the allowlist does and does NOT buy us (honest framing — corrected after the Issue #6
audit).** The model-facing default does not allow raw interpreters (`node`) or package runners
(`npx`) because either one is arbitrary code execution and can bypass the patch workflow by writing
directly to the workspace. Verification workflows that Keiko constructs deterministically use an
explicit verification-only rule set for `npm test`/`npm run` and targeted `npx` invocations, but
those rules are not exposed as the model-facing `run_command` defaults. The default allowlist blocks
casual/accidental misuse (`curl`, `bash`, `rm`, `ssh`, `python`), package installation/script
execution (`npm install`, `npm run`, `npm ci`), account/registry mutation (`npm publish`,
`git push`), and transitive-shell escapes (`npm exec`/`x`, `-c`/`--call`). OS-level
filesystem/network isolation is deferred to the container wave (D7).

**Flag-aware subcommand resolution (S-H2).** Subcommand detection is value-flag aware: the resolver
skips a leading value-taking flag AND its value (`git -C DIR push` → `push`, denied), so a flag
value can no longer masquerade as the subcommand. In allowlist mode, the resolved first non-flag
token must be explicitly allowed; an unrecognized stray token is denied by default
(`src/tools/sandbox.ts`).

Executables must be bare names (no `/` or `\` path separators, no NUL bytes). The check matches
`basename(executable)` against the table, so a caller cannot bypass the allowlist by passing an
absolute path to an allowed executable. After the rule match, `runCommand` resolves the bare name to
an absolute executable path from `PATH`, rejects workspace-controlled resolutions (including symlink
realpaths inside the workspace), and passes the resolved absolute path to `spawn`. Unknown or
unresolvable executables are denied by default.

All spawns use `{ shell: false }` unconditionally. Args are passed as an array to
`child_process.spawn`; no argument string is ever interpolated into a shell command. (Note that
`shell:false` only governs OUR spawn — an allowed binary that itself invokes a shell, e.g. via
`npm exec`/`-c`, would re-introduce one, which is why those are explicitly denied above.)

The allowlist is configurable via `ToolHostConfig.commandRules` so operators can narrow it further
without code changes. The defaults are the most permissive safe baseline.

### D2 — Five documented, test-enforced sandbox dimensions

The sandbox boundary is expressed as a frozen, inspectable `DEFAULT_SANDBOX_POLICY` object
(`src/tools/types.ts:48–54`). Five dimensions are documented, implemented, and tested:

**Dimension 1 — Environment allowlist (name-copy isolation) + ephemeral HOME (C5).**
`buildSandboxEnv(processEnv, allowlist)` builds the child environment by iterating a frozen name
allowlist and copying only names that are present in the parent (`src/tools/sandbox.ts:11–23`). It
never spreads `...process.env`. `DEFAULT_ENV_ALLOWLIST` contains `PATH`, `LANG`, `LC_ALL`,
`LC_CTYPE`, `TZ`, `TERM`, `TMPDIR`, and Windows essentials (`SystemRoot`, `SystemDrive`, `PATHEXT`,
`COMSPEC`, `NUMBER_OF_PROCESSORS`, `WINDIR`). No credential-bearing variable —
`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, etc. — is ever
forwarded to a child process.

`HOME` and `USERPROFILE` are deliberately NOT in the allowlist (C5). Forwarding the developer's real
home would let an allowed subprocess (`npm`/`git`) read `~/.npmrc` (npm tokens),
`~/.git-credentials`, and `~/.aws/…` via standard home-directory lookup — bypassing the env
allowlist entirely, because the credential is read off disk, not off the environment. Instead,
`runCommand` redirects `HOME` and `USERPROFILE` to a per-run **ephemeral, empty directory** created
under the OS temp dir (`mkdtempSync(join(tmpdir(), "keiko-home-"))`) and removed after the command
in every settle path — success, denial-before-spawn (no dir is created), timeout, cancellation, and
spawn error (`src/tools/exec.ts`, `HomeProvider`/`nodeHomeProvider`). The child still receives a
valid, writable `HOME` (so `npm` works), but it is empty: a home-directory credential lookup
resolves to nothing. The provider is injected as a `RunCommandDeps.home` dependency with a Node
default, so tests use a recording/fake provider and assert the child `HOME` is a real, existing,
empty dir that is never the parent's real home, and that the dir is cleaned up.

`collectSensitiveEnvValues(processEnv, allowlist)` collects all non-allowlisted parent env values
≥ 6 characters (`src/tools/sandbox.ts:29–44`) so that `runCommand` can pass them as
`additionalSecrets` to `redact()` when scrubbing captured stdout/stderr. This is defence in depth:
even if a tool reads a credential from its own config file and echoes it, the output is still
redacted before it leaves the layer.

**Dimension 2 — Workspace-rooted cwd.** Every command's working directory is resolved via
`resolveWithinWorkspace(workspace.root, cwd ?? ".")` before spawn (`src/tools/exec.ts:107–109`). A
cwd that escapes the workspace root raises `PathEscapeError` (from `src/workspace/errors.ts`), which
the host surfaces as a tool error. The default cwd is the workspace root.

**Dimension 3 — No shell by default.** `spawn(executable, args, { shell: false, ... })` is
unconditional (`src/tools/exec.ts:256`). Args are passed as a `readonly string[]` array. No
metacharacter interpolation is possible.

**Dimension 4 — Network policy (honest, not overclaimed).** Wave 1 does NOT enforce OS-level network
isolation. The `SandboxPolicy.network` field carries `"inherit"` as its current value
(`src/tools/types.ts:48`), meaning the child process inherits the parent's network namespace.
The mitigation is the combination of the env allowlist (no proxy credentials or auth tokens reach
the child) and the command allowlist (only read-only `npm` and read-only `git` may execute by
default; arbitrary `curl`/`wget`/`ssh` commands are denied). This is documented explicitly, not
papered over.

The `NetworkPolicy = "inherit" | "none"` type and the `SandboxPolicy.network` field are the seam a
later wave flips to `"none"` when the container layer lands. Tool consumers depend on
`SandboxPolicy`; they will not need to change when the network is enforced at the OS level.

**Dimension 5 — Signal-termination behaviour (no zombies, no partial patch state).** On timeout or
`signal.abort`, `terminate()` sends `SIGTERM` to the process group, then arms a
`terminationGraceMs` (default 2 000 ms) timer that sends `SIGKILL` (`src/tools/exec.ts:148–154`).
On POSIX, the process is spawned `{ detached: true }` so `process.kill(-pid, sig)` kills the entire
process group including grandchildren (`src/tools/exec.ts:56–69`). On Windows, `child.kill()` still
terminates the immediate child, and `killGroup` additionally bounds the whole descendant tree via
the conventional `<identity-approved SystemRoot>\System32\taskkill.exe /PID <pid> /T /F` on every
SIGTERM/SIGKILL escalation step — an OS binary reached only after the environment-selected root's OS
identity is verified against `\\?\GLOBALROOT\SystemRoot`, never through PATH. This closes what issue
#3350's `cmd.exe` wrapping turned into the
guaranteed topology for every Windows `.cmd`/`.bat` invocation: the wrapper's immediate child is
always `cmd.exe`, and the real work (e.g. `node.exe` running npm) is a grandchild that
`child.kill()` alone cannot reach.

**The tree kill runs BEFORE the immediate child is signalled, to COMPLETION, and both properties
are load-bearing.** `child.kill()` is `TerminateProcess` and takes effect at once, whereas
`taskkill /PID <pid> /T` resolves the descendant set from the live process table when it runs.
Signalling `cmd.exe` first would leave taskkill with no such pid, terminating no descendant — and
Windows does not reparent orphans, so the grandchild would survive exactly the path this exists to
bound. `nodeWindowsTreeKill` is therefore SYNCHRONOUS (`spawnSync` with a bounded wait): an
asynchronous spawn would only SCHEDULE taskkill, and `child.kill()` would race it. `nodeGroupKill`
in keiko-server's `lspNodeAdapter.ts` holds the same ordering, and `exec.test.ts` pins the order
directly rather than asserting only that the tree kill was called.

**Lifecycle stop reuses this helper (issue #3351).** Cross-process `process.kill(pid, "SIGTERM")` is
`TerminateProcess` on Windows and never delivers the in-process `waitForShutdown` handler, so
`keiko stop` / `restart` / unhealthy-start and `keiko uninstall --force` request drain through
the pid-bound `<stateDir>/ui.shutdown` sentinel first. Windows escalation then calls
`nodeWindowsTreeKill` to completion before `SIGKILL`, instead of growing a second taskkill
wrapper. POSIX still sends `SIGTERM` in addition to the sentinel.

**The bounded wait is per invocation; one shared rolling budget bounds the process-wide aggregate.**
`spawnSync` blocks the ENTIRE Node event loop, not just the run being terminated, and `terminate()`
executes on that loop. One Windows run can pay the 5 000 ms bound twice (SIGTERM and SIGKILL), so
`WindowsTerminationCapacity` deliberately admits at most THREE live Windows commands process-wide.
Each admitted command reserves two units from the same 30-second/60-second rolling budget used by
direct LSP tree kills. A fourth concurrent command, or any command for which two units are not
available, is denied with `CommandDeniedError` before ephemeral HOME creation or spawn. Held units
remain charged across a window rollover; completed calls refund only their unused wait, and release
returns only units the command never consumed. Releasing a concurrency slot therefore cannot reset
the stall budget, and `runCommand` plus LSP termination together cannot stack past the process-wide
ceiling. The concurrency slot and unused budget reservation are released only after confirmed
`close` or a pre-spawn failure. Because an admission denial owns no child, it emits no fabricated
termination line; the owning surface records its ordinary body-free `denied` outcome and
correlation.

Reservation also binds the trusted executable decision: admission copies only `SystemRoot` and
`WINDIR`, verifies the OS identity and regular `taskkill.exe`, and caches the validated conventional
command. Later mutation of the caller's environment cannot redirect or refuse the kill for an
already-admitted child. Direct consumers of exported `nodeWindowsTreeKill` debit the same monotonic
budget; exhaustion reports `budget-exhausted` without launching taskkill. It is distinct from
`unknown`, which means taskkill did launch but its bounded wait expired.

**Termination is single-flight.** Abort, timeout, the output cap, a failing `onSpawn` callback and a
post-spawn child-process error can all reach `terminate()`; the FIRST one becomes the terminal cause,
the others are disarmed, and
exactly one grace timer is armed. Before this, each trigger re-signalled the tree and overwrote the
tracked timer handle, so `cleanup()` cleared only the last one and the orphaned earlier timer fired
`taskkill /T /F` against a raw pid AFTER the run had settled — with the handle that kept that pid
reserved already released. The escalation is additionally guarded on the child still being alive.

**The reported outcome is measured, not assumed.** `WindowsTreeKillDisposition` carries taskkill's
own completed exit status (`succeeded`/`failed`), `unknown` only when the bounded wait expired,
`budget-exhausted` only when the shared monotonic aggregate budget refused to launch taskkill,
`blocked-untrusted-system-root` when the trusted-System32 resolver refuses a malformed or hostile
`SystemRoot`/`WINDIR` (kept distinct from `failed` because it is a security-relevant fact about the
environment, not an operational hiccup), `refused-self-pid` when the pid handed to `killGroup` is
this process or its own parent (see the residual below), `root-not-found` when taskkill's own exit
code is 128 — "the specified process was not found". That result proves only that the requested
root was absent; it does not prove that every descendant is gone. It remains a different fact from
`failed` and must not share its word — and `not-attempted` applies on POSIX, when there is no pid to
signal, or when the child is already verifiably exited before a signal would have been sent. The
previous boolean was a production tautology — the default implementation could not throw, so a
genuine failure on an image without `taskkill.exe` was logged as success, which is worse than not
logging it.

Two residuals, both narrower than the general `taskkill` caveat:

- **A `taskkill.exe` failure** no longer reports as success. A missing binary or untrusted root
  denies a `runCommand` Windows spawn before it owns a child. If the already-validated binary is
  removed or taskkill later refuses, termination surfaces `windowsTreeKill: "failed"`; descendants
  it could not reach can survive, so orphaning is not architecturally impossible.
- **PID reuse WAS reachable on this path, and a customer hit it.** `taskkill` validates no process
  identity, so a stale pid can hit an unrelated process, and `/T` takes the whole tree — which, on a
  recycled pid, can include this server or its own launcher. The original argument for why that
  could not happen here — Node holds an open Win32 handle to the child for the lifetime of the
  `ChildProcess` object, and Windows does not recycle a PID until every handle to the process object
  is closed — assumed the handle was still open at the moment `killGroup` signals. It is not,
  reliably: `state.settled` is set on `'close'`, Node releases the child's handle on `'exit'`, and
  `'data'` events (an output-cap trigger, for one) keep arriving in the window between the two, so a
  termination reaching `killGroup` in that window could signal a pid Node no longer held reserved. A
  customer's Windows machine reproduced exactly the failure this predicts — the UI process died with
  no error in the log and a fresh pid repeated the cycle, consistent with a reused pid landing on the
  server or its launcher. Two guards close it now: `childExited()` runs immediately before every
  `killGroup` call — the initial SIGTERM step and the SIGKILL escalation alike — and reports
  `not-attempted` instead of signalling once the child is verifiably gone (`state.settled`, or an
  observed `exitCode`/`signalCode`); and `killGroup` itself refuses to signal a pid equal to
  `process.pid` or `process.ppid`, reporting `refused-self-pid`, regardless of what the caller
  believes it holds. Together they narrow the window sharply and make the worst outcome — this
  process or its launcher taking a `/T` tree-kill meant for a child — impossible rather than merely
  unlikely. What is not proven impossible: that same narrow window landing a recycled pid on some
  OTHER, unrelated process that is neither this one nor its parent. A Job Object would bind
  termination to process identity outright and close that too, but Node exposes no Job Object API:
  it needs native code, which is a runtime dependency ADR-0001 forbids. The existing Job Object
  implementation in keiko-server's `nativeRuntimeProcessBackend.ts` drives a separate compiled
  helper over a control pipe and cannot be reached from `keiko-tools` without inverting the
  ADR-0019 dependency direction.

The `runCommand` promise rejects with `CommandCancelledError` on abort and `CommandTimeoutError` on
timeout — both caught from the `close` event after cleanup (`src/tools/exec.ts:194–202`). The
`applyPatch` function checks `signal.aborted` before planning and during the write phase; a
mid-apply cancellation rolls back completed writes before surfacing `CommandCancelledError`.

### D3 — Separate `WorkspaceWriter` port as the single controlled write surface

We will introduce a `WorkspaceWriter` port (`src/tools/writer.ts:9–14`) as the ONLY path through
which the tools layer writes to the filesystem. `WorkspaceFs` (ADR-0005 D1) remains strictly
read-only. The separation enforces the invariant that reads and writes are independently testable,
auditable, and mockable: a test that injects a recording `WorkspaceWriter` can assert exactly which
files were written and in what order, without real filesystem side-effects.

`WorkspaceWriter` exposes four operations: `writeFileUtf8`, `mkdirp`, `remove`, `rename`. Every
call site in `patch.ts` receives an absolute path that was already validated by
`resolveWithinWorkspace + isDenied` before it reaches the writer (`src/tools/patch.ts:42–57`,
`src/tools/patch.ts:223–231`). The writer adapter (`nodeWorkspaceWriter`) is deliberately thin — it
contains no validation logic — because validation belongs to the caller, not the IO adapter.

### D4 — Patch validation rules, dry-run-never-writes, and fail-closed atomic apply

**Supported subset.** `parseUnifiedDiff` (`src/tools/patch-parse.ts:193`) handles standard unified
diffs: `--- a/<path>` / `+++ b/<path>` headers, `@@ -l,s +l,s @@` hunks, ` `/`+`/`-` body lines,
file creation (`--- /dev/null`), and deletion (`+++ /dev/null`). This is not git-apply: no rename
detection, no fuzzy matching, no binary patches. The parser is linear — a single pass over split
lines with bounded per-line regexes — so it cannot backtrack catastrophically (CodeQL ReDoS guard).

**Validation rules (structured, non-throwing).** `validatePatch` returns a `PatchValidation` report
for every outcome, including a parse failure: the parser's `PatchParseError` is caught internally
and surfaced as a `malformed` entry in `reasons` (it is NOT re-thrown). The only error
`validatePatch` propagates is a genuine security violation from the symlink path gate
(`PathEscapeError`), where failing closed is correct. Checks in order:

1. **Size limit** — `Buffer.byteLength(diff, "utf8") <= maxPatchBytes` (default 65 536 bytes, matching the harness `maxPatchBytes` limit from ADR-0004 D3).
2. **Binary rejection** — any diff containing `GIT binary patch`, `Binary files … differ`, or NUL bytes is rejected.
3. **Path safety** — every target path is checked via `resolveWithinWorkspace` (rejects `..`, abs, NUL), `isDenied` (always-on deny list from ADR-0005 D3: `.env*`, `*.pem`, `*.key`, `.git/**`, `node_modules/**`, etc.), AND `containedRealPathInfo` — the same symlink/realpath gate the read path applies (ADR-0005 D2). The realpath gate resolves the target (or, for a create, the nearest existing parent) and rejects a path whose real location escapes the root or resolves to an always-denied in-workspace target, closing both symlink-write/outside and symlink-alias-to-denied-file escalations. The write path re-asserts it at `planWrites` as defence in depth.
4. **Line-count limits** — `maxChangedLines` (default 2 000) and `maxFilesChanged` (default 50).
5. **Conflict detection** — pre-image context and removed lines must match the current file at the stated line numbers; a mismatch yields a structured `PatchConflict`. Creation of an existing file or modify/delete of a missing file is also a conflict. Conflict detection only runs after all structural and path checks pass, so a denied or oversized patch never reads target files.

Each rejection carries a stable `PatchRejectionCode` discriminant so callers switch on codes, not
messages.

**Dry-run.** `renderDryRun(validation)` returns a human-readable preview of what apply would do
(`src/tools/patch.ts:180–192`). It never touches the filesystem. This is what `propose_patch`
returns; the `patch:proposed` harness event carries the diff, which `emitter.ts` redacts before
forwarding to non-replay sinks.

**Fail-closed apply.** `applyPatch` is the only function that writes. It will not write unless
`deps.applyEnabled === true` — raising `PatchApplyDisabledError` otherwise
(`src/tools/patch.ts:267–270`). The default `ToolHostConfig.applyEnabled` is `false`
(`src/tools/types.ts:213`). When apply is enabled, the order is: (a) validate — any rejection
raises `PatchValidationError` and writes nothing; (b) check `signal.aborted` before and during write
planning — raises `CommandCancelledError` and writes nothing; (c) compute all new file contents in
memory (pure); (d) write phase with rollback: if any write fails or cancellation is requested after
a write, already-written files are restored from their in-memory originals before the error
propagates. The atomicity
bound is best-effort: a process kill during the rollback itself (e.g. OOM) can leave files in a
partially reverted state, as there is no journal. This is documented, not papered over.

### D5 — Redaction at the tool-output edge; tool stdout never enters a HarnessEvent

Tool `output` strings are redacted at two points:

1. **Command stdout/stderr** — if output fits under `maxOutputBytes`, `redact(text,
   sensitiveValues)` is called with both the built-in patterns and the values of all non-allowlisted
   parent env vars collected by `collectSensitiveEnvValues`. If the cap is hit, `runCommand`
   returns a constant truncated-output marker instead of a partial raw prefix, so a secret split
   across the cap boundary cannot leak.

2. **ToolCallResult.output** — the `WorkspaceToolHost.execute` method returns `output` that is
   already the redacted string from step 1 (or the structured JSON from read/list/patch tools,
   which does not contain raw command output).

Tool stdout does NOT appear in any `HarnessEvent`. The `tool:call:completed` event carries only
`{toolName, toolCallId, durationMs}` — safe metadata (`src/harness/executor.ts:110–115`). The full
`output` string flows into a `{ role: "tool", content: result.output, toolCallId }` ChatMessage that
is added to the context window for the next model call (`src/harness/executor.ts:116`). This means
tool output feeds the model but is not persisted in the audit ledger (issue #10) via the event
stream. The audit ledger receives `RunManifest.events`, which contains only the metadata events; it
does not receive the message array unless explicitly included.

**Broadened `redact()` patterns (additive).** Four common credential shapes and PEM markers were
added to `src/gateway/redaction.ts` (lines 15–19): GitHub tokens (`gh[pousr]_[A-Za-z0-9]{20,}`),
AWS access key IDs (`AKIA[0-9A-Z]{16}`), Slack tokens (`xox[baprs]-[A-Za-z0-9-]{10,}`), Google API
keys (`AIza[0-9A-Za-z_-]{20,}`), and PEM private key blocks
(`-----BEGIN [A-Z ]*PRIVATE KEY-----` through the matching `END` marker). The PEM header-only
fallback still covers truncated output.

The stale comment in `src/harness/emitter.ts` that described broadened redaction as out of scope
for Wave 1 has been updated to reflect that these patterns are now active (line 35).

### D6 — `commandExecutions` counter wired via additive `ToolCallResult.commandExecuted`

`ToolCallResult` gains an optional `commandExecuted?: boolean | undefined` field
(`src/harness/ports.ts:26–27`). This is additive: the field is absent from existing mock
implementations and from all tools except `run_command`, so no existing code path breaks.

In `executor.ts:runOneTool`, after a successful `execute()` call, `if (result.commandExecuted ===
true) ctx.counters.commandExecutions += 1` (`src/harness/executor.ts:107–109`). This makes the
`maxCommandExecutions` limit enforced by `loop.ts:checkToolLimits` live for the first time. Before
this change, the counter was always zero and the check was dead. `run_command` is the only tool
that sets `commandExecuted: true` (`src/tools/registry.ts:206`); all other tools return `false`.

### D7 — Container/process-isolation integration seam deferred to a later wave

OS-level isolation — Docker namespaces, Firecracker micro-VMs, or gVisor — is explicitly deferred.
The `SandboxPolicy` and `ToolHostConfig` types are the integration seam. A later wave that adds
container isolation will:

1. Set `SandboxPolicy.network` to `"none"`.
2. Replace the `SpawnFn` adapter with one that launches the subprocess inside a container or
   restricted namespace.
3. Optionally add `filesystem` and `pid` fields to `SandboxPolicy`.

Tool consumers (`WorkspaceToolHost` callers) depend only on the `ToolPort` interface and
`ToolHostConfig`. They will not need to change when the container layer lands.

## Consequences

### Positive

- The deny-by-default command allowlist guarantees that a model-requested `curl`, `bash`, `rm`,
  or `ssh` command is rejected before any subprocess is created. A new engineer can read
  `DEFAULT_COMMAND_RULES` and know exactly what the model can execute.
- The env allowlist ensures that even if a command makes a network call (Wave 1 limitation), no
  credential is available for exfiltration: no `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`,
  `DATABASE_URL`, or similar variable is in the child's environment.
- Redaction at the tool-output edge means secrets in command output are scrubbed before they reach
  the model context window, before they reach the harness event stream, and before they reach any
  log or audit ledger.
- `applyEnabled: false` by default means the tools layer cannot write to the repository without an
  explicit operator decision. This is not a configuration mistake waiting to happen — it is the
  only path to write, and it is gated.
- `WorkspaceWriter` as a separate port keeps `WorkspaceFs` read-only (ADR-0005 invariant preserved)
  and makes write-path testing exact: inject a recording writer, assert the exact file writes.
- The patch validation layer rejects unsafe, oversized, binary, out-of-workspace, and conflicting
  diffs before touching the filesystem. Each rejection code is stable and machine-readable; the
  security-auditor and the harness can switch on codes without parsing messages.
- The `SandboxPolicy.network` seam and `SpawnFn` injection mean the container isolation layer can
  be added in a later wave without changing `ToolPort` consumers.
- The `commandExecutions` counter is now live: a model that loops on `run_command` calls will hit
  `maxCommandExecutions` and the harness transitions to `limit-exceeded`, not an infinite loop.

### Negative

- **Network is not isolated in Wave 1.** An allowlisted command can make outbound TCP connections
  if the underlying tool does so. The mitigation — no credentials in the child env and no raw
  interpreter/package-runner defaults — reduces the impact of exfiltration but does not eliminate
  it (hardcoded URLs, timing side-channels). This is the most significant residual risk in this
  wave. It is documented, not hidden.
- **Rollback atomicity is best-effort.** Multi-file patch apply uses an in-memory originals buffer
  and re-writes files on failure. A process kill (OOM, `SIGKILL` from the OS) during rollback can
  leave the working tree in a partially reverted state. There is no write-ahead log or journal. For
  the regulated environment, the mitigating control is that the developer reviews and commits:
  `git status` exposes any partial write, and the repository's VCS history is the recovery path.
- **Windows termination safety deliberately caps concurrency.** At most three Windows
  `runCommand` children may be live process-wide because each reserves both bounded tree-kill
  escalations from the shared rolling stall budget. A fourth concurrent command is denied before
  spawn with `CommandDeniedError`; it is not started with weaker descendant containment. This is
  an intentional availability trade-off, and callers must surface the ordinary correlated denied
  outcome rather than retrying in an unbounded loop.
- **Windows grandchild orphaning is bounded, not architecturally eliminated.** `child.kill()`
  terminates the immediate child only; `killGroup` additionally runs
  `taskkill.exe /PID <pid> /T /F` to bound the whole descendant tree (e.g. a test runner that
  forks workers, or — the guaranteed case since issue #3350's `cmd.exe` wrapping — `node.exe`
  running npm under a wrapped `.cmd` target's `cmd.exe`). `taskkill.exe` is an OS binary shipped
  with every supported Windows image, so the earlier justification (`tree-kill` needs a runtime
  npm dependency forbidden by ADR-0001) no longer applies. taskkill now runs SYNCHRONOUSLY to
  completion before the immediate child is signalled (Dimension 5 above), so the window this
  bullet used to describe — a grandchild spawning between signalling and taskkill's snapshot —
  cannot occur; a `taskkill.exe` failure is measured and surfaces as `windowsTreeKill: "failed"`
  rather than being swallowed. `runCommand` validates taskkill and reserves termination capacity
  before spawning, so a stripped image is denied before a tree exists. What remains, narrower than
  that: an admitted taskkill can be removed/refuse later, and a grandchild that spawns AFTER
  taskkill's snapshot but before it exits can still orphan — taskkill enumerates the tree once, it
  does not repeat the scan. See Dimension 5 for the full, current residual list.
- **Bounded unified-diff subset only.** The parser handles the common cases (create, modify,
  delete, standard hunks) but not rename detection, extended git-diff headers, or fuzzy matching.
  A diff produced by a non-standard tool may fail to parse or produce conflicts where a full
  git-apply would succeed.

### Neutral

- The six tools (`read_file`, `list_files`, `inspect_package_scripts`, `run_command`,
  `propose_patch`, `apply_patch`) are the Wave-1 surface. The `ToolPort` interface allows a later
  wave to add tools without changing the harness.
- `ToolHostConfig` merges all knobs (sandbox policy, command rules, patch limits, `applyEnabled`,
  `maxReadBytes`) into a single injectable object so tests can override precisely what they need
  without a full constructor rewrite.
- Synchronous IO in `WorkspaceWriter` mirrors the existing `nodeWorkspaceFs` style. An async port
  is a future option; the synchronous path is adequate for Wave 1's file sizes.

## Alternatives Considered

### Alternative 1: Shell execution with input sanitisation vs. no-shell allowlist

Allow `shell: true` in `spawn` and apply an escaping/sanitisation library to model-supplied
command strings before execution.

- **Pros**: simpler model-facing API (the model produces a shell command string, which is familiar);
  supports shell pipes and redirections natively; many reference implementations use this approach.
- **Cons**: shell injection is a well-documented class of vulnerability (OWASP A03:2021 Injection).
  No sanitiser reliably handles every shell metacharacter across bash, zsh, sh, cmd.exe, and
  PowerShell, especially when the input is from a language model that may produce novel inputs.
  Adding a sanitiser library would also violate ADR-0001's zero-runtime-dependency constraint.
  The surface area of "what can the shell do" is far larger than "what is on the allowlist".
- **Why rejected**: shell execution is incompatible with fail-closed security in a regulated
  environment. The no-shell, deny-by-default allowlist provides a smaller and more legible attack
  surface: a model cannot reach for `curl`/`bash`/`rm`, cannot chain pipes/redirections, and cannot
  trigger metacharacter expansion. We do NOT claim it is OS-level isolation; verification-specific
  `npm`/`npx` paths can still run repository code by design. The model-facing default allowlist
  removes the shell-injection class, the casual-misuse class, and raw interpreter/package-runner
  bypasses of the patch workflow; credential isolation (D2) and redaction (D5) remain defence in
  depth.

### Alternative 2: Full `process.env` passthrough with output redaction vs. name-copied env allowlist

Pass `process.env` to the child process unchanged, and rely solely on `redact()` to scrub secrets
from stdout/stderr.

- **Pros**: simpler implementation (no allowlist to maintain); child tools can access all the env
  vars they might need (e.g. `npm` reading `NPM_TOKEN`, `git` reading `GIT_ASKPASS`); no risk of
  a legitimate tool failing because a needed var is missing.
- **Cons**: the child process has access to every credential in the parent's environment, including
  `ANTHROPIC_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `DATABASE_URL`, and any other secret the Keiko
  process holds. Redaction only catches secrets that match known patterns in captured output; a
  command that uses a credential to authenticate without printing it (e.g. `aws s3 cp`) would never
  be caught. A tool that crashes and writes a credential to a temp file leaves no stdout to redact.
- **Why rejected**: the env allowlist is the primary control; output redaction is defence in depth,
  not the other way around. Passing `process.env` wholesale to an adversarially-influenced
  subprocess violates the principle of least privilege and is incompatible with the regulated
  environment's credential handling requirements.

### Alternative 3: `git apply` / diff library dependency vs. hand-written bounded unified-diff parser

Use a well-tested npm package (`diff`, `patch`, `what-the-diff`) or invoke `git apply` as a
subprocess for patch application.

- **Pros**: complete unified-diff semantics including rename detection, fuzzy context matching, and
  binary patches; less bespoke code to maintain; lower risk of parser bugs.
- **Cons**: any npm dependency violates ADR-0001's zero-runtime-dependency constraint. Invoking
  `git apply` as a subprocess introduces different problems even though `git apply` itself does
  NOT run the `applypatch-msg`/`pre-applypatch`/`post-applypatch` hooks — those are a `git am`
  concern, not `git apply`. The real costs are: (a) it adds another spawned subprocess and an
  uncontrolled write surface outside our `WorkspaceWriter` boundary, so writes bypass the
  path/deny/realpath gates and the audit seam; (b) `git apply` writes directly to the working tree
  with no in-process rollback or per-file buffering, weakening the atomicity and audit guarantees
  of D4; and (c) `git` would need its allowlist widened from read-only to include `apply`, enlarging
  the command attack surface. (Note: a repository CAN still carry malicious hooks that fire on a
  later developer `git commit`/`git am`; our patch path never runs them, but that is an
  argument for keeping write surface inside our controlled boundary, not for shelling out to git.)
- **Why rejected**: the zero-dependency constraint is non-negotiable. The bounded subset of unified
  diff that the Wave-1 use cases require (create, modify, delete; standard hunks) is well-defined
  and implementable in a linear, ReDoS-free parser. Rename detection and fuzzy matching are deferred;
  the parser is transparent and auditable.

### Alternative 4: Extending `WorkspaceFs` with write operations vs. a separate `WorkspaceWriter` port

Add `writeFileUtf8`, `mkdirp`, `remove`, `rename` to the existing `WorkspaceFs` interface
(ADR-0005 D1) rather than defining a new port.

- **Pros**: one port instead of two; simpler dependency graph; callers already hold a `WorkspaceFs`
  reference.
- **Cons**: `WorkspaceFs` was explicitly defined as a read-only port in ADR-0005. Making it
  mutable collapses the distinction between the "read, never write" context-pack layer and the
  "controlled write" patch layer. Any component that receives a `WorkspaceFs` would then implicitly
  have write access; the type system would not enforce "this component is read-only". The
  security auditor would need to inspect every `WorkspaceFs` call site to determine whether writes
  are possible. A separate `WorkspaceWriter` port makes write access explicit in the type system:
  a component that does not receive a `WorkspaceWriter` cannot write, by construction.
- **Why rejected**: write access is a security-sensitive capability. Making it opt-in via a separate
  port (rather than opt-out via a read-only subtype) is the correct direction for least-privilege
  design. ADR-0005's read-only invariant is preserved.

### Alternative 5: Enforcing container isolation now vs. documenting the boundary and seam

Require container isolation (e.g. Docker `--network=none --read-only --tmpfs /tmp`) as a
precondition for Wave 1, and block the issue until the operator infrastructure is in place.

- **Pros**: eliminates the network non-isolation limitation from day one; provides OS-enforced
  filesystem isolation in addition to the lexical path checks; satisfies the "fail-closed" mandate
  more completely.
- **Cons**: requires operator infrastructure (Docker, a CI/CD setup that grants the Keiko process
  permission to create containers, port mapping for any network-accessible service the tools need)
  that is outside the scope of a TypeScript library. Blocking Wave-1 delivery on infrastructure
  readiness delays the `commandExecutions` counter, the `WorkspaceWriter` port, and the patch
  workflow — all of which are needed regardless of isolation level. The `ToolPort` interface
  (ADR-0004) can be served by a container-wrapped implementation without changing any consumer.
- **Why rejected**: the container layer is a deployment concern, not a library-layer concern. The
  `SandboxPolicy.network` seam and injectable `SpawnFn` are specifically designed so the container
  layer arrives without a redesign. Blocking on infrastructure would make this ADR obsolete before
  it was accepted. The honest documentation of the Wave-1 limitation (D2, Dimension 4) is preferable
  to an overclaimed guarantee.

### Alternative 6: OS-owned SystemRoot identity vs. trusting a shaped environment path (PR #3355 review, finding T19)

The first trusted-System32 resolver accepted a drive-absolute `SystemRoot`/`WINDIR` once its shape
was canonical and the requested binary existed. That is insufficient: an accepted task may control
the process environment and create `C:\workspace\fake-windows\System32\cmd.exe`, or select a junction,
without writing to the real Windows directory. Treating that capability as equivalent to already
owning the host contradicted the workspace trust boundary and failed open.

**Rejected — spawn PowerShell to call `GetSystemDirectoryW`.** The verifier binary must itself be
located before the candidate is trusted, making the bootstrap circular. It also adds another process
surface and a cold synchronous spawn to process-tree termination.

**Rejected — hard-code `C:\Windows`.** This fails every genuine Windows installation whose OS root
is on another drive.

**Decision — compare filesystem object identity with the OS object-manager root.** Windows maintains
the live OS-root symbolic link as `\SystemRoot` in the object-manager namespace. The Win32
`\\?\GLOBALROOT` escape reaches that namespace independently of `SystemRoot`, `WINDIR`, PATH, drive
mappings, and the workspace. On win32 the resolver therefore:

1. validates the candidate's canonical drive-absolute shape;
2. resolves it and requires case-insensitive realpath-text equality, rejecting a symlink or junction
   at the final component or any ancestor;
3. compares its BigInt filesystem device/file identity with `\\?\GLOBALROOT\SystemRoot`; and
4. uses `lstat` plus native-realpath equality to require a regular System32 binary that is neither a
   final symlink nor a redirect to another name, then returns the validated conventional drive path
   for execution. `\\?\GLOBALROOT\SystemRoot` remains the identity oracle only: Node's
   `CreateProcessW` bridge rejects that object-manager spelling as an image path with `EINVAL`.

An unreadable identity, zero/unsupported identity fields, a missing root, a fabricated directory,
or a symlink/junction redirect all fail closed as `WindowsSystemDirectoryError`. Comparing
identity, not path text, supports a genuine non-`C:` Windows installation without trusting an
arbitrary environment path. The returned candidate has already passed the canonical-shape,
symlink/redirect, and OS-identity checks at verification time. The decision remains point-in-time:
Node's spawn API takes an executable path and cannot bind `CreateProcessW` to the filesystem handle
that was inspected.
Repeating `realpath` after the identity match would still return a mutable string and must not be
presented as closing that race. Immediate-spawn callers resolve at their execution boundary to
minimize the window. Installed launchers that persist the identity-approved path cannot do that and
retain the Windows ACL/replacement residual between installation and execution; the stored string
is not a durable filesystem capability. Exploiting either residual requires the ability to replace
the genuine identity-approved OS root or its System32 binary after verification. A workspace-only
fake root or ancestor junction fails at the identity decision, and a final binary symlink or other
redirect to another name fails at the binary check. Node does not expose the raw Windows reparse
attribute through `Stats`, so this contract does not claim to classify a non-redirecting custom
reparse tag. The production check performs no verifier spawn and emits no path or environment value
in its error; callers retain their existing body-free security/termination evidence.

This is a whole-class executable contract, not only the command sandbox's rule. CLI launcher
generation, lifecycle browser opening, portable legacy-launcher cleanup and native failure alerts,
server Authenticode probes, shortcut helpers, and Git/LSP runtime probes resolve known Windows
system executables through the same authoritative helper. A fail-soft surface may keep its primary
operation available, but it must emit a correlated, body-free event that distinguishes an untrusted
root from an unavailable or unprovable system binary; it may not collapse either into a generic
stderr-only notice.

## Related

- ADR-0001: Project Foundation and Toolchain — zero-runtime-dependency constraint (load-bearing
  for this ADR); `src/tools/` module location; strict TypeScript/ESM/LOC limits.
- ADR-0002: CI and Supply-Chain Security Baseline — no new runtime deps; CodeQL
  `javascript-typescript` taint analysis (the `resolveWithinWorkspace` return value is the only
  path handed to `WorkspaceWriter`; the `redact()` output is the only string in `ToolCallResult.output`).
- ADR-0003: Model Gateway Boundary — `redact()` helper reused and extended; typed-error pattern
  mirrored in `src/tools/errors.ts`.
- ADR-0004: Agent Harness Boundary and State Machine — `ToolPort` interface implemented here;
  `commandExecutions` counter wired (the dead `checkToolLimits` guard is now live);
  `applyEnabled: false` default satisfies the "patch never auto-applied" guarantee of D8.
- ADR-0005: Repository Context and Workspace Access Layer — `WorkspaceFs` stays read-only;
  `resolveWithinWorkspace` and `isDenied` reused as the path-safety gate for all patch targets;
  `readWorkspaceFile` and `discoverWithStats` are the read path for `read_file` and `list_files`.
- Issue #6: Safe tool execution, sandboxed command boundary, and patch workflow.
- Issue #10: Audit ledger — consumes `RunManifest.events`; tool stdout flows into ChatMessage, not
  HarnessEvents; the audit ledger will not persist raw tool output unless issue #10 explicitly adds
  a message-array snapshot to the manifest.
- OWASP Command Injection: https://owasp.org/www-community/attacks/Command_Injection
- OWASP Path Traversal: https://owasp.org/www-community/attacks/Path_Traversal
- Node.js child_process security: https://nodejs.org/api/child_process.html#security-considerations

## Date

2026-05-29
