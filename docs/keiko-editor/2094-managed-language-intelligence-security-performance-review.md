# Epic 2094 managed language intelligence security and performance review

Review refreshed: 2026-07-18 against `dev@1325bf1321f15956afd08d7988bae3e24e6c8387` plus
the local verification-only Issue #2282 diff. Scope: Python, Go, Shell, Java, and Rust activation,
configuration, process supervision, language operations, semantic tokens, Settings UI, docked-agent
projection, evidence, performance, rollback, and release gates.

## Conclusion and evidence status

No unresolved critical or high security defect was found in the reviewed product boundaries or in
the Issue #2282 verification harness. The closeout found two non-security product gaps: Settings
cannot create the first typed runtime configuration after activation (#2534), and the live
projection hides the restart action after a configuration mutation (#2535). Issue #2282 is
verification-only, so neither product-source fix is folded into this closeout.

The real-browser axe/visual lane, controlled Linux orchestration run, and Linux-authoritative editor
evidence are green. This conclusion remains provisional until the exact-head local aggregate and
protected checks are green.

## Trust-boundary review

| Boundary               | Required invariant                                                                                                                           | Reviewed evidence and disposition                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local-human authority  | Activation/configuration mutations require explicit local-human UI/BFF action, current revision, and bounded scope.                          | CSRF, strong ETag, expected revision, idempotency, strict request parsing, workspace root resolution, and actor-class evidence remain mandatory. **PASS** in route/control tests.             |
| Executable discovery   | Exact approved command names resolve outside the workspace; no ambient or workspace substitution.                                            | Planted files, symlinks, missing binaries, command-rule denial, and external fixture executables are covered. The browser fixture is placed in an external temporary bin directory. **PASS**. |
| Spawn and descendants  | No shell interpolation; closed arguments/environment; only reviewed descendants.                                                             | `shell: false`, fixed argument arrays, environment allowlists, descendant allowlists, and generation cleanup are executable evidence. **PASS**.                                               |
| Egress                 | Profiles with no-network policy fail closed when enforcement is unavailable; offline profiles do not inherit proxy/package-manager behavior. | Shared security plus Java/Rust/Shell provider tests cover network attempts and closed package/toolchain settings. **PASS**.                                                                   |
| Filesystem             | Workspace input stays contained; provider runtime state is private, disjoint, bounded, and removed.                                          | Canonical root/path checks, mode-0700 generations, state quotas, failed-init/crash/restart/disposal cleanup, and actual recursive disk measurement are covered. **PASS**.                     |
| Protocol               | Frames, pending requests, documents, results, display strings, edits, diagnostics, locations, and tokens are bounded and sanitized.          | Malformed/accessor-hostile/oversized fixtures, server mutation requests, unknown capabilities, stale generations, cancellation, and timeout tests remain collected. **PASS**.                 |
| Capability negotiation | A static provider candidate must never become an executable UI/agent claim without live initialize evidence.                                 | Per-provider conformance executes every negotiated candidate. The 675-cell ledger references those suites and keeps unsupported/blocked cells explicit. **PASS**.                             |
| Docked agent           | Existing governed action/language routes are reused; review-only results grant no write/delivery authority.                                  | Real-loopback integration covers Python/Go operations, cancellation, workspace switch, stale activation, redacted audit, and byte-identical files for review-only edits. **PASS**.            |
| UI                     | Settings reflects server state, remains keyboard/focus safe, and does not install providers or expose secrets/paths.                         | Component axe/i18n/state coverage and the composed real-browser axe/visual lane pass. The two product gaps are tracked in #2534 and #2535. **PASS WITH FOLLOW-UPS**.                          |
| Evidence               | Diagnostics/manifests contain statuses, counts, hashes, reason codes, and relative paths only.                                               | Redaction tests exclude roots, source/diagnostic bodies, executable paths, environment, stderr, configuration bodies, endpoints, and credentials. **PASS**.                                   |
| Delivery               | No check, budget, coverage floor, approval, or branch protection may be bypassed.                                                            | Local-first aggregate and exact-head protected checks are still required; no merge/closure authority is inferred from this review. **PENDING**.                                               |

## Provider-operation-state closure

The executable matrix now covers all 675 provider-operation-state cells. The arithmetic and closed
dispositions are:

| Category                                   |   Cells | Rationale                                                                    |
| ------------------------------------------ | ------: | ---------------------------------------------------------------------------- |
| Candidate operation in a spawnable state   |     260 | Must be backed by provider initialize negotiation and conformance execution. |
| Unsupported operation in a spawnable state |      40 | Explicit `unsupported-by-candidate`; never advertised as complete.           |
| Any operation in a non-spawnable state     |     375 | Explicit `blocked-by-state`; no dispatch.                                    |
| **Total**                                  | **675** | 5 providers × 15 operations × 9 effective states.                            |

Spawnable states are `available`, `starting`, `active`, and `degraded`, matching the production
authorization set. Non-spawnable states are `disabled`, `disabledByPolicy`, `notProvisioned`,
`unhealthy`, and `restartRequired`. This ledger is a completeness and fail-closed proof; live
capability evidence remains the provider conformance suite.

## Language-specific no-execution review

### Shell

- Bash Language Server receives an exact command and closed environment.
- ShellCheck is a reviewed companion executable, not a workspace hook.
- `npm`, `npx`, shell startup files, arbitrary formatters, and workspace-local binaries cannot be
  selected as descendants.
- Language operations analyze bounded text; they do not execute the document.
- Cancellation, planted binaries, crash recovery, oversized diagnostics, stderr handling, and
  descendant cleanup are conformance-tested.

### Java

- Eclipse JDT LS uses the approved distribution layout and an operator-approved JDK.
- Maven/Gradle import, wrappers, autobuild, class-file generation, execution commands,
  `workspace/executeClientCommand`, external downloads, and annotation processing are disabled or
  rejected.
- `pom.xml`, Gradle files/wrappers, Eclipse metadata, escaping classpaths, and hostile project roots
  remain adversarial input, not execution authority.

### Rust

- rust-analyzer uses the approved profile and exact Cargo/rustc/rustfmt descendants.
- Build scripts, proc macros, checks, runnables, debug commands, workspace toolchain overrides,
  registries/sources, and online metadata are disabled or rejected.
- `.cargo`, `build.rs`, toolchain files, `rust-project.json`, escaping linked projects/path
  dependencies, custom builds, and proc-macro crates fail closed.
- Project file, metadata byte, memory, and index-deadline budgets are explicit configuration.

## Adversarial regression inventory

The complete LSP directory collected by `test:managed-lsp-closeout` contains the mandatory fixtures
for:

- planted and symlinked executables;
- ambient environment/configuration injection and disallowed runtime identities;
- malformed, oversized, and accessor-hostile frames/capabilities/results/tokens;
- server registration/configuration/mutation requests and stale unregister/generation events;
- descendants, stderr flooding, crash loops, initialization/request timeout, cancellation, and
  graceful-to-forced disposal;
- network attempts and package/toolchain download surfaces;
- Java build import/execution, Rust build scripts/proc macros, and Shell document execution;
- large documents, workspace-read caps, item/result truncation, queue serialization, and semantic
  token bounds;
- evidence/body/path/environment redaction and corrupt/schema-skewed state.

Optional real-provider lanes supplement this inventory. They may skip only when exact approved
offline binaries are absent; no test is authorized to install or download them.

The refreshed focused command passed 52 files and 642 tests. Five real-provider files (five tests)
skipped because no approved offline provider directories were configured. The focused UI
continuation passed 2 files and 102 tests.

## Performance and resource review

The schema-v2 measurement harness records separate profiles for Pyright, gopls, Bash Language
Server, Eclipse JDT LS, and rust-analyzer. Each receives an isolated workspace identifier, executable
name, manager identity, 20 cold/disposal samples, 100 warm samples, process RSS delta, and recursively
measured workspace disk delta.

The 2026-07-18 `linux-arm64` run enforced the committed thresholds. All profiles passed:

| Provider             | Cold Observed p50 | Cold Observed p95 | Warm Observed p50 | Warm Observed p95 | Disposal Observed p50 | Disposal Observed p95 |   RSS delta | Disk delta |
| -------------------- | ----------------: | ----------------: | ----------------: | ----------------: | --------------------: | --------------------: | ----------: | ---------: |
| Pyright              |          0.239 ms |          0.597 ms |          0.028 ms |          0.054 ms |              0.080 ms |              0.217 ms | 5,111,808 B |        0 B |
| gopls                |          0.110 ms |          0.178 ms |          0.020 ms |          0.035 ms |              0.043 ms |              0.064 ms | 5,767,168 B |        0 B |
| Bash Language Server |          0.087 ms |          0.276 ms |          0.015 ms |          0.033 ms |              0.031 ms |              0.052 ms | 3,932,160 B |        0 B |
| Eclipse JDT LS       |          0.075 ms |          0.131 ms |          0.013 ms |          0.028 ms |              0.027 ms |              0.039 ms |   131,072 B |        0 B |
| rust-analyzer        |          0.076 ms |          0.189 ms |          0.016 ms |          0.028 ms |              0.028 ms |              0.038 ms | 2,883,584 B |        0 B |

Budgets are cold p95 250 ms, warm p95 25 ms, disposal p95 100 ms, process RSS delta 64 MiB, and
disk delta 1 MiB. Disk cleanup is deterministic and enforced in every mode. ADR-0139 requires
wall-clock and RSS enforcement only in a controlled context:

```bash
KEIKO_ENFORCE_WALL_CLOCK_BUDGETS=1 npm run check:managed-lsp-performance
```

The fake process isolates Keiko's orchestration cost. It does not claim real-provider indexing
latency, real child RSS, or workload-general performance. Those remain operator acceptance evidence
for an approved provider/workspace profile.

### Additional resource dispositions

- **Queueing:** operations serialize per warm root/language manager rather than spawning a second
  provider or returning an unbounded busy loop.
- **Large documents/results:** document, workspace-read, frame, pending-request, diagnostics,
  locations, edits, symbols, completion, and semantic-token caps reject or truncate deterministically.
- **Runtime state:** private generations are disjoint from the workspace and cleaned after shutdown,
  restart, crash, timeout, and failed initialization; configured quotas are enforced.
- **Crash loops:** bounded restart windows terminate in `RESTART_THROTTLED`; stale generations cannot
  revive or debit the current one.
- **Cancellation:** pre-dispatch and in-flight aborts are typed, and real agent HTTP disconnects
  propagate to managed requests.

## Accessibility, visual, and i18n review

The Settings component uses semantic sections/articles, labelled fields, text-plus-icon states,
native controls, an alert dialog, focus restoration, a polite live region, English/German message
ownership, and component-scoped styling. Existing component tests cover axe and all state/error/
keyboard paths.

The new Playwright proof adds the real composed Settings window, real BFF state, live negotiated
capability/health text, keyboard activation/deactivation, visible restart impact, guarded real-route
restart/rollback, real-browser axe, and a visual attachment. It passed 1/1 in 32.4 seconds with zero
serious/critical axe violations. The populated-state PNG SHA-256 is
`4554ed9eac369e1f167ca9a232d45d5734317ec106e458e826088e860390e9ba`.

The SHA-pinned global stylesheet remains unchanged. No product styling was added by #2282.

## Rollback and residual risk

Tested rollback controls include current-revision deactivation, policy denial, targeted restart,
immediately previous typed configuration, corrupt/schema-skewed state, failed atomic persistence,
missing binary, unhealthy runtime, crash-loop exhaustion, cancellation, workspace switch, stale
revision/generation rejection, and semantic-token syntax fallback. None downloads a runtime, serves a
stale process, mutates source, or grants delivery authority.

Residual limitations:

- exact-head aggregate and protected-check receipts remain required;
- provider-native indexing/RSS varies by approved binary and workspace and is not represented by the
  fake orchestration result;
- Settings cannot create the first runtime configuration; #2534 owns that product correction;
- the live projection hides the restart action after configuration changes; #2535 owns that product
  correction;
- real-provider smoke requires operator-provisioned offline profiles and was not run in this local
  refresh;
- semantic tokens remain Rust-first;

The two M5 conflict-UX findings were resolved in
`94fa38d42c9b9ec62e72b0464e30b5a526865bde`: conflict acceptance now requires actual conflict
state, and large-file conflict scanning is disabled. They are no longer an open M6 entry dependency.

## Required final commands

```bash
npm run test:managed-lsp-closeout
npm run test:e2e:managed-language-closeout-2282
npm run check:managed-lsp-performance
KEIKO_ENFORCE_WALL_CLOCK_BUDGETS=1 npm run check:managed-lsp-performance
npm run agent:pre-pr -- --no-cache
```

Only the controlled runner should set the wall-clock switch. The exact command results, optional
skips, `.agent/pre-pr-report.json`, Linux visual/axe attachment, editor-evidence disposition, and all
required checks must be recorded before #2282 or Epic #2094 is closed.
