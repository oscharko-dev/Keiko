# Epic #2096 governed debugging regression evidence

**Status: Foundation-wave candidate verification in progress — not a release-closure claim.**

This ledger records evidence collected for Epic #2096 and children #2342 through #2348. Passing a
focused mutation, browser, or performance command is not a substitute for the final immutable-head
local and remote gates. The companion trust-boundary assessment is
[`2096-governed-debugging-security-review.md`](2096-governed-debugging-security-review.md).

## Candidate and architecture

- Governing decision: [ADR-0136](../adr/ADR-0136-governed-debug-adapter-session-management.md).
- Foundation-wave audit base: `origin/dev` at
  `8a1d61575123183d6f1227a5fea4c2742320a933`.
- The candidate is an uncommitted working tree. That is why the mutation scope command based on
  `origin/dev...HEAD` is not a valid changed-line result yet; it sees no uncommitted diff. A future
  authorized commit must rerun the scope gate against its actual PR head.

## Child-issue composition audit

| Issue | Delivered composition                                                                                                                                                            | Evidence surface                                                                                                                 | Current disposition                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| #2342 | ADR-0136 defines the governed Node.js/TypeScript DAP architecture, ownership, limits, failure modes, and non-goals.                                                              | `docs/adr/ADR-0136-governed-debug-adapter-session-management.md`; `npm run check:adr-index`                                      | Implemented; local architecture index passed.                                |
| #2343 | One canonical server-side DAP manager/registry owns admission, timers, protocol framing, output bounds, lifecycle evidence, and exactly-once teardown.                           | DAP unit suites included in `npm test`; adversarial suite at `packages/keiko-server/src/editor/dap/dapDebuggingSecurity.test.ts` | Implemented; full suite passed.                                              |
| #2344 | Stateless, closed, operator-provisioned capsule launch planning remains separate from session ownership.                                                                         | ADR-0136 ownership rules; DAP production, launch-plan, and sandbox tests in `npm test`                                           | Implemented; full suite passed.                                              |
| #2345 | Strict contracts, canonical breakpoint/watch persistence, CSRF/origin/session-bound routes, and bounded HTTP/SSE projections expose only server-owned state.                     | Contracts/server/UI suites; `npm run check:error-observability`; dedicated real-browser E2E                                      | Implemented; route and composed browser evidence passed.                     |
| #2346 | Gutter/palette controls, exception/conditional/log breakpoints, toolbar, stack/scopes/variables/watches, inline values, bounded output, and accessible status UI are integrated. | UI coverage, `DebugPanel`/editor tests, dedicated E2E, smoke suite                                                               | Implemented; UI coverage and browser evidence passed.                        |
| #2347 | Revisioned four-factor activation uses the existing durable `debuggingEnabled` opt-in and synchronously revokes a narrowed live session.                                         | Contract/server security tests in `npm test`; adversarial revocation scenario                                                    | Implemented; full suite passed.                                              |
| #2348 | Closeout adds hostile-path, real-browser, Linux-performance, release-evidence, coverage, and mutation-quality verification.                                                      | Commands below                                                                                                                   | Mutation quality is complete; immutable-head D12 and aggregate gates remain. |

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

The values in this section are the last historical Linux record inherited by the Foundation-wave
candidate. They remain useful regression context, but they do not satisfy the new paired D12
comparison: that record must be regenerated from the immutable signed candidate head after the
implementation commit.

The Linux-authoritative performance command completed successfully:

```text
npm run test:e2e:editor-perf
1 passed (47.7s)
```

The recorded artifact is
[`1209-perf-evidence.json`](../release/1209-perf-evidence.json). Its relevant final values are:

| Budget                        | Result                                                              |
| ----------------------------- | ------------------------------------------------------------------- |
| B4 cold start                 | p50 1434 ms; p95 1604 ms (budgets 1500/2500 ms)                     |
| B5 ordinary keystroke         | p95 0 ms; zero long tasks                                           |
| B5 idle active DAP session    | p95 3 ms; zero long tasks; paused session; trace captured           |
| B6 interaction                | p75 40 ms; max 40 ms (budget p75 200 ms)                            |
| B11 memory                    | baseline, peak, and residual all 50,400,000 bytes across two cycles |
| bounded workspace degradation | explicit `DOCUMENT_TOO_LARGE`, 413, truncated, 179 ms               |

The Linux production static-export evidence was regenerated and immediately rechecked:

```text
npm run build:ui
node scripts/editor-release-evidence.mjs --json
npm run check:editor-release-evidence
```

All release bounds passed: B1 has zero Monaco/editor markers in 14 first-load scripts; B2 is
1152.6 KiB of 2560.0 KiB; B3 is a 103.7 KiB editor worker of 750.0 KiB. The historical committed
artifact is [`1209-bundle-evidence.json`](../release/1209-bundle-evidence.json), measurement
`ae8a4d826ee39c18777e8d0daf59e02afe182c2afa6c2b236842373bddfe5e8d`.

## Debug-launch mutation quality

The Foundation-wave candidate completed the full governed debug-launch mutation command after a
failure-first repair cycle:

```text
npm run test:mutation:debug-launch-security
4,043 killed; 49 timeout; 0 survived; 0 no-coverage
Mutation score: 100.00%
```

The first expanded run exposed seven surviving and four uncovered mutants. Focused tests then
closed the exact protocol-disposal, ancestor-process, sandbox-platform, code-point, and boundary
export gaps. A targeted 164-mutant rerun reached 100 percent before the single final full rerun
above. The machine-readable report is
`reports/mutation/debug-launch-security/mutation-report.json`; generated reports are not committed.

Remaining closeout work is the immutable signed candidate commit, Linux-authoritative paired D12
comparison and refreshed release evidence, the final `npm run codex:pre-pr`, and required checks on
the exact pushed PR head.
