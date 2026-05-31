# ADR-0014: Keiko Workspace Shell Architecture

## Status

Accepted. Amended on 2026-05-31 after the issue #63 production audit to reflect the shipped
post-#64/#65/#67 shell contract.

This ADR defines the layout host, route-sharing contract, client-state persistence, brand-color
token system, logo delivery, component decomposition, empty-state taxonomy, responsive contract,
read-only mount discipline, and accessibility landmark structure for the Keiko workspace shell.
Implementation lands under `ui/app/layout.tsx`, `ui/app/page.tsx`, `ui/app/launch/**`,
`ui/app/globals.css`, `ui/tailwind.config.ts`, and `ui/app/components/shell/**`.

## Context

Issue #63 replaces the current form-oriented top-navigation UI (a three-link `<header>` above page
content) with a **three-zone workspace shell**: collapsible left sidebar for project navigation,
central chat/composer workspace, and right tool entry area (Files, Browser, Review, Terminal).
Issue #61 is the parent epic. Without the shell, Keiko's UI reads as a demo form surface rather than
a workspace tool suitable for repeated developer use inside a regulated repository.

Five forces shape the design.

**The static-export and zero-runtime-dependency invariants are absolute.** ADR-0011 D1 chose
`output: "export"` + a hand-written Node BFF and documented those as load-bearing constraints.
Any shell layout must be expressible as static React running in a browser, with dynamic data
arriving via client-side fetches to the BFF — no SSR, no server components that read from the
BFF, no new `dependencies:` entries. The shell is a client-side layout concern; it does not
require any new runtime capability.

**The ADR-0013 persistence layer is already shipped.** Issue #62 (PR #70, merged as `5568bf3`)
delivered `GET /api/projects`, `GET /api/chats`, and the full `UiStore` surface. The shell may
read these endpoints on mount to populate the sidebar. The ADR-0013 D9 read-only mount discipline
— no mutating call triggered by rendering — must be extended to the shell layer; a `createProject`
or `deleteProject` call must never fire during shell initialization.

**A three-zone shell introduces genuine CSS layout complexity.** Collapsible regions, a fixed
header, full-viewport height, responsive breakpoints, and accessible focus management are harder
to get right when spread across many ad-hoc component files. The decomposition must be explicit
and small enough that each file has one reason to change, while avoiding the opposite failure of
over-splitting a single logical surface across a dozen tiny components that add indirection without
adding isolation.

**The existing light-blue Tailwind token set is incompatible with the new brand.** The current
`tailwind.config.ts` defines a light palette (`surface: #ffffff`, `ink: #1a1f2b`, `accent:
#1d4ed8`). The brand specifies dark-background, green-accent (`#4EBA87`), dark-gray (`#333333`),
white (`#fff`). Changing the token set is a breaking visual change; every component that uses
`bg-surface`, `text-ink`, `text-accent`, etc. will reflow visually. The ADR must therefore fix
the exact hex values for every semantic token and verify WCAG 2.2 AA contrast for each intended
foreground/background pairing before the first line of implementation is written.

**The CSP forbids inline scripts; the SVG logo must not use `<img src>` for a data-URI.** The
CSP in ADR-0011 D5 sets `script-src 'self'` with no `unsafe-inline`. The logo SVG is currently
at `img/keiko-logo.svg` (outside `ui/`). Shipping it as a `next/image` or `<img src>` referencing
a public asset is possible, but serving it inline as a React component eliminates the asset-path
coordination at build time (static export copies `public/` assets via Next) and allows
the brand-green fill to be driven by a CSS custom property, making it trivially tunable by the
theme. The `img-src 'self' data:` CSP clause already permits inline SVG rendered via the DOM.

## Decision

### D1 — Layout host: `app/layout.tsx` server component hosts a thin `ShellChrome` client component

