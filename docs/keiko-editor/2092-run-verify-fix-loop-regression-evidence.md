# Epic #2092 run-verify-fix loop regression evidence

Closure evidence for Epic #2092 (Built-in editor M4 — run, verify, and problems) and its five child
issues #2210 (ADR-0126 + contracts), #2211 (verification route + SSE stream), #2212 (run affordances

- status bar), #2213 (problems panel), and #2214 (agent verification access). This document records
  the aggregate local gate results and the end-to-end evidence for the edit → run → verify → fix loop.

## Maintained policy

The human-control invariant is unchanged. A verification run is agent-triggerable but non-mutating;
it is classified under the new `"execution"` effect class (ADR-0126, #2210) and gated by the
Authority Envelope before any sandboxed spawn starts. Every run — human- or agent-triggered — reaches
the workspace through the single governed `keiko-tools` spawn boundary
(`executeVerificationEnforced`, `enforce-or-fail-closed`); there is no separate agent execution
engine. Evidence stays redacted: lifecycle SSE events are content-free (status + duration only), and
the agent's tool result is a redacted `RedactedVerificationReport` (kind, overall status, per-step
counts, structured failure locations) that cannot carry raw `outputSummary`, argv, or command.

## End-to-end evidence

- Full-loop Playwright spec `tests/e2e/editor-run-verification-2215.spec.ts`
  (config `tests/e2e/config/playwright.issue-2215-editor-run-verification.config.ts`, script
  `test:e2e:editor-run-verification-2215`) drives, against the real BFF: a file-targeted
  (`targeted-test`) run to a terminal SSE state; the problems panel surfacing the failure with a
  file/line location; jump-to-line via the existing reveal flow; a workspace-scoped (`typecheck`)
  run; a cancel-mid-run; and a fix → rerun that returns to a passing terminal state. Chromium is the
  reference browser; the Studio browser gate on CI is authoritative for its execution.
- Route + governance integration: `packages/keiko-server/src/editor/verificationRoutes.test.ts`
  (human route, SSE framing, backpressure) and
  `packages/keiko-server/src/editor/agentVerificationRoute.test.ts` (agent route: stricter-of-two
  composition, denied → no-run call-count assertion, content-free audit, redacted report) — all green.
- Single-boundary + honest fail-closed proof for the agent path:
  `packages/keiko-server/src/editor/agentVerificationBoundary.test.ts` (4 tests) proves the agent
  `runToReport` and the human `execute` route through the same injected execution port, an agent run
  is confined to the requested `VerificationKind`, and a `denied` (fail-closed) run is surfaced
  honestly rather than upgraded to passed.

## Coverage verification

Coverage floors in `docs/qa/package-coverage-baseline.json` are held, not lowered, for every package
this epic touched (`keiko-contracts`, `keiko-server`, `keiko-verification`, `keiko-tools`,
`keiko-editor`, `keiko-ui`). Every new module ships co-located tests; no `fileFloors` entry was
reduced. `npm run test:coverage:quality` is the authoritative gate and runs on CI.

## Agent verification access disposition

Issue #2214 delivered `editor_request_verification` as the sixth `EditorAgentToolHost` tool. Its
request is classified via `classifyEditorAgentAction("requestVerification", …)` and composed against
the resolved Authority Envelope via `composeEditorAgentActionPolicyDecision`, resolved and reserved
through `editorAgentAuthorityRegistry`, and audited via the existing `recordEditorAgentActionAudit`
ledger — the same classify → compose → reserve → audit sequence every other agent action uses. The
`"execution"` effect class maps non-`null` in both `EDITOR_AGENT_WORKBENCH_ACTION_CLASS`
(`verification`) and `EDITOR_AGENT_WORKBENCH_RESOURCE_SCOPE` (`workspace-contained`), so a
verification request is always envelope-gated; the composed disposition can only be as-or-more
restrictive than either layer alone. The audit ledger records execution-class actions when admitted
(not only when denied) so an allowed run stays visible, with `mutating: false` preserved.

## Editor release evidence

