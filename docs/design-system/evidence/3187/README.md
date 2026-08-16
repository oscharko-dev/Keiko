# Issue #3187 — Dev boot recovery evidence

This evidence pack verifies the pre-hydration watchdog after its existing two automatic reload
attempts have been exhausted. The shared Chromium configuration blocks only Next.js client bundles,
leaving the exported inline watchdog executable; it then seeds the existing session-only retry
counter at its maximum. This deterministically proves the recovery path without changing backend
startup policy or clearing local state.

Run the focused browser proof with the shared, wired configuration:

```bash
npx playwright test tests/e2e/boot-recovery-3187.spec.ts --config tests/e2e/config/playwright.config.ts --project=chromium
```

The test records Dark, Light, High Contrast, forced-colors, and 320px responsive captures. Each
capture asserts visible recovery content outside `aria-hidden`, a native focused Reload Keiko button,
absence of the logo-only placeholder, keyboard activation, and zero serious or critical axe-core
WCAG 2.0/2.1/2.2 A/AA violations.

Use `KEIKO_WRITE_TRACKED_EVIDENCE=1` only when intentionally refreshing the tracked PNG and JSON
artifacts. Standard runs write to `test-results/e2e-evidence/` and leave the working tree clean.
