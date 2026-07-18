# Epic 2094 managed language intelligence demo

This runbook reproduces the governed managed-language lifecycle delivered by Epic #2094 and targeted
for closeout by Issue #2282. The mandatory path is hermetic: it uses real loopback UI/BFF routes and real
stdio subprocesses backed by deterministic fake language servers. It does not access the network or
install a provider, toolchain, module, package, crate, or build dependency.

## Preconditions

- Node.js 24.18.0 or newer in the repository-supported `>=24.18.0 <25` range is installed.
- npm is used with the committed root `package-lock.json`; pnpm, Yarn, and Bun are unsupported.
- Chromium from the repository's Playwright installation can launch on the host.
- The candidate checkout is clean except for the exact candidate under review.
- Commands run from the repository root.

Install the locked dependency graph and verify the focused surface:

```bash
npm ci
npm run test:managed-lsp-closeout
npm run check:managed-lsp-performance
npm run test:e2e:managed-language-closeout-2282
```

`npm run test:managed-lsp-closeout` builds the package graph and collects the complete
`packages/keiko-server/src/editor/lsp` test directory, the contracts/control-plane routes, the real
BFF docked-agent integration, the static browser/fixture contract, the closeout evidence guard, and
the Settings component/API tests. This directory-based collection prevents a newly added
managed-LSP test from being silently omitted from the closeout command.

## Hermetic browser product path

The Issue #2282 Playwright configuration creates external temporary executables named
`pyright-langserver` and `gopls`. Both are copies of one bounded stdio JSON-RPC fixture. The real BFF
still performs executable discovery outside the selected workspace, command-policy checks, process
spawn, initialization, capability negotiation, document synchronization, operation dispatch,
shutdown, and disposal. No route is stubbed.

The browser test drives this sequence:

1. Register a temporary workspace through the real `POST /api/projects` route.
2. Open a real Settings window and select **Languages**.
3. Prove Python, Go, Shell, Java, and Rust are default-off and expose text states rather than
   color-only status.
4. Focus **Enable Python** and **Enable Go** and activate each with the keyboard.
5. Warm the real capabilities route and prove `active`, `READY`, and live negotiated operations.
6. Execute Python diagnostics and Go definition through `POST /api/editor/language` and real stdio.
7. Change Python type checking in Settings, save, observe the visible restart impact, roll it back
   through the real control route, confirm the rolled-back value in Settings, restart through the
   real revision/ETag-protected control route, and negotiate the restored generation.
8. Change Go static analysis in Settings, save, observe the visible restart impact, restart through
   the same real control route, and negotiate the changed generation.
9. Request Rust semantic tokens while Rust is disabled and prove the bounded
   `{ "schemaVersion": "1", "supported": false }` fallback.
10. Run real-browser axe against the populated Settings window and attach a deterministic visual
    evidence image to the Playwright result.
11. Disable Python and Go from Settings and prove subsequent operations fail with
    `UNSUPPORTED_LANGUAGE`; no in-process or stale-provider fallback serves them.

The test uses the real control route to install a bounded baseline Python/Go configuration before it
edits that configuration in Settings. This is explicit test setup, not a route stub. Closeout found
that first activation does not create a runtime-configuration record and the UI only renders its
editor for an existing record. It also found that the live projection currently resolves
`restartRequired` to `available`, hiding the UI restart action even though Settings displays the
restart impact. Product follow-ups #2534 and #2535 own those two experiences; Issue #2282 is
verification-only and must not patch product source inline.

If Chromium cannot launch because of a host sandbox, kernel policy, missing browser artifact, or
display restriction, the browser lane is not green. Record the exact platform failure and rerun the
same command on the supported Linux measurement runner; do not replace it with a component test or
claim a visual/axe pass.

## Provider-operation-state conformance

`providerOperationMatrix.test.ts` covers all 675 provider-operation-state cells:

```text
5 providers × 15 operations × 9 effective states = 675 cells
```

Every cell has one closed disposition:

- `executed`: the operation is a candidate for that provider and the effective state is one of
  `available`, `starting`, `active`, or `degraded`; provider conformance must then prove real
  initialize negotiation and operation execution against the bounded protocol fixture;
- `unsupported-by-candidate`: the state is spawnable but the reviewed provider profile deliberately
  excludes the operation;
- `blocked-by-state`: `disabled`, `disabledByPolicy`, `notProvisioned`, `unhealthy`, and
  `restartRequired` fail closed before operation dispatch.

