# Epic #518 — Closure Evidence

Status: Wave 7 deliverable for [issue #531](https://github.com/oscharko-dev/Keiko/issues/531) under parent epic [#518](https://github.com/oscharko-dev/Keiko/issues/518).

Date: 2026-06-06.

## Outcome

The governed Keiko workspace foundation has landed on `dev`. The child issues under Epic #518 first landed on the long-lived epic branch `claude/epic-518-governed-workspace-foundation`, and that branch was then merged into `dev` through [#563](https://github.com/oscharko-dev/Keiko/pull/563) (merge commit `f23b3e66`).

Current closure evidence should be read against present `origin/dev`, not the original merge snapshot alone. PR [#565](https://github.com/oscharko-dev/Keiko/pull/565) wired the interaction substrate and object metadata into the live `AppShell` on the epic branch immediately before the epic merged, so its changes are part of the epic's `dev` commit `f23b3e66` rather than a separate post-merge change. The current baseline additionally includes the direct post-merge follow-up PRs [#597](https://github.com/oscharko-dev/Keiko/pull/597), [#598](https://github.com/oscharko-dev/Keiko/pull/598), and [#599](https://github.com/oscharko-dev/Keiko/pull/599), which tightened the shell audit coverage, browser-local persistence boundaries, and `#529` deferral narrative after the epic merged.

This delivery follows the epic's required implementation order:

> `#545` → `#520` → `#522` → `#523` + `#524` → `#525` → `#526` → `#527` → `#528` → `#529` (deferred) → `#530` → `#531`

The two preconditions for the explicit `#529` deferral path were both satisfied:

- The [capability audit](518-capability-audit.md) (`#545`) confirmed that Keiko already implements the workspace editor (`useWorkspace`), DOM renderer (`Workspace.tsx`), camera (`View`), connections (`ConnectionsLayer`), and capsule graph (`connector-graph.tsx`).
- The [architecture blueprint](518-architecture-blueprint.md) and [ADR-0026](../adr/ADR-0026-workspace-substrate.md) (`#525`) locked the existing surfaces as the substrate and rejected an independent canvas / graph build.

The implementation deltas Wave 4 added remain bounded to typed contracts, two UI hooks, a sidecar descriptor metadata table, and the test files that pin them. The post-merge follow-ups above hardened those same seams; they still did not add a new package, a new runtime dependency, or a new persistence store.

## Child issue matrix

| Issue  | Title                                            | PR                                                                                                             | Branch                                                         | Status                                                                                                                                                                                                                                                                                                                                                                                                 | Verification                                                                                                                             |
| ------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `#545` | Existing Keiko capability audit                  | [#550](https://github.com/oscharko-dev/Keiko/pull/550)                                                         | `claude/issue-545-capability-audit`                            | Merged to `dev` through epic PR [#563](https://github.com/oscharko-dev/Keiko/pull/563)                                                                                                                                                                                                                                                                                                                 | Markdown only                                                                                                                            |
| `#520` | OSS reference architecture analysis              | [#551](https://github.com/oscharko-dev/Keiko/pull/551), [#587](https://github.com/oscharko-dev/Keiko/pull/587) | `claude/issue-520-reference-analysis`, `codex/issue-520-audit` | Merged to `dev` through epic PR [#563](https://github.com/oscharko-dev/Keiko/pull/563); acceptance evidence tightened directly on `dev` by [#587](https://github.com/oscharko-dev/Keiko/pull/587)                                                                                                                                                                                                      | Markdown links checked; docs-only security and supply-chain review; Qodana/static analysis not applicable                                |
| `#522` | Product boundaries, taxonomy, journeys           | [#552](https://github.com/oscharko-dev/Keiko/pull/552)                                                         | `claude/issue-522-product-boundaries`                          | Merged to `dev` through epic PR [#563](https://github.com/oscharko-dev/Keiko/pull/563)                                                                                                                                                                                                                                                                                                                 | Markdown only                                                                                                                            |
| `#523` | UX blueprint and interaction contract            | [#553](https://github.com/oscharko-dev/Keiko/pull/553)                                                         | `claude/issue-523-ux-blueprint`                                | Merged to `dev` through epic PR [#563](https://github.com/oscharko-dev/Keiko/pull/563)                                                                                                                                                                                                                                                                                                                 | Markdown only                                                                                                                            |
| `#524` | UI blueprint and visual composition              | [#554](https://github.com/oscharko-dev/Keiko/pull/554)                                                         | `claude/issue-524-ui-blueprint`                                | Merged to `dev` through epic PR [#563](https://github.com/oscharko-dev/Keiko/pull/563)                                                                                                                                                                                                                                                                                                                 | Markdown only                                                                                                                            |
| `#525` | Architecture blueprint + ADRs 0026–0030          | [#555](https://github.com/oscharko-dev/Keiko/pull/555)                                                         | `claude/issue-525-architecture-blueprint`                      | Merged to `dev` through epic PR [#563](https://github.com/oscharko-dev/Keiko/pull/563)                                                                                                                                                                                                                                                                                                                 | Markdown only                                                                                                                            |
| `#526` | Workspace shell contract test + runbook          | [#556](https://github.com/oscharko-dev/Keiko/pull/556)                                                         | `claude/issue-526-workspace-shell`                             | Merged to `dev` through epic PR [#563](https://github.com/oscharko-dev/Keiko/pull/563); shell audit gaps later closed by [#597](https://github.com/oscharko-dev/Keiko/pull/597)                                                                                                                                                                                                                        | Current shell slice passes: 6 files, 32 tests (`Footer`, `AppShell.commands`, rails, `Workspace`, `ProjectPanel`)                        |
| `#527` | Interaction substrate (commands, undo, keyboard) | [#557](https://github.com/oscharko-dev/Keiko/pull/557)                                                         | `claude/issue-527-interaction-substrate`                       | Merged to `dev` through epic PR [#563](https://github.com/oscharko-dev/Keiko/pull/563); later integrated by [#565](https://github.com/oscharko-dev/Keiko/pull/565) and broadened by [#597](https://github.com/oscharko-dev/Keiko/pull/597)                                                                                                                                                             | Current interaction slice passes: 4 files, 42 tests (`useUndoStack`, `useKeyboardShortcuts`, `AppShell.commands`, `shell-undo-bindings`) |
| `#528` | Object registry meta + validator                 | [#559](https://github.com/oscharko-dev/Keiko/pull/559)                                                         | `claude/issue-528-object-registry`                             | Merged to `dev` through epic PR [#563](https://github.com/oscharko-dev/Keiko/pull/563); later integrated by [#565](https://github.com/oscharko-dev/Keiko/pull/565), hardened for descriptor-aware browser-local persistence by [#598](https://github.com/oscharko-dev/Keiko/pull/598), and hardened for secret-shaped browser-local config by [#600](https://github.com/oscharko-dev/Keiko/issues/600) | Descriptor + persistence slice passes: 1 contracts file / 16 tests plus 3 UI files / 23 tests                                            |
| `#529` | Canvas / graph substrate (deferred)              | [#560](https://github.com/oscharko-dev/Keiko/pull/560)                                                         | `claude/issue-529-canvas-deferral`                             | Merged to `dev` through epic PR [#563](https://github.com/oscharko-dev/Keiko/pull/563); deferral evidence in `518-canvas-graph-deferral.md`                                                                                                                                                                                                                                                            | No code change                                                                                                                           |
| `#530` | Hardening evidence                               | [#561](https://github.com/oscharko-dev/Keiko/pull/561)                                                         | `claude/issue-530-hardening`                                   | Merged to `dev` through epic PR [#563](https://github.com/oscharko-dev/Keiko/pull/563); refreshed on current `dev` to reflect [#565](https://github.com/oscharko-dev/Keiko/pull/565), [#597](https://github.com/oscharko-dev/Keiko/pull/597), [#598](https://github.com/oscharko-dev/Keiko/pull/598), and [#599](https://github.com/oscharko-dev/Keiko/pull/599)                                       | Verification suite and risk narrative updated in `518-hardening-evidence.md`                                                             |
| `#531` | Closure evidence + final epic PR                 | [#562](https://github.com/oscharko-dev/Keiko/pull/562)                                                         | `claude/issue-531-closure`                                     | Merged to `dev` through epic PR [#563](https://github.com/oscharko-dev/Keiko/pull/563); issue open pending human-controlled closure                                                                                                                                                                                                                                                                    | This document                                                                                                                            |

The epic has already merged into `dev`. Issues `#523`, `#525`, `#530`, and `#531` remain open: their deliverables landed on `dev`, but their audit-fix PRs intentionally used `Refs` rather than `Resolves` so that closure stays human-controlled (see [#595](https://github.com/oscharko-dev/Keiko/pull/595)). Each open issue is therefore a pending governance action, not an implementation blocker.

Post-merge audit PRs also tightened individual children directly on `dev`, beyond the integration follow-ups already cited in the matrix above: [#591](https://github.com/oscharko-dev/Keiko/pull/591) (`#520`), [#592](https://github.com/oscharko-dev/Keiko/pull/592) (`#522`), [#593](https://github.com/oscharko-dev/Keiko/pull/593) (`#523`), [#594](https://github.com/oscharko-dev/Keiko/pull/594) (`#524`), [#595](https://github.com/oscharko-dev/Keiko/pull/595) (`#525`), [#599](https://github.com/oscharko-dev/Keiko/pull/599) (`#529` deferral narrative), [#601](https://github.com/oscharko-dev/Keiko/pull/601) and [#603](https://github.com/oscharko-dev/Keiko/pull/603) (`#527` accessibility and contrast), and [#602](https://github.com/oscharko-dev/Keiko/pull/602) (`#530` hardening refresh, which also last updated this document).

## Implementation summary

### Documentation (Waves 1–3, plus #530 + #531)

Nine workspace documents under `docs/workspace/`:

- [518-capability-audit.md](518-capability-audit.md) — Reuse Matrix + Gap Matrix; bounded Wave 4 implementation scope.
- [518-reference-analysis.md](518-reference-analysis.md) — tldraw / AFFiNE / Excalidraw / React Flow dispositions; no-new-dep compliance note; glossary.
- [518-product-boundaries.md](518-product-boundaries.md) — first-class taxonomy from the 19 `WindowType`s + extension-ready future types; authority model with five inviolable rules; seven primary journeys.
- [518-ux-blueprint.md](518-ux-blueprint.md) — seven interaction principles; selection / command / undo / keyboard contracts; 17-chord minimum shortcut set; state pattern catalogue; accessibility contract.
- [518-ui-blueprint.md](518-ui-blueprint.md) — shell layout; panel / inspector / overlay / dialog / notification behavior; 5-tier visual hierarchy; object presentation patterns; responsive behavior; 11-class state catalogue; visual rules locked from existing Keiko patterns.
- [518-architecture-blueprint.md](518-architecture-blueprint.md) — package ownership; state ownership; command/event/selection/undo boundaries; persistence boundary; security flows; the workspace substrate decision; the no-new-dep strategy.
- [518-shell-runbook.md](518-shell-runbook.md) — workspace entry surface; region ownership; four shell-level status indicators; visual-state catalogue reachability; keyboard reach map; regression-prone state transitions.
- [518-canvas-graph-deferral.md](518-canvas-graph-deferral.md) — #529 deferral evidence with file-by-file mapping to existing substrate.
- [518-hardening-evidence.md](518-hardening-evidence.md) — a11y / perf / security / evidence / supply-chain verification.

Five new ADRs under `docs/adr/`:

- [ADR-0026](../adr/ADR-0026-workspace-substrate.md) — workspace substrate (existing surfaces locked as substrate; canvas/graph independent build rejected).
- [ADR-0027](../adr/ADR-0027-workspace-state-ownership.md) — state ownership and persistence (8 state classes; closed `PersistenceExpectation` set).
- [ADR-0028](../adr/ADR-0028-workspace-commands-undo.md) — commands / events / selection / undo (typed `Command` records; conflict-at-startup keyboard substrate; typed `Action` union with no constructor for evidence/patch/verification/model-call/tool/memory/fs/durable-config kinds — compile-time refusal).
- [ADR-0029](../adr/ADR-0029-workspace-object-registry.md) — object registry and extension contract (`WIN_META` sidecar metadata + metadata validator).
- [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md) — security, evidence, trust (five inviolable workspace rules; gates that enforce them).

The decision summary in `docs/adr/README.md` was updated for ADRs 0025–0030.

### Contracts (`@oscharko-dev/keiko-contracts`)

- `src/workspace-ui.ts` (new) — `WorkspaceCommand`, `WorkspaceUiAction`, `WorkspaceKeyChord`, undo stack API, keyboard binding + conflict types, pure helpers (`workspaceActionLabel`, `workspaceChordKey`, `workspaceChordsEqual`, `isWorkspaceReservedChord`, `workspaceInverseAction`). The `WorkspaceUiAction` discriminated union has constructors only for `ui.*` kinds — ADR-0028's compile-time refusal.
- `src/workspace-descriptors.ts` (new) — `WorkspaceObjectLifecycleState`, `WorkspaceObjectTrustBoundary`, `WorkspaceObjectAuthority`, `WorkspaceObjectPersistence` closed-set enums; `WorkspaceDescriptorMeta`; pure `validateWorkspaceDescriptorMeta` validator enforcing six rules (R1–R6).
- `src/workspace-descriptors.test.ts` (new) — 16 contract tests covering all six rules + objectType reporting.
- `src/index.ts` — additive re-exports only.

### UI (`@oscharko-dev/keiko-ui`)

- `src/app/components/desktop/Footer.test.tsx` (new) — pins the shell-level status indicators, governance pill, and footer landmark semantics.
- `src/app/components/desktop/hooks/useUndoStack.ts` (new) — typed undo stack with push / undo / redo / clear, bounded history, injected `apply()` side-effect.
- `src/app/components/desktop/hooks/useUndoStack.test.tsx` (new) — covers bounded undo/redo behavior plus the runtime witness for the compile-time refusal.
- `src/app/components/desktop/hooks/useKeyboardShortcuts.ts` (new) — conflict-at-startup keyboard substrate with platform normalization (`cmd → meta` on macOS, `ctrl` elsewhere); browser-reserved chord refusal; exact modifier matching.
- `src/app/components/desktop/hooks/useKeyboardShortcuts.test.tsx` (new) — covers conflict detection, reserved-chord refusal, and exact modifier matching.
- `src/app/components/desktop/windows/descriptor-meta.ts` (new) — `WIN_META` sidecar table mapping every `WindowType` to declared meta (19 entries); module-evaluation validation guard.
- `src/app/components/desktop/windows/descriptor-meta.test.ts` (new) — pins the descriptor metadata table and validation guard.
- `src/app/components/desktop/shell-undo-bindings.ts` (new) — shell-level undo apply dispatcher + shortcut binding table used by the production shell integration.
- `src/app/components/desktop/shell-undo-bindings.test.ts` (new) — covers the shell-level undo apply dispatcher and the shortcut binding table.
- `src/app/components/desktop/AppShell.tsx` (modified) — wires undo/redo and keyboard shortcuts into the live shell.
- `src/app/components/desktop/AppShell.commands.test.ts` (new) — pins the AppShell command registration (Card / Tool / Layout / View / Edit groups).
- `src/app/components/desktop/widgets/panels/InspectorPanel.tsx` (modified) — surfaces governance metadata from `WIN_META`.
- `src/app/components/desktop/widgets/panels/InspectorPanel.test.tsx` (new) — covers the governance metadata rows surfaced from `WIN_META`.

## Files changed by area

| Area                              | Files                                                  |
| --------------------------------- | ------------------------------------------------------ |
| Documentation (`docs/workspace/`) | 9 new files                                            |
| ADRs (`docs/adr/`)                | 5 new files; 1 modified (`README.md` decision summary) |
| Contracts source                  | 2 new files; 1 modified (`src/index.ts`)               |
| Contracts tests                   | 1 new file                                             |
| UI source                         | 4 new files; 2 modified existing files                 |
| UI tests                          | 7 new files                                            |

Zero changes to `package.json`, `package-lock.json`, or `bundleDependencies`.

## Verification performed

Recorded in detail by [#530 hardening evidence](518-hardening-evidence.md). Summary verified on `origin/dev` at `6ba594db` (current dev HEAD):

| Command                                              | Result                                        |
| ---------------------------------------------------- | --------------------------------------------- |
| `npm -w @oscharko-dev/keiko-contracts run typecheck` | PASS                                          |
| `npm -w @oscharko-dev/keiko-ui run typecheck`        | PASS                                          |
| `npm -w @oscharko-dev/keiko-contracts run build`     | PASS                                          |
| `npm -w @oscharko-dev/keiko-contracts test -- --run` | PASS — 21 files, 872 tests                    |
| `npm -w @oscharko-dev/keiko-ui test -- --run`        | PASS — 67 files, 779 tests passing, 3 skipped |
| `npm run arch:check`                                 | PASS — 1070 modules, 2620 deps, 0 violations  |
| `npm run arch:check:negative`                        | PASS — gate fired on 23 expected fixtures     |
| `npm run lint`                                       | PASS — repository-wide eslint green           |

The full-suite totals above are a point-in-time snapshot at the pinned SHA and move with ordinary repository activity (for example, the keiko-contracts total includes tests from unrelated areas); the stable #518-specific addition is the 16 keiko-contracts descriptor tests plus the UI slices recorded in the child-issue matrix.

The final epic PR to `dev` was [#563](https://github.com/oscharko-dev/Keiko/pull/563). This document now serves as post-merge closure evidence rather than a pre-merge handoff.

## Delivery board state

- Epic `#518` and its child issues should now be treated as post-merge governance items: any remaining `Ready for Human Review` or open-state board entries need manual project-state cleanup rather than more implementation work.

## Review settlement

- All 13 PRs into the epic branch were merged green (the twelve issue deliverables `#550`–`#562` plus substrate-integration PR [#565](https://github.com/oscharko-dev/Keiko/pull/565)). Required `dev` CI did not run on child PRs into the epic branch (workflows trigger only on PRs targeting `dev`); the final epic PR is the gate.
- No external review findings were posted on the child PRs prior to merge.
- Post-merge follow-up [#598](https://github.com/oscharko-dev/Keiko/pull/598) improved the browser-local workspace persistence seam by sanitizing transient, evidence-reference, and `durable.config` payloads before browser-local write or restore.
- Issue [#600](https://github.com/oscharko-dev/Keiko/issues/600) closes the remaining browser-local `useWorkspace` snapshot hardening gap by redacting or omitting secret-shaped config strings before `localStorage` write and during restore. This is scoped to the workspace layout snapshot and is not a universal claim about unrelated durable stores.

## Known limitations

Each is documented at the ADR or blueprint level, not hidden:

- **Performance virtualization for workspace windows** — deferred per [ADR-0026](../adr/ADR-0026-workspace-substrate.md). Revisit when measured scale exceeds the existing budget.
- **Multi-selection of workspace windows** — deferred per [ADR-0028](../adr/ADR-0028-workspace-commands-undo.md). UX blueprint does not require it for current scope.
- **Right-click context menu in workspace** — UX blueprint defers; can land in a future feature issue.
- **Mini-map / zoom controls overlay** — defer per [reference analysis](518-reference-analysis.md); only land if a future feature requires it.

## Follow-up candidates

If the maintainer chooses to address the limitations above, open a new issue referencing the relevant ADR + capability audit gap line. The Reuse Matrix in [518-capability-audit.md](518-capability-audit.md) is the gate for any future workspace-foundation work to prevent parallel-subsystem drift.

## No-new-dependency confirmation

The Epic #518 Definition of Done item _"Closure evidence confirms that no new third-party dependencies were added by this epic"_ is satisfied:

- `packages/keiko-contracts/package.json` runtime deps unchanged (0 entries).
- `packages/keiko-ui/package.json` runtime deps unchanged (4 entries: `@oscharko-dev/keiko-contracts`, `next`, `react`, `react-dom`).
- Root `package.json` runtime deps unchanged (20 internal `@oscharko-dev/keiko-*` packages + `ws`).
- `package-lock.json` unchanged.
- Root `bundleDependencies` array unchanged.
- No vendored code added.
- No package override added.

## References

- Epic: [#518](https://github.com/oscharko-dev/Keiko/issues/518)
- Child issue closure mapping: see "Child issue matrix" above
- All five blueprints + the shell runbook + this closure evidence: under [docs/workspace/518-\*.md](.)
- ADRs added: [ADR-0026](../adr/ADR-0026-workspace-substrate.md), [ADR-0027](../adr/ADR-0027-workspace-state-ownership.md), [ADR-0028](../adr/ADR-0028-workspace-commands-undo.md), [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md)
- Foundations preserved: [ADR-0019](../adr/ADR-0019-modular-package-architecture.md), [ADR-0020](../adr/ADR-0020-workspace-tooling-and-architecture-gate.md), [ADR-0025](../adr/ADR-0025-forward-only-0-2-0-modular-baseline.md)
