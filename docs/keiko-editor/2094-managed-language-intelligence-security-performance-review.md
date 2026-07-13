# Epic 2094 managed language intelligence security and performance review

Review date: 2026-07-11. Scope: managed Python, Go, Shell, Java, and Rust activation, configuration,
process supervision, language operations, semantic tokens, Settings UI, docked-agent projection,
evidence, rollback, and release gates.

## Security conclusion

The reviewed M6 implementation has no unresolved critical or high security finding. Mandatory
security evidence is hermetic and does not trust a workspace executable, provider response,
configuration body, environment variable, process descendant, or UI capability claim. Failures are
typed and content-free outside the bounded local result surface.

This conclusion is conditional on the final candidate passing the commands in this document. It is
not an authorization to merge, deliver, close issues, or widen an Authority Envelope.

## Trust-boundary findings

| Boundary                 | Disposition                                                                                                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Executable discovery     | Exact approved command names are resolved outside the workspace. Workspace-planted and symlinked binaries fail before spawn. Required companion executables are checked as one profile.                                                                         |
| Spawn and descendants    | `shell: false`; exact argument arrays; closed environment allowlists; unique private descendant `PATH`; no ambient credential, package-manager, toolchain-home, proxy, or startup-file inheritance. Cleanup is attempted for every generation.                  |
| Egress                   | Provider-owned launch preparation enforces native `network:none`; a platform without the enforcing backend fails closed. Container fallback is not silently enabled.                                                                                            |
| Filesystem               | Workspace roots are canonical and selected; overlay and result paths must remain contained and root-relative. Provider state uses unique mode-0700 temporary roots outside the workspace and is removed on shutdown, crash, restart, and failed initialization. |
| Protocol                 | JSON-RPC frames, pending requests, document bytes, item counts, edits, diagnostics, locations, semantic tokens, and display strings are bounded. Malformed, accessor-hostile, overlapping, escaping, command-bearing, and oversized input is rejected.          |
| Activation/configuration | Default-off, local-human mutation, CSRF, ETag, revision, idempotency, typed schemas, approved runtime identities, atomic persistence, and content-free evidence are all required. Deployment policy and health can only reduce capability.                      |
| Docked agent             | The existing action route and language route are reused. Dispatch rechecks current workspace activation and negotiation. Failures retain typed provider/capability/timeout/cancel/limit codes. Audit stores status, code, count, and relative path only.        |
| UI                       | Settings never installs a provider or treats a static candidate as active. Status is text plus semantic styling, keyboard-operable, localized, and axe-tested. Component-scoped CSS avoids the pinned global stylesheet.                                        |
| Evidence                 | Activation evidence uses fingerprints, revisions, reason codes, outcomes, and counts. It excludes workspace roots, configuration bodies, source, diagnostics, executable paths, environment, stderr, and secrets.                                               |

## Language-specific no-execution proof

### Shell

- Bash Language Server receives a closed command and environment profile.
- ShellCheck is a reviewed companion executable, not a workspace hook.
- `npm`, `npx`, `shfmt`, shell startup files, and workspace-local binaries cannot be selected as
  descendants.
- Language operations do not execute the document. Cancellation, diagnostic truncation, planted
  binaries, crash recovery, and descendant cleanup are conformance-tested.

### Java

- Eclipse JDT LS must match the pinned `1.60.0` distribution layout and run under an explicitly
  approved JDK 21-or-newer executable.
- Maven/Gradle import, wrapper use, autobuild, class-file generation, execution commands,
  `workspace/executeClientCommand`, and external downloads are disabled or rejected.
- `pom.xml`, Gradle files/wrappers, `.project`, `.classpath`, `.factorypath`, and `.settings` are
  hostile import metadata for the managed profile. No project build is executed.

### Rust

- rust-analyzer uses the pinned `2026-07-06` profile with Rust `1.97.0` and exact approved Cargo,
  rustc, and rustfmt descendants.
- Build scripts, proc macros, checks, runnables, debug commands, workspace toolchain overrides,
  registry/source configuration, and network metadata are disabled or rejected.
- Cargo metadata is offline and no-dependency. `.cargo`, `build.rs`, toolchain files,
  `rust-project.json`, escaping path dependencies, custom builds, and proc-macro crates fail closed.

The shared `lspSecurity.test.ts`, process-manager tests, and all provider security/conformance suites
prove descendant, stderr, crash, frame, cleanup, and cancellation behavior. The focused command is:

```bash
npm run test:managed-lsp-closeout
```