We will make **`app/layout.tsx`** the root layout host, retaining its role as a Next.js App Router
Root Layout (server component). It will no longer render the current three-link `<header>` and
`<main>` directly. Instead, it will render a single `<ShellChrome>` client component that wraps
`{children}`. `ShellChrome` owns all interactive shell chrome: the collapsed/expanded sidebar
state, the three-zone grid, and the outer landmark structure. The root layout emits the `<html>`
and `<body>` tags and imports `globals.css`; everything visible is delegated to `ShellChrome`.

This design keeps the Root Layout a server component (consistent with Next.js App Router
conventions and the static export model), which means it has no runtime state of its own and
produces no hydration boundary. `ShellChrome` is the single hydration root for the shell chrome.
All existing routes (`/config`, `/evidence`, `/run`, etc.) nest under it automatically — they
retain their content but the current three-link top-nav header is removed. `Config` and `Evidence`
are demoted to secondary navigation inside `ShellHeader`.

**What is removed.** The current `<header>` element and its `<nav aria-label="Primary navigation">`
(the three-link Launch / Evidence / Config row) in `app/layout.tsx` is deleted entirely.
The current `<main id="main-content">` wrapper is moved inside `ShellChrome` as part of D6's
component tree.

### D2 — Route sharing: `/` and `/launch` render one shared URL-aware route component

The no-project empty state remains a single React component, `WorkspaceShellEntry`, defined at
`ui/app/components/shell/WorkspaceShellEntry.tsx`. The route-level component is `WorkspaceRoute`,
defined at `ui/app/components/shell/WorkspaceRoute.tsx`; it owns the Suspense boundary required
by `CentralArea`, and `CentralArea` dispatches URL state (`?project=`, `?chat=`) to the welcome,
project, or chat views. Both `app/page.tsx` and `app/launch/page.tsx` export `WorkspaceRoute` as
their default export. The concrete implementation is:

```
// app/page.tsx
export { WorkspaceRoute as default } from "@/app/components/shell/WorkspaceRoute";

// app/launch/page.tsx
export { WorkspaceRoute as default } from "@/app/components/shell/WorkspaceRoute";
```

No copy-paste of JSX. No parallel state. One route module, two route-file re-exports. This keeps
`/` and `/launch` behavior identical for selected project, selected chat, and active tool query
parameters.

**Constraint.** Neither `app/page.tsx` nor `app/launch/page.tsx` may define per-route Next.js
metadata (`export const metadata`) that differs between the two files, because `WorkspaceRoute`
is a shared route component and cannot be a server component that emits static metadata. If
route-specific metadata is ever needed (e.g. distinct `<title>` values for `/` vs `/launch`),
that is a scope change requiring a superseding note. For issue #63, both routes share the same
shell identity and the metadata in `app/layout.tsx` covers both.

### D3 — Persisted UI state: `localStorage` under `keiko.shell.sidebarCollapsed`

We will persist the sidebar collapsed/expanded flag to `localStorage` under the key
**`keiko.shell.sidebarCollapsed`**. The value is a JSON boolean string (`"true"` / `"false"`).
Reading and writing this key is confined to `ShellChrome`. The flag must be read in a
**mount-only effect** (`useEffect(() => { ... }, [])`) to prevent a hydration mismatch: the
server-rendered HTML cannot know the client's `localStorage` state, so the component renders
with its default state on first paint and then corrects via the effect.

**Default logic.** On screens ≥ 1024 px (`window.innerWidth >= 1024`), the default when no key
is stored is `false` (expanded). On screens < 1024 px, the default when no key is stored is
`true` (collapsed). This avoids rendering an overlapping sidebar on mobile for first-time users.
The `window.innerWidth` check is also done inside the mount effect.

**Known constraint.** `localStorage` is per-origin (same as the Keiko BFF port) and is cleared in
private-browsing mode. Sidebar state will reset to the default on private sessions. This is
acceptable: sidebar state is a cosmetic preference, not a security-sensitive datum, and the cost
of losing it is trivial. Cross-session durability could be added via `PATCH /api/preferences`
in a later issue, but is out of scope for #63.

