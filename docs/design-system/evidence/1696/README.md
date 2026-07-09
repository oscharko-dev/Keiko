# Issue #1696 - Governed Update Experience Evidence

Design-system, accessibility, and product-copy evidence for the Settings Updates entry point, startup
update notification, and reusable governed update window added in issue #1696.

## Surface Covered

- Settings > General > Updates entry point.
- Startup update notification after shell readiness.
- Update window normal/current/critical/manual/progress/restart/remediation/failure/success states.
- Collapsed patch notes and collapsed technical details/log previews.
- Plain-language remediation and affected-feature copy for state-impacting updates.
- Portable-managed update state added by #1958, with GitHub Release Asset installability and no
  npm/package-manager fallback in the primary user path.
- Command-palette exclusion: Updates opens only from Settings or startup notification.

## Design-System Mapping

- Component page: [`../../update-experience.md`](../../update-experience.md).
- Register row: [`../../governance.md`](../../governance.md).
- Family: Card / window plus status/feedback patterns from
  [`../../state-matrix.md`](../../state-matrix.md).
- Base styles live in `packages/keiko-ui/src/app/globals.css`; update-window state refinements live
  in `packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.module.css`. Both layers
  consume only semantic/component tokens.
- No raw colors, Tier-1 primitive references, or new `[data-theme="light"]` overrides are introduced
  by #1696.

## Verification Evidence

Rerunnable browser harness:

```bash
npm run test:e2e:update-ui-1696
```

Receipt command for the user-facing child gate:

```bash
.keiko-scripts/ui-verify-receipt.sh 1696 -- npx playwright test --config tests/e2e/config/playwright.issue-1696-update-ui.config.ts --project=chromium
```

The Playwright harness writes these artifacts in this directory:

- `01-update-window-dark.png`
- `02-update-window-light.png`
- `03-update-window-dark-high-contrast.png`
- `04-update-window-light-high-contrast.png`
- `05-update-window-prefers-contrast.png`
- `06-update-window-forced-colors.png`
- `07-update-window-reduced-motion.png`
- `08-startup-notice-critical.png`
- `09-settings-entrypoint.png`
- `10-responsive-manual-path.png`
- `11-progress-state.png`
- `12-portable-managed-one-click.png`
- `update-experience-fidelity-proof.json`
- `a11y-proof.json`
- `manifest.json`

## Test Coverage Map

- API helpers and CSRF/no-store behavior: `packages/keiko-ui/src/lib/api.test.ts`.
- Update window state rendering, collapsed disclosures, focus, action wiring, and jest-axe smoke:
  `packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.test.tsx`.
- Startup notification readiness gating, dismissal, review action, and critical alert treatment:
  `packages/keiko-ui/src/app/components/desktop/update/UpdateStartupNotice.test.tsx`.
- Settings entry point and registry wiring:
  `packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.test.tsx` and
  `packages/keiko-ui/src/app/components/desktop/widgets/index.test.tsx`.
- Global command-palette exclusion:
  `packages/keiko-ui/src/app/components/desktop/AppShell.commands.test.ts`.
- Running packaged UI evidence: `tests/e2e/update-ui-1696.spec.ts`.

## Evidence Boundary

The artifacts use deterministic update fixtures. They do not include customer repository files,
secrets, private paths, raw package-manager output, prompts, model outputs, or token-bearing logs.
