# AGENTS.md — Working on Keiko

Guidance for AI coding agents (Claude Code, Codex, Cursor, Copilot, …) and the humans
reviewing their output. This file is the shared, checked-in contract: every contributor and
every agent works from the same rules. Read it before you touch code.

If anything here conflicts with an [Architecture Decision Record](docs/adr/), the ADR wins —
tell the human and stop. If it conflicts with [`CONTRIBUTING.md`](CONTRIBUTING.md), they should
agree; flag the drift.

---

## 1. What Keiko is (and the one rule you cannot break)

Keiko is a **governed, local-first agentic workspace** for regulated engineering and knowledge
work. It is a TypeScript monorepo (npm workspaces, Node >=24.18.0 <25) that ships as one bundled
product.

**The human-control invariant — non-negotiable:**

> A local human selects or accepts the task, autonomy mode, Authority Envelope, and deployment
> ceiling. Keiko may then act inside that validated, bounded authority without per-action approval
> when policy says `allowed`. For accepted repository work targeting `dev`, agents may commit, push
> their feature branch, and maintain the pull request; GitHub native auto-merge may integrate only
> after the app-bound required checks succeed on the exact current head and every review
> conversation is resolved. Direct pushes to
> `dev`, force pushes, gate bypasses, and authority widening remain denied or separately approved.
> Manifest-producing surfaces emit **redacted** evidence for deterministic gate evaluation.

The repository-delivery sentence above governs how agents contribute accepted work to Keiko's own
`dev` branch under ADR-0135. It is not a capability promise for the end-user Governed Merge Gateway:
ADR-0087 continues to require an explicit, approval-gated merge request and excludes autonomous or
background auto-merge scheduling from that product surface.

The product has exactly three user-facing modes — the product-wide authority model for every
autonomy-capable surface, anchored by
[ADR-0129](docs/adr/ADR-0129-product-wide-authority-and-autonomy-model.md), amended for repository
delivery by [ADR-0135](docs/adr/ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md), and
governed in detail by
[ADR-0124](docs/adr/ADR-0124-coding-autonomy-modes-and-sidecar-runtime-authority.md) and
[ADR-0125](docs/adr/ADR-0125-governed-agent-docking-and-editor-changesets.md), with the corrected
monotonic semantics fixed by
[ADR-0138](docs/adr/ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md):

- **Ask for approval** (`governed-assist`) allows reads and planning and asks before workspace
  edits, commands, external files, internet use, or delivery.
- **Supervised workspace** (`supervised-coding`) allows routine workspace-contained edits, vetted
  commands, and verification and asks before risky contained work, external files, internet use,
  or delivery.
- **Full access** (`autonomous-delivery`) allows file and internet work inside the validated
  Authority Envelope without per-action approval. Accepted `dev` delivery follows ADR-0135 and is
  integrated automatically only once the auto-merge preconditions in the invariant above hold.

Hard denials remain mode-independent: invalid or expired authority, workspace escape, denied
sensitive paths, secret exfiltration, unsupported actions, exhausted budgets, and platform
restrictions fail closed.

This shapes the product _and_ how you work on it:

- For an accepted Keiko task or epic, agents may commit, push the assigned non-`dev` branch, open or
  update its PR, repair deterministic findings, arm native auto-merge, and close the issue after
  verified merge without a second human handoff. Never push directly to `dev`, force-push, bypass a
  required check, dismiss a finding to obtain green status, or merge outside the ADR-0135
  direct-check path.
- **Never** weaken a trust boundary, evidence redaction, or a governance gate to make something
  pass. Fail closed. If a gate blocks you, the gate is usually right.
- Secrets stay out of code, logs, evidence, config, and tests. Evidence and diagnostics are
  body-free: counts, hashes, redacted summaries — never raw content, keys, endpoints, or PII.

---

## 2. Setup and the commands you will actually run

```bash
npm install               # installs all workspaces from the single root lockfile
npm run provision:usearch # ONCE per checkout — see below; without it `npm test` is red
npm run build             # build:packages (tsc -b) then the root build
npm run dev:start         # Node BFF + Next.js UI on ONE loopback URL (http://127.0.0.1:1983)
npm run dev:stop
```

