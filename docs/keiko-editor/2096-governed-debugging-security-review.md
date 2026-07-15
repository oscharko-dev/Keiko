# Epic #2096 governed debugging security review

**Status: Foundation-wave candidate verification in progress — mutation quality is complete.**

This is the security ledger for the governed Node.js/TypeScript debugging capability introduced by
Epic #2096. It is paired with the factual command record in
[`2096-governed-debugging-regression-evidence.md`](2096-governed-debugging-regression-evidence.md).
No delivery action, issue state change, or release closure is implied by this document.

## Governing boundaries

- [ADR-0136](../adr/ADR-0136-governed-debug-adapter-session-management.md) is the primary
  architecture decision: server-owned DAP transport, closed operator provisioning, attested capsule
  execution, numerical bounds, canonical lifecycle ownership, and exactly-once teardown.
- ADR-0069 and ADR-0043 retain the process-hardening/isolation floor. Missing qualified execution
  enforcement fails closed.
- ADR-0042 retains browser use of same-origin BFF paths; no browser-reachable DAP transport or new
  CSP destination is introduced.
- ADR-0124, ADR-0125, ADR-0129, and ADR-0135 retain the authority model: debugging activation does
  not grant delivery authority. Accepted `dev` repository delivery still requires its separately
  validated Authority Envelope and exact-head direct checks before native auto-merge.
- ADR-0018 forbids PTY, arbitrary shell, and free-form debug-console evaluation.

## Trust-boundary verification matrix

| Boundary               | Enforced behavior                                                                                                                                         | Automated evidence collected                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Operator provisioning  | Adapter/runtime inputs are operator-owned and outside the selected workspace; a planted workspace adapter and secret-bearing environment are rejected.    | `dapDebuggingSecurity.test.ts`, full `npm test` pass                                   |
| Launch envelope        | Browser callers cannot supply executable, argv, environment, cwd, attach target, port, or arbitrary launch target.                                        | `dapDebuggingSecurity.test.ts`, `editorSecurityBoundary.test.ts`, full `npm test` pass |
| Strict capsule         | Launch requires qualified Bubblewrap enforcement and a private DAP topology; an unsupported enforcement backend is denied.                                | Linux real-DAP E2E: 2/2 passed                                                         |
| Session lifecycle      | Aggregate capacity, deadlines, output caps, process-group teardown, crash paths, and activation revocation are canonical-manager responsibilities.        | DAP adversarial tests in full `npm test`; Linux breakpoint and exception lifecycle E2E |
| Browser routes and SSE | Same-origin, API-path, CSRF, Host/Origin, and browser-session binding are enforced before debug controls/events are admitted.                             | Route/security suites in full `npm test`; Linux real-browser E2E                       |
| Activation narrowing   | The four-factor activation result is revisioned and a narrower effective ceiling awaits live-session teardown.                                            | DAP adversarial revocation test included in full `npm test`                            |
| Data projection        | Stack, scope, variable, watch, inline-value, and output projections are count/size/depth bounded and expose truncation rather than raw unbounded content. | DAP/UI unit suites and full coverage-quality pass                                      |
| UI accessibility       | Controls are finite and bounded; Debug uses the existing status-live-region model rather than adding an uncontrolled announcement channel.                | UI coverage, component tests, and Chromium smoke pass                                  |

## Eight required adversarial classes

The full unit/integration suite passed with 21,558 tests and includes the eight #2348 hostile-path
assertions below. They must remain part of the mutation and PR-diff verification after the candidate
is committed.

|   # | Bypass class                                   | Required containment                                                           |
| --: | ---------------------------------------------- | ------------------------------------------------------------------------------ |
|   1 | Workspace-planted adapter / secret environment | Reject substituted executable and exclude secret environment propagation.      |
|   2 | Free-form launch input                         | Reject arbitrary target/path/environment input before launch construction.     |
|   3 | Aggregate capacity exhaustion                  | Deny before a session exceeds the configured global bound.                     |
|   4 | Wall-time overrun                              | Terminate the complete process group and expose a content-free terminal state. |
|   5 | Cross-origin or non-API SSE                    | Deny before event-stream admission.                                            |
|   6 | Oversized variables or stack                   | Return bounded projections with explicit truncation.                           |
|   7 | Mid-session activation revocation              | Await process-group termination when the effective ceiling narrows.            |
|   8 | Unknown activation fields                      | Reject closed-contract extensions rather than silently interpreting them.      |

## Runtime evidence and data handling

The Linux DAP E2E passed both the complete breakpoint flow and a separate uncaught-exception flow.
The exception proof verifies a bounded, user-visible description without treating it as an evidence
payload. The Linux performance run passed B4/B5/B6/B11, including an active-but-idle paused DAP
session with B5 p95 3 ms and zero long tasks. Release measurements are stored as bounded numeric
artifacts in `docs/release/1209-perf-evidence.json` and
`docs/release/1209-bundle-evidence.json`; they contain no source, variable value, console text,
endpoint credential, or reusable browser capability.

`npm run check:error-observability` passed, preserving correlation-id propagation and redacted
operator diagnostics for server error paths.

## Non-goal audit

The design and covered regression paths retain the following prohibitions:

- no user-facing PTY, shell, arbitrary terminal, or free-form debug evaluation;
- no attach-to-arbitrary-process, remote target, caller-selected port, or network-debugging route;
- no bundled, downloaded, self-updating, or workspace-supplied adapter binary;
- no browser DAP endpoint or agent-facing debug-session control plane;
- no hot reload, edit-and-continue, activation authority widening, or delivery authorization; and
- no raw source, debugger value, console output, secret, endpoint, private path, or capability in
  evidence or diagnostics.

## Remaining condition

The expanded Foundation-wave candidate completed the full debug-launch mutation command with 4,043
killed, 49 timeout, zero survived, and zero no-coverage mutants: a 100.00 percent mutation score.
The first expanded run exposed seven surviving and four uncovered mutants; focused failure-first
tests closed those exact gaps before the single final full rerun.

Security closeout still requires immutable-head Linux D12 cap/comparison evidence, the final local
aggregate gate, and the exact pushed PR head's direct required checks. No policy, mutation threshold,
coverage floor, evidence bound, or trust boundary has been weakened to avoid those requirements.