### D4 — Brand-color token system: dark Keiko palette replacing the light theme

We will replace the light-palette tokens in `ui/tailwind.config.ts` with a dark token set built
from the three brand colors (`#4EBA87` green, `#333333` dark gray, `#fff` white). All existing
component files use the semantic token names (`bg-surface`, `text-ink`, `text-accent`, etc.),
so replacing the hex values in the Tailwind config propagates the rebrand without per-component
edits. The color-scheme declaration in `ui/app/globals.css` switches from `light` to `dark`.

**Semantic token definitions:**

| Token | Hex | Role |
|---|---|---|
| `canvas` (replaces `surface.DEFAULT`) | `#1a1e23` | Page and main workspace background |
| `chrome` (replaces `surface.subtle`) | `#242830` | Sidebar and header background |
| `panel` | `#2e3340` | Raised panel, card, form background |
| `elevated` | `#363c4a` | Hover states, active row, dropdown |
| `ink.DEFAULT` (primary text) | `#ffffff` | Primary foreground text |
| `ink.muted` (secondary text) | `#9ca3af` | Labels, hints, secondary copy |
| `ink.dim` (disabled / decorative) | `#6b7280` | Placeholder text, decorative separators |
| `accent.DEFAULT` | `#4EBA87` | Brand green; foreground text, icons, focus ring, button-bg fill |
| `accent.strong` | `#3da872` | Accent hover state (slightly darker green) |
| `border.DEFAULT` | `#3a4052` | Dividers, input outlines, region separators |
| `ink.inverse` | `#1a1e23` | Text on accent-colored backgrounds (canvas-dark value) |

**WCAG 2.2 AA contrast verification** (relative luminance per IEC 61966-2-1;
ratio = (L_hi + 0.05) / (L_lo + 0.05); AA requires ≥ 4.5:1 for normal text):

The four most critical pairings for text legibility:

1. **`ink #ffffff` on `canvas #1a1e23`** — L = 1.000 vs 0.013 → **16.75:1** (AA + AAA pass)
2. **`ink #ffffff` on `chrome #242830`** — L = 1.000 vs 0.021 → **14.78:1** (AA + AAA pass)
3. **`ink-muted #9ca3af` on `canvas #1a1e23`** — L = 0.364 vs 0.013 → **6.60:1** (AA pass)
4. **`accent #4EBA87` on `canvas #1a1e23`** — L = 0.385 vs 0.013 → **6.94:1** (AA pass)

**Critical negative constraint — the `accent` token must not be used as a button background with
white foreground:**

- `ink #ffffff` on `accent #4EBA87` — L = 1.000 vs 0.385 → **2.41:1 (FAIL — insufficient for AA)**

The `accent` token is safe as foreground text/icon color on dark backgrounds, and as a button
background only when paired with `ink.inverse (#1a1e23)` as the button label:

- `ink.inverse #1a1e23` on `accent #4EBA87` — 6.94:1 (AA pass)
- brand dark `#333333` on `accent #4EBA87` — 5.23:1 (AA pass)

Interactive buttons with a green accent background must use `text-ink-inverse`, not `text-white`.
Interactive controls that use `accent` as a background must use `text-ink-inverse`; this usage
must be preserved after the token rebrand.

**Backward-compatible token aliases.** To minimize churn in existing component files the
implementation retains `surface.DEFAULT`, `surface.subtle`, and existing token names as aliases
pointing to the new dark hex values. Existing `bg-surface`, `text-ink`, `text-accent` utility
classes continue to compile without per-component edits. New tokens (`canvas`, `chrome`, `panel`,
`elevated`, `border`) are added additively for shell-specific components.

