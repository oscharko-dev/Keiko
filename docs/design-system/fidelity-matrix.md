# Deliverable 1 — Design System Fidelity Matrix

Parent Epic: [#1290](https://github.com/oscharko-dev/Keiko/issues/1290). Issue: [#1291](https://github.com/oscharko-dev/Keiko/issues/1291).
Companion: [README.md](README.md) · [token-component-reuse-map.md](token-component-reuse-map.md) · [light-mode-deviation-register.md](light-mode-deviation-register.md) · [visual-qa-matrix.md](visual-qa-matrix.md).

This matrix covers **every visible product surface**, maps it to its rendering files and interaction states,
and assigns an **owner child issue or a documented deferral** (acceptance criterion A). Paths are relative to
the repository root.

> **Snapshot note:** The counts below (16,191-line `globals.css`, 31 `WindowType`s, 32 `registerWindowRender`
> call sites, 77 `.lk-*` rules) are as of the **2026-06-21 audit snapshot (release/0.2.0)**; current counts have
> grown (e.g. `globals.css` is now ~22,658 lines and `registerWindowRender` call sites are 39). They are
> retained as a point-in-time architecture baseline.

## 0. Surface model (read this first)

Keiko-UI is a single-route governed desktop, so a naive route enumeration misses almost every surface:

- One real interactive route: `/` → `KeikoDesktop → AppShell` ([packages/keiko-ui/src/app/page.tsx](../../packages/keiko-ui/src/app/page.tsx)).
- `/launch` and `/local-knowledge` re-export `KeikoDesktop`; the four `/memoriaviva/*` routes are server
  `redirect("/")` stubs ([memoriaviva/page.tsx](../../packages/keiko-ui/src/app/memoriaviva/page.tsx)). `/memoriaviva/detail/MemoryDetailClient.tsx` is orphaned by the redirect.
- `/relationships` exists only as a post-hydration deep-link interception in `AppShell.tsx:576-589` — there is
  no `app/relationships/page.tsx`.
- The only genuine standalone non-shell route is `/local-knowledge/capsule` (renders `CapsuleDetail`, not
  `KeikoDesktop`; `<main class="lk-page">`; 77 `.lk-*` rules in `globals.css`).
- The product's "pages" are **singleton/non-singleton tool windows** — 31 `WindowType`s in `WindowsRegistry.ts`
  with 32 `registerWindowRender` call sites in
  [widgets/index.tsx](../../packages/keiko-ui/src/app/components/desktop/widgets/index.tsx) — framed by `WindowFrame.tsx`.

The entire visual language is one 16,191-line [globals.css](../../packages/keiko-ui/src/app/globals.css) of
global class names. The matrix is therefore a **class-name ⇄ component ⇄ design-spec** mapping, not a route map.

## 1. Routes

| Route                                                           | Nature                                                                 | Key files                                                                                                                                   | Owner                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `/`                                                             | The product (highest traffic)                                          | `app/page.tsx`, `app/layout.tsx`, `components/desktop/KeikoDesktop.tsx`, `components/desktop/AppShell.tsx`                                  | #1293                     |
| `/launch`                                                       | Byte-identical re-export of `/`                                        | `app/launch/page.tsx`                                                                                                                       | #1293 (no unique UI)      |
| `/local-knowledge`                                              | Compat bookmark → opens `localKnowledge` window, normalizes URL to `/` | `app/local-knowledge/page.tsx`, `AppShell.tsx:582`                                                                                          | #1295 (via window)        |
| `/local-knowledge/capsule`                                      | **Standalone non-shell page**                                          | `app/local-knowledge/capsule/page.tsx`, `app/local-knowledge/[capsuleId]/capsule-detail.tsx` + `capsule-actions.tsx` + `capsule-rename.tsx` | #1295                     |
| `/memoriaviva` (+ `/consolidation`, `/detail`, `/review-queue`) | Dead server `redirect("/")` stubs                                      | `app/memoriaviva/**/page.tsx`                                                                                                               | Deferral D1 (dead routes) |
| `/relationships` (deep link)                                    | Opens `relationships` window                                           | `AppShell.tsx:581`                                                                                                                          | #1295 (via window)        |

## 2. App-shell chrome (always-on, highest traffic) — owner #1293

| Surface                                | Key files                                                                                          | Primary states                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Header                                 | `components/desktop/Header.tsx`                                                                    | default / hover / focus (`.hd-tool`), tile/split/cascade tools                                                               |
| Left rail (primary nav + theme toggle) | `components/desktop/LeftRail.tsx`                                                                  | default / hover / focus-visible / active (`data-active`) / pressed (`aria-pressed`)                                          |
| Right rail                             | `components/desktop/RightRail.tsx`                                                                 | **empty spacer, no tools wired** — see Deferral D2                                                                           |
| Footer + window palette                | `components/desktop/Footer.tsx`                                                                    | default / hover / disabled (0 windows) / palette-open / status tones ok·warn·danger / Alt+S focus target                     |
| Workspace canvas + shader + empty blob | `components/desktop/Workspace.tsx`, `WorkspaceShader.tsx`, `EmptyWorkspaceBlob.tsx`                | empty(blob) / default / panning / hand-tool / connecting(valid·invalid) / window-maxed / zoom 30–200%                        |
| Window frame chassis (31 window types) | `components/desktop/windows/WindowFrame.tsx`, `WindowsRegistry.ts`, `windows/ConnectionsLayer.tsx` | top/not-top, max, dragging, conn source·valid·invalid, **density full · mini(<430px) · tiny/TooSmall**, content-zoom 0.5–2.0 |
| PWA install banner + boot recovery     | `components/desktop/install/InstallBanner.tsx`, `app/layout.tsx:46`                                | hidden(standalone·installed·dismissed·unsupported) / supported(CTA) / iOS add-to-home                                        |

## 3. Window-type surfaces (rendered on the canvas)

| Surface (window type)                                                                                                                                       | Key files                                                                                                                                                                                                                  | Primary states                                                                                                                                                                                                   | Owner                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Chat / conversation (`chat`, `chatHistory`)                                                                                                                 | `components/desktop/ChatWindow.tsx`, `context/ChatSessionContext.tsx`, `hooks/useChatSession.ts`, `widgets/panels/ChatHistoryPanel.tsx`                                                                                    | loading / no-model / no-chat / empty / sending·queued·streaming·cancelled / completed / failed / attachment-rejection / memory-panel / density full·mini·minimal·compact                                         | #1295                             |
| AI grounding + workflow handoff (`agents`)                                                                                                                  | `components/desktop/GroundedAnswer.tsx`, `WorkflowHandoff.tsx`, `ContextStatusPanel.tsx`                                                                                                                                   | busy / folder·local-knowledge·hybrid grounding / citations collapsed·expanded / partial-coverage / uncertainty / context status collapsed·expanded / dialog list·form step / run queued·running·succeeded·failed | #1296                             |
| Agent run / gate cards (`agents`)                                                                                                                           | `widgets/cards/AgentRunWidget.tsx`, `widgets/cards/AgentGateCard.tsx`                                                                                                                                                      | loading / queued / running / dry-run / fix-proposed / fix-applied / investigation-only / completed / failed / rejected / cancelled / gate-awaiting-approval / 404                                                | #1296                             |
| Quality Intelligence hub + run cards (`quality`, `qiRun`)                                                                                                   | `widgets/quality-intelligence/{QiHubPanel,QiRunCard,RunLauncher,CandidatesPane,CandidateEditForm,DriftPanel,ExportBar}.tsx`                                                                                                | hub empty·loading·list / launch form / running / qi-badge succeeded·running·cancelled·failed·default / candidate review·edit / drift / export                                                                    | #1295                             |
| Prompt Enhancer (`promptEnhancer`)                                                                                                                          | `widgets/panels/PromptEnhancerPanel.tsx`                                                                                                                                                                                   | raw-input / profile·strategy select / enhancing / enhanced(sections·grounding·safety·schema·scorecards) / error / empty                                                                                          | #1295                             |
| Files + Editor + diff (`files`, `editor`)                                                                                                                   | `widgets/cards/{FilesWidget,FilePreview,EditorWidget,EditorSurface,EditorRuntimeWidget,EditorDiffSurface}.tsx`                                                                                                             | no-root / loading-tree / folder-open / file-selected / Monaco loading·load-error / editing / read-only / diff                                                                                                    | #1295                             |
| Browser / Terminal / Review / Integrations (`browser`, `terminal`, `review`, `integ`)                                                                       | `widgets/cards/{BrowserWidget,TerminalWidget,ReviewWidget,IntegrationsWidget}.tsx`                                                                                                                                         | per-widget idle / running / output / no-runId form / static-list                                                                                                                                                 | #1295 (Integrations: Deferral D3) |
| Local Knowledge hub (`localKnowledge`, `connector`)                                                                                                         | `local-knowledge/connector-graph.tsx`, `connector-graph-state.ts`, `capsule-set-compose.tsx`, `widgets/cards/ConnectorPickerWidget.tsx`                                                                                    | loadStatus loading·error / list / action-busy·error / creating·error / indexing·cancel / disconnect-confirm / compose-set / capsule lifecycle                                                                    | #1295                             |
| MemoriaViva governed memory (`memoria`)                                                                                                                     | `memoriaviva/components/{MemoriaVivaWindow,MemoryList,MemoryFilters,MemoryDetail,MemoryActions,MemoryConsolidation,ReviewQueue,EditMemoryDialog,ForgetConfirmDialog}.tsx`                                                  | sub-view list·detail·consolidation·reviewQueue / filters / policy on·off / edit / forget-confirm / loading·empty·error                                                                                           | #1295                             |
| Relationships engine (`relationships`)                                                                                                                      | `relationships/RelationshipsView.tsx`, `widgets/panels/{RelationshipListPanel,RelationshipInspectorPanel,RelationshipHealthPanel,RelationshipImpactCard,RelationshipEdgeBadge}.tsx`, `modals/RelationshipCreateDialog.tsx` | list density minimal·standard / filtered / selected / inspector(10 sections) / health / impact / create(denial banner) / high-contrast / activity-animated / loading·empty·error                                 | #1295                             |
| Figma snapshot + scoped source windows (`figma`, `figmaView`, `figmaJson`, `figmaImage`)                                                                    | `widgets/figma/{FigmaSnapshotWindow,FigmaJsonSourceWindow,FigmaImageSourceWindow,JsonSyntaxBlock}.tsx`                                                                                                                     | paste-link / building / snapshot grid / screen-selected / JSON-IR / image-render / auto-grow / loading·error·empty                                                                                               | #1295                             |
| Secondary tool panels (`settings`, `project`, `search`, `plugins`, `automations`, `mobile`, `inspector`, `notifications`, `resources`, `timeline`, `keiko`) | `widgets/panels/*.tsx`                                                                                                                                                                                                     | Settings(17 markers), ChatHistory(14) state-rich; Search/Plugins/Automations/Mobile/Notifications/Resources show **0 explicit state markers** — see Deferral D4                                                  | #1295 / D4                        |

> **#1295 status: shipped (value-preserving + light adaptation).** The #1295 high-traffic product-surface class
> blocks in `globals.css` were migrated to consume Tier-3 semantic tokens (chat-, chatw-, grounded-, wf-, qi-\*,
> mc-/memoria-, rel-/rb-, lk-/lkd-/connector-, figma-, fpv-/hl- prefixes; ~330 rules / ~466+30 declarations).
> Categories A/B are value-preserving across dark/HC/forced-colors modes (proven by the 2324-probe, 0-diff
> computed-value harness in [evidence/1295](evidence/1295/) and gated by the `Issue #1295` describe block in
> `globals.css.test.ts`). Category C introduces deliberate Light Mode adaptations: new `--shadow-ink-rgb` primitive
> making Table A required shadow rows light-adaptive with warm ink (20 30 25), centralised `--overlay-scrim` via
> `.mc-dialog-backdrop`. Deferred: AI/agent patterns (#1296), data-grid/lists (#1297), systematic
> spacing/typography/density/breakpoint (#1298), deeper running-Monaco editor visual-regression (#1300). Designer
> approval (◐) stays open pending human sign-off (Human Review Required: Yes).

## 4. Modals / dialogs (portal layer) — owner #1294 (migrate with owning surface) · **shipped**

> **#1294 status: shipped (value-preserving).** The modal/dialog chrome class blocks in `globals.css` now consume
> the Tier-3/4 semantic/component tokens (`--surface-*`, `--border-*`, `--text-*`, `--popover-*`, `--focus-ring`,
> …) — part of the 363-rule / ~550-declaration control migration, proven byte-identical by the 1106-probe, 0-diff
> 7-mode computed-value harness in [evidence/1294](evidence/1294/) and gated by the `Issue #1294` describe block
> in `globals.css.test.ts`. The `required` Light scrim rows (`.dlg-overlay`, `.cmdk-overlay`,
> `.mc-dialog-backdrop`, `.wf-dialog-overlay`, `.gw-setup-backdrop`) stay with **#1295** (shadow/scrim
> tokenisation is a Light visual change).

| Surface                                          | Key files                                                 | Primary states                                           |
| ------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------- |
| Command palette                                  | `components/desktop/modals/UnifiedQuickAccessPalette.tsx` | open / filter / no-results                               |
| Gateway setup dialog                             | `modals/GatewaySetupDialog.tsx`                           | idle / pending / success / error                         |
| New window dialog (entry point for every window) | `modals/NewWindowDialog.tsx`                              | per-type config form / directory-note·error / validation |
| Create picker (non-modal)                        | `modals/Palette.tsx`                                      | non-modal create picker (background stays interactive)   |
| Permission control                               | `modals/PermControl.tsx`                                  | permission grant states                                  |

## 5. Shared controls / input atoms — owner #1294 · **shipped**

> **#1294 status: shipped (value-preserving).** These reusable control / input-atom class blocks in `globals.css`
> were routed from raw primitives (`var(--card)`, `var(--fg)`, `var(--line)`, `var(--danger)`,
> `var(--accent-text)`, …) to the Tier-3/4 semantic/component tokens (`--button-*`, `--input-*`, `--text-*`,
> `--surface-*`, `--border-*`, `--feedback-*`, `--combobox-*`, `--focus-ring`), and the `EditorMenu` inline hex
> tiles migrated too. Kept verbatim as documented non-migrations: the accent-family brand primitives, the
> no-token raw literals (`#fff`, `oklch` amber inks, green Light scrims, disabled opacities `0.45 / 0.55 / 0.6`),
> and the approved `[data-theme="light"]` deviations. No Light-Mode visual change — that fidelity was delivered by
> #1292's mode-aware primitives, which these controls now consume. Evidence: [evidence/1294](evidence/1294/) —
> 1106 computed-value probes, 0 differences across 7 modes; gated by the `Issue #1294` describe block in
> `globals.css.test.ts`.

`KeikoSelect`, `NumberControlStepper`, `widgets/shared/Toggle.tsx`, `ModeSwitch`, `EditorMenu`,
`AttachmentStrip` (+ `AttachButton`/`AttachDropZone`/`AttachRejectionAlert`), `ConnectedScopePill`,
`ConnectorScopePill`, `ScopeConnectButton`, `SafeMarkdown` (+ `SafeMarkdownBoundary`), `ErrorNotice`,
`Icons.tsx`. All under `components/desktop/`. These atoms are reused across nearly every window and are the
core of the token-to-component fidelity check. States per atom are catalogued in
[visual-qa-matrix.md](visual-qa-matrix.md) §3.

## 6. Cross-cutting visual states (every surface multiplies by these)

| Axis                          | Mechanism                                                                                                                                                                              | Owner                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Theme: Dark (default) · Light | `data-theme` via `hooks/useTheme.ts` (storage key `keiko.theme`), bootstrap `layout.tsx:40`                                                                                            | #1292                         |
| High Contrast                 | OS `@media (prefers-contrast: more)` only; in-app `[data-hc]` hook exists but is **editor-only / never set by runtime JS**                                                             | #1292 (add in-app neutral HC) |
| Forced colors (Windows HCM)   | **No `@media (forced-colors)` in `globals.css`** (editor JS only)                                                                                                                      | #1292                         |
| Reduced motion                | 27 `no-preference` opt-in blocks + 3 `reduce` kill-switches + JS rAF guards                                                                                                            | #1293 / #1300                 |
| Input modality (focus-ring)   | `AppShell.tsx:604-625` sets `data-input-modality` pointer·keyboard                                                                                                                     | #1293                         |
| Window density                | `full` · `mini` (<430px) · `tiny`/TooSmall via `WindowFrame.selectBody` (107–175); composer `compact` variants                                                                         | #1298 (formalise) / #1293     |
| Breakpoints                   | 11 unsystematic `max-width` queries: 420·560·620·640·680·700·760·900·1000·1100·1180px; tablet 768–1024px exists only as a documented overflow note (`globals.css:~14060`, WCAG 1.4.10) | #1298                         |

## 7. Surfaces with no migration owner — documented deferrals

These satisfy acceptance criterion A by explicit deferral rather than an owner child issue.

| ID  | Surface                                                                                      | Why deferred / disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `/memoriaviva/*` route stubs + orphaned `MemoryDetailClient.tsx`                             | Dead `redirect("/")` routes render no UI; the live surface is the `memoria` window (owned by #1295). No fidelity work; recommend a separate cleanup issue to delete dead routes (out of epic scope).                                                                                                                                                                                                                                                                                                                                        |
| D2  | Right rail (empty spacer)                                                                    | Renders nothing today; accepts `openTools`/`onTool` props but wires no tools. Defer until a tool set is specified; not a fidelity target for this epic. Flag for product decision.                                                                                                                                                                                                                                                                                                                                                          |
| D3  | Integrations widget (static honest list)                                                     | No real integrations exist yet (uiux-fix F023 C054). Style-only fidelity under #1295; functional wiring is out of epic scope.                                                                                                                                                                                                                                                                                                                                                                                                               |
| D4  | Search / Plugins / Automations / Mobile / Notifications / Resources panels (0 state markers) | Static/placeholder panels. Apply token fidelity opportunistically under #1295; standardise loading/empty/error states under #1299.                                                                                                                                                                                                                                                                                                                                                                                                          |
| D5  | Icon system fidelity                                                                         | Design-system ships a full Lift icon grammar ([Keiko Icon System](../../design-system/) — `Keiko Icon System.html`, `lift-icons.jsx`, `lift-glyphs.js`); product has `components/desktop/Icons.tsx` + 7 inline-`<svg>` files (`KeikoSelect`, `EmptyWorkspaceBlob`, `windows/ConnectionsLayer`, `windows/WindowFrame`, `widgets/panels/RelationshipEdgeBadge`, `widgets/quality-intelligence/RunLauncher`). Reconcile glyph grammar under #1298 (navigation/icon breadth) or #1299 (governance); tracked here so it is not silently dropped. |
| D6  | Content & Voice microcopy + Messages four-level taxonomy                                     | Design-system `content.html` (voice/microcopy) and `messages.html` (error·warn·info·success severity by icon-shape across inline messages, banners, toasts, field errors) have no full product mapping. Product surfaces today: `components/desktop/ErrorNotice.tsx`, `.install-banner-*`, QI/agent status badges, field validation. Map message components under #1294; microcopy/voice governance under #1299.                                                                                                                            |

## 8. Acceptance criterion A — coverage statement

Every visible product surface above is assigned an owner child issue (#1293–#1298) **or** an explicit deferral
(D1–D6). The route reality (single route + 31 windows + standalone capsule page) is fully enumerated; the
cross-cutting axes (theme, contrast, motion, density, breakpoints) are owned by #1292/#1298/#1293/#1300. No
visible surface is left unassigned. The foundation and first two consumer migrations have shipped:
#1292 (token layer), #1293 (app-shell chrome, §2), and #1294 (modals/dialogs §4 + shared controls / input atoms
§5) — all value-preserving, with the per-section status notes and browser evidence under
[evidence/1294](evidence/1294/).