The matrix never turns a static candidate array into capability evidence. The provider conformance
suites initialize a JSON-RPC session, intersect candidate and negotiated operations, execute every
retained operation, sanitize the response, and keep unsupported cells explicit.

## Controlled performance measurement

The default local command records p50/p95 latency, process RSS delta, and actual recursive disk delta
for separate Python, Go, Shell, Java, and Rust workspace/provider profiles. Its wall-clock and RSS
results are informational because an ordinary developer machine is not a controlled measurement
context:

```bash
npm run check:managed-lsp-performance
```

The controlled Linux evidence job enforces the same committed budgets by setting the ADR-0139
switch:

```bash
KEIKO_ENFORCE_WALL_CLOCK_BUDGETS=1 npm run check:managed-lsp-performance
```

Disk disposal is enforced in both modes. A non-zero but bounded delta is reported rather than
replaced by a constant. The fake provider measures Keiko orchestration overhead only; it does not
claim provider-native indexing latency or child-process RSS attribution.

## Rollback drills

Run the focused suite before release and inspect the named owner for each rollback path:

| Drill                            | Expected closed result                                                                                  | Owning evidence                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Deactivation                     | Current-revision deactivation disposes the pool entry; stale agent/UI operations fail unavailable.      | `managedLspControl.test.ts`, real-BFF integration, Issue #2282 browser test |
| Policy downgrade                 | Deployment denial wins over stored workspace activation and prevents spawn.                             | `managedLspPolicy.test.ts`, `managedLspControl.test.ts`                     |
| Missing binary after restart     | Provisioning resolves `notProvisioned`; ambient PATH and workspace binaries are not substituted.        | control/factory and provider security tests                                 |
| Corrupt settings or schema skew  | Reads become unavailable or input is rejected without rewriting state or reflecting bodies.             | activation-store, contract, and route tests                                 |
| Failed atomic write              | Activation, evidence, and disposal do not partially commit.                                             | `managedLspControl.test.ts`                                                 |
| Unhealthy/crash-loop provider    | Bounded restarts end in `RESTART_THROTTLED`; stale generations cannot serve.                            | `lspProcessManager.test.ts`                                                 |
| Configuration rollback           | Only the immediately previous typed configuration can be restored; the affected pool entry is disposed. | control and route tests                                                     |
| Disabled semantic-token provider | The editor retains syntax highlighting through `supported: false`.                                      | semantic-token route/bridge tests and browser test                          |

## Optional real-provider smoke

Real-provider smoke is offline and additive. It is never required to download a provider during CI.
Provision only an exact approved profile, set its directory variable, and rerun the focused command:

| Provider | Approved profile                                                    | Variable                       |
| -------- | ------------------------------------------------------------------- | ------------------------------ |
| Python   | Pyright `1.1.410`                                                   | `KEIKO_TEST_PYRIGHT_BIN_DIR`   |
| Go       | gopls `v0.21.1`, Go `1.26.5`                                        | `KEIKO_TEST_GOPLS_BIN_DIR`     |
| Shell    | Bash Language Server `5.6.0`, ShellCheck `0.11.0`, provider Node 22 | `KEIKO_TEST_SHELL_LSP_BIN_DIR` |
| Java     | Eclipse JDT LS `1.60.0`, JDK 21 or newer                            | `KEIKO_TEST_JDTLS_BIN_DIR`     |
| Rust     | rust-analyzer `2026-07-06`, Rust `1.97.0`                           | `KEIKO_TEST_RUST_LSP_BIN_DIR`  |

An absent optional profile must be an explicit skip. Presence does not permit network access,
dependency resolution, build-script execution, proc macros, Maven/Gradle import, shell execution,
or workspace-local executable substitution.

## Final repository gate

The focused commands are not a substitute for the repository green bar. For a PR-bound candidate,
run the complete local-first gate after all targeted tests pass:

```bash
npm run agent:pre-pr -- --no-cache
```

Also rerun `npm run check:editor-release-evidence` when the measured editor surface changed. The
Issue #2282 implementation is verification/docs/tooling-only; test-only server files do not
invalidate the ADR-0139 product-surface binding. The committed evidence checker remains
authoritative, and Linux remains authoritative when a macOS build fingerprint differs. Record
optional skips, platform restrictions, and every non-green command exactly.