The dev UI and BFF bind loopback port **1983** (not Vite's 5173, not 3000). If 1983 is taken,
`dev:start` picks the next free loopback port and prints it.

**`provision:usearch` is a real prerequisite, not an optional extra.** The pinned USearch HNSW ANN
runtime (ADR-0164; sqlite-vec was retired — it performed exhaustive KNN, not ANN) is deliberately not
an npm dependency (upstream publishes an invalid SPDX license string that two supply-chain gates
reject), so the exact upstream tarball is fetched and SHA-256-verified by that script instead. CI
runs it as a setup step before every test lane. `npm test` does **not** run it for you, so on a
fresh checkout the two Knowledge-M2 proof suites — `knowledge-m2-closeout` (its `ann-active` proof)
and `knowledge-m2-clean-checkout-demo` — fail until you have run it once. They fail rather than skip
on purpose: a missing runtime must never quietly mask a real ANN regression.

Use `npm` only. This repo is npm workspaces with a committed `package-lock.json` — there is no
pnpm/yarn/bun lockfile. Do not add one.

---

## 3. The green bar — how to know a change is actually done

**This is the most important section. Read it twice.**

Keiko holds a production, enterprise quality bar and enforces it with a large gate surface. A
change is "done" only when the gates that apply to it pass **locally**. Do not use CI as your
test loop — reproduce the gates here first.

### The trap that catches every new agent

> **`npm test` (vitest) does NOT run TypeScript type-checking or ESLint.**

Vitest transpiles and runs — it will happily go green on code that does not type-check and that
lint would reject. "Tests pass" is **not** "the change is green." You must run `typecheck`,
`lint`, and `format:check` as separate steps, every time.

### Minimum loop for any change

```bash
npm run typecheck        # builds packages, checks the package graph, then tsc --noEmit (strict)
npm run lint             # eslint . --max-warnings=0  AND  the keiko-ui workspace lint
npm run format:check     # prettier --check (CI runs this; format:check failing = red)
npm test                 # build:packages then vitest run
npm run arch:check       # dependency-cruiser + import-policy + contract-boundaries
npm run arch:check:negative
```

There is a convenience aggregate that chains the core of the above:

```bash
npm run conversation:release-check
```

To run the common failure classes in CI's own Linux userland before pushing — the same image for
every contributor and agent:

```bash
npm run gates:local
```

Two thirds of recent required-CI failures were reproducible this way, each otherwise costing a full
CI cycle to discover. What the container may and may not answer is in
[`docs/qa/local-gates.md`](docs/qa/local-gates.md) — note that D12 measurement evidence is the
opposite of CI-owned: its reference environment IS a developer-machine container, and no hosted
runner matches it.

### Before every pull request, without exception

```bash
npm run gates:sonar
```

**This is mandatory before you open or update a pull request against `dev`.** It runs a real SonarJS
analyzer against your diff in a self-hosted, digest-pinned container and exits non-zero if it finds
anything. It never contacts sonarcloud.io.

Run it because `npm run check:sonar-rules` cannot answer the question. That gate runs
`eslint-plugin-sonarjs`, which carries 279 rules in every published version up to 4.2.0; SonarCloud
runs the full analyzer, which carries hundreds more. `S7786` (throw `TypeError`, not `Error`, after a
type check), `S7755` (`.at(-1)`, not `[x.length - 1]`), `S7778` (one `push` with several arguments)
and `S7776` (a `Set`, not `.includes()` on a constant array) are in that gap and exist in **no**
version of the plugin. Each of them has already cost this repository a full CI round, and the
`Coverage and SonarCloud` job demands zero unresolved issues — so one MINOR of that class fails the
required `ci` context. A green `check:sonar-rules` says nothing about any of them.

What it is and is not, and how to read a disagreement with CI:
[`docs/qa/local-sonar.md`](docs/qa/local-sonar.md).

For PR-bound work there is deliberately **no aggregate pre-PR wrapper** (ADR-0145 retired
`agent:pre-pr` by owner decision): run the minimum-loop commands that can see your change, plus
`npm run gates:sonar` and any touched-area gate from the table below, and let the required CI run on
the pull request be the complete arbiter.

### Local-first gate policy

Verify locally what your change can affect; required CI is the authoritative full matrix on every
pull request. Never use CI to discover what your own diff obviously breaks. Concretely:

1. Before a push or PR update, run the minimum-loop commands scoped to what your change touches,
   `npm run gates:sonar`, and any touched-area gate from the table below.
2. If a required CI gate goes red, reproduce that exact failure locally with the targeted
   command before pushing another fix; after the fix, rerun that command first.
3. Push only when your targeted local runs are green or a documented platform-specific local
   skip is unavoidable.
4. Report outcomes from the runs you actually executed, not from memory.
5. The required CI run on the pull request is the final, complete arbiter.

If a required gate cannot be run locally, state that in the PR instead of guessing.

For UI smoke failures, run the targeted Playwright repro first, then the full affected smoke gate.
For package export or runtime surface changes, run the package build and package-surface smoke
locally before pushing. For platform-specific evidence, do not replace CI/Linux evidence with
macOS-generated values unless the repository explicitly documents macOS as authoritative for that
evidence.

### When you touched these areas, also run

| You changed…                                   | Also run                                                                                                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anything under `packages/keiko-ui/`            | `npm run typecheck --workspace @oscharko-dev/keiko-ui`, `npm run lint --workspace @oscharko-dev/keiko-ui`, `npm run test:coverage:ui`, `npm run check:editor-release-evidence` (see §7) |
| A package's **public exports** / a new package | `npm run check:package-surface:assembled`                                                                                                                                               |
| Retrieval / RAG / grounding                    | `check:retrieval-quality`, `check:grounded-retrieval-quality`, `check:grounded-faithfulness`                                                                                            |
| Context lanes / compaction                     | `check:context-quality`                                                                                                                                                                 |
| Server error handling / diagnostics            | `check:error-observability`                                                                                                                                                             |
| An ADR (added/renumbered)                      | `npm run check:adr-index`                                                                                                                                                               |
| Added or renamed a `test:e2e:*` script         | `npm run check:e2e-suite-wiring` — a suite no lane runs is not coverage (#2629)                                                                                                         |
| Package versions / release metadata            | `check:version-consistency`, `check:release-impact`                                                                                                                                     |
| Coverage-sensitive code                        | `npm run test:coverage:quality`                                                                                                                                                         |
| **Any code at all, before every pull request** | **`npm run gates:sonar`** — the only local run that sees the SonarJS rules `eslint-plugin-sonarjs` does not ship ([`docs/qa/local-sonar.md`](docs/qa/local-sonar.md))                   |

Prefer the narrow gate for your change over running everything; run the full
`test:coverage:quality` chain before you claim a release-affecting change is green.

---

## 4. Architecture and package boundaries

Packages live under `packages/`. Root `src/` holds the top-level entrypoints and runtime wiring;
`tests/` holds cross-package integration + Playwright e2e; `scripts/` holds the build/gate/release
tooling (`.mjs`, Node ESM, outside the TS program); `docs/adr/` is the decision record.

Dependencies flow **one direction only**, enforced by `arch:check` (dependency-cruiser rules
named after their governing ADR, plus `check-import-policy.mjs` and `check-contract-boundaries.mjs`).
The shape (ADR-0019):

- **`keiko-contracts` is the leaf** — the shared type/contract layer. It depends on nothing else
  in the repo. Everything else depends _inward_ toward it. Put cross-package types here.
- **`keiko-security`** depends only on contracts. Most domain packages depend only on
  contracts + security.
- **`keiko-model-gateway`** is the _only_ place provider SDKs (`openai`, `@anthropic-ai/*`,
  `*-ai-sdk`) may be imported. This isolation is a hard gate — do not import a model SDK anywhere
  else (ADR-0019 trust-1).
- **`keiko-tools` / `keiko-harness` / `keiko-workflows`** must not touch `node:fs` outside the
  workspace boundary, and file patches route through `keiko-tools` (trust-4 / trust-5).
- **`keiko-server`** (the BFF) sits near the top: it may use the domain packages, but **domain
  packages must not depend on the server**, and the server must not depend on `keiko-editor`.
- **`keiko-ui`** (Next.js, static export) is the frontend. It talks to the server only across
  the shared contract types — `check-contract-boundaries.mjs` pins specific wire types (e.g.
  desktop chat SSE payloads must come from `keiko-contracts`, not be re-declared).

Before adding a dependency edge, check whether it points the right way. If `arch:check` rejects
it, the fix is almost never "add an exception" — it's "move the code to the layer that owns it"
or "route through contracts."

---

## 5. Reuse first — do not grow a second subsystem

Keiko already has a workspace layer, a graph/relationship engine, a policy layer, an evidence
layer, a memory subsystem, a connector layer, a workflow engine, and a design-system-driven UI.
The PR template makes this a checklist item; treat it as a design rule:

- **Inspect before you build.** `grep`/read for an existing helper, contract, or subsystem that
  already does most of this. Extend, generalize, or consolidate it.
- **Do not** introduce a parallel workspace, graph, relationship, policy, evidence, memory,
  connector, workflow, or UI subsystem when an existing one can be shaped for the need.
- If existing code is close but not quite right, refactoring it is preferred over a second copy.
- New surface area is justified only by a documented capability gap in the linked issue.

---

## 6. Code style and idioms

The bar is strict and **machine-enforced** — match it or the build is red.

- **TypeScript strict, and then some:** `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  `verbatimModuleSyntax`. **No `any`** (`no-explicit-any: error`). **Explicit function return
  types** are required. Model states with discriminated unions; narrow instead of casting.
- **ESLint:** `strictTypeChecked` + `stylisticTypeChecked`, **zero warnings**
  (`--max-warnings=0`). Cyclomatic **complexity ≤ 10**. **`max-lines-per-function: 50`** (blank
  lines and comments excluded; test `describe` blocks are exempt). Small functions, extract
  helpers. `no-console` is a warning in product code — route real output through the intended
  logger/diagnostic sink, not `console.*`.
- **Prettier (the formatter is law):** 2-space indent, **double quotes**, semicolons,
  `printWidth: 100`, trailing commas everywhere, LF endings. Run `npm run format` before you
  finish; `format:check` is a CI gate.
- **Match the file you are in.** Naming, error handling, evidence redaction, and test style are
  consistent within a package — read a neighbouring file and follow it rather than importing an
  outside convention.
- **Delete dead code** instead of commenting it out. No leftover scaffolding, no `TODO` that
  hides an unfinished branch.
- **English only** in all code, comments, identifiers, docs, commit messages, issues, and PRs —
  regardless of the language the human is chatting in.

---

## 7. Landing a change — patterns reviewers hold you to

Distilled from how Keiko is actually reviewed and gated. These are the things that get a change
sent back.

- **Prove the failure first.** A regression test must fail before your fix and pass after. A test
  that passes with and without the fix proves nothing.
- **A fixture never restates a formula the code under test owns — it derives it from the production
  entry point.** A fixture that recomputes the expectation cannot detect the case where the
  production formula moves and the fixture's copy does not: both sides change together and the test
  stays green over a broken product. Import the producer and call it. Epic #2285: the debug-launch
  validator re-derived the workspace identity digest as `sha256(JSON.stringify([...]))` while the
  producer had migrated to the shared framed digest, so every Linux debug launch failed
  `INVALID_CAPSULE_PLAN` with the suite green (#2643). The same rule applies to a mock: simplify it
  past the point where the violation it guards can occur and it will never fail again.
- **Fix the whole class, at the owning layer.** Don't patch one call site if the same bug exists
  behind three others — fix it where the invariant lives (usually a contract or the layer that
  owns the state). One implementation, not a special case bolted on.
- **No silent failures.** Don't swallow errors with an empty `catch`. Errors must surface with
  enough context to diagnose — and, on the server, a correlation id that ties a UI-visible opaque
  500 to a redacted operator diagnostic (this exact pattern is gated by `check:error-observability`;
  a bare `.catch(() => {})` fails it).
- **Fail closed on trust boundaries.** Validate before you process. Assume workspace input,
  model output, and connector data are hostile. Generated/model-produced code runs behind the
  sandbox egress boundary — never route it around that.
- **Keep evidence redacted.** Manifests, audit exports, and diagnostics report counts, statuses,
  scopes, and hashes — never raw memory bodies, secrets, or customer data.
- **Tests are hermetic.** No real network, no shared mutable global state, no wall-clock/ordering
  races, no reliance on a port being free. `await` a condition instead of sleeping. Fixtures are
  deterministic and self-contained.
- **A behavioural change is documented where decisions live.** If it changes an architectural
  decision, add or update an ADR (and the index). If it's release-impacting, update the
  release-impact catalog / issue metadata.
- **A regression pin may be relocated or strengthened, never relaxed.** A pin is a test that
  encodes a specific past incident — the very thing it must never accept again. If a change
  makes an existing pin fail, treat the pin as authoritative: understand what invariant it
  captures (usually named in a comment or an ADR reference), then either preserve the
  invariant, move the pin to the layer that now owns it, or add a tighter pin around the new
  shape. Do NOT edit the pin's assertion so the current change passes, and never re-attribute
  the pin to a decision record that does not actually sanction the relaxation. A pin rewritten
  to bless the behaviour it was written to prevent — especially under a false ADR attribution
  — is the highest-consequence artifact this repository can produce; the Wave-2 pre-merge
  audit of epic #2285 (#2627) caught this exact class of edit.

---

## 8. Traps specific to this repo (learn these once)

These cost real time when rediscovered. They are all real and current.

- **`packages/keiko-ui/**/globals.css` is behind a SHA-pinned visual-proof gate (#1300).** Editing
  it to add component or state styling trips a byte-exact hash check and a cross-mode axe/visual
  proof, turning CI red. Style components with **component-scoped classes** (e.g. `.cmp-*`), not
  by extending global CSS. See [`docs/design-system/`](docs/design-system/).
- **Editor perf evidence does not need an in-flight regeneration — except for toolchain edits.**
  The pull-request gate validates evidence integrity + budgets only (ADR-0139 D10), and since
  ADR-0156 D2 it asks the toolchain-freshness question only of a diff that actually touches
  `D12_MEASUREMENT_TOOLCHAIN_PATHS`. Regenerate in-flight (`npm run perf:evidence:regen`) only when
  your change edits that list — changing the ruler requires re-measuring with it. Real per-PR perf
  protection lives in the deterministic bundle gates (`check:editor-release-evidence`,
  `check:editor-bundle-size`).
- **The D12 reference environment is a developer machine, not CI (ADR-0156 D6).** The budgets are
  absolute numbers calibrated on the pinned container at linux/arm64 with >=14 logical cores, which
  is where every committed evidence document was measured. A hosted runner has 4 cores and measures
  the same scenario at roughly twice the cost, so it cannot produce a passing document — the
  scheduled `nightly-perf-evidence` lane therefore **detects drift and does not measure**, and files
  a tracking issue when the committed evidence stops binding `dev`. If you see a 2x "regression",
  check the provenance hardware in the document before believing it: comparing a local document
  against a hosted run is comparing two machine classes. See
  [`docs/qa/perf-evidence.md`](docs/qa/perf-evidence.md).
- **New package exports drift `check:package-surface`.** Adding a public export changes the
  packaged surface contract; run `npm run check:package-surface:assembled` and update the expected
  surface. The aggregate builds the product, prepares the CLI mode, builds the UI, removes
  build-only and host-native artifacts, and then runs the fail-closed surface checker.
- **A new long-lived integration branch (`feat/…`) must be added in THREE places in
  `.github/workflows/ci.yml`**: the `push:` trigger list, the `pull_request:` trigger list, AND
  the protected-branch-gate `case` allowlist (`refs/heads/<branch>:` and `*:<branch>` patterns) —
  miss the third and CI runs but the gate still rejects the merge.
- **Coverage is ratcheted against a committed baseline** (`docs/qa/package-coverage-baseline.json`)
  with per-file floors across all four metrics. Lowering coverage fails the gate; if you add code,
  add tests. There is exactly ONE per-file floor store and ONE evaluation
  (`npm run check:coverage:quality`) — do not add a `coverage.thresholds` block to a vitest config
  to gate a file, and do not write the literal `85` into a coverage gate (import
  `KEIKO_REPOSITORY_GATE_CONTRACT.newCodeCoverageMinimum`). Which ruler answers which question is
  the one table in [`docs/qa/coverage-truth-model.md`](docs/qa/coverage-truth-model.md); the
  reasoning is [ADR-0158](docs/adr/ADR-0158-one-coverage-ruler-per-question.md).
- **Some agent harnesses run sub-agents in an isolated worktree at clean `HEAD`.** If you delegate
  edits, confirm they landed on _this_ working tree and not a throwaway checkout before you report
  the change as made.

---

## 9. Tests

- **Unit/integration tests are co-located:** `foo.ts` → `foo.test.ts` next to it. Vitest,
  `environment: "node"` for packages; `keiko-ui` and `keiko-editor` use jsdom (+ `axe` a11y
  assertions). Root suite include globs are in `vitest.config.ts`.
- **E2E** lives in `tests/e2e/` and runs on Playwright (chromium is the reference browser; WebKit
  timing/render on CI is a software-render artifact — don't gate on it). Smoke: `npm run
test:e2e:smoke`. Performance-evidence and per-feature suites have their own `test:e2e:*` scripts.
- Cover the input space, not one happy path: empty, boundary, malformed, and hostile inputs;
  both branches of every guard you add.

---

## 10. Git, branches, and PRs

- **Signed commits are required** — `dev` branch protection rejects unsigned commits. Ensure
  commit signing is configured before you commit.
- **`dev` is the integration branch** and the base for PRs (not `main`). It is protected: linear
  history and signed squash merges. Nobody — agent or human — clicks merge: the agent arms GitHub
  native auto-merge on the PR, and the platform integrates automatically once the required checks
  are green on the exact current head and every review conversation is resolved (ADR-0135). Green
  gates plus settled review threads ARE the merge decision; there is no human review step and no
  waiting for a person.
- **Branch naming** follows `type/short-slug` — e.g. `feat/…`, `fix/…`, `issue/<n>-…`,
  `codex/…`, `claude/…`, `release/…`. Never work directly on `dev`.
- **Commit subjects** are imperative and conventional-ish (`feat(scope): …`, `fix: …`,
  `refactor(scope): …`) and reference the PR/issue (`(#1234)`). English, no secrets.
- **All required CI checks must be green before merge.** As of today (verify against
  [`CONTRIBUTING.md`](CONTRIBUTING.md), which is authoritative):

  `ci` · `workflow hygiene` · `Analyze (actions)` · `Analyze (javascript-typescript)` ·
  `Build, scan, SBOM, smoke` · `Review dependency diff (dev/main)` · `ui` ·
  `SonarCloud Code Analysis` · `Socket Security: Project Report` ·
  `Socket Security: Pull Request Alerts`, plus every external status recorded as live-promoted in
  [`docs/qa/external-quality-gates.md`](docs/qa/external-quality-gates.md).

  `workflow hygiene` is one context running actionlint, the pinned-SHA grep, zizmor and the OSV
  lockfile scan as serial steps of one job (ADR-0159) — same tools, same pinned versions, same rule
  sets as the four separate contexts it replaced.

  No human approving review is required for `dev`. CodeRabbit is advisory because its free-tier
  status can report success after quota prevents a current-head review; it is not a required status
  or review authority. Findings still must be repaired and every actual review conversation remains
  resolved. Qodo and Keiko for Quality are retired under ADR-0167. Sonar remains independently
  required and revalidated inside `ci`. Full mutation and reference-machine performance evidence
  run outside the PR critical path; fast OSS duplicate and secret gates run inside `ci` in parallel.

- **GitHub Actions are pinned to full 40-hex commit SHAs** with a version comment. A tag or
  branch ref (`@v4`) fails the pinned-SHA step of `workflow hygiene`. Keep the SHA-plus-comment
  format.
- Fill in the [PR template](.github/pull_request_template.md) honestly — the Reuse/No-Duplication,
  Verification, and Update-Impact sections are load-bearing, not decoration. Report failures and
  skipped steps truthfully; "green" claims must be backed by output you actually ran.

---

## 11. Decisions and docs

- **ADRs (`docs/adr/`) are the source of truth for architecture.** Read the relevant ones before
  changing a boundary. There is a machine-checked index (`check:adr-index`) — a new ADR must be
  added with the next free number and registered in the index. Do not renumber existing ADRs.
- There is intentionally **no root `CHANGELOG.md`**; release notes live in GitHub Releases and the
  release-impact catalog.
- Operator failure modes go in [`docs/troubleshooting/`](docs/troubleshooting/) using the template
  (Symptom / Root Cause / Diagnostic Steps / Resolution) — redacted, no live endpoints or logs.

---

## 12. When you are unsure

Stop and ask the human rather than guessing across a trust boundary, a governance gate, a release
process, or the human-control invariant. A blocked gate is a signal, not an obstacle: understand
_why_ it exists (usually an ADR) before you try to move it. Reuse beats rebuild; redaction beats
disclosure; failing closed beats a convenient bypass.
