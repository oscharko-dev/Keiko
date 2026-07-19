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
> after the direct app-bound required checks succeed on the exact current head. Direct pushes to
> `dev`, force pushes, gate bypasses, and authority widening remain denied or separately approved.
> Manifest-producing surfaces emit **redacted** evidence for deterministic gate evaluation.

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
  integrated automatically only after the direct required checks succeed.

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
npm install          # installs all workspaces from the single root lockfile
npm run build        # build:packages (tsc -b) then the root build
npm run dev:start    # Node BFF + Next.js UI on ONE loopback URL (http://127.0.0.1:1983)
npm run dev:stop
```

The dev UI and BFF bind loopback port **1983** (not Vite's 5173, not 3000). If 1983 is taken,
`dev:start` picks the next free loopback port and prints it.

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

For PR-bound work, use the agent pre-PR gate instead of manually stitching a partial checklist
together. This is the single, agent-agnostic quality gate every agent (Claude Code, Codex,
Cursor, …) runs before a push or a PR update:

```bash
npm run agent:pre-pr
```

The gate is **diff-scoped by default** (ADR-0139 D4): it computes your change set versus the
integration base (`origin/dev`; override with `-- --base <ref>`) and runs only the steps whose
declared input scope that change set touches — a docs-only change runs the handful of steps that
can see docs, a server change runs the full test/build chain. Steps that are skipped as out of
scope are reported visibly with the reason, never silently. Steps without a declared scope always
run. `npm run agent:pre-pr -- --full` runs the complete fixed sequence (typecheck, lint, format,
shell-spawn guardrails, UI package checks, unit tests, coverage quality, LCOV source mapping,
architecture checks, ADR/dependency hygiene, clean build, UI build, package-surface, editor
bundle size, installable-package smoke, and smoke coverage). Every run writes a machine-readable
report to `.agent/pre-pr-report.json` — including the scope decision — so the exact local outcome
is inspectable.

On top of the diff scope, the gate keeps a content-addressed step cache
(`.agent/pre-pr-cache.json`, ADR-0139 D4): in-scope steps whose declared inputs are
byte-identical to the last passing run report `cached` instead of re-executing. Pass `--no-cache`
to bypass it; CI never uses the cache.

### Local-first gate policy

Verify locally what your change can affect; required CI is the authoritative full matrix on every
pull request. Never push a change whose scoped local gate is red, and never use CI to discover
what your own diff obviously breaks. Concretely:

1. Run `npm run agent:pre-pr` (diff-scoped) before every push or PR update, plus any
   touched-area gate from the table below that is not part of the gate.
2. If a required CI gate goes red, reproduce that exact failure locally — targeted, or with
   `-- --full` — before pushing another fix; after the fix, rerun the failed gate locally first.
3. Push only after the scoped local gate is green or a documented platform-specific local skip is
   unavoidable (the report records those skips).
4. Report outcomes from the generated pre-PR report, not from memory.
5. The full local matrix (`-- --full`) is for parity debugging, not for every iteration — the
   required CI run on the pull request is the final, complete arbiter.

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
| A package's **public exports** / a new package | `npm run build && npm run check:package-surface`                                                                                                                                        |
| Retrieval / RAG / grounding                    | `check:retrieval-quality`, `check:grounded-retrieval-quality`, `check:grounded-faithfulness`                                                                                            |
| Context lanes / compaction                     | `check:context-quality`                                                                                                                                                                 |
| Server error handling / diagnostics            | `check:error-observability`                                                                                                                                                             |
| An ADR (added/renumbered)                      | `npm run check:adr-index`                                                                                                                                                               |
| Package versions / release metadata            | `check:version-consistency`, `check:release-impact`                                                                                                                                     |
| Coverage-sensitive code                        | `npm run test:coverage:quality`                                                                                                                                                         |

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

---

## 8. Traps specific to this repo (learn these once)

These cost real time when rediscovered. They are all real and current.

- **`packages/keiko-ui/**/globals.css` is behind a SHA-pinned visual-proof gate (#1300).** Editing
  it to add component or state styling trips a byte-exact hash check and a cross-mode axe/visual
  proof, turning CI red. Style components with **component-scoped classes** (e.g. `.cmp-*`), not
  by extending global CSS. See [`docs/design-system/`](docs/design-system/).
- **Editor perf evidence does not need an in-flight regeneration — except for toolchain edits.**
  The pull-request gate validates evidence integrity + budgets only (ADR-0139 D10); source-tree,
  lockfile, and working-tree drift are owned by the nightly `nightly-perf-evidence` lane, which
  re-measures `dev` daily. Regenerate in-flight (`npm run perf:evidence:regen`,
  Linux-authoritative; see [`docs/qa/perf-evidence.md`](docs/qa/perf-evidence.md)) only when your
  change edits the D12 measurement toolchain itself (`scripts/d12-measurement-toolchain.mjs`
  list) — changing the ruler requires re-measuring with it. Real per-PR perf protection lives in
  the deterministic bundle gates (`check:editor-release-evidence`, `check:editor-bundle-size`).
- **New package exports drift `check:package-surface`.** Adding a public export changes the
  packaged surface contract; run `npm run build && npm run check:package-surface` and update the
  expected surface, or CI goes red on the release job.
- **A new long-lived integration branch (`feat/…`) must be added to the trigger lists in
  `.github/workflows/ci.yml`** (both `push:` and `pull_request:`), or CI silently never runs on
  it and the branch protection gate rejects the merge.
- **Coverage is ratcheted against a committed baseline** (`docs/qa/package-coverage-baseline.json`)
  with per-file floors and a branch-metric floor. Lowering coverage fails the gate; if you add
  code, add tests.
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

  `ci` · `actionlint` · `Verify pinned action SHAs` · `zizmor` · `Analyze (actions)` ·
  `Analyze (javascript-typescript)` · `Build, scan, SBOM, smoke` ·
  `Review dependency diff (dev/main)` · `ui` · `Scan dependency lockfiles` ·
  `SonarCloud Code Analysis` · `Socket Security: Project Report` ·
  `Socket Security: Pull Request Alerts`

  No human approving review is required for `dev`. Qodo and `Keiko for Quality` are advisory and
  must not be added to branch protection until their availability, bounded settlement, and
  non-self-deadlocking repair path pass the live probes in
  [`docs/qa/keiko-for-quality.md`](docs/qa/keiko-for-quality.md). Full mutation and hosted-runner
  performance evidence run outside the PR critical path.

- **GitHub Actions are pinned to full 40-hex commit SHAs** with a version comment. A tag or
  branch ref (`@v4`) fails the `Verify pinned action SHAs` gate. Keep the SHA-plus-comment format.
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
