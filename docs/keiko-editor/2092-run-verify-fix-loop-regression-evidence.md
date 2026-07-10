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
