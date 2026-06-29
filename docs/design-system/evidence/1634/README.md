# Issue #1634 — PDF Viewer Window Evidence

Browser-rendered design-system and accessibility evidence for the passive Keiko-native PDF viewer
window foundation.

## How to reproduce

From the repository root, after `npm ci` and `npx playwright install chromium`:

```bash
node docs/design-system/evidence/1634/equivalence-harness.mjs
```

The harness renders the viewer surface against the real
`packages/keiko-ui/src/app/globals.css` via `page.setContent` and captures the
governed window chrome in these modes:

- Dark
- Light
- Dark + in-app high contrast (`data-hc="more"`)
- Light + in-app high contrast (`data-hc="more" data-theme="light"`)
- Forced colors
- Responsive mobile width
- Loading state
- Error state
- Focus-visible state

It writes:

- `01-dark.png`
- `02-light.png`
- `03-dark-hc.png`
- `04-light-hc.png`
- `05-forced-colors.png`
- `06-responsive.png`
- `07-loading.png`
- `08-error.png`
- `09-focus-visible.png`
- `pdf-viewer-fidelity-proof.json`
- `a11y-proof.json`

The JSON receipts include the `globals.css` SHA-256 digest, the capture matrix,
and the aggregated axe results. The harness exits non-zero if any serious or
critical axe violation is found.

## Result

Latest local run: `PASS`

- `pdf-viewer-fidelity-proof.json`: PASS
- `a11y-proof.json`: PASS
- Screenshot coverage: 9 captures across dark, light, dark-HC, light-HC,
  forced-colors, responsive, loading, error, and focus-visible states
