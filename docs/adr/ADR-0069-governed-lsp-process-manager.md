# ADR-0069: Governed LSP Process Manager — ADR-0043 Amendment for Long-Lived stdio Providers

## Status

Proposed

## Date

2026-06-26

## Version

1.0

## Context

ADR-0045 D2 records the following gate:

> "LSP process launch must not introduce an ungoverned second spawn boundary: a future implementation
> either reuses the existing ADR-0043 command wrapper/attestation path (`keiko-tools` `runCommand`,
> with command rules, environment allowlisting, and sandbox attestation) OR lands an ADR-0043 amendment
> that defines an equivalent long-lived LSP process manager before any provider ships."

Issue #1381 (Epic #1491) is that amendment. It defines the governed, long-lived process manager that
multi-language LSP providers (Python/Pyright, Go/gopls, Java/jdtls, Rust/rust-analyzer, per ADR-0045
D4) will register against. **No real language server ships here.** The manager is proven with injected
fake/test providers only; the `unavailableExternalLspDescriptors()` seam in
`packages/keiko-server/src/editor/builtinLanguageProviders.ts` is unchanged until a per-language
implementation issue enables a real executable.

### Why `runCommand` cannot be reused

`keiko-tools/src/exec.ts` `runCommand` buffers all stdout and stderr into in-memory `Buffer[]` arrays
before returning, and its spawn/kill lifecycle is tightly coupled to a single bounded invocation:
one command → wait → return `CommandResult`. A Language Server Protocol server speaks JSON-RPC
over a persistent stdio channel: the server process stays alive for the lifetime of the workspace
session, sending and receiving interleaved JSON-RPC frames asynchronously. Feeding a streaming
JSON-RPC channel through a buffering one-shot executor would either:

- require accumulating all server output in memory until the process exits (violating ADR-0043 I3:
  stream boundaries never buffer), or
- require invasive surgery on `runCommand` that changes its contract for all existing callers.

Neither is acceptable. This amendment defines equivalent controls for a long-lived, streaming stdio
process. It does not relax ADR-0043; it extends its governance surface to cover a second spawn
class that runCommand was architecturally never designed for.

### Existing seams this manager builds on

- `packages/keiko-tools/src/sandbox.ts` exports `buildSandboxEnv`, `isCommandAllowed`,
  `collectSensitiveEnvValues` — all pure functions, usable without exec.ts's buffering harness.
- `packages/keiko-tools/src/exec.ts` implements `assertExecutableOutsideWorkspace` logic (not
  exported as a function; the manager reimplements the same pattern with the same invariants, citing
  this ADR as the authoritative definition).
- `packages/keiko-server/src/editor/languageCancellation.ts` `createDeadlineCancellation` provides
  the deadline + AbortSignal token model that per-request LSP cancellation mirrors.
- `packages/keiko-server/src/editor/languageProvider.ts` `LanguageProviderRegistry` is the existing
  pluggable registry; the LSP manager produces a `LanguageProvider` whose `descriptor.availability`
  reflects the manager's live `LspProcessStatus`.
- `packages/keiko-server/src/editor/builtinLanguageProviders.ts`
  `unavailableExternalLspDescriptors()` is the status seam that already advertises python-lsp,
  java-lsp, go-lsp, rust-lsp, shell-lsp, sql-lsp as "unavailable". The manager does not modify
  this seam; future per-language issues will replace an entry when a real managed provider is
  configured.
- `packages/keiko-server/src/editor/patchApplyEvidence.ts` establishes the content-free-by-
  construction audit pattern (no raw text, no paths, only enums/counts/hashes/timestamps) that
  lifecycle event records in this subsystem follow.

### Coverage floor constraint

The base branch for this work is `feat/keiko-agent-native-editor-foundation-and-runtime` (not
`feat/keiko-editor`), so the `test:coverage:quality` gate skip condition is false and
keiko-server's 75.75% branch-coverage floor is ACTIVE. Every branch in the new lsp/ modules must
be hit by deterministic injected-fake-spawn unit tests.

