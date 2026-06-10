# Epic #518 — Existing Keiko Capability Audit

Status: Wave 1 deliverable for [issue #545](https://github.com/oscharko-dev/Keiko/issues/545) under parent epic [#518](https://github.com/oscharko-dev/Keiko/issues/518).

Audit date: 2026-06-06. Original audit basis: repository HEAD `d834195d` on the long-lived epic branch before Wave 4 implementation began.

Current `dev` note: Epic #518 later merged into `dev` via [#563](https://github.com/oscharko-dev/Keiko/pull/563), with additional substrate integration from [#565](https://github.com/oscharko-dev/Keiko/pull/565). The reuse and gap rationale below remains the governing audit output, and the file-landing references in this document are updated to match the merged implementation on `origin/dev`.

## Purpose

This document is the gate-keeper for every downstream #518 child issue. Its job is to prevent the governed workspace foundation from becoming a parallel project inside Keiko by recording, before any implementation begins:

1. Which Keiko subsystems already implement the capability a child issue plans to introduce.
2. Where each child issue must reuse, extend, or generalize an existing surface instead of writing a new one.
3. Where a genuine capability gap exists and new code is justified, with scope strictly bounded to the gap.
4. Stop-condition triggers for any child issue at risk of duplicating existing functionality.

Per the epic's required implementation order, no downstream #518 issue may begin until this audit is complete or explicitly waived by the maintainer with rationale.

## Scope of the audit

| Package                                    | Scope inspected                                                                                                                                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@oscharko-dev/keiko-ui`                   | `app/layout.tsx`, `app/page.tsx`, `app/components/desktop/**` (35+ components, hooks, windows registry, modals, contexts, widgets), `app/local-knowledge/**`, `app/memoriaviva/**`, `app/quality-intelligence/**`, `lib/**` |
| `@oscharko-dev/keiko-contracts`            | `bff-wire`, `evidence`, `gateway`, `harness`, `local-knowledge`, `memory-*`, `connected-context`, `bug-investigation-events`, validation helpers                                                                            |
| `@oscharko-dev/keiko-server`               | Route surface (`routes.ts`, `*-handlers.ts`), CSP, evidence, files, gateway-setup, grounded orchestrator, terminal, browser, conversation, memory, run, store, host-check                                                   |
| `@oscharko-dev/keiko-workspace`            | `discovery`, `contextPack`, `retrieval`, `gitHistory`, `importGraph`, `repoSearch`, `paths`, `realpath`, `ignore`, `binaryDetect`, `document-extraction`                                                                    |
| `@oscharko-dev/keiko-tools`                | terminal-policy command boundary, applyPatch, file IO, sandboxed execution                                                                                                                                                  |
| `@oscharko-dev/keiko-evidence`             | `aggregate`, `build`, `connected-context-evidence`, `index-api`, redacted-by-construction manifests                                                                                                                         |
| `@oscharko-dev/keiko-model-gateway`        | provider abstraction, OpenAI-compatible adapter, credential surfaces                                                                                                                                                        |
| `@oscharko-dev/keiko-workflows`            | `bug-investigation`, `contextpack`, `planner`, `qualityIntelligence`, `ranking`, `unit-tests`, descriptor base                                                                                                              |
| `@oscharko-dev/keiko-local-knowledge`      | capsule lifecycle, chunking, composition, conversation, discovery, evaluations, indexing, parsers, privacy, retrieval                                                                                                       |
| `@oscharko-dev/keiko-memory-*`             | capture policy, consolidation engine, governance envelopes, retrieval, vault store                                                                                                                                          |
| `@oscharko-dev/keiko-harness`              | runtime loop, session, cancellation, limits, ports                                                                                                                                                                          |
| `@oscharko-dev/keiko-verification`         | deterministic verification orchestrator, plan compilation                                                                                                                                                                   |
| `@oscharko-dev/keiko-quality-intelligence` | pure-domain QI test-design logic                                                                                                                                                                                            |
| `@oscharko-dev/keiko-security`             | redaction, safe-error, secret patterns                                                                                                                                                                                      |

## Headline finding

**Keiko already implements a governed workspace foundation.** The Wave 1 desktop UI in `packages/keiko-ui/src/app/components/desktop/` is a complete reviewable workspace shell with the architectural pieces #518 is asking to build:

- A workspace root component (`KeikoDesktop` → `AppShell`) that already composes Header, LeftRail, RightRail, Footer, and a draggable/resizable `Workspace` canvas of windows.
- A typed window-type registry (`windows/WindowsRegistry.ts`) declaring 20 first-class object types — `chat`, `connector`, `files`, `editor`, `browser`, `terminal`, `review`, `agents`, `integ`, `keiko`, `settings`, `project`, `search`, `plugins`, `automations`, `mobile`, `inspector`, `activity`, `notifications`, `resources` — each with title, icon, default size, min/tiny sizes, config schema, render function, optional singleton flag, and an `accent`/`tool` classifier.
- A `registerWindowRender(type, render)` extension point used by `widgets/index.tsx` to bind 20 window types to React renderers in `widgets/cards/**` and `widgets/panels/**`, without modifying the registry.
- A `CommandPalette` modal in `modals/CommandPalette.tsx` with discoverable commands generated from the registry, plus a separate `Palette` modal and a `NewWindowDialog`.
- A `useWorkspace` hook (`hooks/useWorkspace.ts`) that owns workspace pan/zoom, window placement, focus, z-ordering, and a `WorkspaceApi` contract consumed by the shell and the command system.
- A `ConnectionsLayer` and `connectionUtils` for object-to-object connections inside the workspace.
- An infinite-canvas-shaped surface with world coordinates, pan, zoom, and a `WorkspaceShader` background, implemented directly with the existing stack and zero new dependencies.
- A reviewable connector graph in `app/local-knowledge/connector-graph.tsx` with WCAG-conformant focus rings, ≥30×30 hit targets, and `aria-live="assertive"` error alerts.
- A `widgets/panels/InspectorPanel.tsx`, `ResourcesPanel.tsx`, `NotificationsPanel.tsx`, `ActivityPanel`/`TimelinePanel.tsx`, and `SettingsPanel.tsx` for object inspection and status surfaces.
- A bound theme system (`useTheme`), Twin mode (`useTwinMode`, `TwinContext`), Chat session (`ChatSessionContext`), and WebSocket context (`WsContext`).
- An installable PWA shell with `InstallBanner` and `registerSw`, governed by ADR-0024.

The consequence is that the bulk of #518's implementation work is _extension_, not _new code_. The audit recommends closing #529 with documented deferral evidence and tightly scoping #526–#528 and #530 to the deltas required by the epic's Definition of Done.

## Reuse Matrix

For each downstream child issue, this table records the disposition: **REUSE** (use as-is), **EXTEND** (modify an existing surface within its current contract), **GENERALIZE** (lift a contract into a shared seam), or **NEW** (genuine capability gap; bounded new code).

### #520 — Analyze open-source workspace reference architectures

| Concept area                                           | Existing Keiko surface                                                                                                                                     | Disposition                                                                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| World-coordinate workspace, pan/zoom, window placement | `app/components/desktop/hooks/useWorkspace.ts`, `Workspace.tsx`, `View` type in `windows/types.ts`                                                         | REUSE — reference analysis must map tldraw/Excalidraw concepts onto the existing `useWorkspace` model, not propose a new canvas substrate |
| Object/shape registry, extension model                 | `app/components/desktop/windows/WindowsRegistry.ts` + `widgets/index.tsx` registry pattern                                                                 | REUSE — reference analysis must map tldraw `Shape`/`ShapeUtil`, Excalidraw element types, and React Flow node types onto this registry    |
| Document/whiteboard composition (AFFiNE)               | Workspace + windows + InspectorPanel + Editor card                                                                                                         | REUSE — reference analysis must locate AFFiNE document concepts within existing Keiko object types                                        |
| Node-graph patterns (React Flow)                       | `app/local-knowledge/connector-graph.tsx` + `connector-graph-state.ts` + `connector-graph-types.ts` + workspace `Connection` type + `ConnectionsLayer.tsx` | REUSE — graph analysis must compare against the existing connector graph, not propose a parallel implementation                           |
| Camera/viewport contract                               | `View { zoom, x, y }` plus `panBy` + `useWorkspace` zoom                                                                                                   | REUSE — analysis must document this as the camera/viewport contract                                                                       |

**Reuse plan:** the reference analysis document records dispositions against Keiko's existing model. The reference output is documentation only; no source code from any reference project may be copied.

### #522 — Define governed workspace product boundaries, object taxonomy, primary journeys

| Concept area                                                                     | Existing Keiko surface                                                                                                                                               | Disposition                                                                                                   |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Object taxonomy                                                                  | `WindowType` enum in `windows/WindowsRegistry.ts` (20 types)                                                                                                         | EXTEND — promote existing window types into a documented product taxonomy; do not invent parallel terminology |
| Authority model (user/agent/server/model)                                        | Existing Model Gateway, Tools terminal policy, Workspace path containment, Evidence redaction, `useChatSession`, `useWorkspace`                                      | REUSE — authority boundaries already enforced by package boundaries; document them rather than redesigning    |
| Primary journeys (connect project, inspect context, ask, review, verify, return) | Existing surfaces in `local-knowledge`, `memory`, `quality-intelligence`, `desktop` widgets, `launch` route, `desktop/Workspace.tsx`                                 | REUSE — journeys already exist as flows through the desktop; document them                                    |
| Object lifecycle states                                                          | `CapsuleLifecycleState` (in `keiko-contracts/local-knowledge`), workflow run states in `keiko-workflows/descriptor.ts`, evidence manifest states in `keiko-evidence` | REUSE — lifecycle vocabulary already exists; consolidate cross-package terminology                            |
| Trust boundaries per object                                                      | Model Gateway adapter contracts, Workspace path validators, Tools terminal policy, Evidence redactor                                                                 | REUSE — document the existing trust matrix                                                                    |

**Reuse plan:** the product boundary document treats `WindowType` as the canonical taxonomy seed. Extension-ready and deferred object types extend the registry's union and add a registry entry; they do not introduce a new taxonomy system.

### #523 — UX blueprint

| Concept area                                                  | Existing Keiko surface                                                                                                  | Disposition                                                                                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Command model & palette                                       | `modals/CommandPalette.tsx` (Command type, build/select/run), `buildAppShellCommands` in `AppShell.tsx`                 | REUSE — UX blueprint formalizes the existing command vocabulary, adds discoverability rules and shortcut conflict rules where not yet documented |
| Selection / multi-selection / focus                           | `useWorkspace` focus and z-ordering, window `top`/`active` derivation in `AppShell`                                     | EXTEND — define selection semantics for multi-window selection; existing focus is single-window                                                  |
| Keyboard handling, shortcuts                                  | Command palette open shortcut, Header tool buttons, `Icons.tsx`/`aria-label`, focus-visible CSS                         | EXTEND — document the keyboard matrix; minimum shortcut set already partially exists                                                             |
| Undo/redo boundary                                            | Not implemented today                                                                                                   | NEW — UX blueprint defines the undo/redo boundary; this is the genuine gap                                                                       |
| Context menus, inspector behavior                             | `InspectorPanel`, `NotificationsPanel`, `Footer`, `PermControl`                                                         | REUSE — formalize behaviors already present                                                                                                      |
| Error/empty/loading/blocked states                            | `AlertBanner` in connector-graph, `AgentGateCard.tsx` for review-needed, `lk-alert`/`lk-empty` classes in `globals.css` | REUSE — UX blueprint documents these patterns as the standard                                                                                    |
| Accessibility behavior                                        | Existing `aria-live`, `aria-label`, focus-visible, ≥30×30 hit targets, `prefers-reduced-motion`/`motion-safe:` patterns | REUSE — document the existing rules as the contract                                                                                              |
| Trust prompts (apply / verify / dismiss / archive / escalate) | `PermControl.tsx`, `AgentGateCard`, ReviewWidget                                                                        | REUSE — document explicit authority moments                                                                                                      |

**Reuse plan:** the UX blueprint is a documentation deliverable. The only genuine new behavior it must specify is the undo/redo boundary for reversible workspace-object actions, separating evidence/applied-patch/verification history from UI undo.

### #524 — UI blueprint

| Concept area                                                              | Existing Keiko surface                                                                                                                                       | Disposition                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Workspace shell layout                                                    | `AppShell.tsx` (LeftRail / Workspace / RightRail / Header / Footer)                                                                                          | REUSE — UI blueprint documents the existing composition |
| Panels and inspectors                                                     | `widgets/panels/**` (13 panels)                                                                                                                              | REUSE                                                   |
| Modals and dialogs                                                        | `modals/CommandPalette`, `Palette`, `GatewaySetupDialog`, `NewWindowDialog`, `PermControl`                                                                   | REUSE                                                   |
| Notifications and footer                                                  | `NotificationsPanel`, `Footer.tsx`, `lk-alert` styling                                                                                                       | REUSE                                                   |
| Empty / loading / streaming / blocked / degraded / error states           | Existing patterns in `local-knowledge/connector-graph.tsx`, `memory/components`, `quality-intelligence/QualityIntelligencePanel.tsx`, `lk-empty`, `lk-alert` | REUSE                                                   |
| Responsive behavior                                                       | Existing CSS variables, breakpoints in `globals.css`, PWA viewport hooks                                                                                     | REUSE                                                   |
| Focus ring, hit target, contrast rules                                    | WCAG 2.5.8-compliant `lk-btn-primary`, focus-visible rules, contrast guidance recorded in PR #71                                                             | REUSE — UI blueprint documents the existing rules       |
| Theme system                                                              | `useTheme.ts`, `data-theme` toggle, `colorScheme: "dark light"`                                                                                              | REUSE                                                   |
| Visual hierarchy for evidence, conversation, workflows, generated patches | Existing widgets (`ReviewWidget`, `AgentGateCard`, `GroundedAnswer`, `ChatWindow`)                                                                           | REUSE                                                   |

**Reuse plan:** the UI blueprint document records the existing composition system as the production system. No new design library is proposed; the dependency list in `packages/keiko-ui/package.json` (`@oscharko-dev/keiko-contracts`, `next`, `react`, `react-dom`) stays unchanged.

### #525 — Architecture blueprint + ADR set

| Architecture area                           | Existing Keiko surface                                                                                                                               | Disposition                                                                                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace package ownership                 | ADR-0019, ADR-0020 (workspace-tooling-and-architecture-gate)                                                                                         | EXTEND — add an ADR that locates the workspace foundation inside `keiko-ui` + `keiko-server` + `keiko-contracts` + `keiko-workspace` + `keiko-evidence` without introducing a new package |
| State ownership                             | UI hooks own browser state; server owns BFF state; `keiko-workspace` owns FS state; `keiko-evidence` owns evidence; `keiko-memory-vault` owns memory | EXTEND — add an ADR that documents the workspace object state seams                                                                                                                       |
| Command / event / selection / undo boundary | Command palette, `useWorkspace` focus, no undo today                                                                                                 | EXTEND — add an ADR defining the undo/redo boundary as the only new behavioral contract (UI undo never rewrites evidence / applied patches / verification / model-call records)           |
| Object registry contract                    | `windows/WindowsRegistry.ts` + `registerWindowRender`                                                                                                | EXTEND — add an ADR formalizing the existing registry as the extension contract; document descriptor fields, identity, lifecycle, trust boundary, persistence expectation                 |
| Persistence boundary                        | Local `node:sqlite` (#62), evidence-store (`keiko-evidence`), workspace FS (`keiko-workspace`)                                                       | REUSE — document the seams; no new store                                                                                                                                                  |
| Security / evidence flow                    | Existing redactor, denied-path rules, terminal-policy, evidence redacted-by-construction                                                             | REUSE — document the existing trust matrix                                                                                                                                                |
| Independent canvas substrate                | `Workspace.tsx` + `useWorkspace` + `WorkspaceShader` + `ConnectionsLayer` already provide world coordinates, camera, viewport, hit, connections      | REUSE — ADR records this as the workspace substrate; no separate canvas package                                                                                                           |
| Independent graph substrate                 | `app/local-knowledge/connector-graph.tsx` (already implemented for capsules) + `windows/ConnectionsLayer.tsx` for workspace-level connections        | REUSE — graph patterns exist for two distinct use cases; ADR records this and rejects a third generic graph substrate                                                                     |

**Reuse plan:** the architecture blueprint records the existing substrate as approved. The ADRs add behavior contracts (undo boundary, registry extension contract, object descriptor identity/lifecycle/trust/persistence fields) without changing package boundaries.

### #526 — Implement production workspace shell + governed navigation foundation

| Capability                                                                                                              | Existing Keiko surface                                                                                                          | Disposition                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace route / entry surface                                                                                         | `app/page.tsx` re-exports `KeikoDesktop`; `app/layout.tsx` is the root                                                          | REUSE — entry already in place                                                                                                                             |
| Global navigation and project context                                                                                   | `Header.tsx` (workspace tabs), `LeftRail.tsx` (PRIMARY + SECONDARY rail tools), `Footer.tsx` + `useChatSession` shell status    | REUSE — extend the existing shell surfaces if the audit identifies a gap; `ConnectedScopePill.tsx` remains a chat-scope surface rather than a shell banner |
| Primary work area shell with regions for conversation/context/workflows/review/evidence                                 | Window types `chat`, `files`, `review`, `agents`, `integ`, `editor`, `terminal`, plus widgets                                   | REUSE                                                                                                                                                      |
| Responsive structure for desktop and constrained widths                                                                 | CSS variables and breakpoints; `WorkspaceShader` adapts to viewport                                                             | REUSE                                                                                                                                                      |
| Empty / loading / blocked / degraded / error shell states                                                               | `lk-alert` (error/blocked) and `lk-empty` (empty state) classes, `AgentGateCard` for blocked, `NotificationsPanel` for degraded | REUSE — verify each shell-level state is reachable; close any gap with a single AlertBanner addition                                                       |
| Keyboard-reachable navigation and focus rings                                                                           | Existing `rail-btn` + `hd-tool` ARIA + focus-visible rules                                                                      | REUSE                                                                                                                                                      |
| Shell-level status indicators (connected project, model availability, workflow readiness, verification/evidence access) | `Footer.tsx`, `ConnectedScopePill.tsx`, gateway status computed inline in `SettingsPanel.tsx` (local state, no named hook)      | REUSE — verify each indicator is reachable; close gap with a small `ShellStatusIndicators` addition if needed                                              |

**Gap (genuine new work):**

- A documented test surface confirming the shell renders all approved states under the WCAG / focus / navigation contract from #523/#524. The implementation adds a small targeted test file under `packages/keiko-ui/src/app/components/desktop/`, not a new shell component.

### #527 — Implement governed workspace interaction substrate, commands, undo

| Capability                                | Existing Keiko surface                                                                                            | Disposition                                                                                                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection state for workspace objects     | `useWorkspace` exposes focus and z-ordering for windows                                                           | EXTEND — formalize selection semantics for multi-window selection where the UX blueprint requires it                                                                                                                          |
| Keyboard handling                         | Existing palette open shortcut + Header buttons                                                                   | EXTEND — add the minimum shortcut set documented by #523                                                                                                                                                                      |
| Contextual command model                  | `modals/CommandPalette.tsx` already routes typed `Command` records                                                | REUSE                                                                                                                                                                                                                         |
| Undo/redo boundary                        | `packages/keiko-contracts/src/workspace-ui.ts`, `hooks/useUndoStack.ts`, `shell-undo-bindings.ts`, `AppShell.tsx` | NEW at audit time, now landed on `dev` as a typed undo stack scoped to UI-state actions. The substrate refuses by type to rewrite evidence, executed commands, applied patches, verification records, and model-call records. |
| Context-menu and inspector action routing | `InspectorPanel` + `PermControl`                                                                                  | EXTEND if the UX blueprint requires a right-click menu; otherwise REUSE                                                                                                                                                       |
| Optional canvas/graph interaction hooks   | `useWorkspace` already exposes pan, zoom, pointer behavior, connection state                                      | REUSE                                                                                                                                                                                                                         |

**Gap (genuine new work, now landed on `dev`):**

- A typed undo/redo action contract in `packages/keiko-contracts/src/workspace-ui.ts`, a small undo stack hook in `hooks/useUndoStack.ts`, and shell wiring in `shell-undo-bindings.ts` + `AppShell.tsx`.
- A keyboard matrix implementation in `hooks/useKeyboardShortcuts.ts`, wired into the production shell through `AppShell.tsx`.

### #528 — Implement minimal workspace object registry + persistence contract

| Capability                                                                                    | Existing Keiko surface                                                                                                                                                  | Disposition                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed object registry                                                                         | `windows/WindowsRegistry.ts` + `registerWindowRender`                                                                                                                   | REUSE — registry exists                                                                                                                                           |
| Object descriptors (title, icon, default size, config schema, render fn, tool/singleton flag) | `WindowTypeDef` in `WindowsRegistry.ts` plus `WIN_META` in `windows/descriptor-meta.ts`                                                                                 | EXTEND — keep the registry as the object taxonomy seam, and land governance metadata as a sidecar `WorkspaceDescriptorMeta` table rather than a parallel registry |
| Identity for workspace objects                                                                | Existing window `id` (string), `AppWindow.id`                                                                                                                           | REUSE                                                                                                                                                             |
| Persistence boundary                                                                          | UI hooks own transient state; `useWorkspace` persists the current workspace layout to browser `localStorage`; `keiko-evidence` owns evidence; `keiko-workspace` owns FS | REUSE — document the current browser-local layout seam accurately and keep durable / transient / evidence references separate at the descriptor level             |
| UI integration to list, inspect, route supported objects                                      | `Workspace.tsx` renders windows; `InspectorPanel.tsx` inspects; `CommandPalette` routes via the registry                                                                | REUSE                                                                                                                                                             |
| Validation behavior                                                                           | Existing contracts validators in `keiko-contracts`                                                                                                                      | REUSE — add a small descriptor validator                                                                                                                          |
| Evidence-safe references                                                                      | Existing `keiko-evidence` redacted manifests; window types that surface evidence already do so through evidence routes                                                  | REUSE — descriptor records the evidence boundary explicitly                                                                                                       |

**Gap (genuine new work, now landed on `dev`):**

- A `WorkspaceDescriptorMeta` contract in `packages/keiko-contracts/src/workspace-descriptors.ts` plus the `WIN_META` sidecar table in `packages/keiko-ui/src/app/components/desktop/windows/descriptor-meta.ts`.
- A metadata validator (`validateWorkspaceDescriptorMeta`) that enforces closed-set and boundary-consistency rules for `authority`, `trustBoundary`, and `persistence`.
- Tests that pin the contract and sidecar table in `workspace-descriptors.test.ts` and `descriptor-meta.test.ts`.

### #529 — Implement approved independent canvas + graph substrate primitives

| Capability                                           | Existing Keiko surface                                                                                                                           | Disposition                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| World coordinates, camera, viewport, pan, zoom       | `Workspace.tsx` + `useWorkspace` + `View { zoom, x, y }`                                                                                         | REUSE — already implemented, no new substrate needed                    |
| Hit testing, object bounds                           | `useWorkspace` window placement; `windows/connectionUtils.ts` for connection hit                                                                 | REUSE                                                                   |
| Renderer abstraction                                 | `Workspace.tsx` direct DOM rendering + `WorkspaceShader` background                                                                              | REUSE                                                                   |
| Fit-to-view / reset-view                             | `useWorkspace` exposes `resetView` and the underlying camera state; a dedicated fit-to-view helper is not exposed on `dev`                       | REUSE for reset-view / DEFER for fit-to-view                            |
| Minimal graph primitives                             | `app/local-knowledge/connector-graph.tsx` for capsule graph + `windows/ConnectionsLayer.tsx` for workspace-level connections + `Connection` type | REUSE                                                                   |
| Performance guardrails                               | Current-scale workspace behavior is covered by existing workspace/UI tests; large-object performance evidence is not recorded on `dev`           | REUSE at current scale / DEFER for representative large-object evidence |
| Accessibility alternatives for pointer-driven canvas | Existing keyboard rail and command palette                                                                                                       | REUSE                                                                   |

**Audit verdict for #529:** the canvas and graph substrates already exist in Keiko (`Workspace` for canvas, `connector-graph` + `ConnectionsLayer` for graph), each implemented with the existing stack and zero new dependencies. A separately built independent canvas / graph substrate would be a parallel subsystem and is forbidden by the epic's reuse gate.

**Recommendation:** #525's architecture ADR records the existing surfaces as the substrate. #529 is closed with documented deferral evidence pointing to `Workspace.tsx`, `useWorkspace.ts`, `windows/ConnectionsLayer.tsx`, and `local-knowledge/connector-graph.tsx`. This is the explicit path the epic's required implementation order anticipated: _"Implement #529 only if #525 explicitly approves canvas or graph substrate scope and #545 confirms there is no sufficient existing Keiko capability to extend; otherwise close #529 with documented deferral evidence."_

### #530 — Harden a11y / perf / security / evidence / supply-chain

| Capability                | Existing Keiko surface                                                                                                                                    | Disposition                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| A11y CI gate              | `jest-axe` + `axe-core` in `keiko-ui` devDeps; `*.a11y.test.tsx` files exist                                                                              | REUSE — run axe across new surfaces                             |
| Perf evidence             | Existing Workspace performance characteristics + `keiko-quality-intelligence`                                                                             | REUSE                                                           |
| Security review           | `keiko-security` redactor; `keiko-tools` terminal-policy; `keiko-workspace` path containment; `keiko-evidence` redacted manifests; Model Gateway boundary | REUSE — verify no new boundary surface added                    |
| Evidence boundary         | `keiko-evidence` redacted-by-construction manifests                                                                                                       | REUSE — verify new surfaces persist only through approved seams |
| Supply-chain verification | `package.json` manifests; lockfile; `dependency-cruiser` rules in `.dependency-cruiser.cjs` (gated by `npm run arch:check`)                               | REUSE — verify no new runtime/devDep introduced by Wave 4       |
| Regression verification   | `npm test`, `npm run lint`, `npm run typecheck`, `npm run arch:check`, `npm run arch:check:negative`, `npm run build`, CI required checks                 | REUSE                                                           |

**Gap (genuine new work):** none. #530 is verification of the hardening properties already enforced by existing gates against any deltas Wave 4 adds.

### #531 — Closure evidence

| Capability                | Existing Keiko surface                                                                                | Disposition |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ----------- |
| Closure evidence record   | Prior epic closure pattern (`docs/historical/**`, epic-final-comment pattern from #423 / #270 / #142) | REUSE       |
| Verification command list | Existing `package.json` scripts                                                                       | REUSE       |
| Follow-up issue creation  | `gh issue create` per existing process                                                                | REUSE       |
| Delivery board update     | Existing `gh project item-edit` GraphQL pattern                                                       | REUSE       |

**Gap (genuine new work):** none. #531 is a coordination + documentation step.

## Gap matrix (true new work)

Across all child issues, the genuine capability gaps are:

| Gap                                                                                                                                       | Where it lands                                                                                                                                                 | Scope cap                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Documented capability audit (this doc), reference analysis, product boundary, UX blueprint, UI blueprint, architecture blueprint, ADR set | `docs/workspace/518-*.md` and `docs/adr/ADR-0026...0030.md` (or adjacent ADR numbers)                                                                          | Documentation only                                          |
| Descriptor governance metadata (`lifecycle`, `trustBoundary`, `authority`, `persistence`) plus a small validator                          | `packages/keiko-contracts/src/workspace-descriptors.ts`, `packages/keiko-ui/src/app/components/desktop/windows/descriptor-meta.ts`, `descriptor-meta.test.ts`  | One shared contract file, one sidecar table, targeted tests |
| Typed undo/redo action contract, undo stack hook, refusal-by-type for evidence/patch/verification/model-call mutations                    | `packages/keiko-contracts/src/workspace-ui.ts`, `packages/keiko-ui/src/app/components/desktop/hooks/useUndoStack.ts`, `shell-undo-bindings.ts`, `AppShell.tsx` | Shared contract + one hook + bounded shell integration      |
| Minimum keyboard-shortcut matrix wiring (per #523)                                                                                        | `packages/keiko-ui/src/app/components/desktop/hooks/useKeyboardShortcuts.ts`, `AppShell.tsx`                                                                   | One hook + bounded shell integration                        |
| Targeted shell + interaction + registry tests that fail on regressions                                                                    | Existing `*.test.tsx` pattern under `packages/keiko-ui/src/app/components/desktop/`                                                                            | Test files only                                             |
| Closure evidence + follow-up issue list                                                                                                   | `docs/workspace/518-closure-evidence.md` plus epic comment                                                                                                     | Documentation only                                          |

Total new TypeScript implementation code introduced by Epic #518 is therefore bounded to: one shared interaction contract surface, one shared descriptor-meta contract surface, one descriptor-meta sidecar table, one undo-stack hook, one keyboard-shortcut hook, a small shell integration layer in existing `AppShell` / `InspectorPanel` surfaces, and the targeted tests that cover them. No new package. No new dependency. No new persistence backend.

## Stop-condition triggers

A downstream child issue MUST stop and ping the maintainer if any of the following becomes true during implementation:

- The implementation proposes a new package (`packages/keiko-canvas`, `packages/keiko-graph`, `packages/keiko-workspace-objects`, etc.). The substrate already exists in `keiko-ui` and the registry already exists.
- The implementation proposes a new `react-dnd` / `react-flow` / `xstate` / `zustand` / `valtio` / `tldraw` / `excalidraw` / `framer-motion` / `dnd-kit` / `dagre` / `elkjs` / `cytoscape` runtime dependency. Rejected by the epic's no-new-dependency invariant and by the architecture invariants.
- The implementation proposes a parallel state-management library (Redux, MobX, Zustand, Recoil, Jotai). Existing state seams in `useWorkspace`, `ChatSessionContext`, `TwinContext`, `WsContext`, and individual feature hooks already cover the required ownership.
- The implementation proposes a new BFF route family that duplicates `evidence`, `local-knowledge`, `memory`, `terminal`, `browser`, `chat`, or `files` routes.
- The implementation proposes a new evidence store / persistence store / canvas store. Rejected by ADR-0019 and by the evidence package ownership.
- The implementation proposes a runtime plugin host beyond the existing `registerWindowRender` extension contract.
- The implementation removes or relaxes any of: model-gateway boundary, workspace path containment, terminal-policy command boundary, patch validator, evidence redaction.
- The implementation copies source code from tldraw / Excalidraw / AFFiNE / React Flow. Rejected by the epic's reference-use rules.

## Tracing matrix back to the epic Definition of Done

| Epic DoD bullet                                                                                                                  | How this audit addresses it                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| All child issues closed with AC and Expected Verification updated                                                                | Audit names a disposition for each child; #529 is recommended for documented deferral and the remainder are tightly scoped extensions       |
| Required GitHub checks green on implementation PRs                                                                               | All implementation work lands inside `packages/keiko-ui` which is covered by the required `ci`, `ui`, and `Build, scan, SBOM, smoke` checks |
| Reference analysis, UX, UI, architecture blueprints + ADRs linked                                                                | Audit specifies which `docs/workspace/518-*.md` and `docs/adr/ADR-00xx-*.md` files Wave 1–3 will add                                        |
| Production implementation preserves Model Gateway, workspace containment, controlled execution, patch safety, evidence-redaction | Audit confirms no Wave 4 deltas cross these boundaries; gap matrix is bounded to descriptor fields, undo stack, keyboard hook, tests        |
| Accessibility and performance documented with evidence, not stated as intent                                                     | Audit references existing `jest-axe`/`axe-core` infrastructure and existing `*.a11y.test.tsx` pattern that Wave 6 will extend               |
| Closure evidence confirms no new third-party dependencies                                                                        | Gap matrix introduces zero new dependencies; audit makes this a hard stop condition                                                         |

## References

- Epic: [#518](https://github.com/oscharko-dev/Keiko/issues/518)
- Child: [#545](https://github.com/oscharko-dev/Keiko/issues/545)
- Repository HEAD at audit time: `d834195d` on `dev`
- Workspace shell entry: [packages/keiko-ui/src/app/components/desktop/KeikoDesktop.tsx](../../packages/keiko-ui/src/app/components/desktop/KeikoDesktop.tsx)
- Workspace shell composition: [packages/keiko-ui/src/app/components/desktop/AppShell.tsx](../../packages/keiko-ui/src/app/components/desktop/AppShell.tsx)
- Workspace canvas surface: [packages/keiko-ui/src/app/components/desktop/Workspace.tsx](../../packages/keiko-ui/src/app/components/desktop/Workspace.tsx)
- Window-type registry: [packages/keiko-ui/src/app/components/desktop/windows/WindowsRegistry.ts](../../packages/keiko-ui/src/app/components/desktop/windows/WindowsRegistry.ts)
- Registry extension binding: [packages/keiko-ui/src/app/components/desktop/widgets/index.tsx](../../packages/keiko-ui/src/app/components/desktop/widgets/index.tsx)
- Workspace state hook: [packages/keiko-ui/src/app/components/desktop/hooks/useWorkspace.ts](../../packages/keiko-ui/src/app/components/desktop/hooks/useWorkspace.ts)
- Command palette: [packages/keiko-ui/src/app/components/desktop/modals/CommandPalette.tsx](../../packages/keiko-ui/src/app/components/desktop/modals/CommandPalette.tsx)
- Connections / connection state: [packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx](../../packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx)
- Connector graph (local-knowledge): [packages/keiko-ui/src/app/local-knowledge/connector-graph.tsx](../../packages/keiko-ui/src/app/local-knowledge/connector-graph.tsx)
