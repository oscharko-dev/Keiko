# Epic #2096 governed debugging regression evidence

**Status: verification in progress — not a release-closure claim.**

This ledger records evidence collected for Epic #2096 and children #2342 through #2348. It is
deliberately explicit about the remaining mutation-quality run: passing unit, browser, performance,
and release-evidence commands do not turn that remaining gate into an implicit pass. The companion
trust-boundary assessment is
[`2096-governed-debugging-security-review.md`](2096-governed-debugging-security-review.md).

## Candidate and architecture

- Governing decision: [ADR-0136](../adr/ADR-0136-governed-debug-adapter-session-management.md).
- Base Git revision observed during the Linux evidence runs:
  `a5c7157e5a59e55bb6c9acd98b549f48271a3783`.
- The candidate is an uncommitted working tree. That is why the mutation scope command based on
  `origin/dev...HEAD` is not a valid changed-line result yet; it sees no uncommitted diff. A future
  authorized commit must rerun the scope gate against its actual PR head.

## Child-issue composition audit

| Issue | Delivered composition                                                                                                                                                            | Evidence surface                                                                                                                 | Current disposition                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| #2342 | ADR-0136 defines the governed Node.js/TypeScript DAP architecture, ownership, limits, failure modes, and non-goals.                                                              | `docs/adr/ADR-0136-governed-debug-adapter-session-management.md`; `npm run check:adr-index`                                      | Implemented; local architecture index passed.                            |
| #2343 | One canonical server-side DAP manager/registry owns admission, timers, protocol framing, output bounds, lifecycle evidence, and exactly-once teardown.                           | DAP unit suites included in `npm test`; adversarial suite at `packages/keiko-server/src/editor/dap/dapDebuggingSecurity.test.ts` | Implemented; full suite passed.                                          |
| #2344 | Stateless, closed, operator-provisioned capsule launch planning remains separate from session ownership.                                                                         | ADR-0136 ownership rules; DAP production, launch-plan, and sandbox tests in `npm test`                                           | Implemented; full suite passed.                                          |
| #2345 | Strict contracts, canonical breakpoint/watch persistence, CSRF/origin/session-bound routes, and bounded HTTP/SSE projections expose only server-owned state.                     | Contracts/server/UI suites; `npm run check:error-observability`; dedicated real-browser E2E                                      | Implemented; route and composed browser evidence passed.                 |
| #2346 | Gutter/palette controls, exception/conditional/log breakpoints, toolbar, stack/scopes/variables/watches, inline values, bounded output, and accessible status UI are integrated. | UI coverage, `DebugPanel`/editor tests, dedicated E2E, smoke suite                                                               | Implemented; UI coverage and browser evidence passed.                    |
| #2347 | Revisioned four-factor activation uses the existing durable `debuggingEnabled` opt-in and synchronously revokes a narrowed live session.                                         | Contract/server security tests in `npm test`; adversarial revocation scenario                                                    | Implemented; full suite passed.                                          |
| #2348 | Closeout adds hostile-path, real-browser, Linux-performance, release-evidence, coverage, and mutation-quality verification.                                                      | Commands below                                                                                                                   | All listed evidence passed except the still-running full mutation suite. |

## Final local quality-gate record

`npm run codex:pre-pr` completed successfully on 2026-07-13 on darwin / Node v24.18.0. Its
machine-readable report is `.codex/pre-pr-report.json`.

| Gate                                                                                   | Result                                                                                          |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Typecheck, root lint, format, UI typecheck, UI lint                                    | **PASS**                                                                                        |
| `npm test`                                                                             | **PASS** — 1,242 files passed, 5 skipped; 21,558 tests passed, 13 skipped                       |
| `npm run test:coverage:quality`                                                        | **PASS** — package, file-floor, release-target, statement, branch, and function ratchets passed |
| LCOV mapping, architecture, negative architecture, ADR index, dependency hygiene       | **PASS**                                                                                        |
| Clean build, bin preparation, UI production build, package surface, editor bundle size | **PASS**                                                                                        |
| Chromium smoke                                                                         | **PASS** — 56 tests passed                                                                      |
| `npm run check:editor-release-evidence` on darwin                                      | **SKIPPED as designed** — Linux is authoritative                                                |

`npm run check:error-observability` additionally passed: top-level 500 correlation, redacted
diagnostic, and opaque UI correlation behavior remain enforced.

## Dedicated composed-browser evidence (#2348)

The Linux-qualified command below ran against the production build and a real private-socket DAP
fixture under enforced Bubblewrap capability checks:

```text
npm run test:e2e:editor-debugging-2348
2 passed (31.4s)
```

The two assertions cover:

1. source breakpoint, start, pause, step over/into/out, inline values, scopes/variables, watch
   creation/evaluation, and explicit stop; and
2. a separate uncaught-exception breakpoint whose DAP `stopped` event has reason `exception` and
   whose bounded description is visible in the Debug panel.

## Linux performance and release evidence

The Linux-authoritative performance command completed successfully:

```text
npm run test:e2e:editor-perf
1 passed (47.7s)
```

The recorded artifact is
[`1209-perf-evidence.json`](../release/1209-perf-evidence.json). Its relevant final values are:

| Budget                        | Result                                                              |
| ----------------------------- | ------------------------------------------------------------------- |
| B4 cold start                 | p50 893 ms; p95 894 ms (budgets 1500/2500 ms)                       |
| B5 ordinary keystroke         | p95 0 ms; zero long tasks                                           |
| B5 idle active DAP session    | p95 0 ms; zero long tasks; paused session; trace captured           |
| B6 interaction                | p75 24 ms; max 32 ms (budget p75 200 ms)                            |
| B11 memory                    | baseline, peak, and residual all 37,300,000 bytes across two cycles |
| bounded workspace degradation | explicit `DOCUMENT_TOO_LARGE`, 413, truncated, 152 ms               |

The Linux production static-export evidence was regenerated and immediately rechecked:

```text
npm run build:ui
node scripts/editor-release-evidence.mjs --json
npm run check:editor-release-evidence
```

All release bounds passed: B1 has zero Monaco/editor markers in 14 first-load scripts; B2 is
1152.6 KiB of 2560.0 KiB; B3 is a 103.7 KiB editor worker of 750.0 KiB. The committed candidate
artifact is [`1209-bundle-evidence.json`](../release/1209-bundle-evidence.json), measurement
`ae8a4d826ee39c18777e8d0daf59e02afe182c2afa6c2b236842373bddfe5e8d`.

## Remaining closeout condition

The last complete debug-launch mutation report in this worktree records 3,510 killed and 22 timeout
mutants, with zero survived and zero no-coverage mutants. A new full 100-percent Stryker run was
started against the expanded uncommitted candidate and deliberately stopped once its interim result
already contained survivors; it is not represented as a passing result. This ledger remains in
progress until an authorized commit permits the actual PR head to run
`node scripts/check-mutation-scope.mjs --base origin/dev --head HEAD` and the resulting scoped
quality check.