## Decision

### D1 — Location: keiko-server module, lsp/ subdir; one new contracts leaf

We will place the LSP process manager entirely within `packages/keiko-server/src/editor/lsp/` — a
cohesive subdirectory of the existing editor module. No new workspace package is created (ADR-0045
D1; ADR-0025 forward-only baseline). keiko-server already has unrestricted downstream imports so no
new dependency-cruiser rule is required.

One new strict-leaf contract file `packages/keiko-contracts/src/lsp-process.ts` will define the
status, configuration, error-code, and lifecycle-event types that cross package boundaries (the
contracts leaf may only contain frozen const tables, pure types, and throw-free validators — no
`@oscharko-dev/keiko-*` imports per ADR-0019 D1). All internal implementation types (codec state,
pending-request maps, restart-window ring-buffers) remain private to the lsp/ subdir.

### D2 — Spawn boundary: injected LspSpawnFn, not runCommand (the ADR-0043 amendment core)

We will spawn the LSP child process through an **injected `LspSpawnFn`** port whose default adapter
wraps `node:child_process.spawn` directly. `runCommand` is explicitly NOT used (reasons above).

The following ADR-0043 equivalent controls apply to this new spawn boundary:

**I1 equivalent — network isolation policy accepted, not precluded:**
The manager accepts an optional `networkPolicy` field in `LspProcessConfig`. For the foundation
and for Python/Go (no index-time untrusted execution per ADR-0045 D3), the manager spawns with
the env allowlist only (`network: "inherit"`). For Java and Rust, where index-time untrusted code
executes, a future per-language implementation issue MUST provide `network: "none"` via
`keiko-sandbox` wrapping — a separate security review per ADR-0045 D3/D5. The manager must never
preclude that wrapping.

**I2 equivalent — workspace-root containment:**
The LSP executable must resolve to an absolute path that lies OUTSIDE the workspace root (operator-
provisioned like `git` or `node`, per ADR-0045 D2). We will reimplement the
`assertExecutableOutsideWorkspace` pattern from `exec.ts` inside a `resolveExecutableOutsideWorkspace`
helper (pure function, injectable `ProcessEnv`) rather than importing the unexported private
function. The check uses the same two-step: lexical `isWithinWorkspace` AND realpath-resolved
`isWithinWorkspace`, so a symlink from within the workspace cannot point to a workspace-external
binary and bypass the check.

**I3 equivalent — stream boundaries never buffer:**
The LSP base-protocol frame reader will enforce a `maxFrameBytes` cap. When the `Content-Length`
header declares a frame larger than `maxFrameBytes`, the reader REJECTS the frame immediately with
a typed `LspProcessErrorCode.RESPONSE_TOO_LARGE` error and disposes the connection — it NEVER
reads the oversized body into memory. Child stderr is neither buffered nor logged: it is
discarded or counted-but-not-stored to keep all content off the audit trail (content-free
invariant below). Only a count of discarded stderr bytes may appear in the lifecycle audit record.

**I4 equivalent — content-free lifecycle attestation:**
Every process lifecycle event (spawn, initialize, crash, dispose, restart) produces a typed
`LspLifecycleEvent` record that carries ONLY: an opaque `managerId` (hash-derived), the
`LspProcessStatus` enum value, a timestamp in milliseconds, counts (pending requests, restart
count), and the typed `LspProcessErrorCode` on failure. It carries NO source text, NO
request/response bodies, NO raw stderr, NO LSP method names, NO workspace paths. The
`keiko-security` `deepRedactStrings` function is applied as defense-in-depth before any record
is surfaced through `GET /api/editor/lsp/status`. Content-free-by-construction: the
`LspLifecycleEventInput` builder type has no field that could hold raw content, so a content leak
is architecturally impossible.

