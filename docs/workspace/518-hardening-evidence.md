# Epic #518 — Workspace Foundation Hardening Evidence

Status: Wave 6 deliverable for [issue #530](https://github.com/oscharko-dev/Keiko/issues/530) under parent epic [#518](https://github.com/oscharko-dev/Keiko/issues/518), refreshed against current `origin/dev`.

Date: 2026-06-06. Verified on `origin/dev` at `99fda2b3` after epic merge [#563](https://github.com/oscharko-dev/Keiko/pull/563) and follow-up PRs [#565](https://github.com/oscharko-dev/Keiko/pull/565), [#597](https://github.com/oscharko-dev/Keiko/pull/597), [#598](https://github.com/oscharko-dev/Keiko/pull/598), and [#599](https://github.com/oscharko-dev/Keiko/pull/599).

## Purpose

This document records the accessibility, performance, security, evidence, supply-chain, and regression verification that #518 deltas were exercised against. Per the [architecture blueprint](518-architecture-blueprint.md) and [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md), hardening reuses Keiko's existing gates without introducing a new one.

## What this epic actually added

| Area              | Delta                                                                                                                              | Files                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Documentation     | 6 blueprints + 5 ADRs + this hardening doc + closure                                                                               | `docs/workspace/518-*.md` + `docs/adr/ADR-0026..0030-*.md`                                                                                       |
| Contracts         | `WorkspaceCommand`, `WorkspaceUiAction`, `WorkspaceKeyChord`, `WorkspaceDescriptorMeta` types + closed-set enums + pure validators | `packages/keiko-contracts/src/workspace-ui.ts`, `packages/keiko-contracts/src/workspace-descriptors.ts`, `packages/keiko-contracts/src/index.ts` |
| UI hooks          | `useUndoStack`, `useKeyboardShortcuts`                                                                                             | `packages/keiko-ui/src/app/components/desktop/hooks/useUndoStack.ts`, `useKeyboardShortcuts.ts`                                                  |
| UI registry meta  | `WIN_META` sidecar table + module-evaluation validator                                                                             | `packages/keiko-ui/src/app/components/desktop/windows/descriptor-meta.ts`                                                                        |
| Shell integration | Undo/redo binding layer + live shell/inspector wiring                                                                              | `packages/keiko-ui/src/app/components/desktop/shell-undo-bindings.ts`, `AppShell.tsx`, `widgets/panels/InspectorPanel.tsx`                       |
| Tests             | Targeted contract, hook, shell-command, shell-binding, inspector, and descriptor-meta tests                                        | `*.test.tsx` and `*.test.ts` siblings of the files above                                                                                         |

## Accessibility evidence

### Scope of accessibility surface

The epic does not introduce a new visual surface. The hardening contract is therefore:

1. The epic's TypeScript contracts and hooks remain mostly non-visual; the meaningful accessibility evidence comes from the existing shell surfaces that consume them.
2. Post-merge follow-up [#597](https://github.com/oscharko-dev/Keiko/pull/597) widened shell coverage beyond the original footer-only check, especially around shell landmarks, labels, and command surfaces.
3. Existing `jest-axe` / `axe-core` infrastructure in `packages/keiko-ui` remains available, but the commands below are targeted regression checks rather than a full workspace accessibility audit.

### Run

- `npx vitest run src/app/components/desktop/Footer.test.tsx src/app/components/desktop/AppShell.commands.test.ts src/app/components/desktop/LeftRail.test.tsx src/app/components/desktop/RightRail.test.tsx src/app/components/desktop/Workspace.test.tsx src/app/components/desktop/widgets/panels/ProjectPanel.test.tsx` (run from `packages/keiko-ui`) — 6 files, 32 tests passing.
- `npx vitest run src/app/components/desktop/WorkspaceShell.a11y.test.tsx src/app/components/desktop/modals/GatewaySetupDialog.test.tsx` (run from `packages/keiko-ui`) — 2 files, 8 tests passing, including shell `jest-axe` coverage and dialog focus restoration.
- `npm -w @oscharko-dev/keiko-ui test -- --run` — package suite passes with 67 files, 773 tests passing, 3 skipped.

### Outcome

PASS for the shell and workspace surfaces exercised above. This is evidence of regression resistance for the touched surfaces, not a blanket accessibility certification for the full product.

## Performance evidence

### Scope

- `useUndoStack`: immutable history list bounded by `limit` (default 100). Push is `O(n)` due to the array spread; bounded. Undo / redo are `O(n)`.
- `useKeyboardShortcuts`: one `keydown` listener on `window`. Conflict detection is `O(n)` at startup over the binding list (≤ 17 entries per the [UX blueprint minimum shortcut set](518-ux-blueprint.md#minimum-shortcut-set-the-contract-527-must-wire)).
- `validateWorkspaceDescriptorMeta`: one pass per descriptor; six rules; module-evaluation only.
- `workspace-persistence` (#598): linear sanitization over the persisted window / connection lists before browser-local write or restore.
- `WIN_META` table: 19 entries; constant.

### Run

- `npx vitest run src/app/components/desktop/hooks/useUndoStack.test.tsx src/app/components/desktop/hooks/useKeyboardShortcuts.test.tsx src/app/components/desktop/AppShell.commands.test.ts src/app/components/desktop/shell-undo-bindings.test.ts` (run from `packages/keiko-ui`) — 4 files, 36 tests passing.
- `npx vitest run src/app/components/desktop/windows/descriptor-meta.test.ts src/app/components/desktop/widgets/panels/InspectorPanel.test.tsx src/app/components/desktop/hooks/workspace-persistence.test.ts` (run from `packages/keiko-ui`) — 3 files, 20 tests passing.
- No dedicated microbenchmark or browser-profile run was performed for this refresh.

### Outcome

No regression signal was found in the bounded data structures or the targeted suite above. This document does not claim measured latency or throughput improvements; virtualization remains deferred per [ADR-0026](../adr/ADR-0026-workspace-substrate.md) until scale warrants profiling.

## Security evidence

### Scope

Per [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md), the workspace foundation must satisfy the five inviolable rules:

1. No UI bypass of the Model Gateway.
2. No escape of workspace path containment.
3. No arbitrary shell commands.
4. No undo rewrite of evidence / patches / verification / model-call records.
5. No raw secrets in UI durable state.

### Verification per rule

| Rule                      | Verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Result  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| 1 (Model Gateway)         | New code initiates no model call; `WorkspaceCommand.authority: "model"` still routes through the existing Model Gateway path. `npm run arch:check` remains green on current `origin/dev`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | PASS    |
| 2 (Workspace containment) | New code names no file path. `WorkspaceDescriptorMeta.persistence: "fs-reference"` still requires the `fs` trust boundary, and current descriptor tests continue to enforce that rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | PASS    |
| 3 (No shell commands)     | New code spawns no process directly. `WorkspaceCommand.authority: "tool"` still describes delegation rather than ad hoc shell execution, and the shell wiring remains covered by targeted tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | PASS    |
| 4 (Undo refusal)          | `WorkspaceUiAction` still exposes only `ui.*` kinds; the runtime witness tests continue to assert that forbidden prefixes are excluded from the reversible action set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | PASS    |
| 5 (No raw secrets)        | Follow-up [#598](https://github.com/oscharko-dev/Keiko/pull/598) materially tightened the browser-local workspace snapshot: transient windows are dropped, `evidence-reference` windows persist only declared reference fields, and `durable.config` payloads are stripped before browser-local write or restore. That narrows the exposed browser snapshot seam. It does **not** prove that every secret-bearing durable-state path in the wider product is impossible, because this validator-driven sanitization is scoped to `useWorkspace` persistence rather than every durable config source. Follow-up issue [#600](https://github.com/oscharko-dev/Keiko/issues/600) now tracks the remaining browser-local secret-shape hardening gap. | PARTIAL |

### Static-analysis sweep

- `npm run arch:check` — 1070 modules / 2620 dependencies cruised, 0 violations.
- `npm run arch:check:negative` — gate fired on 23 expected fixtures (`exit=0`, all 23 negative fixtures proven live).

### Credential / CSP / WebSocket / WebRTC

- No new credential surface added.
- CSP in `packages/keiko-server/src/csp.ts` unchanged.
- No new WebSocket route; existing `ws` library unchanged.
- WebRTC remains deferred per ADR-0030.

### Outcome

Rules 1-4 remain green on current `origin/dev`. Rule 5 is better defended than the original epic merge state because [#598](https://github.com/oscharko-dev/Keiko/pull/598) sanitizes the browser-local workspace snapshot, but this refresh does not close the broader durable-state secret-hardening question for every persisted UI/config seam. Follow-up issue [#600](https://github.com/oscharko-dev/Keiko/issues/600) remains open for that residual browser-local risk.

## Evidence semantics evidence

### Scope

Evidence-bearing object types declare `persistence: "evidence-reference"` and `trustBoundary` including `"evidence"`. The `WIN_META.review` entry encodes this for the existing `review` window. The descriptor validator (R3) refuses any descriptor with `evidence-reference` persistence that lacks the evidence boundary, and [#598](https://github.com/oscharko-dev/Keiko/pull/598) now strips non-declared payload keys from the browser-local workspace snapshot before persistence.

### Run

- `npm -w @oscharko-dev/keiko-contracts test -- --run src/workspace-descriptors.test.ts` — 1 file, 16 tests passing including R3 + R4 + R5 + R6 rule verifications.
- `npx vitest run src/app/components/desktop/windows/descriptor-meta.test.ts src/app/components/desktop/widgets/panels/InspectorPanel.test.tsx src/app/components/desktop/hooks/workspace-persistence.test.ts` (run from `packages/keiko-ui`) — 3 files, 20 tests passing, including the `review` evidence-binding assertion and the browser-local persistence sanitization checks.

### Outcome

PASS for the current `origin/dev` state. Evidence-bearing objects remain classified as `evidence-reference`, and the browser-local workspace snapshot is now partially descriptor-aware for persistence sanitization. That still should not be mistaken for a universal secret-redaction or durable-state proof beyond the `useWorkspace` seam.

## Supply-chain evidence

### Runtime dependency audit

| Manifest                                | Runtime deps                                                      | Change in this epic |
| --------------------------------------- | ----------------------------------------------------------------- | ------------------- |
| `packages/keiko-contracts/package.json` | 0                                                                 | none                |
| `packages/keiko-ui/package.json`        | 4 (`@oscharko-dev/keiko-contracts`, `next`, `react`, `react-dom`) | none                |
| Root `package.json`                     | 20 internal `@oscharko-dev/keiko-*` packages plus `ws`            | none                |

### Lockfile audit

`package-lock.json` is unchanged by this epic. Any local drift observed during development was reverted before commit.

### Bundle audit

The root `bundleDependencies` array (per [ADR-0021](../adr/ADR-0021-publish-strategy-bundled-monorepo-product.md)) is unchanged by this epic. No new internal package was created.

### Outcome

PASS. No new runtime, devtime, or vendored code dependency introduced. No `bundleDependencies` entry added or removed.

## Regression verification — local command list

| Command                                              | Result | Notes                                  |
| ---------------------------------------------------- | ------ | -------------------------------------- |
| `npm -w @oscharko-dev/keiko-contracts run typecheck` | PASS   | `tsc -b tsconfig.json --noEmit`        |
| `npm -w @oscharko-dev/keiko-ui run typecheck`        | PASS   | `tsc --noEmit`                         |
| `npm -w @oscharko-dev/keiko-contracts run build`     | PASS   | `tsc -b tsconfig.json`                 |
| `npm -w @oscharko-dev/keiko-contracts test -- --run` | PASS   | 21 files, 869 tests                    |
| `npm -w @oscharko-dev/keiko-ui test -- --run`        | PASS   | 67 files, 773 tests passing, 3 skipped |
| `npm run arch:check`                                 | PASS   | 1070 modules, 2620 deps, 0 violations  |
| `npm run arch:check:negative`                        | PASS   | gate fired on 23 expected fixtures     |
| `npm run lint`                                       | PASS   | repository-wide eslint now green       |

## Required CI gates

The final epic PR to `dev` was [#563](https://github.com/oscharko-dev/Keiko/pull/563). That merge ran the repository's required `dev` checks:

| Required check                      | Notes                                                  |
| ----------------------------------- | ------------------------------------------------------ |
| `ci`                                | Includes lint + typecheck + tests + arch:check + build |
| `actionlint`                        | No workflow change                                     |
| `Verify pinned action SHAs`         | No workflow change                                     |
| `Analyze (actions)`                 | No workflow change                                     |
| `Analyze (javascript-typescript)`   | New code is plain TypeScript; no `<script>` regex      |
| `Build, scan, SBOM, smoke`          | No new dependency; no SBOM delta                       |
| `Review dependency diff (dev/main)` | No dependency added/removed                            |
| `ui`                                | Includes UI test suite                                 |

CI runs only on PRs targeting `dev`, so child PRs into the epic branch did not run them. The final epic PR opened by #531 is the gate.

## Findings + follow-ups

| Finding                                                                                                                                                                         | Severity | Disposition                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser-local workspace persistence is now sanitized per descriptor metadata, but end-to-end durable-state secret hardening is not fully proven outside the `useWorkspace` seam | Medium   | Do not mark fixed. Follow-up issue [#600](https://github.com/oscharko-dev/Keiko/issues/600) tracks the remaining browser-local hardening work. |
| Performance virtualization for workspace windows                                                                                                                                | Deferred | Tracked by ADR-0026 — revisit when measured scale exceeds the existing budget                                                                  |
| Multi-selection of workspace windows                                                                                                                                            | Deferred | Tracked by ADR-0028 — UX blueprint does not require it for current scope                                                                       |
| Right-click context menu in workspace                                                                                                                                           | Deferred | UX blueprint defers; can land in a future feature issue                                                                                        |
| Mini-map / zoom controls overlay                                                                                                                                                | Deferred | Defer per reference analysis — only land if a future feature requires it                                                                       |

## References

- Epic: [#518](https://github.com/oscharko-dev/Keiko/issues/518)
- Child: [#530](https://github.com/oscharko-dev/Keiko/issues/530)
- Companions: [518-capability-audit.md](518-capability-audit.md), [518-architecture-blueprint.md](518-architecture-blueprint.md), [518-canvas-graph-deferral.md](518-canvas-graph-deferral.md)
- ADR: [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md)
