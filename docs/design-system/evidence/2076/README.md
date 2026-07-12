# Issue #2076 — Maintainer publication controls evidence

The `maintainer-review-2076` Playwright fixture serves the packaged, same-origin maintainer UI and
intercepts only the protected maintainer API. It proves the publication journey without a live GitHub
connection or a real report body.

## Captures

- `01-dark-desktop-prepare.png` — one configured target and the prepare action.
- `02-dark-preview-inert.png` — exact hostile synthetic title/body rendered as inert `<pre>` text.
- `03-light-succeeded.png` — approved delivery with the server-authorized GitHub link.
- `04-dark-cancelled-private.png` — explicit private cancellation result with no public link.
- `05-mobile-forced-colors-reduced-motion.png` — narrow forced-colors and reduced-motion state.
- `06-light-high-contrast.png` — light high-contrast state.
- `07-dark-manual-remediation.png` — safe manual-remediation copy plus retained authorized link.
- `08-forced-colors-active.png` — forced-colors pressed state on an approval target.

`a11y-proof.json` records axe serious/critical results. `fidelity-proof.json` records the exact
served assets and capture list. Both are emitted only after the focused Playwright suite passes.
