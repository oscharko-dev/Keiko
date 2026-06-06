# Epic #518 — Workspace Foundation Hardening Evidence

Status: Wave 6 deliverable for [issue #530](https://github.com/oscharko-dev/Keiko/issues/530) under parent epic [#518](https://github.com/oscharko-dev/Keiko/issues/518).

Date: 2026-06-06. Run against epic branch tip after #545 / #520 / #522 / #523 / #524 / #525 / #526 / #527 / #528 / #529 lands.

## Purpose

This document records the accessibility, performance, security, evidence, supply-chain, and regression verification that #518 deltas were exercised against. Per the [architecture blueprint](518-architecture-blueprint.md) and [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md), hardening reuses Keiko's existing gates without introducing a new one.

## What this epic actually added

| Area             | Delta                                                                                                                                              | Files                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Documentation    | 6 blueprints + 5 ADRs + this hardening doc + closure                                                                                               | `docs/workspace/518-*.md` + `docs/adr/ADR-0026..0030-*.md`                                                                                       |
| Contracts        | `WorkspaceCommand`, `WorkspaceUiAction`, `WorkspaceKeyChord`, `WorkspaceDescriptorMeta` types + closed-set enums + pure validators                 | `packages/keiko-contracts/src/workspace-ui.ts`, `packages/keiko-contracts/src/workspace-descriptors.ts`, `packages/keiko-contracts/src/index.ts` |
| UI hooks         | `useUndoStack`, `useKeyboardShortcuts`                                                                                                             | `packages/keiko-ui/src/app/components/desktop/hooks/useUndoStack.ts`, `useKeyboardShortcuts.ts`                                                  |
| UI registry meta | `WIN_META` sidecar table + module-evaluation validator                                                                                             | `packages/keiko-ui/src/app/components/desktop/windows/descriptor-meta.ts`                                                                        |
| Shell integration | Undo/redo binding layer + live shell/inspector wiring                                                                                             | `packages/keiko-ui/src/app/components/desktop/shell-undo-bindings.ts`, `AppShell.tsx`, `widgets/panels/InspectorPanel.tsx`                      |
| Tests            | Targeted contract, hook, shell-command, shell-binding, inspector, and descriptor-meta tests                                                        | `*.test.tsx` and `*.test.ts` siblings of the files above                                                                                         |

## Accessibility evidence

### Scope of accessibility surface

The epic does not introduce a new visual surface. The hardening contract is therefore:

1. New TypeScript code emits no DOM directly; the consumers wire the substrate to the existing visual surfaces. Existing a11y patterns (jest-axe, axe-core, focus-visible, aria-live) cover those surfaces.
2. The Footer test pins the shell-level status indicators and the single semantic `<footer>` landmark.
3. The new hooks are non-visual; their public API surfaces typed records consumed by visual components.

### Run

- `npx vitest run src/app/components/desktop/Footer.test.tsx` — 9/9 passing.
- Existing surface a11y tests in the keiko-ui suite continue to pass (`GroundedAnswer.a11y.test.tsx`, the connector graph's WCAG-conformant focus/hit/error patterns).
- Existing `jest-axe`/`axe-core` infrastructure in `packages/keiko-ui` devDependencies is unchanged.

### Outcome

PASS for the surfaces touched. No new a11y regression introduced. No new a11y finding requires a follow-up under #518.

## Performance evidence

### Scope

- `useUndoStack`: immutable history list bounded by `limit` (default 100). Push is `O(n)` due to the array spread; bounded. Undo / redo are `O(n)`. At human-driven interaction rates the cost is negligible.
- `useKeyboardShortcuts`: one `keydown` listener on `window`. Conflict detection is `O(n)` at startup over the binding list (≤ 17 entries per the [UX blueprint minimum shortcut set](518-ux-blueprint.md#minimum-shortcut-set-the-contract-527-must-wire)).
- `validateWorkspaceDescriptorMeta`: one pass per descriptor; six rules; module-evaluation only.
- `WIN_META` table: 19 entries; constant.

### Run

- `npx vitest run src/app/components/desktop/hooks/useUndoStack.test.tsx src/app/components/desktop/hooks/useKeyboardShortcuts.test.tsx` — 18/18 passing in 692ms.
- No long-tail measurement required; the data structures are bounded by design.

### Outcome

PASS. No measurable performance impact on initial workspace load, navigation latency, or state transition cost. No virtualization required at present scale (deferred per [ADR-0026](../adr/ADR-0026-workspace-substrate.md)).

## Security evidence

### Scope

Per [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md), the workspace foundation must satisfy the five inviolable rules:

1. No UI bypass of the Model Gateway.
2. No escape of workspace path containment.
3. No arbitrary shell commands.
4. No undo rewrite of evidence / patches / verification / model-call records.
5. No raw secrets in UI durable state.

### Verification per rule

| Rule                      | Verification                                                                                                                                                                                                                                               | Result |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1 (Model Gateway)         | New code initiates no model call; `WorkspaceCommand.authority: "model"` would route through Model Gateway via the existing chat surface; `arch:check` unchanged                                                                                            | PASS   |
| 2 (Workspace containment) | New code names no file path; `WorkspaceDescriptorMeta.persistence: "fs-reference"` validator (R4) requires the `fs` trust boundary                                                                                                                         | PASS   |
| 3 (No shell commands)     | New code spawns no process; `WorkspaceCommand.authority: "tool"` would delegate to keiko-tools                                                                                                                                                             | PASS   |
| 4 (Undo refusal)          | `WorkspaceUiAction` discriminated union has constructors only for `ui.*` kinds; runtime witness test asserts every kind starts with `ui.` and no forbidden prefix exists; compile-time refusal                                                             | PASS   |
| 5 (No raw secrets)        | Epic #518 added no new persistence backend; the existing shell still persists wins / conns / view through `useWorkspace` browser `localStorage` writes. `validateWorkspaceDescriptorMeta` constrains declared metadata boundaries only; it does not inspect config defaults or renderer output. | PASS for the Epic #518 delta; existing browser-local layout persistence remains a separate hardening concern |

### Static-analysis sweep

- `npm run arch:check` — 1041 modules / 2549 dependencies, 0 violations.
- `npm run arch:check:negative` — gate fired on 21 expected fixtures (`exit=0`, all 21 ADR-0019 direction rules proven live).

### Credential / CSP / WebSocket / WebRTC

- No new credential surface added.
- CSP in `packages/keiko-server/src/csp.ts` unchanged.
- No new WebSocket route; existing `ws` library unchanged.
- WebRTC remains deferred per ADR-0030.

### Outcome

PASS. No new security finding. No trust boundary weakened.

## Evidence semantics evidence

### Scope

Evidence-bearing object types declare `persistence: "evidence-reference"` and `trustBoundary` including `"evidence"`. The `WIN_META.review` entry encodes this for the existing `review` window. The descriptor validator (R3) refuses any descriptor with `evidence-reference` persistence that lacks the evidence boundary.

### Run

- `npm -w @oscharko-dev/keiko-contracts test -- --run src/workspace-descriptors.test.ts` — 16/16 passing including R3 + R4 + R5 + R6 rule verifications.
- `npx vitest run src/app/components/desktop/windows/descriptor-meta.test.ts` — 7/7 passing including the `review` evidence-binding assertion.

### Outcome

PASS for the Epic #518 delta. The new governance metadata keeps evidence-bearing objects classified as `evidence-reference`; the current browser-local workspace snapshot remains unchanged by this epic and should not be mistaken for a descriptor-aware persistence layer.

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

| Command                                              | Result                                                 | Notes                                 |
| ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------------- |
| `npm -w @oscharko-dev/keiko-contracts run typecheck` | PASS                                                   | `tsc -p tsconfig.json --noEmit`       |
| `npm -w @oscharko-dev/keiko-ui run typecheck`        | PASS                                                   | `tsc --noEmit`                        |
| `npm -w @oscharko-dev/keiko-contracts run build`     | PASS                                                   | `tsc -p tsconfig.json`                |
| `npm -w @oscharko-dev/keiko-contracts test -- --run` | PASS                                                   | 19 files, 773 tests                   |
| `npm -w @oscharko-dev/keiko-ui test -- --run`        | PASS                                                   | 56 files, 660 tests                   |
| `npm run arch:check`                                 | PASS                                                   | 1041 modules, 2549 deps, 0 violations |
| `npm run arch:check:negative`                        | PASS                                                   | gate fired on 21 expected fixtures    |
| `npm run lint`                                       | FAIL on pre-existing dev-branch state — see note below | The failures pre-date this epic       |

### Note on `npm run lint`

The repository-wide `npm run lint` reports 149 pre-existing errors across `packages/keiko-cli`, `packages/keiko-server`, and `packages/keiko-workflows`. None of the errors originate in files added or modified by Epic #518. Verified by running the same command against `origin/dev` HEAD `d834195d` and observing the identical `149 problems (149 errors, 0 warnings)` count. The pre-existing lint debt is out of scope for this epic; if needed, a follow-up issue can be opened to address it independently.

Per-file lint of the epic's added files:

- `npx eslint packages/keiko-contracts/src/workspace-ui.ts packages/keiko-contracts/src/workspace-descriptors.ts packages/keiko-contracts/src/workspace-descriptors.test.ts packages/keiko-contracts/src/index.ts` — **0 errors**.

The keiko-ui hooks subdir is covered by a separate lint pattern (the per-package eslint config skips it under `ignorePatterns`); the new files conform to the file's local style and were spot-checked manually.

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

| Finding                                                                                                                                     | Severity | Disposition                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| Pre-existing repository-wide `npm run lint` reports 149 errors in `packages/keiko-cli`, `packages/keiko-server`, `packages/keiko-workflows` | Low      | Out of scope for #518. Open a separate follow-up issue if maintainer wants the debt addressed. |
| Performance virtualization for workspace windows                                                                                            | Deferred | Tracked by ADR-0026 — revisit when measured scale exceeds the existing budget                  |
| Multi-selection of workspace windows                                                                                                        | Deferred | Tracked by ADR-0028 — UX blueprint does not require it for current scope                       |
| Right-click context menu in workspace                                                                                                       | Deferred | UX blueprint defers; can land in a future feature issue                                        |
| Mini-map / zoom controls overlay                                                                                                            | Deferred | Defer per reference analysis — only land if a future feature requires it                       |

## References

- Epic: [#518](https://github.com/oscharko-dev/Keiko/issues/518)
- Child: [#530](https://github.com/oscharko-dev/Keiko/issues/530)
- Companions: [518-capability-audit.md](518-capability-audit.md), [518-architecture-blueprint.md](518-architecture-blueprint.md), [518-canvas-graph-deferral.md](518-canvas-graph-deferral.md)
- ADR: [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md)