**Light-themed Tailwind built-ins.** Existing component files use Tailwind built-in utilities
such as `bg-red-50 text-red-700` for error states. These were authored against a light background.
On a dark canvas `red-50` (#fef2f2) renders as a near-white block — visually inconsistent with
the dark shell. The implementor must audit all built-in light-color utility uses across existing
pages and replace them with dark-theme equivalents. This audit is a required deliverable of #63.

### D5 — Logo: inline SVG React component at `ui/app/components/KeikoLogo.tsx`

We will ship the logo as a **React component** at `ui/app/components/KeikoLogo.tsx` that renders
the SVG markup inline. This is the correct choice for a static export where there is no runtime
`public/` asset server and where the CSP's `img-src` policy should not need to widen for the logo.

**Color binding.** The source SVG at `img/keiko-logo.svg` has a hardcoded `fill="#4EBA87"` on the
`<g>` element. In the React component, that hardcoded value is replaced with `fill="currentColor"`.
The wrapping element in `ShellHeader` sets `className="text-accent"`, binding the fill to the
`accent` Tailwind token. The logo color can therefore be changed by changing the text color of
the wrapper — no SVG edits required.

**Component signature:**

```typescript
interface KeikoLogoProps {
  readonly className?: string;           // passed to the outer <svg> for sizing
  readonly "aria-hidden"?: boolean | "true" | "false";
}
export function KeikoLogo(props: KeikoLogoProps): ReactNode
```

The logo SVG has no text content and must carry `aria-hidden="true"` when it appears alongside a
visible "Keiko" text label in `ShellHeader`. When used without a text sibling, the `<svg>` element
requires a `<title>` child and `role="img"`.

**Why not `next/image` or `<img src="...">`.**
`next/image` optimization is unavailable in static export without a custom loader. A plain
`<img src="/keiko-logo.svg">` requires copying the SVG into `ui/public/`, adds an HTTP
round-trip, and cannot be driven by `currentColor`. An inline SVG React component resolves at
build time, ships in the JS bundle (4 KB SVG, negligible after gzip), and eliminates the
duplicate-file maintenance concern.

### D6 — Component decomposition: `ui/app/components/shell/`

We will place all shell components under `ui/app/components/shell/`. Each file has one reason to
change and should stay small enough for direct review. The decomposition:

| File | Kind | Responsibility |
|---|---|---|
| `ShellChrome.tsx` | Client | Top-level wrapper; owns `collapsed` state; renders the three-zone shell layout; emits all ARIA landmarks |
| `ShellHeader.tsx` | Client | Brand logo + secondary nav (Config, Evidence links); sidebar toggle button; skip link |
| `Sidebar.tsx` | Client | Project navigation region; calls `fetchProjects()` on mount; inline loading / empty / error / list states; hosts add-project and chat navigation affordances introduced by child issues |
| `WorkspaceRoute.tsx` | Server-compatible route component | Shared `/` and `/launch` route component; owns the Suspense boundary around URL-aware central content |
| `CentralArea.tsx` | Client | URL-aware central dispatcher for welcome, selected project, and selected chat states |
| `ChatView.tsx` | Client | Selected-chat message history and composer host introduced by child issues |
| `ToolRail.tsx` | Client | Right-side tool entry area; project-aware Files / Browser / Review / Terminal buttons and panel host |
| `WorkspaceShellEntry.tsx` | Client | Shared `/` and `/launch` "no chat selected" content; empty-state variants (D7) |

**Inline sub-states vs. separate files for Sidebar states.** The loading, empty, and error states
of the sidebar are simple enough (a spinner, a call-to-action, an error message) that they should
be rendered inline within `Sidebar.tsx` via conditional rendering rather than extracted to
`Sidebar.loading.tsx` / `Sidebar.empty.tsx` / `Sidebar.error.tsx`. Extracting them to separate
files would add three files with fewer than 20 LOC each, failing the three-usages-before-extracting
criterion. If the sidebar grows to include project-list items with their own sub-states (as issue
#64 introduces the add-project flow), extraction becomes warranted at that point.

**File-ownership summary.** `ui/app/layout.tsx` imports `<ShellChrome>` and wraps `{children}`.
`ui/app/page.tsx` and `ui/app/launch/page.tsx` are one-line re-exports of `WorkspaceRoute`.
The previous form-oriented `LaunchPage.tsx` and `HomePage.tsx` artifacts are superseded by the
shell route; workflow launch behavior is integrated through the central composer path in child
issues. `ui/tailwind.config.ts` and `ui/app/globals.css` carry the D4 dark-token contract.

### D7 — Empty-state taxonomy: four states with defined visual rules and ARIA semantics

We will define four empty-state variants the shell must render, each with explicit visual rules
and ARIA semantics:

**State 1 — No project registered.** Visual: centered placeholder, headline "No projects yet",
sub-copy "Add a project to get started", CTA button "Add project" (disabled in #63; wired in
#64). ARIA: static `<p>` for headline and sub-copy; CTA is a `<button disabled>`. No live region
needed — this is a stable empty state, not a dynamic update.

**State 2 — No chat in selected project.** Visual: project name in the workspace area, headline
"No chats yet", CTA "Start a new chat" (disabled in #63; wired in #65). ARIA: same as State 1
— static text, CTA button. No live region. This state is documented here; its implementation is
a #65 deliverable.

**State 3 — Loading (projects or chats fetching).** Visual: spinner or skeleton rows in the
sidebar / workspace area. ARIA: `<div role="status" aria-live="polite">` wrapping the spinner;
`aria-label="Loading projects"` (or "Loading chats"). Screen readers announce the region update
when content arrives.

**State 4 — Persistence / API failure.** Visual: error banner with brief message and "Retry"
action. ARIA: `<div role="alert">` (implicit `aria-live="assertive"`). The message text is
drawn from the BFF error envelope `{ error: { code, message } }`, which is already pre-redacted
per ADR-0011 D9. No stack trace. The "Retry" action re-triggers the fetch.

States 1, 3, and 4 are in scope for #63. State 2 is a #65 deliverable.

### D8 — Responsive contract: three explicit breakpoints

We will define the shell's responsive behavior across three breakpoints aligned with Tailwind's
default scale:

**Mobile (< 640 px — below Tailwind `sm`).** The sidebar defaults to its collapsed width on first
paint and can be expanded by the user after hydration. The tool rail is CSS-hidden below `sm`
(`display: none` via Tailwind) so desktop first paint keeps stable geometry without exposing the
right rail to the mobile accessibility tree. A native slide-out drawer and focus trap remain a
future hardening item rather than part of the #63 MVP shell.

**Tablet (640 px – 1023 px — Tailwind `sm` to just below `lg`).** The sidebar is visible
icon-only when collapsed (project-initial-letter avatars or icons, no text labels) and shows
labels when expanded. The tool rail is visible as an icon-only column. The three-zone CSS Grid
pattern is represented by a flex content row with a narrow sidebar column, a wide center column,
and a narrow tool-rail column.

**Desktop (≥ 1024 px — Tailwind `lg` and above).** All three zones are expanded by default unless
the user has persisted a collapsed sidebar preference. The sidebar can be collapsed by the user;
the tool rail does not collapse. Sidebar column widths: collapsed `3rem` (icon-only), expanded
`15rem` (240 px). Tool rail: `3.5rem` icon column, plus an optional `18rem` active tool panel.

**Implementation.** The shell uses a fixed header and a flex content row. Tailwind responsive
prefixes (`sm:`, `lg:`) provide first-paint geometry for the sidebar and tool rail; JavaScript
drives the persisted `collapsed` boolean after hydration. CSS transitions animate explicit
sidebar width changes.

### D9 — Read-only mount discipline: no mutating call during shell initialization

We will enforce that the shell issues **GET requests only** during mount:

- `Sidebar.tsx` calls only `fetchProjects()` (`GET /api/projects`) in its mount `useEffect`.
- `CentralArea.tsx` and `ToolRail.tsx` may read project metadata with `GET /api/projects` when
  URL state references a selected project.
- `FilesPanel.tsx` may read a selected registered project summary with `GET /api/workspace`;
  the BFF rejects unregistered workspace paths.
- No call to `createProject`, `updateProject`, `deleteProject`, `createChat`, or any `POST`,
  `PATCH`, or `DELETE` route may be triggered by rendering or mounting any shell component.
- `WorkspaceShellEntry.tsx` issues no network calls (static content only).

This invariant extends ADR-0013 D9's read-only mount discipline from the BFF store layer to the
frontend shell. A render the user did not explicitly initiate must not modify any state. Violations
create ghost writes (e.g. creating a project record on every `/` visit) that are difficult to debug
and violate the principle of least privilege for UI-initiated writes.

The `fetchProjects()` calls follow an active-flag cleanup pattern:

```typescript
useEffect(() => {
  let active = true;
  void fetchProjects()
    .then((r) => { if (active) setProjects(r.projects); })
    .catch((err) => { if (active) setError(err); });
  return () => { active = false; };
}, []);
```

### D10 — Accessibility landmark structure

We will emit the following ARIA landmark structure from the shell:

```
<body>
  <a href="#main-content">Skip to main content</a>    <!-- sr-only unless focused -->
  <ShellChrome>
    <header role="banner">                              <!-- ShellHeader -->
      <nav aria-label="Secondary navigation">          <!-- Config / Evidence links -->
    </header>
    <nav aria-label="Project navigation" id="shell-sidebar">   <!-- Sidebar -->
    <main id="main-content" tabIndex={-1}>             <!-- central workspace / {children} -->
    <aside aria-label="Workspace tools">               <!-- ToolRail -->
  </ShellChrome>
</body>
```

**Collapsible sidebar button pattern.** The sidebar toggle in `ShellHeader` must follow the
disclosure widget pattern:

```tsx
<button
  aria-expanded={collapsed ? "false" : "true"}
  aria-controls="shell-sidebar"
  aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
>
```

Focus must remain on the toggle button when state changes — the sidebar collapsing must not
steal focus or displace it to the document body. A future mobile drawer overlay must trap focus
while open and return focus to the toggle on close.

**ToolRail button pattern.** Files / Browser / Review / Terminal are `<button>` elements (not
`<div>` or `<a>`). When no usable project is selected they are disabled and expose an
`aria-describedby` tooltip explaining the project requirement. When an active panel closes, focus
returns to the corresponding tool button.

**Skip link target.** `<main id="main-content" tabIndex={-1}>` preserves the existing skip link
target from the current `app/layout.tsx`. The `href="#main-content"` skip link must survive the
layout refactor unchanged.

## Consequences

### Positive

- **Unified shell chrome.** One `ShellChrome` component owns all layout chrome. Future layout
  changes have a single location. The Root Layout stays a server component and never requires a
  client bundle.
- **No route drift between `/` and `/launch`.** A divergence becomes a deliberate code change
  (breaking the re-export), not a quiet copy-paste fork accumulating over multiple issues.
- **WCAG 2.2 AA verified before implementation.** Contrast ratios are computed in this ADR.
  The accent-as-background failure case (2.41:1 with white text) is documented as a forbidden
  usage, not discovered at code-review time.
- **Zero new runtime dependencies.** Pure React/Tailwind shell; `dependencies: {}` is unchanged;
  ADR-0011 D1 holds.
- **Sidebar state is cheap to remove or replace.** `localStorage` under a single stable key is
  trivially reversible; a future `PATCH /api/preferences` BFF route can take over with a
  one-line change.
- **Logo color decoupled from SVG source.** `currentColor` binding means the brand color change
  requires no SVG file edit and no `ui/public/` copy.
- **Read-only mount is structurally enforced.** Shell components may issue only same-origin GETs
  during mount, and `/api/workspace` is bound to registered projects before filesystem reads.

### Negative

- **All existing page components must be audited for light-theme Tailwind utility conflicts.**
  Utilities like `bg-red-50`, `bg-blue-50`, `text-blue-600` were authored against a light
  canvas. On a dark canvas they produce visually inconsistent results. This audit is required
  work under #63 with no easy shortcut.
- **`localStorage` without the mount guard causes hydration mismatch.** If the mount-only
  effect pattern is implemented incorrectly (reading `localStorage` in the render phase), Next.js
  throws a hydration error. The test suite must include a test that renders `ShellChrome` in
  jsdom and verifies no `window is not defined` error.
- **Private-browsing clears sidebar state.** Intentional tradeoff (D3). Must be documented in
  the UI runbook.
- **The re-export pattern breaks if per-route `generateMetadata` diverges.** A future requirement
  for distinct page `<title>` values forces a refactor from re-export to explicit import. This is
  low-risk for #63 but tracked as a known constraint.
- **The mobile drawer is not a native overlay yet.** The current shell is usable and stable on
  mobile through the collapsed sidebar and hidden tool rail, but a full slide-out drawer with
  focus trap remains a follow-up.
- **The form-oriented launch page is displaced.** The old standalone launch form is replaced by
  the shell route; workflow launch behavior is integrated into the central composer path through
  child issues.

### Known follow-ups

- #64: Project sidebar, add-project flow (writes; outside #63 scope).
- #65: Composer wiring, model dropdown, and integration of the existing launch form.
- #67: Files panel and project-aware ToolRail entry integration.
- Follow-up: Browser, Review, and Terminal runtime integrations.
- #68: Full accessibility hardening, end-to-end visual verification, documentation.
- Post-#63 audit: all existing page components for light-themed Tailwind utilities that conflict
  with the dark canvas.

## Alternatives Considered

### Alternative 1: Promote `app/layout.tsx` to a client component to own sidebar state directly

Mark `app/layout.tsx` with `"use client"` so it holds the `collapsed` state alongside the
`{children}` rendering. One file instead of two.

- **Pros**: one file; no delegation indirection; simplest possible implementation.
- **Cons**: in Next.js App Router, a `"use client"` Root Layout creates a client bundle boundary
  at the root of the entire component tree. Every child page component is forced into the client
  bundle, removing the ability for any child to be a React Server Component and setting a precedent
  that conflicts with the App Router's design intent. Even in the static export model (where there
  are no true RSCs at runtime), this is a known App Router anti-pattern documented by Vercel that
  leads to larger client bundles and loss of incremental adoption of server components in later
  issues.
- **Why rejected**: the thin `ShellChrome` client component is the canonical App Router answer —
  it keeps the Root Layout a server component, isolates the hydration root to the chrome only,
  and follows Next.js documentation's explicit guidance on "pushing client components to the
  leaves." The indirection adds two files, not twenty.

### Alternative 2: CSS-only sidebar collapse (checkbox hack or `:has()` selector, no JS state)

Use a CSS `:has()` selector and a hidden `<input type="checkbox">` to implement the collapsible
sidebar without React state or `localStorage`.

- **Pros**: no hydration mismatch; works before JS loads; no `localStorage`; no `useEffect`;
  can be server-rendered predictably.
- **Cons**: `aria-expanded` requires JavaScript to update correctly — a CSS-only toggle has no
  canonical ARIA binding for the disclosure widget pattern; the focus-trap behavior required for
  the mobile drawer (D10) is not achievable in pure CSS; `localStorage` persistence requires
  JavaScript regardless; browser support for `:has()` is strong in 2026 but the combinatorial
  complexity of `:has()` + animation + responsive rules creates harder-to-maintain CSS.
- **Why rejected**: WCAG 2.2 AA requires `aria-expanded` on the toggle button (ADR-0011 D11)
  and focus management on mobile drawer open/close (D10). These are not satisfiable with a
  CSS-only collapse pattern. The JavaScript state adds < 30 LOC to `ShellChrome`; the cost is
  not prohibitive relative to the accessibility obligation.

### Alternative 3: Store sidebar state in the URL query parameter (`?sidebar=open`)

Encode sidebar collapsed/expanded as a URL query parameter so it survives page navigation without
`localStorage` and without SSR concerns.

- **Pros**: shareable state; no `window` access; survives hard refresh; no hydration mismatch.
- **Cons**: pollutes every URL in the application with a UI preference that has no content
  meaning; Next.js `useSearchParams` requires a `<Suspense>` boundary in static export (see Next
  docs); the sidebar is a per-device cosmetic preference, not navigable state — a shared URL
  should not encode it; `?sidebar=open` would appear in evidence, run, and config URLs, making
  them visually noisy and confusing in copy-pasted links and analytics.
- **Why rejected**: URL state is the right tool for content-level navigation (active run ID,
  evidence filters, selected project). Per-device layout preferences belong in `localStorage`.
  The Suspense boundary requirement in static export is an additional implementation burden with
  no offsetting benefit.

### Alternative 4: Ship logo as a static asset in `ui/public/` with `<img src="/keiko-logo.svg">`

Copy `img/keiko-logo.svg` into `ui/public/keiko-logo.svg` and reference it with a standard
`<img>` tag or `next/image`.

- **Pros**: conventional Next.js public-asset pattern; no SVG markup in the JS bundle; trivially
  HTTP-cacheable.
- **Cons**: requires keeping two copies of the SVG in sync (`img/` and `ui/public/`); `next/image`
  optimization is unavailable in static export without a custom loader; a plain `<img>` element
  cannot be driven by `currentColor`, so the brand-green fill is hardcoded and cannot be toggled
  by the Tailwind theme; a 4 KB SVG makes an extra HTTP request per page load.
- **Why rejected**: the `currentColor` binding is the decisive reason. If the brand color changes
  or a future issue introduces an inverted or high-contrast mode, a CSS-driven fill requires no
  asset edit. The 4 KB SVG inlined in a React component is negligible after gzip. The duplicate-
  file maintenance concern is eliminated.

### Alternative 5: Separate route files for `/`, `/launch`, and a new `/workspace`

Assign distinct page files to `/`, `/launch`, and optionally introduce a new `/workspace` route,
rather than sharing a single component via re-export.

- **Pros**: explicit; no cross-route coupling; each page file can have independent metadata and
  route-level layout overrides.
- **Cons**: the issue acceptance criteria are explicit that `/` and `/launch` must render the same
  experience without duplicating divergent UI logic; three separate page files for one conceptual
  surface creates exactly the divergence risk the issue seeks to eliminate; a new `/workspace`
  route would break existing bookmarks and the URL printed by `keiko ui` at startup.
- **Why rejected**: the re-export pattern (D2) delivers route sharing with no divergence risk,
  no copy-paste, and no new routes. The acceptance criteria are a hard requirement.

## Related

- ADR-0011: Wave-1 User Interface and Packaging — `output: "export"` static export constraint (D1);
  zero-new-runtime-dependency invariant (D1); CSP `script-src 'self'` and `img-src 'self' data:`
  (logo decision D5); WCAG 2.2 AA baseline (D11); `UiHandlerDeps` injection pattern.
- ADR-0013: UI-Local SQLite Persistence for Projects and Chats — `fetchProjects()` client call
  consumed by shell components (D9); read-only mount discipline extended to the shell layer; ten
  additive BFF routes that supply project and chat data.
- Issue #63: Replace launch with the Keiko workspace shell.
- Issue #61: Parent epic — Local workspace shell with project and chat persistence.
- Issue #64: Add-project flow and project sidebar wiring (follow-up, writes to the store).
- Issue #65: Composer wiring (follow-up, central workspace content and existing launch form integration).
- Issue #67: ToolRail integration (follow-up, Files / Browser / Review / Terminal).
- Issue #68: Full accessibility hardening (follow-up).
- Next.js App Router — pushing client components to the leaves:
  https://nextjs.org/docs/app/building-your-application/rendering/composition-patterns#moving-client-components-down-the-tree
- WCAG 2.2 AA contrast requirements: https://www.w3.org/TR/WCAG22/#contrast-minimum

## Date

2026-05-30
