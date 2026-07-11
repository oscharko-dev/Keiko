# Epic #2092 run-verify-fix loop regression evidence

Closure evidence for Epic #2092 (Built-in editor M4 — run, verify, and problems) and all six child
issues: #2210 (ADR/contracts), #2211 (execution route and SSE), #2212 (run affordances), #2213
(Problems), #2214 (agent access), and #2215 (cross-cutting closeout). This evidence was refreshed by
the 2026-07-11 closeout audit against the complete live issue set and the implementation on
`codex/epic-2092-closeout`.

## Acceptance composition

- The editor exposes **Run Tests for File**, **Run Typecheck**, **Run Lint**, **Run Build**,
  **Cancel Verification**, **Trust Workspace Scripts**, and **Open Problems** through its real command
  palette. Script-backed kinds remain unavailable until the local human grants server-owned trust.
- Human and agent runs share `VerificationRunnerManager`, the bounded in-flight registry,
  `executeVerificationEnforced`, the `keiko-verification` planner/orchestrator, the `keiko-tools`
  spawn boundary, resource limits, fail-closed network policy, lifecycle events, cancellation, and
  terminal evidence.
- A completed report feeds one project-scoped Problems store. Language diagnostics retain producer
  ownership across panes/windows; verification failures and diagnostics use the same Unicode-safe,
  bounded projection. Located rows reveal the exact file/line/column through the existing editor
  navigation seam.
- Agent admission is session- and workspace-bound and follows classify → compose → reserve →
  mandatory content-free admission audit → dispatch. Denied, review-required, budget-exhausted,
  unauditable, malformed, disconnected, and out-of-authority calls do not start execution.
- Every external wire guard is deep and closed: nested reports, counts, overall status, step kind,
  locations, paths, coordinates, text bounds, reason enums, and unknown fields are validated or
  projected. The agent client additionally requires exactly the requested verification kind.

## Security and trust-boundary regressions fixed

The closeout audit found and repaired gaps not covered by the original child implementations:

- package-script trust had no positive production grant path and was not shared consistently with
  the command runner; it is now explicit, canonical-workspace- and manifest-digest-bound,
  process-scoped, revocable, and invalidated by `package.json` changes;
- start/trust/cancel browser mutations omitted the CSRF proof;
- absolute, foreign-drive/UNC, traversal, prefix-collision, NUL, invalid-coordinate, oversized, and
  surrogate-splitting failure projections could leak or invalidate a terminal report;
- async execution and evidence failures could disappear from the fire-and-forget path; terminal
  events are now emitted once, interrupted runs receive content-free evidence, and unexpected
  failures emit a correlation-keyed operator diagnostic;
- agent authority was not bound to the live editor session, admission audit happened after execution,
  disconnect cancellation had a listener race, and malformed kind/target combinations were accepted;
- agent response guards were shallow and could retain unknown nested fields or inconsistent counts;
- run and Problems state could cross project/window boundaries, producer teardown could evict another
  pane's diagnostic, terminal status could mask later status indefinitely, and the Problems command
  was not bound to the originating editor project;
- the previous browser closeout bypassed UI affordances, used a non-runnable fixture, made a vacuous
  jump assertion, and was absent from the required CI path.

The detailed threat assessment is in
[`2092-run-verify-fix-loop-security-review.md`](2092-run-verify-fix-loop-security-review.md).

## Deterministic regression evidence

- Contract and hostile-wire tests cover exact/deep request, event, report, result, Problems snapshot,
  failure-location, and agent-result projections.
- Server tests cover trust grant/revoke/invalidation, shared command/verification trust, route
  registration, catalog/start/cancel/SSE behavior, concurrency, evidence success/failure,
  diagnostics, session-bound authority, pre-run audit failure, review-required/denied no-run,
  disconnect cancellation, and budget exhaustion.
- `agentVerificationBoundary.test.ts` drives both human `execute` and agent `runToReport` through the
  real `runVerification` orchestrator with a controlled final spawn seam. It proves identical plans
  and default limits, a real bubblewrap wrapper/attestation when available, and zero spawn with denied
  results when no enforcing backend is attested.
- UI tests cover catalog/trust gating, CSRF on every mutation, per-project lifecycle state, shared
  ref-counted SSE, coalescing, start/cancel failures, scoped review targets, producer-aware Problems
  retention, bounded messages, filters, focus, keyboard activation, and exact reveal requests.
- `editor-run-verification-2215.spec.ts` drives the actual command palette against the real BFF for
  file-targeted failure → Problems → exact line, workspace typecheck, mid-run cancellation, and a real
  Monaco edit → Save → disk proof → rerun → cleared Problems loop.

## Local quality-gate record

| Gate                                                  | Result                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                   | PASS, including package graph and strict root TypeScript                                                                                    |
| `NODE_OPTIONS=--max-old-space-size=8192 npm run lint` | PASS, zero warnings                                                                                                                         |
| `npm run format:check`                                | PASS                                                                                                                                        |
| `npm test`                                            | PASS — 1,151 files passed, 5 skipped; 19,880 tests passed, 7 skipped                                                                        |
| `npm run arch:check`                                  | PASS — 3,053 modules / 8,543 dependencies, no violations                                                                                    |
| `npm run arch:check:negative`                         | PASS — all 50 hostile fixtures rejected                                                                                                     |
| `npm run test:coverage:quality`                       | PASS — 1,159 package files / 19,970 tests and 310 UI files / 4,912 tests; all package, file, release-target, and branch-ratchet floors held |
| `npm run build`                                       | PASS                                                                                                                                        |
| prepack-equivalent `npm run check:package-surface`    | PASS — 4,753 files, static UI present                                                                                                       |
| `npm run check:error-observability`                   | PASS                                                                                                                                        |
| `npm run check:adr-index`                             | PASS — 121 unique ADRs                                                                                                                      |
| `npm run check:ui-i18n`                               | PASS                                                                                                                                        |
| `npm run check:release-impact`                        | PASS                                                                                                                                        |
| `npm run check:perf-evidence`                         | PASS                                                                                                                                        |
| `npm run check:editor-bundle-size`                    | PASS — 98,300 B / 98,304 B; Monaco 0.55.1                                                                                                   |
| `npm run test:e2e:smoke`                              | PASS — 56/56 Chromium scenarios                                                                                                             |
| `npm run test:e2e:editor-run-verification-2215`       | PASS — 4/4 Chromium scenarios                                                                                                               |
| `npm run test:e2e:editor-perf`                        | PASS — release-evidence scenario 1/1                                                                                                        |

The UI release fingerprint was regenerated and checked locally in a clean `node:22-bookworm-slim`
Linux container because gzip/chunk measurements are platform-specific. Linux produced the committed
fingerprint `ba49c1483866b583330343f2e5c72451928540aa958a5c493c6626e29f5a66a8` and passed B1/B2/B3:
0 first-load editor markers, 1,152.5 KiB lazy editor/Monaco runtime against 2,560 KiB, and 103.7 KiB
largest worker against 750 KiB. A macOS fingerprint was deliberately not committed.

## Closure assessment

All six child-issue acceptance contracts now compose into the epic's perceivable outcome without a
parallel trust, execution, Problems, evidence, or agent subsystem. No architecture, coverage,
performance, release, security, or human-control gate was weakened. The required CI workflow now
runs the dedicated closeout E2E in both the required `ui` job and the extended browser matrix.
