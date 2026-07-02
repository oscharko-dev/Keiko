# Controlled command runner — security notes (Issue #1387)

The controlled test/build/run command executor lets Keiko run a **closed catalog** of vetted workspace
tasks through governed local processes. For this product surface it reuses the ADR-0043 / ADR-0006
`runCommand` boundary instead of introducing another repository-script execution path, and it is
**not** an arbitrary terminal.

## Trust model

The executor is a thin task-oriented layer on top of `runCommand`
(`packages/keiko-tools/src/exec.ts`), the governed spawn boundary for terminal, verification,
package-script, git-adapter, and container-task flows that intentionally compose over it. Every
guarantee `runCommand` already proves applies unchanged; the runner only adds **task discovery** and a
**task allowlist**.

Keiko also has a small number of separately governed process surfaces whose lifecycle does not fit
`runCommand`'s one-shot command model. They are not part of this command-runner API and must keep
their own ADR-linked controls and regression tests:

| Surface                      | Boundary                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editor LSP processes         | ADR-0069, `packages/keiko-server/src/editor/lsp/lspNodeAdapter.ts`; long-lived language-server lifecycle with executable allowlists, empty HOME, and tests. |
| Local Knowledge OCR runtime  | `packages/keiko-server/src/local-knowledge-ocr-runtime.ts`; server-owned OCR adapter, bounded stdin/stdout/stderr, and no UI-supplied executable.          |
| Git repository clone/status  | `packages/keiko-server/src/gitRepositoryRoutes.ts` / `gitRoutes.ts`; fixed `git` argv, hardened git environment, host policy, and containment checks.      |
| CLI/browser opener           | `packages/keiko-cli/src/lifecycle.ts` / `src/ui.ts`; local developer convenience process launch, outside the browser authority surface.                    |
| Release/helper scripts       | `scripts/*.mjs`; release-time operator tooling only, covered by supply-chain and shell-guardrail checks rather than browser/API reachability.              |

| Control                           | Where it is enforced                                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deny-by-default command allowlist | `COMMAND_TASK_RULES` (`keiko-contracts/src/command-runner.ts`) passed to `runCommand` as `commandRules`; only the package-manager `run`/`test` subcommands back a task.                                                                                                                                                                          |
| No free-form argv                 | A run names a `taskId` from the server-discovered catalog. The browser/agent never supplies an executable or arguments; the BFF resolves the id to a frozen `["run", <script>]` argv. An unknown id is rejected with `TASK_NOT_FOUND` before any spawn.                                                                                          |
| Server-side workspace trust gate  | Every `package.json` script is repository-authored executable code. The catalog reports `trustState`, but execution re-discovers the task and requires the server's `isWorkspaceTrustedForPackageScripts` decision to approve the resolved workspace. The browser cannot approve trust by echoing a catalog field or request parameter.             |
| No shell                          | `runCommand` always spawns with `{ shell: false }` and an explicit argv array — no string interpolation, no transitive shell.                                                                                                                                                                                                                    |
| Workspace-contained cwd           | The runner sets the cwd to the project root explicitly; `runCommand` re-validates it lexically (`resolveWithinWorkspace`) and via realpath/symlink containment plus the always-on deny list.                                                                                                                                                     |
| Environment / PATH minimization   | `runCommand` builds the child env by **name-copy** from `DEFAULT_ENV_ALLOWLIST` only (never `...process.env`). `HOME`/`USERPROFILE` are replaced with an ephemeral empty per-run directory, so a task cannot read `~/.npmrc`, `~/.git-credentials`, or `~/.aws/…`. The executable is PATH-resolved and proven to live **outside** the workspace. |
| Output bound                      | Combined stdout/stderr is byte-capped at `SandboxPolicy.maxOutputBytes`; on overflow the child is killed and the result is flagged `truncated`. The UI renders the already-capped, redacted output, so a flooding task cannot freeze the surface.                                                                                                |
| Timeout                           | A per-run wall-clock timeout (clamped to a floor and the policy ceiling) sends `SIGTERM` then `SIGKILL` to the process group, so an accidental watch/daemon (out of scope) is reaped rather than left running.                                                                                                                                   |
| Cancellation                      | Each in-flight run holds an `AbortController`; `DELETE /api/commands/runs/:runId` aborts it. The UI learns the server-assigned `runId` from the SSE `run-started` event keyed to its own `requestId`, so a foreign run on the shared event channel can never be cancelled by the wrong tab.                                                      |
| Concurrency                       | At most 8 concurrent runs per BFF; a 9th request is rejected with `RUN_LIMIT_EXCEEDED` (HTTP 429).                                                                                                                                                                                                                                               |

## Discovered-task validation (why this is not RCE)

Tasks are discovered only from the project's own `package.json` `scripts`. Discovery additionally
filters script names to a conservative character set and rejects any name that does not start with an
alphanumeric character, so a discovered name can never smuggle a leading flag (e.g. `-e`) or shell
metacharacter into `npm run`. Because a run can only reference a discovered task id — and the id maps to
a frozen argv server-side — an attacker who controls the run request cannot reach an arbitrary command
or an arbitrary script name.

The script bodies themselves are **not** considered trusted merely because their names are safe. They
are repository-authored executable code and are `approval-required` by default. The BFF must supply a
server-owned `isWorkspaceTrustedForPackageScripts(workspace)` predicate before a task is runnable; the
manager re-evaluates that predicate at execution time after resolving the current workspace realpath
and re-reading the current manifest. With no predicate, or with a predicate that returns false, a run
fails before a run id is minted or any spawn is attempted (`TASK_REQUIRES_TRUST`, HTTP 403).

## Secret redaction

Redaction is dual-layer and applied **after** output is captured, never to inputs:

- **Layer 1 (env values):** `runCommand` scrubs the values of every non-allowlisted environment
  variable from stdout/stderr before they leave the spawn boundary.
- **Layer 2 (structural):** the BFF applies the shared live redactor (`deepRedactStrings` composed with
  the audit redactor — Bearer tokens, `sk-*` keys, PEM markers) to the run result before it reaches the
  browser and to every SSE event frame before it is written.

A focused test asserts that a secret-shaped string emitted to stdout is replaced before the response is
returned (`command-runner-routes.test.ts`).

## Audit evidence (content-free)

Each finished run writes a standard `EvidenceManifest` (`taskType: "command-run"`) through the existing
`EvidenceStore.put` port, carrying **counts and enums only**: run id, task id, task kind, executable
name, argument _count_ (never the argv), exit code, duration, `timedOut`, `truncated`, and
`failureReason`. The argv values and the captured output are deliberately excluded, and `deepRedactStrings`
is applied to every string leaf before persistence (ADR-0048 content-free invariant). The manifest's
standard `context.workspaceRoot` field retains the local project-root path (a non-secret reference, not
reconstructive content) exactly as every other evidence manifest in the codebase does; no command argv,
output bytes, or secret-shaped value is persisted. Evidence writes are fail-closed for this governed
execution surface: after a command settles, the manager persists the content-free manifest before
emitting the terminal run event or returning a successful run result. If evidence persistence is
unavailable or fails, the route returns `EVIDENCE_WRITE_FAILED` (HTTP 500) instead of reporting a
successful unaudited command run.

## Out of scope

Arbitrary shell terminals, background daemon management, remote command execution, and container
execution are explicitly out of scope for this issue and are not reachable through this surface.
