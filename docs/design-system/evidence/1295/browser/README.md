# Issue #1295 — running-app browser evidence

Real running-app screenshots of the live Keiko shell, captured from the Next.js **static export**
(`packages/keiko-ui/out`, ADR-0011 D1 — self-contained, no backend) rebuilt from the migrated
`globals.css`, driven by Playwright/Chromium across the theme × viewport matrix.

## What is shown

`desktop|tablet|mobile __ home __ {dark, light, dark-hc, light-hc, reduced-motion, forced-colors}.png`
— 18 screenshots of the `/` workspace shell (header, rails, footer, workspace canvas, empty-state)
rendering correctly post-migration in every mode at every breakpoint, with **0 page errors**
(see `manifest.json`). This confirms the value-preserving migration introduces no visual or runtime
regression in the always-on chrome, and that the Light-Mode / High-Contrast / forced-colors / reduced-motion
paths all resolve.

## Scope and limitations

- The static export renders the **empty workspace** (no open windows). The populated product surfaces
  that #1295 migrated (chat bubbles, Quality-Intelligence cards, MemoriaViva, Relationships, Local
  Knowledge, Figma) are proven at the component level by the computed-value
  [`equivalence-harness.mjs`](../equivalence-harness.mjs) — which renders the real component markup with
  the real `globals.css` and asserts **2324 probes × 7 modes = 0 differences** (Category A/B) plus the
  Category-C Light-adaptation proof.
- The `/launch`, `/local-knowledge`, `/memoriaviva` sub-routes need client data that does not hydrate in
  the backend-less static export, so they are not captured here. Deep, data-populated, interactive
  workflow visual-regression against the live route is the explicit charter of **#1300** (the reuse-map's
  visual-regression automation child).

## Reproduce

```bash
npm run build --workspace @oscharko-dev/keiko-ui
node docs/design-system/evidence/1295/browser/capture.mjs
```
