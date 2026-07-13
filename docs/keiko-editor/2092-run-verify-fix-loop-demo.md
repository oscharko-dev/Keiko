# Epic #2092 run-verify-fix loop demo

A short, reproducible walkthrough of the perceivable improvement Epic #2092 ships: run and verify
without leaving the editor, a workspace problems panel, and jump-to-failure navigation — for both a
human-triggered and an agent-triggered run.

## Preparation

1. `npm install`
2. `npm run dev:start` (Node BFF + Next.js UI on `http://127.0.0.1:1983`)
3. Open a project whose `package.json` exposes `test`/`typecheck`/`lint`/`build` scripts. From the
   command palette, run **Trust Workspace Scripts**. This explicit local-human action creates a
   server-owned, manifest-digest-bound grant; changing `package.json` invalidates it. The synthetic
   `targeted-test` kind is exempt.
4. Open a source file and its failing test in the editor.

## Run tests and watch results stream in

1. Trigger a run from the editor run affordance (command palette: **Run Tests for File**, **Run
   Typecheck**, **Run Lint**, or **Run Build**).
2. The status bar shows the live verification state; content-free lifecycle events
   (`run-started` → `step-started` → `step-completed` → terminal) stream over
   `GET /api/editor/verification/events`. A step event carries only kind, status, and duration —
   never raw output.
3. On `run-completed`, the redacted `VerificationReport` populates the problems store.

## See every error in the workspace, and jump to the exact line

1. Run **Open Problems** from the command palette. It aggregates open-file language diagnostics and
   the latest run's
   failures into one bounded, filterable, keyboard-navigable list (severity + source filters).
2. Each row shows the message and a `file:line` location. Click a located row (or press Enter) to
   reveal the exact line/column in the editor through the existing `openEditorFile` flow.

## Fix and rerun

1. Edit the source to fix the failure and save.
2. Rerun. The problem clears from the panel and the status bar returns to idle/passing.

## A docked agent requests the same kind of run

1. A docked agent (M3) calls the `editor_request_verification` tool with `{ sessionId, kind,
targetPath? }`. The tool attaches its validated `authorityRef` and calls the governed
   `POST /api/editor/verification/agent-runs` route.
2. The route classifies the request under the `"execution"` effect class, composes it against the
   Authority Envelope (stricter-of-two), reserves one tool-call of budget, appends a mandatory
   content-free admission record, and — only if all four stages succeed — runs through the same
   `keiko-verification` execution path as the human affordance. The returned report is deeply
   projected to its closed redacted shape before it can reach the model. The admission remains
   filterable by the `requestVerification` action type in the agent-actions audit panel; terminal
   execution evidence is recorded separately.

## Automated reproduction

- End-to-end (real BFF, chromium): `npm run test:e2e:editor-run-verification-2215` — file-targeted
  run → terminal SSE → problems panel + jump-to-line → workspace-scoped run → cancel-mid-run →
  fix → rerun. (The Studio browser gate on CI is authoritative for execution.)
- Governance + redaction (hermetic):
  `npx vitest run packages/keiko-server/src/editor/agentVerificationRoute.test.ts`
- Single governed boundary + honest fail-closed (hermetic):
  `npx vitest run packages/keiko-server/src/editor/agentVerificationBoundary.test.ts`
- Tool + client + schema (hermetic):
  `npx vitest run packages/keiko-tools/src/editor-agent-tool-host.test.ts packages/keiko-tools/src/editor-agent-client.test.ts packages/keiko-tools/src/editor-agent-schemas.test.ts`
