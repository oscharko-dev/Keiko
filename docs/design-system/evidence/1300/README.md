# Evidence — Issue #1300 (Design System 0.4.0 visual-regression + acceptance capstone)

Consolidated, re-runnable proof that the migrated 0.4.0 surfaces (children #1292–#1299) resolve to the
governed reference, render across the full theme/contrast/motion/viewport matrix, pass accessibility, and have
been visually accepted. The narrative, surface matrix, tolerance, retention, designer-acceptance notes and the
final variance register are in [`../../visual-regression.md`](../../visual-regression.md); the governance gates
are in [ADR-0051](../../../adr/ADR-0051-design-system-visual-regression-and-acceptance-gate.md).

## How to reproduce

From the repo root, after `npm ci` and `npx playwright install chromium`:

```bash
# 1. Component reference fidelity + accessibility smoke + performance smoke (0-diff gate, dark+light)
node docs/design-system/evidence/1300/equivalence-harness.mjs

# 2. Running-app cross-theme / cross-viewport screenshot bundle (rebuild the static export first)
npm run build --workspace @oscharko-dev/keiko-ui
node docs/design-system/evidence/1300/browser/capture.mjs

# 3. Editor matrix: token-tier fidelity (0-diff gate) + the seven editor reference pages
node docs/design-system/evidence/1300/editor/capture.mjs

# 4. Accessibility: axe-core WCAG 2.1 A/AA across the seven modes (zero serious/critical)
node docs/design-system/evidence/1300/a11y/axe-proof.mjs
```

Each script exits non-zero on a gate failure. The running editor (Monaco registration, tabs/splits,
diagnostics, find/replace, ghost text, agent prompts) is proven by `npm run test:e2e:editor-fidelity-1295`
and `-1296`, whose captures are committed under [`../1295/editor/`](../1295/editor/) and
[`../1296/editor/`](../1296/editor/).

## Environment

- Headless Chromium via Playwright (`chromium`), node 22.
- Fidelity gates use `page.setContent` / `file://` (no server — CodeQL-safe); the running-app capture serves
  `packages/keiko-ui/out` over a path-confined loopback server.
- axe-core is injected from the workspace dependency (`node_modules/axe-core/axe.min.js`); no network.

## Tolerance & retention

- **Tolerance:** computed-value fidelity, colours canonicalised to sRGB via an in-page `<canvas>`, **≤ 1 LSB
  per channel**. 0-diff gated in Dark + Light; HC / forced-colors / reduced-motion / accent-derived recorded.
- **Retention:** all PNG + JSON artifacts are committed in-repo here, so the baseline travels with the source
  it proves; the `Issue #1300` vitest block pins the proofs against the product CSS for CI enforcement.

## Artifact index

| File                                                                                         | What                                                                                            |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `consolidated-fidelity-proof.json`                                                           | component reference fidelity (427 probes, 0 gated diffs), a11y smoke, perf smoke, accent record |
| `01-dark.png` … `07-reduced-motion.png`                                                      | component union rendered in the 7 modes                                                         |
| `08-compact-density.png`, `09-responsive.png`, `10-focus-visible.png`, `11-bounded-rows.png` | density / responsive / focus / perf-smoke renders                                               |
| `browser/manifest.json` + `browser/{desktop,tablet,mobile}__home__*.png`                     | running-app shell, 6 modes × 3 viewports (18 shots)                                             |
| `editor/editor-fidelity-proof.json`                                                          | editor token fidelity (160 gated probes, 0 diffs) + accent + reference-only buckets             |
| `editor/ref-editor-*-{dark,light}.png`                                                       | the 7 editor reference pages (14 shots)                                                         |
| `a11y/a11y-proof.json`                                                                       | axe-core results per mode (0 serious/critical, 40 passes/mode)                                  |

## Results (committed run)

- Component reference fidelity: **427 probes, 0 gated diffs** (Dark + Light); 0 recorded diffs in HC/forced/reduced. `PASS`.
- Editor token fidelity: **160 gated probes, 0 gated diffs**; 10 accent-derived recorded; 3 reference-only recorded (→ #1373/#1390). `PASS`.
- Accessibility: axe-core 4.12.0, **0 serious/critical** in all 7 modes (40 passes/mode). `PASS`.
- Performance smoke: 250-row bounded table, ~0.1 ms, sticky-header delta 0 px. `PASS`.
- Running-app bundle: 18 shots, shell present in every mode/viewport, 0 page errors.
