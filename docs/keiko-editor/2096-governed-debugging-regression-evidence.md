# Epic #2096 governed debugging regression evidence

**Status: Signed Foundation-wave source/evidence verification complete; delivery gates pending.**

This ledger records evidence collected for Epic #2096 and children #2342 through #2348. The signed
source candidate has complete mutation, browser, bundle, and paired D12 evidence. Those focused
passes do not substitute for the final aggregate on the documentation/evidence head or the exact
pushed head's remote gates. The companion trust-boundary assessment is
[`2096-governed-debugging-security-review.md`](2096-governed-debugging-security-review.md).

## Candidate and architecture

- Governing decision: [ADR-0136](../adr/ADR-0136-governed-debug-adapter-session-management.md).
- Foundation-wave audit base: `origin/dev` at
  `1056821a5b861f076cc88e120492aaf5cad37b9d`.
- Signed measured implementation candidate:
  `57524a9c0ea92b5ad19830d7199af32ffbc0822c`.
- Performance subject digest:
  `7134c0b6d8765d08f64d2cdba38c6c0575f775818d70c7d42c48ea3f8f7016ef`. The checker requires the
  measured commit to remain reachable and independently recomputes this digest, so subsequent
  evidence-only documentation does not masquerade as a new source measurement.

## Child-issue composition audit

| Issue | Delivered composition                                                                                                                                                            | Evidence surface                                                                                                                 | Current disposition                                                                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| #2342 | ADR-0136 defines the governed Node.js/TypeScript DAP architecture, ownership, limits, failure modes, and non-goals.                                                              | `docs/adr/ADR-0136-governed-debug-adapter-session-management.md`; `npm run check:adr-index`                                      | Implemented; local architecture index passed.                                      |
| #2343 | One canonical server-side DAP manager/registry owns admission, timers, protocol framing, output bounds, lifecycle evidence, and exactly-once teardown.                           | DAP unit suites included in `npm test`; adversarial suite at `packages/keiko-server/src/editor/dap/dapDebuggingSecurity.test.ts` | Implemented; full suite passed.                                                    |
| #2344 | Stateless, closed, operator-provisioned capsule launch planning remains separate from session ownership.                                                                         | ADR-0136 ownership rules; DAP production, launch-plan, and sandbox tests in `npm test`                                           | Implemented; full suite passed.                                                    |
| #2345 | Strict contracts, canonical breakpoint/watch persistence, CSRF/origin/session-bound routes, and bounded HTTP/SSE projections expose only server-owned state.                     | Contracts/server/UI suites; `npm run check:error-observability`; dedicated real-browser E2E                                      | Implemented; route and composed browser evidence passed.                           |
| #2346 | Gutter/palette controls, exception/conditional/log breakpoints, toolbar, stack/scopes/variables/watches, inline values, bounded output, and accessible status UI are integrated. | UI coverage, `DebugPanel`/editor tests, dedicated E2E, smoke suite                                                               | Implemented; UI coverage and browser evidence passed.                              |
| #2347 | Revisioned four-factor activation uses the existing durable `debuggingEnabled` opt-in and synchronously revokes a narrowed live session.                                         | Contract/server security tests in `npm test`; adversarial revocation scenario                                                    | Implemented; full suite passed.                                                    |
| #2348 | Closeout adds hostile-path, real-browser, Linux-performance, release-evidence, coverage, and mutation-quality verification.                                                      | Commands below                                                                                                                   | Mutation, Linux D12, and release evidence complete; aggregate/remote gates remain. |

## Local quality evidence before the final aggregate

A pre-expansion `npm run agent:pre-pr` passed on 2026-07-13, but it is not reused as final acceptance
after the failure-first repairs. The changed surfaces were then exercised directly:

- the focused Debug panel suite passed 20 tests, including retained row-node identity under append;
- Linux UI coverage passed 335 files and 5,223 tests with 89.66% lines, 86.54% statements, 88.95%
  functions, and 77.84% branches;
- the D12 producer/checker suite passed 239 focused tests after zero-long-task and hostile-sample
  failure-first coverage was added; and
