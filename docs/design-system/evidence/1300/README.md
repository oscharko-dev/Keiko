# Historical evidence — Issue #1300 (Design System 0.4.0 visual-regression + acceptance capstone)

Consolidated, re-runnable historical proof that the migrated 0.4.0 surfaces (children #1292–#1299) resolved to the
governed reference, render across the full theme/contrast/motion/viewport matrix, pass accessibility, and have
been visually accepted. The narrative, surface matrix, tolerance, retention, designer-acceptance notes and the
final variance register are in [`../../visual-regression.md`](../../visual-regression.md); the governance gates
are in [ADR-0051](../../../adr/ADR-0051-design-system-visual-regression-and-acceptance-gate.md).

The commands below are historical evidence tools, not standing CI or pull-request gates. They retain their
non-zero assertions for forensic reproduction, but later intentional changes to the product or reference can
make an old migration comparison fail. Current release protection is provided by the applicable UI and
Playwright regression suites.

## How to reproduce

From the repo root, after `npm ci` and `npx playwright install chromium`:

```bash
# 1. Component reference fidelity + accessibility smoke + performance smoke (0-diff gate, dark+light)
node docs/design-system/evidence/1300/equivalence-harness.mjs

# 2. Running-app cross-theme / cross-viewport screenshot bundle (builds its exact static export)
node docs/design-system/evidence/1300/browser/capture.mjs

# 3. Editor matrix: token-tier fidelity (0-diff gate) + the seven editor reference pages
node docs/design-system/evidence/1300/editor/capture.mjs

# 4. Accessibility: axe-core WCAG 2.1 A/AA across the seven modes (zero serious/critical,
#    with unresolved incomplete findings requiring a checked-in disposition)
node docs/design-system/evidence/1300/a11y/axe-proof.mjs
```

Each script exits non-zero on a gate failure. The component harness also fails on missing selector probes,
stale CSS hashes, a non-scrollable bounded-row smoke, scroll-position failure, or sticky-header drift. The
browser harness rebuilds the static export, records a digest of its emitted CSS, serves it through a
realpath-confined loopback server, blocks non-loopback outbound requests, and fails on page errors, missing
required selectors, visible error notices, crashed window bodies, unexpected API requests, or unavailable
workspace trust in any scenario. Its manifest records the SHA-256 of the capture harness itself so committed
artifacts cannot be reused after the generator changes. The editor harness fails unless all 14 expected
reference-page captures are present and error-free. The running editor (Monaco registration, tabs/splits, diagnostics, find/replace,
ghost text, agent prompts) is proven by
`npm run test:e2e:editor-fidelity-1295` and `-1296`, whose captures are committed under
[`../1295/editor/`](../1295/editor/) and [`../1296/editor/`](../1296/editor/).

## Environment

- Headless Chromium via Playwright 1.61.1 (`chromium`), Node 24.18.0 and npm 11.16.0.
- Fidelity gates use `page.setContent` / `file://` (no server — CodeQL-safe); the running-app capture serves
  `packages/keiko-ui/out` over a realpath-confined loopback server and stubs same-origin API responses with
  deterministic `keiko.workspace.v4` workspace-window state.
- axe-core is injected from the workspace dependency (`node_modules/axe-core/axe.min.js`); no network.

## Tolerance & retention

- **Tolerance:** computed-value fidelity, colours canonicalised to sRGB via an in-page `<canvas>`, **≤ 1 LSB
  per channel**. 0-diff gated in Dark + Light; HC / forced-colors / reduced-motion / accent-derived recorded.
- **Retention:** all PNG + JSON artifacts are committed in-repo here, so the baseline travels with the source
  it proves; the `Issue #1300` vitest block pins the proofs against the product CSS and independently rejects
  a browser manifest whose LF-normalized capture-source digest differs from the checked-in harness.

## Artifact index

| File                                                                                         | What                                                                                              |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `consolidated-fidelity-proof.json`                                                           | component reference fidelity (427 probes, 0 gated diffs), a11y smoke, perf smoke, accent record   |
| `01-dark.png` … `07-reduced-motion.png`                                                      | component union rendered in the 7 modes                                                           |
| `08-compact-density.png`, `09-responsive.png`, `10-focus-visible.png`, `11-bounded-rows.png` | density / responsive / focus / perf-smoke renders                                                 |
| `browser/manifest.json` + `browser/{desktop,tablet,mobile}__*__*.png`                        | running-app shell + seeded high-traffic surfaces, 6 scenarios × 6 modes × 3 viewports (108 shots) |
| `editor/editor-fidelity-proof.json`                                                          | editor token fidelity (160 gated probes, 0 diffs) + accent + reference-only buckets               |
| `editor/ref-editor-*-{dark,light}.png`                                                       | the 7 editor reference pages (14 shots)                                                           |
| `a11y/a11y-proof.json`                                                                       | axe-core results per mode (0 serious/critical, 40 passes/mode)                                    |

## Results (committed run)

- Component reference fidelity: **427 probes, 0 gated diffs** (Dark + Light); 0 recorded diffs in HC/forced/reduced. `PASS`.
- Editor token fidelity: **160 gated probes, 0 gated diffs**; 10 accent-derived recorded; 3 reference-only recorded (→ #1373/#1390). `PASS`.
- Accessibility: axe-core 4.12.0, **0 serious/critical** in all 7 modes (40 passes/mode); unresolved
  incomplete findings are 0 after the checked-in `color-contrast` disposition. `PASS`.
- Performance smoke: 250-row bounded table, ~0.1 ms, sticky-header delta 0 px. `PASS`.
- Running-app bundle: **108 shots** (shell plus chat/Quality Intelligence/Local Knowledge,
  MemoriaViva/Relationships, Files/Editor, and desktop/constrained Git-client scenarios), shell present
  in every mode/viewport, required selectors present, and 0 page errors, visible error notices, crashed
  window bodies, unexpected API requests, or unavailable workspace-trust states.

## SonarCloud CSS maintenance — 2026-10-24

The original four producers were regenerated for the reported CSS maintenance on Node 24.22.0
(macOS arm64). Component fidelity retains 427 probes with zero gated or recorded differences;
editor token fidelity retains zero gated differences and all 14 reference captures; the seven-mode
accessibility proof retains zero serious/critical violations and zero unresolved incomplete findings.
The 108 running-app captures retain zero page errors, unexpected API requests, missing selectors,
crashed windows or unavailable workspace-trust states. The browser fixture now supplies the three
existing browser-approval, empty-draft and absent-skill reads through exact paths and canonical empty
responses. Unexpected requests still fail closed.

The additional [CSS preservation producer](../sonarcloud-2026-10-24/css-preservation.mjs) compares
32 fixtures against the pinned pre-change source, including interaction states, pseudo-elements,
late-loaded Monaco styles and the changed CSS Modules. It records 34,944 equal computed values and
binds the producer and source digests in its sibling proof JSON. This remains fixture qualification.
The separate running-editor smoke is not green; its menu-selection and desktop-hover failures also
reproduce with the original stylesheet. See the complete
[SonarCloud review record](../../../qa/sonarcloud-blocker-medium-2026-10-24.json) for the actual gate
outcomes and limitations. No failure or rule was suppressed to produce these artifacts.

## Merge into PR #4064 — 2026-10-24

The producers bind `package.json`, `package-lock.json` and `packages/keiko-ui/package.json`, which
the merge of `dev` into PR #4064 changes (its own dependency and package updates). The same four
original producers were rerun on the merged tree on Node 24.22.0 (macOS arm64) and all passed:
component fidelity with zero gated differences and no missing selectors, editor token fidelity with
all 14 reference captures, the seven-mode accessibility proof with zero serious/critical violations
and zero unresolved incomplete findings, and all 108 running-app captures with zero page errors,
unexpected API requests, missing selectors, crashed windows or unavailable workspace-trust states.
No gate, fixture or rule was changed.

## Coding runtime pin 1.1.4 — 2026-10-26

The pin of the optional coding-runtime packages to 1.1.4 changes `package.json` and
`package-lock.json`, which these producers bind. The same four original producers were rerun on the
pinned tree on Node 24.22.0 (macOS arm64) and all passed: component fidelity with 427 probes and
zero gated or recorded differences, editor token fidelity with 160 gated probes, zero gated
differences and all 14 reference captures, the seven-mode accessibility proof with zero
serious/critical violations and zero unresolved incomplete findings, and all 108 running-app
captures with zero page errors, unexpected API requests, missing selectors, crashed windows or
unavailable workspace-trust states. No gate, fixture or rule was changed.

## Release 1.3.0 — 2026-10-26

The 1.3.0 version bump changes `package.json`, `package-lock.json` and
`packages/keiko-ui/package.json`, which these producers bind. The same four original producers were
rerun on the release tree on Node 24.22.0 (macOS arm64) and all passed: component fidelity with 427
probes and zero gated or recorded differences, editor token fidelity with 160 gated probes, zero
gated differences and all 14 reference captures, the seven-mode accessibility proof with zero
serious/critical violations and zero unresolved incomplete findings, and all 108 running-app
captures with zero page errors, unexpected API requests, missing selectors, crashed windows or
unavailable workspace-trust states. No gate, fixture or rule was changed.

## qs override 6.16.1 — 2026-10-27

Raising the `qs` override to 6.16.1 for GHSA-6pq8-jhm2-2vcw (#4098) changes `package.json` and
`package-lock.json`, which these producers bind. The same four original producers were rerun on that
tree on Node 24.18.0 (macOS arm64) and all passed: component fidelity with zero gated differences,
editor token fidelity with all 14 reference captures, the seven-mode accessibility proof with zero
serious/critical violations and zero unresolved incomplete findings, and all 108 running-app captures
with zero page errors, unexpected API requests, missing selectors, crashed windows or unavailable
workspace-trust states. No gate, fixture or rule was changed.

## Release 1.3.1 — 2026-10-27

The 1.3.1 version bump changes `package.json`, `package-lock.json` and
`packages/keiko-ui/package.json`, which these producers bind. The same four original producers were
rerun on the release tree after `dev` (including the `qs` override above) was merged into it, on
Node 24.18.0 (macOS arm64), and all passed: component
fidelity with 427 probes and zero gated or recorded differences, editor token fidelity with 160 gated
probes, zero gated differences and all 14 reference captures, the seven-mode accessibility proof with zero
serious/critical violations and zero unresolved incomplete findings, and all 108 running-app
captures with zero page errors, unexpected API requests, missing selectors, crashed windows or
unavailable workspace-trust states. No gate, fixture or rule was changed.

## Release 1.3.2 — 2026-10-28

The 1.3.2 version bump changes `package.json`, `package-lock.json` and
`packages/keiko-ui/package.json`, which these producers bind. The same four original producers were
rerun on the release tree on Node 24.18.0 (macOS arm64), and all passed: component
fidelity with 427 probes and zero gated or recorded differences, editor token fidelity with 160 gated
probes, zero gated differences and all 14 reference captures, the seven-mode accessibility proof with zero
serious/critical violations and zero unresolved incomplete findings, and all 108 running-app
captures with zero page errors, unexpected API requests, missing selectors, crashed windows or
unavailable workspace-trust states. No gate, fixture or rule was changed.