**I5 equivalent — deny-by-default preflight before spawn:**
`isCommandAllowed` (imported from `keiko-tools/src/sandbox.ts`) MUST return `{ allowed: true }`
before any `LspSpawnFn` call. The executable must be a bare PATH name (no separators, no NUL),
must be in the operator-configured command rule allowlist, and must resolve outside the workspace
before the process is ever spawned. If any preflight check fails, the manager transitions to
`LspProcessStatus.EXECUTABLE_NOT_FOUND` or `SPAWN_FAILED` without attempting a spawn.

**Ephemeral HOME:**
The spawned LSP server child receives an empty `mkdtempSync`-created HOME directory (POSIX) /
USERPROFILE (Windows) substituted via the `buildSandboxEnv` env-copy path, exactly as
`nodeHomeProvider` does in `exec.ts`. The ephemeral directory is deleted on process dispose
(best-effort `rmSync`). This prevents the LSP server from reading or writing to the operator's
real home directory.

**POSIX process-group kill:**
On POSIX, the manager spawns with `detached: true` and kills via `process.kill(-pid, signal)` to
include grandchildren. On Windows, `child.kill(signal)` is used (no tree-kill dependency). The
escalation sequence on shutdown or forced-dispose is: `SIGTERM` → grace period (configurable,
default 5 s) → `SIGKILL`. On Windows the sequence degrades to two `child.kill()` calls.

### D3 — Transport: minimal LSP base-protocol framing implemented in-house; no vscode-jsonrpc

We will implement LSP base-protocol framing ourselves as a PURE codec:

- **Frame reader**: reads `Content-Length: N\r\n\r\n` + exactly N UTF-8 bytes. Rejects frames
  where the declared Content-Length exceeds `maxFrameBytes` before reading the body (I3 equivalent).
- **Frame writer**: serializes `Content-Length: N\r\n\r\n` + UTF-8 JSON body.
- **JSON-RPC client**: `id → pending-promise` correlation map, notification dispatch, request
  timeout via `createDeadlineCancellation`-style token, `$/cancelRequest` emission on abort.

`vscode-jsonrpc` is NOT added as a runtime dependency. Rationale:

1. No such package currently exists in the repository's dependency tree; adding it triggers the
   ADR-0045 D6.4 dependency/license-review gate.
2. The foundation ships fake providers only. A production-grade JSON-RPC library is unjustified
   until at least one real provider ships and its surface area is understood.
3. The minimal codec needed for LSP base protocol (Content-Length framing + request/response/
   notification dispatch) is roughly 200 LOC of pure, deterministically testable TypeScript.
   There is no "three similar usages" justification yet for pulling in a runtime dependency.
4. ADR-0045 Consequences explicitly names `vscode-jsonrpc` as "the only candidate new npm runtime
   dependency" — this ADR defers that dependency to the first real language-server implementation
   issue, where the dependency/license review gate can be satisfied against concrete requirements.

This decision is reversible: if `vscode-jsonrpc` is adopted by a future per-language issue, the
codec module is a contained replacement point behind the `LspJsonRpcClient` port in the manager.

### D4 — Lifecycle bounds, per-request deadline, and restart throttling

**Initialize with timeout:** after spawn, the manager sends LSP `initialize` within
`initializeTimeoutMs` (configurable, default 10 s). A timeout transitions to
`LspProcessStatus.INITIALIZE_TIMEOUT` and triggers a restart attempt.

**Per-request deadline:** every outbound LSP request carries a deadline derived from an injected
`now()` clock + `requestTimeoutMs` (default equals `DEFAULT_LANGUAGE_SERVICE_LIMITS.deadlineMs`,
2 000 ms). When the deadline fires: the manager sends `$/cancelRequest` to the server, rejects
the pending promise with `LspProcessErrorCode.REQUEST_TIMED_OUT`, but does NOT kill the process
(a slow request is not a crash).

**AbortSignal cancellation:** callers pass an `AbortSignal`; on abort the manager sends
`$/cancelRequest` immediately (before the deadline fires) and rejects with
`LspProcessErrorCode.CANCELLED`.

**Response byte cap:** enforced at the frame reader boundary (D3 / I3 equivalent above).