- the complete debug-launch mutation run killed 4,043 mutants, timed out 49, and left zero survived
  or uncovered mutants.

`npm run check:error-observability` also passed: top-level 500 correlation, redacted diagnostic,
and opaque UI correlation behavior remain enforced. The final `npm run agent:pre-pr` is deliberately
run only after this ledger and both generated release artifacts are finalized; its machine-readable
result is `.agent/pre-pr-report.json`.

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

The official Linux D12 runner provisioned independent clean checkouts with
`npm ci --ignore-scripts`, performed one Common warm-up per revision and one candidate cap warm-up,
then completed six alternating Common runs plus three candidate cap runs. The final builder and an
independent Linux checker both accepted the generated artifact:

```text
npm run run:d12-perf-comparison -- <pinned baseline and signed candidate inputs>
Wrote D12 comparison for 57524a9c0ea92b5ad19830d7199af32ffbc0822c from six orchestrated runs

node scripts/check-perf-evidence.mjs --target editor
perf-evidence: editor OK (budgets within limits, evidence fresh @ 57524a9c...)
```

The recorded artifact is
[`1209-perf-evidence.json`](../release/1209-perf-evidence.json). Its candidate projection is:

| Budget                     | Candidate result                                                        |
| -------------------------- | ----------------------------------------------------------------------- |
| B4 cold start              | p50 893 ms; p95 899 ms (budgets 1,500/2,500 ms)                         |
| B5 ordinary keystroke      | captured; zero long tasks; maximum 0 ms (budget 50 ms)                  |
| B5 idle active DAP session | p95 2 ms; 60 samples; zero long tasks; paused; 226 matched input events |
| B6 interaction             | p75 24 ms (budget 200 ms)                                               |
| B11 memory                 | baseline, peak, residual 50,400,000 B; two cycles                       |
| worker capture             | editor worker loaded; language/TypeScript workers absent; 3 requests    |

The median-run-level D12 comparison retained the following baseline/candidate/delta values:

| Metric                  |     Baseline |    Candidate |    Delta |
| ----------------------- | -----------: | -----------: | -------: |
| B2 shipped editor bytes |  1,180,165 B |  1,180,213 B |    +48 B |
| B10 own-code gzip       |     67,903 B |     73,392 B | +5,489 B |
| B4 p50                  |       886 ms |       893 ms |    +7 ms |
| B4 p95                  |       897 ms |       899 ms |    +2 ms |
| B5 idle-debug p95       |         2 ms |         2 ms |     0 ms |
| B6 p75                  |        24 ms |        24 ms |     0 ms |
| B11 peak/residual       | 50,400,000 B | 50,400,000 B |      0 B |

B10 remained below its 102,400-byte ceiling. B1 stayed at zero first-load bytes and B3 remained
106,160 bytes in both revisions.

Every candidate cap repetition proved the exact same bounded shape: 128 frames, 32 scopes, 200
variables, depth 4, 1,000 nodes, 200 inline decorations, 1,048,576 adapter-output bytes, one terminal
limit marker, 524,288 retained bytes across 32 rendered/retained rows, and zero residual heap bytes.

| Sequence | stopped projection p75 | output stop p75 | stopped max long task | output max long task |
| -------: | ---------------------: | --------------: | --------------------: | -------------------: |
|        2 |                 139 ms |         82.1 ms |                  0 ms |                 0 ms |
|        3 |               143.7 ms |         78.8 ms |                  0 ms |                 0 ms |
|        6 |               139.5 ms |         79.1 ms |                  0 ms |                 0 ms |

The Linux production static-export evidence was regenerated and immediately rechecked:

```text
npm run build:ui
node scripts/editor-release-evidence.mjs --json
npm run check:editor-release-evidence
```

All release bounds passed: B1 has zero Monaco/editor markers in 14 first-load scripts; B2 is
1,180,213 bytes of 2,621,440 bytes; B3 is a 106,160-byte editor worker of 768,000 bytes. The refreshed
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

The implementation, mutation, Linux D12 comparison, and refreshed bundle evidence are complete.
Remaining delivery conditions are the final `npm run agent:pre-pr` on the documentation/evidence
head and the direct required checks on the exact pushed PR head.
