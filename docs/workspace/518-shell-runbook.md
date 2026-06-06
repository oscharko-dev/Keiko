# Epic #518 — Workspace shell runbook

Status: Wave 4 deliverable for [issue #526](https://github.com/oscharko-dev/Keiko/issues/526) under parent epic [#518](https://github.com/oscharko-dev/Keiko/issues/518).

Purpose: name the workspace entry surface, the four shell-level status indicators, the keyboard reach map, and the regression-prone state transitions that #530 hardening must verify.

## Entry surface

The production workspace is `/` (Next.js App Router root). It re-exports the desktop shell:

- `packages/keiko-ui/src/app/page.tsx` re-exports `KeikoDesktop`.
- `packages/keiko-ui/src/app/components/desktop/KeikoDesktop.tsx` returns `<AppShell />`.
- `packages/keiko-ui/src/app/layout.tsx` provides the root `<html><body>` plus PWA manifest, icons, theme color, color-scheme metadata.

No new route is added by #526. The existing `/launch` (returning-user landing) and `/local-knowledge`, `/memory`, `/quality-intelligence` routes are unchanged.

## Regions and ownership

```
+--------------------------------------------------------------------+
|                              Header                                 |
+------+----------------------------------------------------+--------+
|      |                                                    |        |
| Left |                                                    | Right  |
| Rail |               Workspace surface                    | Rail   |
|      |                                                    |        |
+------+----------------------------------------------------+--------+
|                              Footer                                 |
+--------------------------------------------------------------------+
```

| Region    | Owner                            | Notes                                                                                   |
| --------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| Header    | `Header.tsx`                     | Workspace tabs, command palette CTA, mode switch, editor menu                           |
| LeftRail  | `LeftRail.tsx`                   | Primary tools (Keiko, Project, Search, Plugins) + secondary (Automations, Keiko mobile) |
| Workspace | `Workspace.tsx` + `useWorkspace` | Pannable/zoomable canvas with `WindowFrame`s and a `ConnectionsLayer`                   |
| RightRail | `RightRail.tsx`                  | Inspector, supplemental panels                                                          |
| Footer    | `Footer.tsx`                     | Four shell-level status indicators                                                      |
| Modals    | `modals/*`                       | `CommandPalette`, `Palette`, `NewWindowDialog`, `GatewaySetupDialog`, `PermControl`     |

## Four shell-level status indicators

These are the load-bearing signals the user uses to orient. The architecture blueprint requires them to be visible at all times in the desktop viewport.

| Indicator          | Footer segment                                                              | Verifier                                                                                                               | Notes                                                                         |
| ------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Connected project  | `.ft-seg.ft-opt2` with folder icon + active project name                    | `Footer.test.tsx` it("renders the connected-project indicator with the live workspace label")                          | Reads the selected project from `useChatSession` through `AppShell`           |
| Model availability | `.ft-seg.ft-opt2` with bolt icon + selected model id or `No model selected` | `Footer.test.tsx` it("renders the model-availability indicator") and it("renders an explicit no-model-selected state") | `selectedModel` prop owned by `AppShell` per ChatSession                      |
| Workflow readiness | `.ft-seg.ft-accent` with tile icon + window count (singular/plural)         | `Footer.test.tsx` it("renders the workflow-readiness indicator") and it("singularises the window-count indicator")     | Window count is the workflow readiness proxy (workflows render as windows)    |
| Shell readiness    | `.ft-seg.ft-opt2` with cube icon + shell state label                        | `Footer.test.tsx` it("renders the shell trust-boundary status indicator")                                              | Reports loading, error, unavailable-project, gateway-setup-required, or ready |
| Review / evidence  | `.ft-seg.ft-accent` with review icon + review/evidence state label          | `Footer.test.tsx` it("renders the review and evidence-access indicator")                                               | Distinguishes no review window, open review, and evidence-ready review        |

## Visual state catalogue reachability

The UI blueprint mandates 11 production states. The reachability map below names where each state is exercised in the existing codebase. #530 hardening verifies the catalogue at the shell level.

| State                  | Existing reach                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| Empty                  | `ComposerEmptyState` for chat; LeftRail without a selected tool; Workspace with no windows   |
| Loading                | `Streaming` test pattern; `useChatSession` loading flag; PWA `InstallBanner` waiting state   |
| Streaming              | `GroundedAnswer` SSE stream; `ChatWindow` `sending` state with `aria-live="polite"`          |
| Success                | Footer review/evidence indicator reports `Evidence ready`; Notifications panel quiet success |
| Review-needed          | `AgentGateCard` inside `ReviewWidget`                                                        |
| Blocked                | `ChatWindow` blocked composer state; `PermControl` denied response                           |
| Warning                | `lk-alert` warning variant in `connector-graph.tsx`                                          |
| Error                  | `AlertBanner` in `connector-graph.tsx` (`role="alert"`); `ChatWindow` error state            |
| Offline / disconnected | Footer shell readiness indicator reports an unavailable project or setup requirement         |
| Stale                  | `connector-graph` stale capsule indicator                                                    |
| Degraded               | `useChatSession` `noEligibleModels` state                                                    |

## Keyboard reach map (minimum, per #523)

The shell must satisfy the minimum keyboard contract. The substrate behind these chords is wired by #527 (interaction substrate); the shell merely surfaces them.

| Region    | Reach pattern                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------ |
| Header    | `Tab` from page entry; `Cmd/Ctrl+K` opens the command palette                                    |
| LeftRail  | `Tab` from Header; `Enter` or `Space` activates navigation buttons                               |
| Workspace | `Tab` enters windows; `Cmd/Ctrl+Arrow` moves the front window; `Alt+Arrow` resizes it            |
| RightRail | `Tab` reaches inspector and utility controls                                                     |
| Footer    | `Alt+S` focuses the status surface; status segments remain non-interactive                       |
| Modal     | `Esc` closes; focus is trapped inside supported shell dialogs; `Enter` confirms where applicable |

## Regression-prone state transitions

When implementation lands additional behavior on the shell, the following transitions must be regression-tested:

1. **No project → project connected.** Footer connected-project indicator updates; LeftRail Project entry reflects the project; existing windows persist across the transition without rendering errors.
2. **No model → model selected.** Footer model-availability indicator updates from `No model selected` to the model id; the chat composer becomes enabled.
3. **Manual mode → autonomous mode.** Footer governance pill switches between `You · manual` and `Keiko governing`.
4. **Window count 0 → 1.** Footer plural switches between `windows` and `window`.
5. **Modal open → close.** Focus restores to the trigger element; the underlying shell does not re-render.
6. **RightRail collapsed → expanded.** Layout reflows without horizontal scrollbar; inspector state preserved.
7. **PWA install banner appears → dismissed.** Banner is dismissable; dismissal persists across reloads.

## Verification

Targeted tests for the shell-level contract introduced by #526:

- `packages/keiko-ui/src/app/components/desktop/Footer.test.tsx` — shell status indicators, governance pill, footer landmark, and focusable status surface.

Existing tests already cover region renderings:

- `LeftRail.test.tsx` — page-route links, accessible names, and navigation landmark.
- `RightRail.test.tsx` — complementary landmark for workspace utilities.
- `Workspace.test.tsx` — workspace canvas card connections and the main workspace landmark.
- `ProjectPanel.test.tsx` — live project and chat context rendering without placeholder workspace data.
- `ChatWindow.test.tsx`, `ComposerEmptyState.test.tsx`, `ConnectedScopePill.test.tsx`, `Streaming.test.tsx`, `GroundedAnswer.test.tsx`, `GroundedAnswer.a11y.test.tsx` — chat surface rendering and a11y.

## Acceptance Criteria evidence

| #526 AC                                                                                            | Where                                                       |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| First screen is usable and aligned with the approved UI blueprint                                  | Entry surface section + UI blueprint cross-ref              |
| Users can identify connected project, available work areas, review/evidence access, blocked states | Four shell-level status indicators + state catalogue        |
| Navigation is keyboard reachable with stable focus                                                 | Keyboard reach map                                          |
| Empty / loading / error / degraded implemented as production states                                | Visual state catalogue reachability                         |
| Implementation preserves Model Gateway, workspace containment, evidence, tool boundaries           | No new BFF route + no new credential surface (per ADR-0030) |
| Tests cover shell behavior and fail on meaningful regressions                                      | `Footer.test.tsx` + existing tests                          |
| No dependency, lockfile, package override, or vendored code added                                  | `packages/keiko-ui/package.json` unchanged                  |

## References

- Epic: [#518](https://github.com/oscharko-dev/Keiko/issues/518)
- Child: [#526](https://github.com/oscharko-dev/Keiko/issues/526)
- Companions: [518-capability-audit.md](518-capability-audit.md), [518-ux-blueprint.md](518-ux-blueprint.md), [518-ui-blueprint.md](518-ui-blueprint.md), [518-architecture-blueprint.md](518-architecture-blueprint.md)
- Footer: [packages/keiko-ui/src/app/components/desktop/Footer.tsx](../../packages/keiko-ui/src/app/components/desktop/Footer.tsx)
- AppShell: [packages/keiko-ui/src/app/components/desktop/AppShell.tsx](../../packages/keiko-ui/src/app/components/desktop/AppShell.tsx)
- Workspace: [packages/keiko-ui/src/app/components/desktop/Workspace.tsx](../../packages/keiko-ui/src/app/components/desktop/Workspace.tsx)