**Crash detection:** `child 'exit'` and `child 'error'` events transition the manager to
`LspProcessStatus.CRASHED` and initiate a restart-throttle check.

**Restart throttling:** a rolling window (configurable `restartWindowMs` / `maxRestartsInWindow`)
tracked with an injected clock. If the window is exhausted, the manager transitions to
`LspProcessStatus.RESTART_THROTTLED` and stays down. The window resets when the process is up
for at least `restartWindowMs` without a crash.

**Graceful shutdown:** on `dispose()` or workspace-close, the manager sends LSP `shutdown` request
(with `shutdownTimeoutMs` deadline), then `exit` notification, then begins SIGTERM→grace→SIGKILL.
All pending request promises are rejected with `LspProcessErrorCode.DISPOSED` before the kill.

**Dispose/workspace-close:** kills the process group, deletes the ephemeral HOME, and rejects all
pending promises. The manager becomes inert; further method calls throw synchronously.

### D5 — Status integration: pure mapping function, no UI rewrite, default registry unchanged

The manager exposes a `getLspProcessStatus(): LspProcessStatus` method. A pure function
`lspStatusToProviderDescriptor(managerId: string, languages: readonly string[],
operations: readonly LanguageServiceOperation[], status: LspProcessStatus):
LanguageProviderDescriptor` maps:

- `READY` → `{ availability: "available" }` (no `unavailableReason`)
- any other status → `{ availability: "unavailable", unavailableReason: <content-free enum label> }`

The `unavailableReason` strings derive only from the enum member name (e.g. `"RESTART_THROTTLED"`,
`"INITIALIZE_TIMEOUT"`) — no source text, no paths, no stack traces.

**The default registry remains unchanged.** `unavailableExternalLspDescriptors()` in
`builtinLanguageProviders.ts` continues to advertise python-lsp/java-lsp/go-lsp/rust-lsp as
`"unavailable"`. This ADR ships no real provider. A future per-language issue will:
1. instantiate a manager for the target executable,
2. register a `LanguageProvider` whose `descriptor` is derived from `lspStatusToProviderDescriptor`,
3. replace the corresponding `unavailableExternalLspDescriptors()` entry.

`touchesUi = false`: the `LanguageProviderDescriptor` shape is already consumed by the existing
`describeLanguageCapabilities()` → browser surface path without change; no new UI component is
added by this issue.

### D6 — Security: content-free-by-construction on every surface

The security invariant is enforced structurally, not procedurally:

- `LspLifecycleEventInput` (the builder input type) has no field with type `string` that could
  carry raw text. Every string field is typed as a member of a closed enum or a hash/id with
  a constrained format. A reviewer can confirm content-freedom by reading the type definition,
  not by reading every call site.
- `deepRedactStrings` from `@oscharko-dev/keiko-security` is applied as defense-in-depth before
  any structured data is handed to `GET /api/editor/lsp/status`.
- AC3 content-free proof: sentinel-fingerprint spy tests are provided for every status/audit/log
  sink, including the child stderr drain, asserting that no raw content crosses the boundary.
- Child stderr: the manager opens a drain on `child.stderr` that increments a counter but does not
  store, log, or surface the bytes. The counter appears in `LspLifecycleEvent` as
  `stderrBytesSeen: number` only.

### D7 — Coverage: unit-test backbone via injected fake spawn

To clear the 75.75% keiko-server branch floor, every branch in the new
`packages/keiko-server/src/editor/lsp/` modules is exercised by deterministic unit tests that
inject a fake `LspSpawnFn`. The fake spawns a controllable in-process shim (Node.js `PassThrough`
stream pair) rather than a real child process. Tests must cover:

- happy path (initialize → ready → request → response → dispose)
- initialize timeout branch
- request timeout branch
- AbortSignal cancellation branch
- RESPONSE_TOO_LARGE (oversized frame) branch
- crash detection + restart branch
- restart-throttle exhaustion branch (max restarts exceeded → stays down)
- shutdown timeout branch
- EXECUTABLE_NOT_FOUND / SPAWN_FAILED preflight-denial branches
- DISPOSED (calls after dispose) branch