Observed result: 25 files passed, five optional real-provider files skipped, 325 tests passed, five
optional tests skipped.

## Performance and resource budgets

`npm run check:managed-lsp-performance` measures the full fake-process manager startup/initialize,
warm JSON-RPC request, and graceful disposal paths. It uses 20 cold/disposal samples and 100 warm
samples. The fake provider isolates Keiko orchestration overhead; it is not a substitute for the
optional real-provider compatibility lane.

Committed hard dispositions:

| Metric                          | Budget |
| ------------------------------- | -----: |
| cold initialize p95             | 250 ms |
| warm request p95                |  25 ms |
| disposal p95                    | 100 ms |
| process RSS delta               | 64 MiB |
| harness-created persistent disk |  1 MiB |

Linux-authoritative measurement, Docker `node:22-bookworm`, Linux arm64, Node `v22.23.1`:

| Metric                      |      p50 |      p95 |             max | Result |
| --------------------------- | -------: | -------: | --------------: | ------ |
| cold initialize, 20 samples | 0.202 ms | 1.011 ms |        3.578 ms | Pass   |
| warm request, 100 samples   | 0.031 ms | 0.069 ms |        0.211 ms | Pass   |
| disposal, 20 samples        | 0.075 ms | 0.214 ms |        0.505 ms | Pass   |
| RSS delta                   |        - |        - | 4,456,448 bytes | Pass   |
| persistent disk             |        - |        - |         0 bytes | Pass   |

Reference macOS arm64 run, Node `v22.22.3`: cold p95 `0.945 ms`, warm p95 `0.034 ms`, disposal p95
`0.138 ms`, RSS delta `4,702,208 bytes`, disk `0 bytes`; all dispositions passed.

The measurement is reproducible with:

```bash
npm run check:managed-lsp-performance
docker run --rm -v "$PWD":/workspace -w /workspace \
  node:22-bookworm node scripts/measure-managed-lsp-closeout.mjs
```

## Additional budget evidence

- **Queueing:** concurrent operations serialize on one warm manager rather than returning busy or
  spawning a second process (`hostLanguageOperation.pool.test.ts`).
- **Large documents/results:** the shared language limits, frame limit, provider sanitizers, and
  semantic-token 10,000-token/256 KiB caps reject or truncate before unbounded allocation.
- **Runtime state:** Rust uses explicit 50,000-entry and 512 MiB state quotas plus memory/index
  budgets; over-budget generations are killed and cleaned. Other profiles use bounded private state
  and lifecycle cleanup. No evidence claims an unenforced universal RSS cgroup.
- **Crash loop:** a bounded rolling restart window ends in `RESTART_THROTTLED`; late events from an
  old generation do not debit or revive the current generation.
- **Startup/disposal:** initialization deadline, shutdown request, exit notification,
  SIGTERM-to-SIGKILL escalation, and cleanup-failure lifecycle evidence are tested.
- **Cancellation:** already-aborted and in-flight requests reject promptly; the real agent HTTP
  connection close propagates to the managed request.

## Accessibility, visual, and release gates

The Settings panel uses labels, fieldsets, buttons, text status, focusable controls, English/German
i18n, and component-scoped styling. `ManagedLanguageSettings.test.tsx` includes axe assertions and
keyboard-reachable state transitions. Full UI and editor gates remain mandatory:

```bash
npm run typecheck --workspace @oscharko-dev/keiko-ui
npm run lint --workspace @oscharko-dev/keiko-ui
npm run test:coverage:ui
npm run check:ui-i18n
npm run test:e2e:smoke
npm run test:e2e:editor-perf
npm run check:editor-release-evidence
```

The authoritative editor fingerprint must be generated on Linux from the final candidate. The
macOS fingerprint is informative only. No global CSS change is permitted for this feature.

## Rollback and residual risk

The tested rollback controls are explicit deactivation, policy denial, targeted restart, previous
configuration rollback, corrupt-state fail-closed behavior, atomic-write failure, missing binary,
unhealthy runtime, and crash-loop exhaustion. None grants delivery authority or mutates source.

Residual limitations:

- real-provider smoke was skipped because no approved offline profiles were provisioned;
- provider-native indexing latency and RSS vary by workspace and must be measured when approving a
  new real-provider profile;
- semantic tokens are deliberately Rust-first;
- PR #2260's two non-blocking M5 conflict-UX findings remain outside this M6 verification-only
  source scope. The maintainer merged PR #2260 after the audit and all 13 protected checks passed;
  this review records, rather than conceals, that disposition.