`npm run check:editor-release-evidence` regenerates the bundle-evidence fingerprint. Because the
epic changed `keiko-ui` (#2212, #2213) the committed fingerprint is refreshed on Linux/CI, which is
authoritative per repository policy. A macOS-generated fingerprint differs by platform and is **not**
committed as the authoritative value.

## Editor performance evidence

`npm run check:perf-evidence` records the B1–B11 budgets on CI. The new run/problems UI is
lazy-loaded behind the existing editor split (B1: no Monaco/editor bytes in first-load JS holds); the
problems panel uses the bounded `buildEditorProblemsSnapshot` caps (per-file and total) so B11
(Monaco worker/model memory) does not regress. Linux/CI values are authoritative.

## Final local gates

| Gate                    | Command                                                   | Result                                                                             |
| ----------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Typecheck               | `npm run typecheck`                                       | PASS                                                                               |
| Typecheck (keiko-ui)    | `npm run typecheck --workspace @oscharko-dev/keiko-ui`    | PASS                                                                               |
| Lint                    | `npm run lint` (`NODE_OPTIONS=--max-old-space-size=8192`) | PASS (0 warnings)                                                                  |
| Format                  | `npm run format:check`                                    | PASS                                                                               |
| Unit/integration        | `npm test`                                                | PASS (full root suite green)                                                       |
| Architecture            | `npm run arch:check`                                      | PASS                                                                               |
| Architecture (negative) | `npm run arch:check:negative`                             | PASS                                                                               |
| Package surface         | `npm run build && npm run check:package-surface`          | macOS-only `@napi-rs/canvas-darwin-arm64` tarball artifact; Linux/CI authoritative |
| Release evidence        | `npm run check:editor-release-evidence`                   | macOS fingerprint differs by platform; Linux/CI authoritative                      |

Package-surface and release-evidence report platform-specific macOS artifacts (a native canvas
optional dependency in the local tarball, and a platform-specific bundle fingerprint), not defects
introduced by this epic. Both are regenerated and validated on Linux/CI, which is authoritative.

## Closure assessment

The five child issues compose into the epic's stated perceivable improvement: run tests from the
editor and watch results stream in; open the problems panel and see every error in the workspace;
click a problem and land on the exact line; the status bar reflects run state; and a docked agent can
request the same kind of run, policy-classified and audit-visible, with no broader command surface
than the human UI. Every trust boundary is verified by a passing test (see
`2092-run-verify-fix-loop-security-review.md`). No gate was weakened.

## Post-acceptance audit (2026-07-10)

A follow-up audit against `dev` (after merge) fanned out one agent per child issue plus one
epic-level pass, then adversarially re-verified every flagged defect. 29 defects were confirmed (2
critical, 11 major, 16 minor). All were fixed in a follow-up change on this branch, with regression
tests proving each fix:

- **#2210** — `EditorVerificationTrustState` duplicated `CommandTaskTrustState` instead of reusing
  it; now a type alias. Added test coverage for `isEditorVerificationCatalog` and the
  `requestVerification` exhaustiveness fixtures.
- **#2211** — the verification runner wrote no audit-evidence entry per run (evidence store was never
  wired); now every finished run persists a content-free `editor-verification-run` evidence manifest,
  mirroring `command-runner-evidence.ts`, with a fail-closed `EVIDENCE_WRITE_FAILED` path when it
  cannot be written. Also fixed: `requestId` was parsed but never echoed on `run-started`; no test
  proved the concurrency cap actually rejects an over-limit run; `clamp()`'s non-positive-line guard
  didn't match its own doc comment.
- **#2212** — the diff-review "Run Verification" button resolved its target from the pane's active
  file instead of the reviewed change, risking silently verifying the wrong file for a multi-file
  agent changeset or rename review; now each review surface resolves its OWN reviewed file(s). The
  status-bar verification label never cleared, permanently masking test-generation status after the
  first run; it now auto-dismisses after a delay, cancelled by a fresh run. Added dispatch-proof tests
  for the two previously-untested "Run Verification" call sites and a type-only `EditorHostPort` test.
- **#2213** — switching the active tab evicted the PREVIOUS tab's Problems-panel diagnostics even
  though the file remained open; eviction now only fires when a file actually leaves the open-tabs
  list (or the pane unmounts). Removed a dead, never-implemented `problems.errored` i18n key. Fixed
  the axe test that claimed to cover a "focused" state but never moved keyboard focus. Added a
  dedicated `onDiagnostics` callback test.
- **#2214/#2215** — an agent-triggered run shared the same concurrency accounting as a human run but
  emitted no lifecycle events, so it was invisible to the status bar/problems panel and effectively
  uncancellable (a human had no way to learn its `runId`); `runToReport` now emits the identical
  lifecycle events `execute` does, making the run visible and cancellable through the existing
  `DELETE /runs/:runId` endpoint. The full-loop Playwright spec drove every scenario via direct
  `page.request.post(...)` calls instead of the command-palette run affordance, and its "jump to
  line" assertion never checked the actual landed line — both rewritten to drive through the real UI
  (Issue #2212's command palette) and assert the post-click status-bar cursor position, mirroring
  `editor-baseline-1377.spec.ts`'s F12 verification pattern. Added a from-scratch regression test for
  the single governed spawn boundary (`executeVerificationEnforced`/`probeNetworkIsolation`) with no
  injected execution port — previously every test in this area faked the execution port, so a
  regression hardcoding `enforcedNetworkAvailable: true` would have gone undetected.
- **Epic-level** — `buildVerificationSummary` never copied `VerificationResult.locations` despite
  ADR-0126 D3 stating the summary projection carries it; fixed with a test. The verification-run
  status store and the problems-aggregation store were unscoped, process-wide singletons even though
  the desktop shell supports multiple simultaneously mounted editor windows bound to different
  project roots — a run or diagnostic from one project could appear in another's UI, and two projects
  sharing a relative path could silently overwrite each other's diagnostics. Both stores are now
  scoped per project root; `EditorVerificationRun`/`EditorVerificationRunStartedEvent` gained a
  required `projectId` field (ADR-0126 D1 updated) so an agent-triggered run — which has no
  client-side call to correlate against — can still be attributed to its project.

Not fixed, by design: `EDITOR_COMMANDS`/`isCommandAvailable` remaining unconsumed by `keiko-ui` is
explicitly out of scope per issue #2212's own text (a documented follow-up, not a regression). Two
process-only findings (a security-review document attributing a source fix to the wrong child issue;
epic/issue tracking state not reflecting the merged evidence) are noted but not code defects.

Residual risk: `docs/release/1209-perf-evidence.json` and the full `test:coverage:quality` /
`check:perf-evidence` CI Studio gates were not regenerated locally for this audit pass (perf evidence
requires the browser performance suites, which — per this repository's own convention — run only in
CI; see the Editor performance evidence section above). This mirrors the original implementing
session's own disclosed limitation and remains a residual risk until CI regenerates it.
