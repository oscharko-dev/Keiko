# Epic #518 — Governed Workspace UI Blueprint

Status: Wave 2 deliverable for [issue #524](https://github.com/oscharko-dev/Keiko/issues/524) under parent epic [#518](https://github.com/oscharko-dev/Keiko/issues/518).

Audit date: 2026-06-06. Builds on [518-capability-audit.md](518-capability-audit.md), [518-reference-analysis.md](518-reference-analysis.md), [518-product-boundaries.md](518-product-boundaries.md), and [518-ux-blueprint.md](518-ux-blueprint.md).

## Purpose

This document defines the UI blueprint for Keiko's governed workspace foundation: layout, panel/inspector/overlay behavior, visual hierarchy, object presentation, responsive behavior, the visual state catalogue, and the accessibility-driven UI requirements that implementation issues #526–#530 must satisfy.

It locks the production workspace UI on the **existing** desktop shell composition (`AppShell` → `LeftRail` / `Header` / `Workspace` / `RightRail` / `Footer` / `modals/*` / `widgets/cards/*` / `widgets/panels/*`) and uses only the **existing** stack (Next.js App Router, React, Tailwind tokens already in `globals.css`, the `Icons.tsx` SVG set). Zero new third-party UI, design, animation, icon, or gesture libraries.

## Workspace shell layout specification

### Regions (top-level)

```
+--------------------------------------------------------------------+
|                              Header                                 | <- workspace tabs, command palette CTA, mode switch, editor menu
+------+----------------------------------------------------+--------+
|      |                                                    |        |
| Left |                                                    | Right  |
| Rail |               Workspace surface                    | Rail   |
|      |     (windows, connections, shader background)      |        |
|      |                                                    |        |
+------+----------------------------------------------------+--------+
|                              Footer                                 | <- status indicators: project, model, workflow, evidence, install
+--------------------------------------------------------------------+
```

| Region    | Existing surface | Width / height contract                                                                  |
| --------- | ---------------- | ---------------------------------------------------------------------------------------- |
| Header    | `Header.tsx`     | Full width; `46px` height (`.header` rule in `globals.css`); always visible              |
| LeftRail  | `LeftRail.tsx`   | `50px` width (`.rail` rule in `globals.css`); always visible; collapsible per memory #63 |
| Workspace | `Workspace.tsx`  | Flex-grow remainder; pannable/zoomable                                                   |
| RightRail | `RightRail.tsx`  | Fixed narrow column when open; collapsible via `Alt+I`; default open on wide viewports   |
| Footer    | `Footer.tsx`     | Full width; `46px` height (`.footer` rule in `globals.css`); always visible              |
| Modals    | `modals/*`       | Fixed-position overlay; focus-trapped while open                                         |

### Stacking

| Layer               | z-index          | Members                                                                             |
| ------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| Background          | 0                | `WorkspaceShader`                                                                   |
| Connections         | 100              | `ConnectionsLayer` SVG edges                                                        |
| Windows             | 200+ z-of-window | `WindowFrame` per `AppWindow`                                                       |
| Drag overlay        | 800              | While dragging a window                                                             |
| Notifications toast | 900              | Transient `aria-live="polite"`                                                      |
| Modal backdrop      | 1000             | `CommandPalette`, `Palette`, `NewWindowDialog`, `GatewaySetupDialog`, `PermControl` |
| Install banner      | 1100             | PWA install prompt                                                                  |

## Panel, inspector, overlay, dialog, notification behavior

### Panels (`widgets/panels/*`)

Panels are workspace windows classified as `tool` in `WindowsRegistry`. They are docked-feeling but rendered as windows so the user may move them.

| Panel               | Existing surface     | Default position    | Persistence              |
| ------------------- | -------------------- | ------------------- | ------------------------ |
| Project             | `ProjectPanel`       | LeftRail-anchored   | Durable                  |
| Search              | `SearchPanel`        | LeftRail-anchored   | Transient                |
| Plugins             | `PluginsPanel`       | LeftRail-anchored   | Durable                  |
| Automations         | `AutomationsPanel`   | LeftRail-anchored   | Durable                  |
| Keiko mobile        | `MobilePanel`        | LeftRail-anchored   | Durable                  |
| Inspector           | `InspectorPanel`     | RightRail-anchored  | Transient                |
| Activity / Timeline | `TimelinePanel`      | RightRail-anchored  | Transient                |
| Notifications       | `NotificationsPanel` | RightRail-anchored  | Durable per unread count |
| Resources           | `ResourcesPanel`     | RightRail-anchored  | Transient                |
| Settings            | `SettingsPanel`      | Modal-like centered | Durable                  |
| Keiko Twin          | `KeikoTwinPanel`     | LeftRail top entry  | Durable                  |

### Inspector behavior

- The `InspectorPanel` updates when window focus changes (per [UX blueprint](518-ux-blueprint.md) selection model).
- For evidence-bearing objects, the inspector shows a "View evidence" affordance.
- For workflow-run objects, the inspector shows last run status, last verification record, and the apply / verify / dismiss authority actions.
- The inspector is empty (with explicit empty-state copy) when nothing is focused.

### Overlays / dialogs

| Overlay              | Existing surface                  | Purpose                                                             |
| -------------------- | --------------------------------- | ------------------------------------------------------------------- |
| `CommandPalette`     | `modals/CommandPalette.tsx`       | Discovery + run of typed commands                                   |
| `Palette`            | `modals/Palette.tsx`              | Theme/density/UX palette controls                                   |
| `NewWindowDialog`    | `modals/NewWindowDialog.tsx`      | Configure a new window when its config schema requires fields       |
| `GatewaySetupDialog` | `modals/GatewaySetupDialog.tsx`   | Configure or repair the Model Gateway                               |
| `PermControl`        | `modals/PermControl.tsx`          | Authority-moment confirmation (apply / verify / dismiss / escalate) |
| `AgentGateCard`      | `widgets/cards/AgentGateCard.tsx` | Inline review surface (in `ReviewWidget`)                           |
| `InstallBanner`      | `install/InstallBanner.tsx`       | PWA install prompt (ADR-0024)                                       |

### Notifications

- Transient: rendered top-right; auto-dismiss in 6s; `aria-live="polite"`.
- Persistent: queued in `NotificationsPanel`; persist as long as state requires; `aria-live="assertive"` only for blocking notifications.

## Visual hierarchy

Visual emphasis (size, contrast, motion) is allocated by **authority criticality**, not by feature recency:

| Tier                           | Visual treatment                                          | Examples                                                         |
| ------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------- |
| **Tier 1 — Authority moments** | Largest CTA, accent color, focus on open, `role="dialog"` | `PermControl`, `AgentGateCard`, model selection, project connect |
| **Tier 2 — Active object**     | Elevated card background, focus ring, distinct shadow     | Focused workspace window, active panel row                       |
| **Tier 3 — Available objects** | Default card style                                        | Inactive windows, idle panels                                    |
| **Tier 4 — Status surfaces**   | Quiet color tokens, no motion                             | Footer indicators, inspector summary, breadcrumbs                |
| **Tier 5 — Ambient / chrome**  | Minimal contrast, decorative only                         | `WorkspaceShader`, rail backgrounds                              |

Visual hierarchy never reverses authority: a tier-5 chrome element does not become a tier-1 authority moment via animation; an authority moment never demotes to ambient noise.

## Object presentation patterns

### First-class object visual patterns

| Object                                          | Card / panel pattern                                                                                                                           | Distinct visual marker             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **Repository context** (`project`, `files`)     | Tree list with status pill (`connected` / `degraded`)                                                                                          | Folder icon, status pill           |
| **Conversation** (`chat`)                       | Bubble list, composer at bottom, streaming target with `aria-live`                                                                             | Avatar / role marker               |
| **Workflow run** (`agents`, `integ`)            | Step list with lifecycle pill (`proposed` → `running` → `verified`)                                                                            | Workflow icon, lifecycle pill      |
| **Generated patch** (`review`)                  | Diff renderer with apply / verify / dismiss                                                                                                    | `AgentGateCard` review framing     |
| **Verification result** (`review/verification`) | Step / log list with terminal-state pill                                                                                                       | Verification icon                  |
| **Evidence artifact** (`review/evidence`)       | Read-only manifest renderer; export emits the `keiko-evidence` redacted bundle only — never raw model output, secrets, or unredacted artifacts | Evidence icon, redacted-only badge |
| **Terminal session** (`terminal`)               | Monospace output with input prompt                                                                                                             | Terminal icon                      |
| **Browser tab** (`browser`)                     | Iframe-style sandboxed embed                                                                                                                   | Browser icon                       |
| **Editor view** (`editor`)                      | Monaco-style editor (existing)                                                                                                                 | Editor icon                        |
| **Settings** (`settings`)                       | Form sections                                                                                                                                  | Gear icon                          |
| **Notifications** (`notifications`)             | Stack of dismissible cards                                                                                                                     | Bell icon, unread count badge      |
| **Activity / Timeline** (`activity`)            | Vertical timeline with timestamps                                                                                                              | Clock icon                         |
| **Resources** (`resources`)                     | Grid of resource cards                                                                                                                         | Stack icon                         |
| **Inspector** (`inspector`)                     | Property list + actions                                                                                                                        | Inspector icon                     |
| **Mobile pairing** (`mobile`)                   | QR + pairing state                                                                                                                             | Phone icon                         |
| **Search** (`search`)                           | Input + result list                                                                                                                            | Search icon                        |
| **Plugins** (`plugins`)                         | List of plugin entries with enable/disable                                                                                                     | Plugins icon                       |
| **Automations** (`automations`)                 | List of automation descriptors                                                                                                                 | Automations icon                   |
| **Keiko Twin** (`keiko`)                        | Status + recent memory + governance pill                                                                                                       | Keiko logo                         |

### Extension-ready future object patterns

| Future object     | Recommended visual pattern                                      | Reuses                                        |
| ----------------- | --------------------------------------------------------------- | --------------------------------------------- |
| Agent profile     | Compact card with provider, role, allowed tools, gateway status | Existing card pattern                         |
| MCP tool          | Tool card with allowlist surface, authority hint                | Existing card pattern                         |
| Connector         | Source card with allowlist surface + denied-paths summary       | Existing card pattern                         |
| Data source       | Source card with redaction notice + provenance                  | Existing card pattern                         |
| Document object   | Reader pane + inspector                                         | Existing editor + inspector                   |
| Knowledge object  | Capsule renderer                                                | Existing capsule UI                           |
| Skill / template  | Compact card with input schema preview                          | Existing card pattern                         |
| Graph node / edge | Connector-graph node + connection                               | Existing connector graph + `ConnectionsLayer` |

## Responsive behavior

| Width band                      | Layout adjustments                                                                                                    | Authority-moment treatment                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Ultra-wide (≥ 1920px)**       | RightRail always open; multiple inspector tabs visible                                                                | Unchanged                                                     |
| **Standard desktop (≥ 1280px)** | LeftRail visible; RightRail open by default                                                                           | Unchanged                                                     |
| **Narrow desktop (≥ 1024px)**   | LeftRail visible; RightRail collapses to icon strip; modals at max-width                                              | Unchanged                                                     |
| **Laptop (≥ 768px)**            | LeftRail collapsible; RightRail collapsed by default; modals at 90vw                                                  | Unchanged                                                     |
| **Mobile inspection (≥ 360px)** | LeftRail as drawer (open by gesture); RightRail as drawer; modals full-screen; commands accessible via palette button | Authority moments take the full sheet — never partial overlay |

The workspace is desktop-first; mobile width is for inspection, not for primary work. The existing `KeikoTwinPanel` mobile pairing flow is the alternate primary surface on phones.

## Visual state catalogue

The blueprint mandates these states are implemented as production states, not placeholders.

| State                      | Visual rules                                                                                                                                  | Existing pattern to reuse                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Empty**                  | Centered icon + 1-line instruction + primary CTA with keyboard hint                                                                           | `lk-empty` style; `ComposerEmptyState`                                                 |
| **Loading**                | Skeleton blocks; `aria-busy`; no spinning until > 500ms                                                                                       | `lk-loading` skeleton                                                                  |
| **Streaming**              | Inline streaming target; `aria-live="polite"` with announced summary at completion                                                            | `GroundedAnswer` streaming pattern                                                     |
| **Success**                | Quiet success state; Footer status indicator only                                                                                             | Existing Footer pattern                                                                |
| **Review-needed**          | Distinct elevated card with explicit actions                                                                                                  | `AgentGateCard`                                                                        |
| **Blocked**                | Warning border + blocking explanation + suggested action                                                                                      | `lk-alert` block variant                                                               |
| **Warning**                | Amber border + warning copy                                                                                                                   | `lk-alert` warning variant                                                             |
| **Error**                  | `role="alert"` (implies `aria-live="assertive"`); explanation of what failed, what wasn't changed, what to try; retry CTA only when retryable | `lk-alert` error variant                                                               |
| **Offline / disconnected** | Footer offline indicator; affected widgets show offline copy with reconnect CTA                                                               | Footer status                                                                          |
| **Stale**                  | Inline stale badge on the affected row; refresh CTA; `aria-live="polite"` on state change                                                     | Reuse Footer status pattern + `lk-alert` warning variant where the row is also blocked |
| **Degraded**               | Footer degraded indicator; per-widget degraded copy at point-of-use                                                                           | Footer status                                                                          |

## Where authority, verification, evidence, and review appear

| Concept             | Primary visible surface                      | Secondary surface                    |
| ------------------- | -------------------------------------------- | ------------------------------------ |
| Authority moment    | `PermControl` modal / `AgentGateCard` inline | Inspector action toolbar             |
| Verification result | `ReviewWidget` verification tab              | Inspector + Footer indicator         |
| Evidence reference  | `ReviewWidget` evidence tab                  | Inspector "View evidence" affordance |
| Review state        | `ReviewWidget` review tab                    | Inspector lifecycle pill             |
| Model availability  | Footer status indicator                      | Header model selector                |
| Connected project   | Footer status indicator + Header tab         | `ConnectedScopePill` in `ChatWindow` |
| Workflow readiness  | Footer status indicator                      | Inspector workflow descriptor        |

## Visual rules (locked from existing Keiko patterns)

These rules MUST NOT regress.

| Rule                                                                                                                                                                                                                                                                                                                                                          | Existing source                                                                                                                 | Notes                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color tokens — backgrounds: `--bg`, `--surface`, `--card`, `--inset`; foregrounds: `--fg`, `--fg-muted`, `--fg-dim`, `--fg-faint`, `--ink-inverse`, `--ink-muted`; accent: `--accent`, `--accent-bright`, `--accent-dim`, `--accent-line`, `--accent-glow`; status: `--ok`, `--warn`, `--info`, `--danger`; borders: `--line`, `--line-soft`, `--line-strong` | `globals.css`                                                                                                                   | No new color tokens added by Wave 4                                                                                                                                           |
| Theme system                                                                                                                                                                                                                                                                                                                                                  | `useTheme.ts`, `data-theme="light"/"dark"`, `color-scheme: dark` on `:root` and `color-scheme: light` on `[data-theme="light"]` | No new theme                                                                                                                                                                  |
| Contrast: `--ink-inverse` on `--accent` (#4EBA87) = 6.94:1 (PASS)                                                                                                                                                                                                                                                                                             | Memory pattern #63                                                                                                              | Do NOT pair near-white text (`--fg`, pure `#ffffff`) directly on `--accent` (≈2.4–2.9:1 FORBIDDEN). Use `--ink-inverse` (oklch ≈ 0.18) for any text on the accent background. |
| Contrast: `--fg-dim` and `--ink-muted` (both oklch 0.58) sit below 3:1 on chrome surfaces — reserved for incidental, non-informational labels                                                                                                                                                                                                                 | Memory pattern #63                                                                                                              | Not for informational tooltip text. Use `--fg-muted` (oklch 0.74, ≥4.5:1) for any text that must remain readable.                                                             |
| Hit target: ≥ 24×24 logical px for all interactives; ≥ 30×30 for primary controls                                                                                                                                                                                                                                                                             | Memory pattern + connector graph                                                                                                | WCAG 2.5.8                                                                                                                                                                    |
| Focus visible: `focus-visible:ring-2 focus-visible:ring-accent` (or equivalent CSS)                                                                                                                                                                                                                                                                           | Memory pattern #67                                                                                                              | Never `focus:outline-none` without replacement                                                                                                                                |
| Reduced motion: `motion-safe:` prefix or `@media (prefers-reduced-motion)` gates                                                                                                                                                                                                                                                                              | Memory pattern #66                                                                                                              | Required for any non-essential motion                                                                                                                                         |
| Icon-only buttons: `aria-label` always set                                                                                                                                                                                                                                                                                                                    | Existing `Icons.tsx` callsites                                                                                                  | WCAG 4.1.2                                                                                                                                                                    |
| `<button aria-pressed>` for toggles, not `role="radio"`                                                                                                                                                                                                                                                                                                       | Memory pattern #67                                                                                                              | Avoids roving-tabindex trap                                                                                                                                                   |
| Status: `aria-live="polite"` for benign progress; `aria-live="assertive"` only for blocking                                                                                                                                                                                                                                                                   | Memory pattern #66                                                                                                              | Spec-conformant announcements                                                                                                                                                 |

## Accessibility-driven UI requirements (delta from UX blueprint)

The UX blueprint owns the behavioral contract; this blueprint owns the **visible** contract:

1. Focus ring is consistent: `--accent` color, `2px ring`, `2px offset`, never disabled.
2. Disabled controls render their disabled reason in tooltip + palette (per UX command record `disabled()` return).
3. Authority moments visually distinguish "Apply" from "Dismiss" via color (accent vs neutral) and via size (Apply is the primary CTA).
4. Status indicators in the Footer use icon + label + color; never color alone.
5. Modals trap focus, restore focus on close, label themselves via `aria-labelledby` + `aria-describedby`.
6. Long-running progress shows ETA estimate when measurable; otherwise indeterminate with status copy.
7. Drag-and-drop has keyboard equivalent for every drag interaction the workspace exposes (window move via arrow keys; connection draw via command).

## Implementation notes for #526

The shell delta needed for #526 is small because everything above already exists. The implementation issue must:

1. Verify each state in the visual catalogue is reachable with a known route or command (write tests to confirm).
2. Verify each tier-1 authority moment satisfies tier-1 visual treatment (focused on open, accent CTA, role="dialog").
3. Verify responsive breakpoints honour the contract above on the existing CSS.
4. Verify the visual rules above with an `axe-core` sweep and a contrast spot-check across the catalogue.

No new component is created by #526 beyond a small `ShellStatusIndicators` aggregator if `Footer.tsx` does not already cover the 4 required indicators (project / model / workflow / evidence).

## Acceptance Criteria evidence

| #524 AC                                                                                                      | Where in this document                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| The first screen is a usable work surface, not marketing                                                     | "Workspace shell layout specification" + "Entry behaviors" (UX blueprint)                                          |
| Layout supports the primary journeys                                                                         | Layout regions ↔ journey table ([518-product-boundaries.md](518-product-boundaries.md) § Primary journeys)         |
| UI states cover empty / loading / streaming / success / review / blocked / warning / error / offline / stale | "Visual state catalogue"                                                                                           |
| Blueprint explains where evidence, authority, verification, review appear                                    | "Where authority, verification, evidence, and review appear"                                                       |
| Responsive behavior avoids overlap / inaccessibility / hidden actions                                        | "Responsive behavior"                                                                                              |
| Preserves existing Keiko UI patterns; only scoped improvements where insufficient                            | "Visual rules" + "Implementation notes for #526"                                                                   |
| No new third-party dependency                                                                                | Implicit — uses only `next`, `react`, `react-dom`, existing CSS, existing Icons; explicit rules section reinforces |

## References

- Epic: [#518](https://github.com/oscharko-dev/Keiko/issues/518)
- Child: [#524](https://github.com/oscharko-dev/Keiko/issues/524)
- Companions: [518-capability-audit.md](518-capability-audit.md), [518-reference-analysis.md](518-reference-analysis.md), [518-product-boundaries.md](518-product-boundaries.md), [518-ux-blueprint.md](518-ux-blueprint.md)
- Shell composition: [packages/keiko-ui/src/app/components/desktop/AppShell.tsx](../../packages/keiko-ui/src/app/components/desktop/AppShell.tsx)
- Panels: [packages/keiko-ui/src/app/components/desktop/widgets/panels/](../../packages/keiko-ui/src/app/components/desktop/widgets/panels/)
- Cards: [packages/keiko-ui/src/app/components/desktop/widgets/cards/](../../packages/keiko-ui/src/app/components/desktop/widgets/cards/)
- Modals: [packages/keiko-ui/src/app/components/desktop/modals/](../../packages/keiko-ui/src/app/components/desktop/modals/)
- Theme: [packages/keiko-ui/src/app/components/desktop/hooks/useTheme.ts](../../packages/keiko-ui/src/app/components/desktop/hooks/useTheme.ts)
