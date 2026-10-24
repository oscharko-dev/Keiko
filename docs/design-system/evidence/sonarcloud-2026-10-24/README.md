# SonarCloud repair evidence — 2026-10-24

Run producers from the repository root. They use the installed Playwright Chromium and the fixed
`c8fb7e2d78720a8ba51d3d3ae7dd0e82f2df7add` baseline. Each proof records its producer and source
hashes. They are targeted preservation checks, not a claim of complete product equivalence.

- `node docs/design-system/evidence/sonarcloud-2026-10-24/context-loop-preservation.mjs` compares
  the original and current context-quality corpus and every non-timing summary field. Both versions
  must independently pass the unchanged timing and non-vacuity budgets. A targeted ESLint
  `no-await-in-loop` check verifies that the four original fixture findings are absent. Only fixed,
  independent in-memory fixture computations run together; each search retains its own budget and
  fixed clock, result order is preserved, and phase dependencies remain sequential.
  The [177-finding individual review](../../../qa/sonarcloud-await-in-loop-2026-10-24.json)
  records why the other 173 loops retain their exact original source. These are not blanket false
  positives: protocol dependencies and measurement isolation differ from resource and callback-order
  trade-offs requiring owner/analyzer review. No Cloud statuses or rule settings were changed.

- `node docs/design-system/evidence/sonarcloud-2026-10-24/css-preservation.mjs` checks 34,944
  computed values over 32 global/module CSS fixtures in eight theme, contrast and input modes,
  including the Monaco vendor cascade. The separately authorized four-pixel Editor host correction
  is covered by the original five-journey Editor smoke producer.
- `node docs/design-system/evidence/sonarcloud-2026-10-24/git-prototype-preservation.mjs` checks
  360 values across Changes, History and Empty, including the named native preview-state group.
- `node docs/design-system/evidence/sonarcloud-2026-10-24/svg-accessibility.mjs` verifies the
  unchanged geometry of the 57 reported reference SVGs, pixel equality in 40 page/mode comparisons,
  and SVG-specific axe rules. It restores only the reported SVG start tags in otherwise current
  HTML/CSS, blocks network traffic and disables page scripts for those comparisons. A separate
  in-page run of the data-table fixture compares keyboard sorting, select-all, clearing, single
  selection and the mixed header state against the baseline while retaining native table semantics.

The application connection SVG is decorative; the independently layered localized buttons remain
accessible. `ConnectionsLayer.a11y.test.tsx` verifies their native Tab/Enter/Space two-stage removal.
The complete issue inventory, owner-approved exceptions and gate results live in
`docs/qa/sonarcloud-blocker-medium-2026-10-24.json`. Cloud statuses require a subsequent Cloud analysis.
