# Issue #1294 Corrective Browser Inspection

- Route/artifact: `docs/design-system/evidence/1294/reference-comparison.mjs` generated isolated browser frames for the Design System 0.4.0 reference and product primitives.
- Viewport: 1440 x 1220 at deviceScaleFactor 2.
- Modes inspected: Dark, Light, Light High Contrast.
- Product focus controls inspected: `.figma-view-json-btn`, `.figma-view-json-copy-btn`, `.figma-view-preview-drag-surface`, `.ui-error-notice-close`, and a primary green `.dlg-primary` control.
- Disposition: product primitives use the semantic `--focus-ring` token; no computed `var(--focus)` reference remains in `globals.css`.
- Readability/usability: side-by-side screenshots show labelled states for default, hover, focus, active, selected, disabled, loading, and error; status/error states include text, not color alone.

Generated artifacts:

- `reference-side-by-side-01-dark.png`
- `reference-side-by-side-02-light.png`
- `reference-side-by-side-03-light-hc.png`
- `focus-contrast-evidence.json`