Real-fixture integration tests (spawning an actual Node.js subprocess that acts as a minimal LSP
echo server) are encouraged for additional fidelity but are NOT the coverage backbone.

## Consequences

### Positive

- ADR-0045 D2's gate is cleared: a concrete, governed spawn boundary for long-lived LSP processes
  is defined and tested before any real language server ships.
- All five ADR-0043 invariants (I1–I5) have explicit equivalents for the new spawn class; the
  extension does not relax the original controls.
- Fake-provider tests stand up independently of any installed language server, keeping the CI
  green without toolchain provisioning.
- The minimal codec (no `vscode-jsonrpc`) keeps the npm/workspace SBOM unchanged until a real
  provider forces the dependency review.
- `lspStatusToProviderDescriptor` produces `LanguageProviderDescriptor` values that flow through
  the existing `describeLanguageCapabilities()` path without any UI changes.

### Negative

- The codec is bespoke; any LSP base-protocol edge case (Unicode multi-byte boundary in a
  Content-Length header, non-standard line endings from a misbehaving server) must be caught by
  the in-house frame reader rather than by a battle-tested library. Mitigation: the codec is a
  well-scoped replacement point behind a port; a future issue can swap in `vscode-jsonrpc` without
  touching the manager.
- Restart throttling and lifecycle state are fully in-memory. A keiko-server restart loses all
  process-manager state; managed LSP processes do not survive the server restart. This is
  acceptable for the foundation but must be documented for operators.
- The ephemeral HOME approach works for stateless analysis servers (Pyright, gopls). Java LSP
  servers (jdtls) that write a workspace-local cache to HOME may see cold-start latency on every
  server restart. This is owned by the per-Java implementation issue.
- No persistence of lifecycle events to the evidence store — lifecycle records are in-memory only
  in this foundation. A future issue may wire them to `EvidenceStore` following
  `patchApplyEvidence.ts`'s pattern.

### Neutral

- The manager's `networkPolicy` field is plumbing only in this issue; it is not exercised by any
  real egress call. Java and Rust providers remain the gating case for a real enforced-egress proof.
- The `stderrBytesSeen` counter in lifecycle events is informational; no alerting or policy is
  wired to it in this issue.

## Out of Scope

- Spawning any real language server (Python/Pyright, Go/gopls, Java/jdtls, Rust/rust-analyzer,
  shell, SQL). Owned by future per-language implementation issues.
- `network: "none"` enforced-egress wrapping of LSP processes. Required for Java and Rust per
  ADR-0045 D3; owned by those per-language security reviews, not this foundation.
- Browser-side LSP client, WebSocket or worker transport, or any CSP/connect-src widening
  (prohibited by ADR-0042 D3/D4).
- Container supervision, remote LSP, multi-workspace process pooling.
- Persistence of lifecycle events to the evidence store (`EvidenceStore`).
- Adding `vscode-jsonrpc` or any other npm runtime dependency (deferred to the first real-provider
  issue that can satisfy the ADR-0045 D6.4 dependency/license-review gate).
- Modifying `unavailableExternalLspDescriptors()` to advertise any provider as available. The
  default registry is unchanged by this issue.

## Alternatives Considered

### Alternative 1: Reuse `runCommand` with a streaming mode

**Pros**: single spawn boundary, minimal new code, existing env/allowlist/attestation wiring.

**Cons**: `runCommand` is architecturally one-shot and buffered (its `Buffers` struct accumulates
all output). Adding streaming would require forking its internal `Buffer[]` accumulation into a
frame-delimited pipe, changing the return type from `CommandResult` to an async iterable, and
updating every existing caller. The blast radius is unacceptable and the resulting function would
violate the principle of single reason to change.

**Why rejected**: invasive; changes an existing high-trust security boundary; requires re-validating
all existing callers. A clean new spawn class with equivalent controls is strictly safer.

