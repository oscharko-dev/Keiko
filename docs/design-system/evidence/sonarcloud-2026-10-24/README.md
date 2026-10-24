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
  trade-offs. SonarCloud now records 112 individually evidenced loop false positives and 61
  explicitly owner-accepted design choices. All 173 retained loop texts are unchanged; no global
  rule settings or gate thresholds changed. Four source corrections await integrated-source analysis.

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
`docs/qa/sonarcloud-blocker-medium-2026-10-24.json`. The initial 354 findings comprise 161 source corrections and 193 individually documented
Cloud dispositions (132 false positives and 61 owner-accepted designs). Main still requires an
analysis of the integrated source to close the 161 source corrections. PR #4069 already reports zero
unresolved code issues; coverage and other required checks remain independently enforced.

The Git and SVG producers use `fixture-html.mjs` and the HTML parser to remove script elements
and inline local stylesheets, including uppercase tags and links without an XML closing slash.
The Git comparison disables page JavaScript. Both producers block browser network requests.
Proofs hash the shared helper and every loaded stylesheet; guards require five stylesheet inputs
per Git revision and eleven distinct stylesheet inputs for the ten SVG pages. The owned grid
interaction run retains its inline handlers and removes external scripts. Parser regression cases
live in `scripts/__tests__/sonar-fixture-html.test.mjs`.

Schema 2 uses `issueId` for public Sonar identifiers and file/hash records for stylesheet digests.
The first immutable PR commit triggered 602 Gitleaks generic-key false positives: 600 public issue
identifiers verified against the original API snapshot and two digests verified against the actual
stylesheet bytes. The history-only `.gitleaks.toml` intersection names that exact commit, three
evidence paths and the verified field shapes/digest lines. Future commits remain fully scanned.
Current proof/inventory JSON passes the pinned scanner; a fresh synthetic credential-shaped
negative control still fails it. No credential is included in these artifacts.
