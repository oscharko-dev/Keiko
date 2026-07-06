# Update experience window

Issue [#1696](https://github.com/oscharko-dev/Keiko/issues/1696) · Epic
[#1687](https://github.com/oscharko-dev/Keiko/issues/1687) · Design System 0.4.0.

## Overview

The update experience is the governed package-update review surface: a Settings entry point, a
non-blocking startup notice, and a reusable update window that explains update readiness, state impact,
remediation, progress, restart, failure, and success.

Canonical product sources:
`packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.tsx`,
`packages/keiko-ui/src/app/components/desktop/update/UpdateStartupNotice.tsx`, the `.upd*` /
`.update-notice*` rules in `packages/keiko-ui/src/app/globals.css`, and the token-based
component-scoped refinements in
`packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.module.css`.

## When (not) to use

Use this surface when the user is reviewing Keiko package update readiness from Settings or from the
startup notification. It is not a general command runner, release-note reader, or service-worker/PWA
refresh banner. Unsupported install modes stay in this surface as a manual-update path; they do not
fall through to Terminal or guessed package-manager commands.

Nearest alternatives:

- Use Settings for persistent product preferences and model/gateway configuration.
- Use Notifications for passive alerts that do not require update-state review.
- Use Terminal only for user-initiated command execution outside the governed update flow.

## Anatomy

- Startup notice: `.update-notice`, icon, plain-language title/body, `Review update`, and `Not now`.
- Window summary: `.upd-summary`, kicker, focused title, current/target version, and tone.
- Primary action: `.upd-primary` with the recommended action and one primary or secondary CTA.
- Status panels: `.upd-panel` for progress, terminal session outcome, manual path, state impact, and
  remediation.
- Remediation rows: `.upd-feature-list` and `.upd-action` for affected features and user-approved
  remediation actions.
- Secondary disclosure: `.upd-details` for patch notes and technical details/log previews, both
  collapsed by default.

## Variants & sizes

Supported entry variants:

- Settings entry point: the General tab exposes `Review updates`.
- Startup notice: fixed, non-blocking notice shown only after shell readiness and update-check
  completion.
- Update window: singleton transient Workspace window opened from Settings or startup only.

Supported state variants:

- Current/no update.
- Normal update available.
- Critical update available.
- Manual or blocked update path.
- Preparing/running progress.
- Restart required.
- Remediation pending/completed/deferred.
- Failed, cancelled, and succeeded session outcomes.

Window size is governed by `WindowsRegistry.ts`: default `620x640`, minimum `420x430`, tiny
`320x260`. The layout stacks internally for narrow and responsive captures instead of creating a
second mobile-only component.

## States

The component maps to the Card / window family in [state-matrix.md](state-matrix.md): **Default**,
**Focus**, **Loading**, **Syncing**, and **Conflict** are applicable.

State mapping:

- Default: current/no-update and normal update-available review.
- Focus: the loaded update title receives programmatic focus; controls use the global focus ring.
- Loading: `role="status"` while update status is being fetched.
- Syncing: preparing/running update sessions expose `role="status"`, `aria-live="polite"`, and a
  native `<progress>` element.
- Conflict: critical/manual/remediation-required states pair warning tone with explicit words,
  affected-feature copy, and action rows.

Non-applicable by design: Hover, Active, Selected, Disabled, Error, and Empty for the window itself.
Hover/active/disabled belong to child buttons. Failure is a session outcome panel with `role="alert"`,
not the matrix's generic Error state.

Evidence: [`evidence/1696/`](evidence/1696/README.md).

## Accessibility

- Startup notice uses `role="status"` for normal updates and `role="alert"` for critical updates.
- The update window is labelled by its focused title and moves focus to the title after async load.
- Preparing/running sessions use a polite live region and native `<progress aria-label="Update progress">`.
- Failure uses assertive alert treatment; success/restart/cancelled use polite status treatment.
- Patch notes and technical details are native `<details>` disclosures and start collapsed.
- Critical/manual/remediation states are not color-only: each carries explicit text, labels, and
  remediation/action copy.
- Keyboard users can reach the Settings entry, startup actions, details disclosures, install/check,
  retry/cancel/restart verification, and remediation run/defer actions in document order.

Automated coverage:

- `packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.test.tsx`
- `packages/keiko-ui/src/app/components/desktop/update/UpdateStartupNotice.test.tsx`
- `tests/e2e/update-ui-1696.spec.ts`

## Tokens

The update experience consumes only existing semantic/component tokens. Primary examples:

- Surfaces: `--surface-primary`, `--surface-secondary`, `--surface-inset`,
  `--surface-accent-subtle`.
- Text: `--text-primary`, `--text-secondary`, `--text-muted`, `--text-accent`,
  `--text-on-accent`.
- Borders/focus: `--border-subtle`, `--border-accent`, `--focus-ring`, `--focus-w`.
- Feedback: `--feedback-success`, `--feedback-info`, `--feedback-warning`, `--feedback-danger`.
- Layout/chrome: `--radius-*`, `--shadow-*`, `--z-toast`, `--control-height`.

No new Tier-1 primitives, raw hex colors, or one-off `[data-theme="light"]` overrides are introduced by
#1696.

## Do / Don't

- Do show the recommended action, current version, target version, and state impact before release
  notes or logs. Do not make technical logs the primary experience.
- Do show unsupported installs as a manual-update path with calm instructions. Do not label an
  unsupported local checkout as a product error or run guessed package-manager commands.
- Do keep patch notes readable and collapsed by default. Do not expose raw package-manager output or
  private paths in the primary UI.

## Status & owner

Status: **Draft while #1696 is in progress; Ready candidate on merge**. Owner: `@core-ui`. Since:
`v0.2.11` candidate. Board status: `In Progress`.

The register row in [governance.md](governance.md) stays Draft until #1696 merges because governance
status must agree with the delivery board. The #1696 PR carries the Ready evidence and promotes the
component on merge.

## Changelog

- **v0.2.11 candidate** ([#1696](https://github.com/oscharko-dev/Keiko/issues/1696)) - adds Settings
  entry point, startup notification, reusable update window, update-session progress/outcome states,
  remediation action UI, product-copy review, and Playwright/axe design-system evidence.
