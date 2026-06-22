# ADR-0051: Design System visual-regression and acceptance gate

Issue [#1300](https://github.com/oscharko-dev/Keiko/issues/1300) · Epic [#1290](https://github.com/oscharko-dev/Keiko/issues/1290) · Design System 0.4.0.

## Status

Accepted (Issue #1300, Epic #1290, 2026-06-22)

## Version

0.2.0

## Context

Issues #1291–#1299 landed the full Design System 0.4.0 adoption: the token tiers, the shell/chrome and
product-surface migrations, the AI/agent, data-grid/dataviz, and input/navigation component sets, and the
component-state and governance contract. Each child shipped a per-surface 0-diff `equivalence-harness.mjs`
proof under `docs/design-system/evidence/<issue>/`, and the runtime/state/governance gates were fixed by
ADR-0049 and ADR-0050.

What remained was the **epic closure gate**: a single, re-runnable, consolidated proof that the migrated
surfaces — taken together — still resolve to the 0.4.0 reference, render correctly across the full
theme/contrast/motion/viewport matrix, pass accessibility, and have been visually accepted; plus a recorded
tolerance, a recorded artifact-retention approach, and a final variance register. Issue #1300 (Agent Execution
Mode: agent team, audit/verification-heavy, human-led/agent-assisted; `Human Review Required: Yes`) is the
governing issue. Without this gate the epic could only be closed on the dispersed per-child proofs and
subjective claims, which ADR-0050 Gate 8 explicitly disallows for acceptance.

The binding evidence is established under [`docs/design-system/evidence/1300/`](../design-system/evidence/1300/)
(the consolidated harnesses + their JSON proofs + the screenshot bundle) and
[visual-regression.md](../design-system/visual-regression.md) (the surface matrix, tolerance, retention,
designer-acceptance notes, and variance register).

## Decision

The following gates are additive to, and never weaken, the existing architecture, security, accessibility,
evidence, and CI gates established by ADR-0049, ADR-0050, and the upstream architecture ADRs.

1. **Consolidated reference-fidelity is the closure gate.** A single re-runnable harness
   (`evidence/1300/equivalence-harness.mjs`) renders the union of the migrated component surfaces (AI, data
   grid, dataviz, inputs, navigation) with the product `globals.css` and with the concatenated DS 0.4.0
   reference, and asserts **0 computed-value diffs in Dark and Light** for every neutral/semantic surface.
   The gate compares colours canonicalised to rendered sRGB pixels through an in-page `<canvas>`, with a
   tolerance of **≤ 1 LSB per channel** (so a hex-authored token and the perceptually-identical `oklch()` the
   reference uses compare equal). High Contrast, forced-colors, prefers-contrast and reduced-motion are
   recorded, not gated.

2. **The screenshot bundle must cover the full matrix and always include Light Mode.** Running-app captures
   (`evidence/1300/browser/`) span Dark, Light, High Contrast, reduced-motion, and forced-colors at desktop,
   tablet, and mobile widths. Light Mode is mandatory in every screenshot matrix and acceptance checklist;
   evidence that omits Light Mode is rejected.

3. **A dedicated editor matrix is required.** Editor token-tier fidelity
   (`evidence/1300/editor/capture.mjs`) gates the `--ed-*` tokens the product defines to **0-diff in Dark and
   Light** against `keiko-editor-tokens.css`, captures the seven `editor-*.html` reference pages for visual
   inspection, and is paired with the running-editor Playwright proofs (`test:e2e:editor-fidelity-1295`,
   `-1296`). The epic is not marked complete while editor token, Monaco, chrome, gutter, navigation, panel,
   markdown, icon, or agent-in-editor evidence is missing.

4. **Accessibility is proven across every mode.** An axe-core run (`evidence/1300/a11y/axe-proof.mjs`) over the
   component union asserts **zero serious or critical WCAG 2.1 A/AA violations** in each of the seven
   theme/contrast/motion modes, covering contrast, name/role/value, keyboard semantics, reduced-motion, and
   forced-colors. Any serious/critical violation fails the run.

5. **Visual automation carries a performance smoke.** Any rendering/visual-automation change must keep a
   bounded interaction proof green (the harness scrolls a bounded 250-row sticky table and asserts the sticky
   header holds and the scroll completes well under budget). This prevents the visual gate from masking an
   interaction regression.

6. **Designer acceptance is visual inspection, recorded.** Per ADR-0050 Gate 8 applied at epic scope, the
   acceptance evidence is autonomous agent visual inspection of the rendered surfaces (polish, readability,
   usability) recorded per surface in [visual-regression.md](../design-system/visual-regression.md) with the
   reference compared, the variance observed, and the disposition. Token/contrast/pixel measurements alone are
   insufficient. `Human Review Required` stays **Yes**: the recorded notes are the agent-assisted pass; final
   human designer sign-off is the governance step on the epic closure comment.

7. **Variances are dispositioned, never suppressed.** Only deviations classified as **approved** (the
   pre-existing ~1.5% `--accent` hex↔`oklch()` primitive delta; product HC/forced-colors layering; the
   governed Light Mode override register) or **carried-forward with a named owner** (0.4.0 editor tokens
   `--ed-inlay-fg`/`--ed-blame-fg`/`--ed-fold-placeholder` not yet adopted by the product, owned by editor
   epics #1373/#1390) may exist between product and reference. A genuine new drift is a regression and fails
   the gate; it must not be reclassified to pass.

8. **Evidence is in-repo, re-runnable, and CI-pinned.** All artifacts (PNG + JSON) are retained under
   `docs/design-system/evidence/1300/` so the baseline travels with the source it proves. The `Issue #1300`
   block in `packages/keiko-ui/src/app/globals.css.test.ts` pins the consolidated proofs and the variance
   register against the product CSS so drift fails the required `ci`/`ui` checks without needing a browser.

## Consequences

- Epic #1290 can be closed on objective, reproducible evidence: 427 component probes and 160 editor-token
  probes at 0 gated diffs, 0 serious/critical accessibility violations across seven modes, a bounded
  performance smoke, and a Light-inclusive screenshot bundle, all re-runnable by future contributors.
- The consolidated harness is a superset of the per-child harnesses, so a future change that drifts any one
  migrated layer fails a single gate rather than slipping between per-surface proofs.
- The variance register makes the only two real gaps explicit: the approved accent primitive delta (no action)
  and the carried-forward editor tokens owned by #1373/#1390 (tracked there, not a #1290 deliverable).
- The acceptance pass is autonomous and recorded, but `Human Review Required: Yes` means human designer
  sign-off remains an explicit, un-bypassed governance step — the gate does not claim human acceptance it did
  not obtain.
- Retaining PNG/JSON artifacts in-repo grows the repository, which is the accepted cost of a baseline that
  travels with the code and is diffable by any contributor.

## References

- Issue [#1300](https://github.com/oscharko-dev/Keiko/issues/1300), Epic [#1290](https://github.com/oscharko-dev/Keiko/issues/1290).
- [visual-regression.md](../design-system/visual-regression.md) (surface matrix, tolerance, retention,
  designer-acceptance notes, final variance register, child-issue evidence index).
- [`evidence/1300/`](../design-system/evidence/1300/) (consolidated harnesses + `consolidated-fidelity-proof.json`,
  `editor/editor-fidelity-proof.json`, `a11y/a11y-proof.json`, `browser/manifest.json`, and the PNG bundle).
- [visual-qa-matrix.md](../design-system/visual-qa-matrix.md) (the #1291 Studio visual-regression plan and
  pixel-variance policy this gate implements and refines).
- [fidelity-matrix.md](../design-system/fidelity-matrix.md), [light-mode-deviation-register.md](../design-system/light-mode-deviation-register.md),
  [token-component-reuse-map.md](../design-system/token-component-reuse-map.md) (#1291 blueprint).
- ADR-0049 (design-system runtime fidelity gates) and ADR-0050 (component state, documentation, and governance
  contract): this ADR adds the consolidated visual-regression and epic-acceptance gate on top of both —
  ADR-0049 governs the runtime token architecture, ADR-0050 governs component-state and contribution
  governance, and this ADR governs the consolidated visual-regression proof and epic-closure acceptance.
- Issues #1373 (Editor Core Workspace Resilience) and #1390 (Agent-Native Editor API): owners of the
  carried-forward 0.4.0 editor tokens recorded in the variance register.
