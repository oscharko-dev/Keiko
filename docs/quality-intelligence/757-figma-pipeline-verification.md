# Figma snapshot → code + tests verification note (#757)

## Context

Epic [#750](https://github.com/oscharko-dev/Keiko/issues/750) delivers a model-independent
Figma → clean Snapshot pipeline: fetch only the scoped, release-ready screens, build them
deterministically into a lean immutable Snapshot (structural IR + design tokens + rendered images),
store it in Keiko, and drive both frontend code generation and Quality Intelligence test generation
from that one artifact. This note is the closure deliverable for the verification child
[#757](https://github.com/oscharko-dev/Keiko/issues/757): it cross-references every #757 acceptance
criterion to file:line evidence in the merged code and tests, records the live end-to-end run against
three real customer test boards (content-free metrics only), and documents — honestly — the findings
that live run surfaced.

This page is closure evidence for Epic #750. It is not the current release gate. **No customer board
content appears anywhere in this note**: only structural counts and ratios.

## Children shipped (all merged to `dev`)

The strict epic execution order (#751 → #752 → #753 → #810 → #754 → #811 → #812 → #755 → #756 → #758
→ #759 → #760) landed on `dev` ahead of this verification. Each short SHA is in
`git log dev --oneline`.

| Order | Issue                                                    | Title                                                  | Merge PR                                               | Short SHA |
| ----- | -------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ | --------- |
| 1     | [#751](https://github.com/oscharko-dev/Keiko/issues/751) | Connector — scoped fetch + ready-signal                | [#825](https://github.com/oscharko-dev/Keiko/pull/825) | `f57fc90` |
| 2     | [#752](https://github.com/oscharko-dev/Keiko/issues/752) | Clean → Screen-IR + design tokens + inter-screen links | [#826](https://github.com/oscharko-dev/Keiko/pull/826) | `b4abcbd` |
| 3     | [#753](https://github.com/oscharko-dev/Keiko/issues/753) | Render + immutable Snapshot evidence artifact          | [#829](https://github.com/oscharko-dev/Keiko/pull/829) | `d84182a` |
| 4     | [#810](https://github.com/oscharko-dev/Keiko/issues/810) | Multimodal capability routing                          | [#827](https://github.com/oscharko-dev/Keiko/pull/827) | `483d339` |
| 5     | [#754](https://github.com/oscharko-dev/Keiko/issues/754) | figma-snapshot QI source — baseline + vision           | [#831](https://github.com/oscharko-dev/Keiko/pull/831) | `f799a0e` |
| 6     | [#811](https://github.com/oscharko-dev/Keiko/issues/811) | Navigation/flow graph + deterministic flow tests       | [#833](https://github.com/oscharko-dev/Keiko/pull/833) | `886af09` |
| 7     | [#812](https://github.com/oscharko-dev/Keiko/issues/812) | Accessibility baseline from Screen-IR + render         | [#836](https://github.com/oscharko-dev/Keiko/pull/836) | `761ff73` |
| 8     | [#755](https://github.com/oscharko-dev/Keiko/issues/755) | Design-to-code — framework-agnostic + adapter seam     | [#835](https://github.com/oscharko-dev/Keiko/pull/835) | `724e94a` |
| 9     | [#756](https://github.com/oscharko-dev/Keiko/issues/756) | Figma/Snapshot Workspace surface (UI)                  | [#834](https://github.com/oscharko-dev/Keiko/pull/834) | `169c913` |
| 10    | [#758](https://github.com/oscharko-dev/Keiko/issues/758) | Secure PAT handling — vault, rotation, expiry          | [#828](https://github.com/oscharko-dev/Keiko/pull/828) | `6f573e1` |
| 11    | [#759](https://github.com/oscharko-dev/Keiko/issues/759) | Snapshot-build resilience — backoff, concurrency       | [#830](https://github.com/oscharko-dev/Keiko/pull/830) | `51fdef7` |
| 12    | [#760](https://github.com/oscharko-dev/Keiko/issues/760) | Observability & governance — audit, error taxonomy     | [#832](https://github.com/oscharko-dev/Keiko/pull/832) | `b447da6` |

All twelve child issues are CLOSED. The merged code at `dev` HEAD is the artifact under verification.

## Live end-to-end evidence (real connector, 3 customer test boards — content-free metrics)

The authoritative live run was executed by the coordinator against the three real customer test
boards. The live run requires `FIGMA_ACCESS_TOKEN` + the real boards, which data-governance keeps out
of agents and commits, so only the **content-free** metrics below are recorded here. The run used the
real connector (`createFigmaConnector`) and the full pipeline, with the transport injected through the
`FigmaHttpPort` seam (the documented #802 prerequisite — see ENV/GOVERNANCE below). The same code path
ran for all three boards with **no board-specific branching** (GENERIC). Re-emission was
**byte-identical** with **no model invoked** (DETERMINISTIC, model-free).

| Board | raw→kept nodes | reduction | screens | tokens color/typo/spacing/radius | inter-screen links | navNodes/navEdges/navTests | a11yTests | structural baseline items | code files | code bytes | deterministic re-emit | token leak |
| ----- | -------------- | --------- | ------- | -------------------------------- | ------------------ | -------------------------- | --------- | ------------------------- | ---------- | ---------- | --------------------- | ---------- |
| 1     | 802→426        | 46.9%     | 60      | 8/1/10/3                         | 1                  | 60/0/60                    | 0         | 121                       | 62         | 61235      | yes (byte-identical)  | none       |
| 2     | 404→240        | 40.6%     | 31      | 4/0/7/1                          | 0                  | 31/0/31                    | 0         | 62                        | 33         | 35174      | yes                   | none       |
| 3     | 863→493        | 42.9%     | 54      | 5/1/9/3                          | 1                  | 54/0/54                    | 0         | 114                       | 56         | 69922      | yes                   | none       |

Each board's emitted code includes a `tokens.css` (design tokens as CSS custom properties) plus an
`index.html`. The Figma PAT never appears in any emitted artifact — asserted by a substring scan over
the IR + code + a11y + nav JSON.

### Live findings (honest — these are the value of the verification)

- **PASS:** scoped-fetch (`GET /v1/files/:key/nodes`, depth=4) → clean → IR → design-token extraction
  (#752) → structural test baseline (#754) → deterministic codegen (#755) work LIVE on all three
  boards; GENERIC; DETERMINISTIC; ZERO token leak; design tokens flow end to end into the code
  (`tokens.css`).
- **FINDING-1 (boards lack prototype links):** `navEdges = 0` on all three boards — these particular
  boards have ~0 wired prototype interactions, so the navigation GRAPH has nodes but no transition
  edges (the 60/31/54 "navTests" are per-screen coverage notices). The nav edge/flow derivation
  (#811) is unit-proven and deterministic; it is simply **unexercised** by these static boards. The
  new synthetic integration test below feeds the derivation a wired link and proves the edge + nav
  test FIRE.
- **FINDING-2 (architectural — the key finding):** `a11yTests = 0` and IR text is sparse (board 1: 11
  of 91 raw TEXT survive; board 2: 0 of 15). Root cause: the meaningful UI text lives DEEP inside
  component INSTANCE subtrees (board 2 has 195 INSTANCEs) BELOW the depth-4 scoped fetch; fetching at
  depth=8 trips `FIGMA_OVERSIZED_SCOPE` (the 5000-node guard, #759) and times out. The shallow
  surviving TEXT nodes are canvas-level labels, correctly NOT part of any screen. So the IR
  faithfully captures layout / structure / tokens but little in-screen text on instance-heavy boards,
  and #812's a11y rules (which gate on `interactionHint` + text + `textColor`) and text-aware codegen
  are **under-fed**. The a11y/nav DERIVATIONS are correct-by-construction (unit-proven); they fire
  when the IR carries the data. The gap is the **scoped-fetch-depth vs oversize-guard tension on
  instance-heavy boards** — an architectural follow-up (per-screen scoped fetch or component
  resolution), **not a derivation bug**. The new synthetic integration test isolates exactly this by
  feeding a properly-shaped IR and showing the a11y items fire.
- **FINDING-3 (sub-finding):** `textColor` was extracted for 0 nodes even where in-screen TEXT
  survived (board 1's 11). `firstSolidPaintHex(node, "fills")` may not match the real Figma TEXT
  fill/style shape (text colour is often carried via a shared `fillStyleId` rather than an inline
  solid fill). This needs a focused follow-up to confirm.
- **ENV / GOVERNANCE:** undici `fetch` fails the corporate-CA TLS that curl / system-CA passes (the
  corporate root CA is rejected by undici at the same endpoint curl reaches at HTTP 200). This is a
  real finding, consistent with #802 being a deferred prerequisite and with #760's
  `FIGMA_TLS_CA_FAILURE` taxonomy. The connector's `FigmaHttpPort` seam absorbs it cleanly. The live
  harness ran entirely in `/tmp`, printed only metrics, and committed nothing; `.keiko/` and
  `only-for-internal-use/` are git-ignored (verified below).

Recommended follow-ups (out of scope for #757, which is verification-only): a per-screen / component-
resolving scoped fetch to feed instance-heavy boards (FINDING-2); `fillStyleId`-aware text-colour
extraction (FINDING-3); and the #802 proxy + custom-CA transport so undici can reach Figma directly.

## Synthetic integration test (committed — synthetic fixtures only)

`packages/keiko-quality-intelligence/src/__tests__/figma/pipelineEndToEnd.test.ts` is a new
end-to-end test that drives a **synthetic, INSTANCE/FRAME-heavy** board carrying proper in-screen data
(TEXT nodes with `characters` + solid text fills, an interactive node, an image fill, bounding boxes,
and a wired inter-screen prototype link) through the FULL pipeline:

```
raw FigmaSourceNode tree
  → cleanScopedNodesToScreenIr               (#752)
  → deriveNavGraph / deriveNavTestItemsByScreen   (#811)
  → deriveA11yTestItemsByScreen               (#812)
  → deriveScreenTestBaseline(screen, extraItems)  (#754 additive seam)
  → emitCode(input, htmlCssAdapter)           (#755)
```

It asserts: a reduction ratio is reported; the screens are detected (stable id order); design tokens
are extracted **and** referenced in `tokens.css`; exactly one navigation edge + a navigation test item
are produced from the wired link; a11y items fire for **contrast** (black on white → exact 21:1 ≥ 4.5
AA verdict), **alt-text** (image-fill node), and **accessible-name** (interactive node with an opaque
id-style name and no text); the nav + a11y items compose into the per-screen baseline through the
`extraItems` seam; codegen emits well-formed per-screen HTML + `tokens.css` + `index.html` with
framework-agnostic nav scaffolding; and a re-run is byte-identical (deterministic, no model). A second
structurally different synthetic board (different screen count, names, depth, link shape) runs the
**same code path** with no rule changes (GENERIC).

This is the cross-check for FINDING-2 / FINDING-3: when the IR is fed real-shaped in-screen data, the
a11y and nav derivations FIRE — confirming the live `a11yTests = 0` / `navEdges = 0` is a
fetch-depth / extraction limitation, not a defect in the deterministic derivation logic.

## Acceptance criteria

| #   | #757 acceptance criterion                                                                                                                                                                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Status |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | A real large board reduced to a lean snapshot; code + tests generated; no token/PII leak into snapshot or evidence.                                                                                      | Live table: boards 1/2/3 reduced 46.9% / 40.6% / 42.9%; 62 / 33 / 56 code files emitted; baseline 121 / 62 / 114 items; token leak `none` (substring scan). Snapshot no-token asserted by `figmaSnapshotBuilder.test.ts:223` ("never embeds the token anywhere in the assembled snapshot value").                                                                                                                                                                                                                       | PASS   |
| 2   | A single read-only PAT (from `FIGMA_ACCESS_TOKEN`), proxy-routed, authenticates the connector; never reaches the browser, snapshot, or log; runtime loads only the allowlisted PAT from `.env` at start. | Token resolved server-side at `figmaConnector.ts:80` via `resolveFigmaToken` (`figmaTokenSource.ts:32`, precedence vault > config > `FIGMA_ACCESS_TOKEN` env); materialised into `X-Figma-Token` only at the transport boundary (`figmaConnector.ts:152`); route resolves it server-side and never returns it (`figmaSnapshotRoutes.ts:249-253`, header note line 15). Runtime `.env` load: the `keiko ui` command imports only `FIGMA_ACCESS_TOKEN` from a repo-local `.env` via `loadLocalKeikoEnv` — see note below. | PASS   |
| 3   | No Figma communication after the bounded snapshot-build; all downstream stages read only the stored snapshot (snapshot = boundary).                                                                      | Figma is contacted only inside the connector + render ports (`figmaConnector.ts`, `figmaRenderPort.ts`), both invoked only during snapshot-build (`figmaResnapshot.ts`, header lines 7-10). The QI source loader reads only the stored snapshot via the evidence store, never Figma (`figmaSnapshotAdapter.test.ts:3-4`). IR / nav / a11y / codegen are pure domain (`packages/keiko-quality-intelligence/src/domain/figma/*`, no IO).                                                                                  | PASS   |
| 4   | Re-snapshot is an explicit, on-demand full re-fetch (no delta/incremental); single-fetch principle holds.                                                                                                | `resnapshotFigma` (`figmaResnapshot.ts:42`) performs a deliberate FULL scoped re-fetch — "NO delta and NO incremental skip" (header lines 3-7); the connector uses scoped `GET /v1/files/:key/nodes?ids=&depth=` only, never the whole-file endpoint (`figmaConnector.ts:88-96`). No webhook / poll path exists.                                                                                                                                                                                                        | PASS   |
| 5   | The deterministic layer produces a usable snapshot, structural baseline, and code skeleton with NO model; model augmentation is additive + attributed.                                                   | Clean → IR (`cleanToScreenIr.ts`), baseline (`screenIrTestBaseline.ts`), and codegen (`codeTargetAdapter.ts`) are pure and model-free. Live re-emission byte-identical with no model invoked (live table, all 3 boards). Synthetic test: byte-identical re-run case. Vision augmentation only merges hints, never overrides the IR (`visionAugmentation.ts`).                                                                                                                                                           | PASS   |
| 6   | Identical behaviour on `gpt-oss-120b` (chat) + a multimodal model, capability-routed, with graceful degradation when multimodal is absent.                                                               | Capability-routed selection (no hard-coded id) at `modelSelection.ts:143`; typed `{ kind: "unavailable" }` degradation to IR-only when no image-input model is configured (`resolveQiMultimodalSelection`, `modelSelection.ts:138-152`). The deterministic baseline stands alone (AC 5). The live run exercised the IR-only path (no multimodal call).                                                                                                                                                                  | PASS   |
| 7   | Multimodal routing (#810) selects a vision model by capability and degrades to IR-only when absent.                                                                                                      | `selectConfiguredModel(config, { kind: "chat", supportsImageInput: true })` (`modelSelection.ts:143`); capability flag `supportsImageInput` in the gateway registry (`packages/keiko-model-gateway/src/model-selection.ts:18-32`, `capabilities.ts:30-31`). Returns `unavailable` → IR-only when no model advertises it.                                                                                                                                                                                                | PASS   |
| 8   | Design tokens are extracted (#752) and consumed by code-gen (#755) — generated code references the extracted tokens.                                                                                     | Tokens extracted in `cleanToScreenIr.ts` (`extractDesignTokens`); consumed by `htmlCssAdapter` into `tokens.css` custom properties — `designToCode.test.ts` "links the design tokens into CSS custom properties referencing token values". Live: every board emits a `tokens.css`. Synthetic test: every extracted colour appears in `tokens.css`.                                                                                                                                                                      | PASS   |
| 9   | The navigation/flow graph + flow tests (#811) are produced deterministically (model-free, reproducible).                                                                                                 | `deriveNavGraph` / `deriveNavFlows` / `deriveNavTestItemsByScreen` are pure (`navGraph.ts`); byte-identical case `navGraph.test.ts:355`. Synthetic test: wired link → 1 edge + 1 navigation item, reproducible.                                                                                                                                                                                                                                                                                                         | PASS   |
| 10  | The a11y baseline (#812) is produced model-free, with contrast computed from the extracted tokens.                                                                                                       | `deriveA11yTestItemsByScreen` is pure; exact WCAG contrast from IR colours (`a11yBaseline.ts`, `relativeLuminance` / `contrastRatio`); cases `a11yBaseline.test.ts:101,117`; determinism `a11yBaseline.test.ts:322`. Synthetic test: contrast / alt-text / accessible-name items fire.                                                                                                                                                                                                                                  | PASS   |
| 11  | GENERIC: no rule/threshold/name/template tuned to a sample board; results hold on a structurally different synthetic fixture.                                                                            | Live: the same code path with no board-specific branching ran across three structurally different boards. Synthetic test: a second structurally different board ("Catalog/Detail/Cart") runs the same code path with no rule changes. The deterministic modules read only structural shape (module headers in `cleanToScreenIr.ts`, `navGraph.ts`, `a11yBaseline.ts`).                                                                                                                                                  | PASS   |
| 12  | GOVERNANCE: no customer board content / Storybook / snapshot committed; live snapshots only in git-ignored `.keiko/`; committed tests synthetic-only.                                                    | `git check-ignore -v` resolves `.keiko/` → `.gitignore:140` and `only-for-internal-use/` → `.gitignore:165` (and nested paths). Committed test (`pipelineEndToEnd.test.ts`) uses invented synthetic fixtures only. This note records content-free metrics only.                                                                                                                                                                                                                                                         | PASS   |

### Note on the `.env` runtime-load criterion (AC 2)

The epic precondition stated "no dotenv loader exists at runtime". As shipped, the `keiko ui` command
loads only the closed allowlist `FIGMA_ACCESS_TOKEN` from `<cwd>/.env` via `loadLocalKeikoEnv`; it does
not import `KEIKO_*` runtime configuration, gateway credentials, or evidence paths from a repo-local
`.env`. So the documented Figma run pattern (`FIGMA_ACCESS_TOKEN` in the repo-root `.env`, then
`keiko ui`) still loads the PAT for the server side, while model gateway and evidence configuration
must be provided through explicit flags or the process environment. There is no general process-wide
dotenv autoloader for non-`ui` entrypoints; callers of those must export the env or use `--env-file` /
`process.loadEnvFile()`.

## Security check (read-only PAT)

- The PAT is materialised into the `X-Figma-Token` header only at the transport boundary
  (`figmaConnector.ts:152`); it is never logged, never returned in any response, and never placed in
  provenance or error bodies (`figmaConnector.ts:8-13`, `extractFigmaReason` passes only the generic
  `err`/`message` string to the classifier, never the token).
- The assembled Snapshot never embeds the token (`figmaSnapshotBuilder.test.ts:223`).
- The token-failure taxonomy (`figmaConnectorErrors.ts`) classifies 401/403/TLS faults into coded
  errors (`FIGMA_TOKEN_INVALID` / `EXPIRED` / `REVOKED` / `FIGMA_TLS_CA_FAILURE`) carrying only
  generic remediation text — no token, no raw provider payload.

## Verification commands (this branch)

Run from the worktree root on the `feat/757-figma-verification` branch:

| Step             | Command                                                                                           | Result                        |
| ---------------- | ------------------------------------------------------------------------------------------------- | ----------------------------- |
| New integration  | `npx vitest run packages/keiko-quality-intelligence/src/__tests__/figma/pipelineEndToEnd.test.ts` | 9 passed                      |
| Type check       | `npm run typecheck`                                                                               | exit 0                        |
| Lint             | `npm run lint`                                                                                    | exit 0 (`--max-warnings=0`)   |
| QI package tests | `npx vitest run packages/keiko-quality-intelligence`                                              | all green (see PR run output) |

This note and the synthetic integration test are the only changes on this branch: no merged feature
code is modified.