### Alternative 2: Adopt `vscode-jsonrpc` now

**Pros**: battle-tested LSP base-protocol implementation; used by the VS Code extension host;
would handle multi-byte boundary and Content-Length edge cases.

**Cons**: new runtime npm dependency triggers ADR-0045 D6.4 dependency/license-review gate. For
the foundation (fake providers only), this is unjustified overhead. Adopting a runtime dependency
before its surface area is needed by a real provider violates the "no premature abstraction" rule
and the "three similar usages before extracting a pattern" principle.

**Why rejected**: dependency review gate cannot be satisfied against a concrete use case until a
real provider ships. The codec is a contained replacement point; `vscode-jsonrpc` can be adopted
by the first real-provider implementation issue with a proper gate pass. Reversible decision.

### Alternative 3: Browser-side LSP client via `monaco-languageclient`

**Pros**: rich Monaco integration; shifts JSON-RPC transport out of keiko-server.

**Cons**: explicitly prohibited by ADR-0042 D3 (no CSP widening), D4 (server language service is
the single governed source of truth), and ADR-0045 D2 (no browser-side LSP client). A browser LSP
client adds a second, ungoverned answer path and a browser egress surface.

**Why rejected**: architectural prohibition, not just a tradeoff.

### Alternative 4: One-file manager (no lsp/ subdir, inline in languageService.ts)

**Pros**: fewer files; less structural overhead.

**Cons**: `languageService.ts` would grow beyond 1 000 LOC and carry > 20 exports (the god-module
anti-pattern). The lsp/ subdir enforces a clear separation of concerns: lifecycle/codec is one
reason to change; orchestrator dispatch is another.

**Why rejected**: violates the "no god modules" quality standard.

## Related

- [ADR-0042](ADR-0042-keiko-editor-package-and-boundaries.md) — D4: server language service is the
  single governed source of truth. D3: no browser LSP client, no CSP widening.
- [ADR-0043](ADR-0043-enforced-execution-isolation.md) — the original spawn-boundary and invariants
  (I1–I5). This ADR is a required amendment extending those invariants to long-lived stdio processes.
  ADR-0043 D2 ("single subprocess boundary remains `runCommand`") is superseded for the LSP process
  class by this amendment; `runCommand` remains authoritative for all one-shot/buffered commands.
- [ADR-0045](ADR-0045-staged-multi-language-lsp-expansion.md) — D2: the gate requiring this amendment.
  D3: safe-by-default; index-time untrusted execution governs Java/Rust; enforced egress deferred to
  per-language security review. D5: LSP/Keiko/security-review partition. D6: verification contract.
- Issue [#1381](https://github.com/oscharko-dev/Keiko/issues/1381) (Epic
  [#1491](https://github.com/oscharko-dev/Keiko/issues/1491)) — implementing issue for this ADR.
- LSP Base Protocol 3.17 / 3.18 (specification: Content-Length framing, JSON-RPC 2.0,
  `initialize`/`shutdown`/`exit` lifecycle, `$/cancelRequest`)
- `packages/keiko-tools/src/sandbox.ts` — `buildSandboxEnv`, `isCommandAllowed`,
  `collectSensitiveEnvValues` (reused)
- `packages/keiko-tools/src/exec.ts` — `assertExecutableOutsideWorkspace` pattern (reimplemented
  with equivalent invariants)
- `packages/keiko-server/src/editor/languageCancellation.ts` — `createDeadlineCancellation` model
  (referenced for per-request deadline design)
- `packages/keiko-server/src/editor/patchApplyEvidence.ts` — content-free audit pattern (followed)
- `packages/keiko-contracts/src/language-service.ts` — `LanguageProviderDescriptor`,
  `LanguageProviderAvailability`, `DEFAULT_LANGUAGE_SERVICE_LIMITS`
- ADR-0019 (modular package architecture; leaf rules)
- ADR-0021 (bundling model; LSP servers operator-provisioned, not bundled)
