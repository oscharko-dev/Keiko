# AGENTS.md — Working on Keiko

Guidance for AI coding agents (Claude Code, Codex, Cursor, Copilot, …) and the humans
reviewing their output. This file is the shared, checked-in contract: every contributor and
every agent works from the same rules. Read it before you touch code.

**Working, clean, secure, verified code is authoritative.** Architecture Decision Records are
guardrails and the repository's architectural memory; they are not executable truth and must never
be used to defend broken, unsafe, or contradictory behavior. When implementation requirements or
verified safe behavior conflict with an ADR, do not stop merely because the text disagrees: fix the
code and update the affected ADR sections in the same change. Do not create a new or "superseding"
ADR merely to repair outdated text; reserve new ADRs for genuinely new architectural decisions.
`AGENTS.md`, [`CONTRIBUTING.md`](CONTRIBUTING.md), and the ADRs must converge in the resulting
change; flag any remaining drift.

**Keep this file to rules.** It is loaded into every agent's context, so it holds only what every
change must respect. Per-feature behaviour, per-operation log fields and the long form of owner
decisions live where that area is documented:

- [`docs/owner-decisions.md`](docs/owner-decisions.md) — the full text of the owner decisions §1
  summarizes;
- [`docs/observability/operation-notes.md`](docs/observability/operation-notes.md) — what
  individual Activity Log operations record, including the connected-context retrieval contract;
- [`EXPERIENCE.md`](EXPERIENCE.md) — repository lessons and traps (§9);
- the ADRs in [`docs/adr/`](docs/adr/) — the architectural record.

A change that alters such behaviour updates that document, not this one.

---

## 1. What Keiko is (and the one rule you cannot break)

Keiko is a **governed, local-first agentic workspace** for regulated engineering and knowledge
work. It is a TypeScript monorepo (npm workspaces, Node >=26.13.1 <27) that ships as one bundled
product.

**The human-control invariant — non-negotiable:**

> A local human selects or accepts the task, autonomy mode, and Authority Envelope within the
> server-owned deployment ceiling. Keiko may then act inside that validated, bounded authority
> without per-action approval when policy says `allowed`. For accepted repository work targeting
> `dev`, agents may commit, push their feature branch, and maintain the pull request. Only the
> repository owner account `oscharko` may authorize and execute integration into `dev`, including
> enabling native auto-merge. Agents acting under that account operate within the owner's explicit
> authorization. Integration additionally requires the app-bound required checks to succeed on the
> exact current head and every review conversation to be resolved. Direct pushes to `dev`, force
> pushes, gate bypasses, and authority widening remain denied or separately approved.
> Manifest-producing surfaces emit **redacted** evidence for deterministic gate evaluation.

That repository-delivery sentence governs how agents contribute to Keiko's own `dev` branch
(ADR-0135). It is not a capability promise for the end-user Governed Merge Gateway: ADR-0087 still
requires an explicit, approval-gated merge request and excludes autonomous or background
auto-merge from that product surface.

The product has exactly three user-facing modes — the product-wide authority model
([ADR-0129](docs/adr/ADR-0129-product-wide-authority-and-autonomy-model.md), amended by
[ADR-0135](docs/adr/ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md), detailed in
[ADR-0124](docs/adr/ADR-0124-coding-autonomy-modes-and-sidecar-runtime-authority.md) and
[ADR-0125](docs/adr/ADR-0125-governed-agent-docking-and-editor-changesets.md), with the monotonic
semantics of
[ADR-0138](docs/adr/ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md)):

- **Ask for approval** (`governed-assist`) allows reads and planning and asks before workspace
  edits, commands, external files, internet use, or delivery.
- **Supervised workspace** (`supervised-coding`) allows routine workspace-contained edits, vetted
  commands, and verification and asks before risky contained work, external files, internet use,
  or delivery.
- **Full access** (`autonomous-delivery`) allows file and internet work inside the validated
  Authority Envelope without per-action approval. Accepted `dev` delivery follows ADR-0135 and is
  integrated only by `oscharko` once the preconditions above hold. (`allowed` is a policy ceiling:
  a surface still needs an implemented execution path before it can act — ADR-0138 D4.)

Hard denials remain mode-independent: invalid or expired authority, workspace escape, denied
sensitive paths, secret exfiltration, unsupported actions, exhausted budgets, and platform
restrictions fail closed.

This shapes the product _and_ how you work on it:

- For an accepted Keiko task or epic, agents may commit, push the assigned non-`dev` branch, open or
  update its PR, and repair deterministic findings. Only `oscharko` may merge into `dev` or arm
  native auto-merge for that target; an agent acting under that account needs the owner's explicit
  authorization. Acceptance of a contributor's task does not grant `dev` integration authority.
  Close the issue only after verified merge. Never push directly to `dev`,
  force-push, bypass a required check, dismiss a finding to obtain green status, or merge outside
  the ADR-0135 direct-check path.
- **Never** weaken a trust boundary, evidence redaction, or a governance gate to make something
  pass. Fail closed. If a gate blocks you, the gate is usually right.
- Secrets stay out of code, logs, evidence, config, and tests. Evidence and diagnostics are
  body-free: counts, hashes, redacted summaries — never raw content, keys, endpoints, or PII.
- Every change to product runtime behaviour ships its own body-free logging on the existing
  activity log, and when you debug, that log is the source you read first (§8).

### Standing owner decisions

Each line is binding. Read its long form in [`docs/owner-decisions.md`](docs/owner-decisions.md)
before you change that area.

- **Model activation (2026-11-28):** a model a person activated is remembered across restarts and
  restored without any model request while its installation, product version, configuration and
  credential digest still match; a first start, an update, a changed connection, Deactivate or a
  proven failure discards it (ADR-0171 D2).
- **Coding Workbench availability (2026-09-27):** a normal installation offers all three modes; the
  Coding ceiling defaults to `autonomous-delivery`, the selected mode to **Ask for approval**.
  Memory keeps its own ceiling; a person's clear "Merke dir"/"Vergiss das" acts at once in every
  mode after the hard denials (ADR-0124 D2, ADR-0146, ADR-0163 D7).
- **Repository credential relay (2026-11-22):** in every mode a native Coding run reads the
  person's Maven and npm repositories only through Keiko's relay; the relay read needs no approval
  (ADR-0184 D6).
- **Ordinary Editor (2026-10-03):** the Editor is a human-operated file editor; its agent surfaces
  are retired and must not come back (ADR-0061). Files/Editor folder selections use the
  `coding-repository` binding, and a Files title never names a different root than its tree shows.
- **No prompt-token cap (2026-11-11):** never reintroduce a cumulative prompt-token allowance;
  cost control is the Model Gateway spend ceiling (ADR-0137, #4346).
- **Work-ending limits (2026-11-24):** Keiko runs on the customer's own models, so a fixed bound
  that ends healthy work is a defect. Coding runs get 480 minutes and 10,000 tool calls, Chat turns
  the same; a bound stays only to protect memory, security, the model's context window or against a
  runaway loop, and context trimming is shown, never silent. Never lower a raised default to ration
  ordinary work.
- **Knowledge Pods (2026-11-04):** local storage, no sharing roadmap or placeholders; the create
  dialog asks only for a name.
- **Linux is a community tier (2026-11-12):** feature parity is promised for macOS and Windows
  only; on Linux a new OS feature reuses an existing implementation or fails closed. Linux stays the
  development and CI platform, and a red Linux job is fixed, never skipped
  ([ADR-0183](docs/adr/ADR-0183-linux-desktop-community-tier.md)).
- **Standalone and npm folder packages (2026-11-17, 2026-11-18):** never modify the payload, never
  let the folder form install anything or become a working folder, never run an install script,
  never weaken the OS download checks, keep the dot before the form in asset names (ADR-0121 D9).
- **Portable updates** never require an Apple Developer subscription (ADR-0121 D7).
- **Local browser connection** keeps the trusted native launcher and single-use fragment
  redemption; **desktop layout restoration** stays bound to the installation identity (ADR-0027).
- **Content threshold (2026-11-04):** content a person reads and the model receives loses only the
  credential floor by default; `KEIKO_CONTENT_REDACTION=on` restores the strict projection.
  Evidence, audit, memory proposals and Quality Intelligence stay on `strictRedactor` (ADR-0003 D7,
  ADR-0022 D4).
- **The Activity Log carries no personal data (2026-11-04):** its sink over-redacts; never loosen
  it to keep a value readable — emit a count, a closed value or a digest.
- **Source redaction** preserves TypeScript/JavaScript and Java syntax but never exempts credential
  data; failed projection is unavailable evidence, not a complete source (ADR-0022).

---

## 2. Setup and the commands you will actually run

```bash
npm install               # installs all workspaces from the single root lockfile
npm run provision:usearch # ONCE per checkout — without it `npm test` is red
npm run provision:ripgrep # ONCE per checkout for the OpenCode coding runtime's search tools
node scripts/install-git-hooks.mjs     # ONCE per checkout — the pre-push SonarJS scan (§3)
npm run build             # build:packages (tsc -b) then the root build
npm run dev:start         # Node BFF + Next.js UI on ONE loopback URL (http://127.0.0.1:1983)
npm run dev:stop
```

The dev UI and BFF bind loopback port **1983** (not 5173, not 3000). If 1983 is taken,
`dev:start` picks the next free loopback port and prints it.

`provision:usearch` and `provision:ripgrep` fetch pinned, SHA-256-verified upstream binaries that
are deliberately not npm dependencies. `npm test` does **not** run them; without USearch the two
Knowledge-M2 proof suites fail on purpose, so a missing runtime never masks an ANN regression.
Details: [`docs/runtime-toolchain.md`](docs/runtime-toolchain.md).

Use `npm` only. There is no pnpm/yarn/bun lockfile; do not add one.

Every workspace package's `scripts.test` is `"vitest run"` — never `"npm run build && vitest run"`.
An isolated
`npm test --workspace <pkg>` therefore requires a prior `npm run build:packages`, which root
`npm test` performs for you once.

---

## 3. The green bar — how to know a change is actually done

**This is the most important section. Read it twice.**

A change is "done" only when the gates that apply to it pass **locally**. Do not use CI as your
test loop, and never use it to discover what your own diff obviously breaks.

### The trap that catches every new agent

> **`npm test` (vitest) does NOT run TypeScript type-checking or ESLint.**

Vitest happily goes green on code that does not type-check and that lint would reject. Run
`typecheck`, `lint`, and `format:check` as separate steps, every time.

### Minimum loop for any change

```bash
npm run typecheck        # builds packages, checks the package graph, then tsc --noEmit (strict)
npm run lint             # eslint --max-warnings=0 per package + root AND keiko-ui lint
npm run format:check     # prettier --check (a CI gate)
npm test                 # build:packages then vitest run
npm run arch:check       # dependency-cruiser + import-policy + contract-boundaries
npm run arch:check:negative
```

`npm run conversation:release-check` chains the core of the above. `npm run gates:local` runs the
common failure classes in CI's own Linux userland; what it may and may not answer is in
[`docs/qa/local-gates.md`](docs/qa/local-gates.md).

### Before every pull request, without exception

```bash
npm run gates:sonar
```

It runs a real SonarJS analyzer against your diff in a digest-pinned local container and never
contacts sonarcloud.io; the installed pre-push hook runs it on every push. It is mandatory because
`npm run check:sonar-rules` (the `ci` step on changed files) uses `eslint-plugin-sonarjs`, which
lacks hundreds of analyzer rules (for example `S7786`, `S7755`, `S7778`, `S7776`). The full
SonarCloud analysis runs only on `dev` after integration and demands zero issues, so one such
finding turns `dev` red (ADR-0131). See [`docs/qa/local-sonar.md`](docs/qa/local-sonar.md).

There is deliberately **no aggregate pre-PR wrapper** (ADR-0145): run the minimum-loop commands that
can see your change, `npm run gates:sonar`, and any touched-area gate below.

### Local-first gate policy

1. Before a push or PR update, run the minimum loop scoped to your change, `npm run gates:sonar`,
   and every touched-area gate from the table below.
2. If a required CI gate goes red, reproduce that exact failure locally before pushing another fix;
   after the fix, rerun that command first.
3. Push only when your targeted local runs are green or a documented platform-specific skip is
   unavoidable. If a required gate cannot run locally, say so in the PR.
4. Report outcomes from the runs you actually executed, not from memory.
5. The required CI run on the pull request is the final, complete arbiter.

For UI smoke failures, run the targeted Playwright repro first, then the full affected smoke gate. For package export changes, run the
package build and package-surface smoke locally. Never replace CI/Linux evidence with
macOS-generated values unless the repository documents macOS as authoritative for that evidence.

### When you touched these areas, also run

| You changed…                                    | Also run                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anything under `packages/keiko-ui/`             | `npm run typecheck --workspace @oscharko-dev/keiko-ui`, `npm run lint --workspace @oscharko-dev/keiko-ui`, `npm run test:coverage:ui`, `npm run check:editor-release-evidence`, and `npm run check:update-ui-evidence` when a source declared in `scripts/check-update-ui-evidence.mjs` changed (regeneration: `docs/design-system/evidence/3405/README.md`)                                                                                          |
| A package's **public exports** / a new package  | `npm run check:package-surface:assembled` (read its ordering warning in EXPERIENCE.md first)                                                                                                                                                                                                                                                                                                                                                          |
| Retrieval / RAG / grounding                     | `check:retrieval-quality`, `check:grounded-retrieval-quality`, `check:grounded-faithfulness`                                                                                                                                                                                                                                                                                                                                                          |
| Context lanes / compaction                      | `check:context-quality`                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Server error handling / diagnostics             | `check:error-observability`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A new or changed activity-log line or `op`      | `npm run generate:op-catalog`, then `npm run check:activity-log` (it runs `check:op-catalog` itself; the catalog is generated, never hand-edited — §8)                                                                                                                                                                                                                                                                                                |
| An ADR (added/renumbered)                       | `npm run check:adr-index`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Anything under `tests/e2e/` — including an edit | `npm run check:e2e-suite-wiring` after `npm run build:packages` — changing a title, a `@tag` or an `/api/...` literal moves reachability just as a rename does                                                                                                                                                                                                                                                                                        |
| The ESLint toolchain or `eslint.config.*`       | `npm run check:eslint-lane` and `npm run check:dependency-hygiene`                                                                                                                                                                                                                                                                                                                                                                                    |
| Any file under `.github/workflows/`             | **`npm run list:workflow-consumers` FIRST** (it names every gate and suite that reads that workflow), then `npm run check:zizmor-anchors` — `.github/zizmor.yml` ignores are line numbers, so a line inserted above one silently drops a reviewed risk acceptance; `-- --fix` re-pins anchors that only shifted, pairing them with steps by order. A job's `if:` also reaches `check:e2e-suite-wiring`, which reads an unknown term as "does not run" |
| A dependency version or a pinned GitHub Action  | `npm run check:dependency-currency`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Package versions / release metadata             | `check:version-consistency`, `check:release-impact`                                                                                                                                                                                                                                                                                                                                                                                                   |
| Coverage-sensitive code                         | `npm run test:coverage:quality`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Any code at all, before every pull request**  | **`npm run gates:sonar`**                                                                                                                                                                                                                                                                                                                                                                                                                             |

Prefer the narrow gate for your change; run the full `test:coverage:quality` chain before you claim
a release-affecting change is green.

---

## 4. Architecture and package boundaries

Packages live under `packages/`. Root `src/` holds the top-level entrypoints and runtime wiring;
`tests/` holds cross-package integration + Playwright e2e; `scripts/` holds the build/gate/release
tooling (`.mjs`, Node ESM, outside the TS program); `docs/adr/` is the decision record.

Dependencies flow **one direction only**, enforced by `arch:check` (ADR-0019):

- **`keiko-contracts` is the leaf** — the shared type/contract layer. It depends on nothing else
  in the repo. Put cross-package types here.
- **`keiko-security`** depends only on contracts. Most domain packages depend only on
  contracts + security.
- **`keiko-activity-log`** owns the writer, segmented store, and reader engine; it depends only on
  contracts + security. Server and CLI compose it, domain packages keep injected log ports, and UI
  never imports it (ADR-0179).
- **`keiko-mcp`** owns the shared MCP protocol host and is the only place official MCP SDK imports
  may live (ADR-0181). Server composition supplies provider/log ports and keeps catalog/binder
  admission; central Settings owns connections, including external OAuth for Chat and Workbench. Native runs receive scoped relay capabilities, never external OAuth tokens; keep
  credential epochs, app-session-bound one-use callbacks, scope binding and no-replay intact.
- **`keiko-model-gateway`** is the _only_ place provider SDKs (`openai`, `@anthropic-ai/*`,
  `*-ai-sdk`) may be imported — a hard gate (ADR-0019 trust-1).
- **`keiko-tools` / `keiko-harness` / `keiko-workflows`** must not touch `node:fs` outside the
  workspace boundary, and file patches route through `keiko-tools` (trust-4 / trust-5).
- **`keiko-server`** (the BFF) may use the domain packages, but **domain packages must not depend
  on the server**, and the server must not depend on `keiko-editor`.
- **`keiko-ui`** (Next.js, static export) talks to the server only across the shared contract
  types; `check-contract-boundaries.mjs` pins specific wire types.

If `arch:check` rejects an edge, the fix is almost never "add an exception" — move the code to the
layer that owns it or route through contracts.

---

## 5. Reuse first — do not grow a second subsystem

Keiko already has a workspace layer, a graph/relationship engine, a policy layer, an evidence
layer, a memory subsystem, a connector layer, a workflow engine, and a design-system-driven UI.

- **Inspect before you build.** Search for an existing helper, contract, or subsystem that already
  does most of this. Extend, generalize, or consolidate it.
- **Do not** introduce a parallel workspace, graph, relationship, policy, evidence, memory,
  connector, workflow, or UI subsystem when an existing one can be shaped for the need.
- If existing code is close but not quite right, refactoring it is preferred over a second copy.
- New surface area is justified only by a documented capability gap in the linked issue.

---

## 6. Code style and idioms

The bar is strict and **machine-enforced** — match it or the build is red.

- **TypeScript strict, and then some:** `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  `verbatimModuleSyntax`. **No `any`**. **Explicit function return types.** Model states with
  discriminated unions; narrow instead of casting.
- **ESLint:** `strictTypeChecked` + `stylisticTypeChecked`, **zero warnings**. Cyclomatic
  **complexity ≤ 10**. **`max-lines-per-function: 50`** (blank lines and comments excluded; test
  `describe` blocks exempt). `no-console` is a warning in product code — route real output through the intended logger or
  diagnostic sink.
- **`keiko-ui` meets the same three limits** through its own config, with a shrink-only
  bulk-suppression register (`packages/keiko-ui/eslint-suppressions.json`) for violations that
  predate the bar. New violations fail; after removing one, run
  `npm run lint:prune-suppressions --workspace @oscharko-dev/keiko-ui` and commit the smaller file.
  This is a temporary bridge, not a carve-out (#2891).
- **Prettier is law:** 2-space indent, double quotes, semicolons, `printWidth: 100`, trailing
  commas, LF. Run `npm run format` before you finish.
- **Match the file you are in.** Naming, error handling, redaction, and test style follow the
  neighbouring code, not an outside convention.
- **Delete dead code** instead of commenting it out. No `TODO` that hides an unfinished branch.
- **English only** in all code, comments, identifiers, docs, commit messages, issues, and PRs —
  regardless of the language the human is chatting in.

---

## 7. Landing a change — patterns reviewers hold you to

- **Prove the failure first.** A regression test must fail before your fix and pass after.
- **A fixture never restates a formula the code under test owns — it derives it from the production
  entry point.** A recomputed expectation moves together with a broken producer and stays green
  over a broken product (#2643). The same holds for a mock simplified past the violation it guards.
- **Fix the whole class, at the owning layer.** Fix the invariant where it lives (usually a contract
  or the state owner), not one call site of several.
- **No silent failures.** No empty `catch`. Errors surface with enough context to diagnose, and on
  the server with a correlation id that ties a UI-visible opaque 500 to a redacted operator
  diagnostic (gated by `check:error-observability`).
- **Fail closed on trust boundaries.** Workspace input, model output, and connector data are
  hostile. Model-produced code runs behind the sandbox egress boundary — never route around it.
- **Keep evidence redacted.** Manifests, audit exports, and diagnostics report counts, statuses,
  scopes, and hashes — never raw memory bodies, secrets, or customer data.
- **Tests are hermetic.** No external network or shared services, no shared mutable state, no
  wall-clock or ordering races, no reliance on a free port. Loopback listeners on ephemeral ports
  are fine with awaited readiness, a positive control and cleanup in `finally`. `await` a condition
  instead of sleeping. Fixtures are deterministic and self-contained. Authorized live-provider qualification records its actual environment and
  never masquerades as a hermetic unit test. No test ever reaches the real login keychain: `realKeychainWithheld`
  withholds it under vitest, and e2e or lab servers set `KEIKO_OS_KEYCHAIN=off`; a test of that
  tier injects a fake `executable`.
- **Document behavioural change where decisions live:** the ADR (and its index) for an
  architectural decision, the release-impact catalog for a release-impacting change.
- **A regression pin may be relocated or strengthened, never relaxed.** If your change makes a pin
  fail, the pin is authoritative: preserve its invariant, move it to the layer that now owns it, or
  tighten it. Never edit its assertion so the change passes, and never re-attribute it to an ADR
  that does not sanction the relaxation (#2627).

---

## 8. Logging is part of every change — and the first thing you read when something breaks

Keiko's activity log (segments in `<stateDir>/logs/`,
[ADR-0173](docs/adr/ADR-0173-server-activity-log-v2-machine-reconstruction-contract.md),
[`docs/observability/`](docs/observability/README.md)) is a **machine-reconstruction contract**: a
customer's log must let an agent rebuild a defect 1:1 without access to that machine. Both rules
below apply to **every** change to product runtime behaviour, in every autonomy mode, with no
exceptions and no "too small to log".
Repository tooling under `scripts/` is not product runtime and keeps its `PASS`/`FAIL` output.

What individual operations record is in
[`docs/observability/operation-notes.md`](docs/observability/operation-notes.md); the
authoritative machine contract is each operation's registration and the generated
[`op-catalog.generated.json`](docs/observability/op-catalog.generated.json).

### Rule 1 — every change ships its own logging, on the existing system

- **Emit through the owning layer's existing port.** Server: `ServerLogSink` / `ServerLogEvent`
  ([`server-log.ts`](packages/keiko-activity-log/src/server-log.ts)) and `emitServerDiagnostic`
  ([`diagnostics-log.ts`](packages/keiko-server/src/diagnostics-log.ts)). Domain packages: their
  injected log port (`SecurityLogSink`, `KnowledgeLogSink`, `MemoryVaultLogSink`,
  `ConsolidationLogSink`, `ModelGatewayLogSink`, …). Browser: `reportClientDiagnostic`
  ([`client-diagnostics.ts`](packages/keiko-ui/src/lib/client-diagnostics.ts)). A new package that
  performs work receives a port of the same shape from the server. Never `console.*`, a private
  logger, a second log file, or a new format.
- **`op` is a typed registry value, never a free string.** Declare each operation with
  `defineActivityLogOperation` and emit it with `activityLogEvent`; the registration owns fields,
  types, bounds, closed vocabularies, lifecycle, failure classes and proofs. Local look-alike
  helpers, unresolved dynamic calls, duplicate or emitter-less registrations, unregistered emitters
  and emissions outside the owner package fail closed. Run `npm run generate:op-catalog` and commit
  the regenerated catalog; `npm run check:op-catalog` rejects drift. Never hand-edit it; its legacy
  literal scan authorizes nothing.
- **Failure-class coverage is complete.** Every supported failure class owns its transitions,
  causal edges, safe context, analyzer projection and replay proof, exercised by fault-injection
  tests. The only exemption is the registry's exact, owner-bound, issue-linked shape with an expiry
  at most 180 days ahead.
- **Declare informational failure facts at their owner** with an exact `diagnosticWhen` condition,
  proven through the real producer and writer. Ordinary eligibility exclusions and budget limits
  are not technical failures.
- **Thread the correlation.** Every line of one logical operation carries its `correlationId`; a
  spawned job carries `parentCorrelationId`. The only fallback is `UNKNOWN_CORRELATION_ID`
  ([`correlation.ts`](packages/keiko-server/src/correlation.ts)). Rebind events with
  `withActivityLogCorrelation` / `withActivityLogParentCorrelation`, never an object spread.
- **Errors and loss take the structured path:** closed `errorKind` and completeness vocabularies,
  `extra.frames` / `extra.causeChain`, and a correlation id on every failure line.
  `check:error-observability` checks every `catch` in the tree. The legacy register
  (`docs/observability/legacy-failure-path-register.json`) may only shrink: never add to it; after
  a fix run `node scripts/check-error-observability.mjs --prune-register`.
- **The persisted identity is complete or the write fails closed.** The central sink stamps schema,
  registry, build and platform identity plus `(pid, instanceId, seq)`; producers cannot set them,
  and events are revalidated before serialization.
- **Loss and degraded operation are explicit.** Backpressure, disk exhaustion, failed durability or
  an unavailable sink never masquerade as a complete writer: count every lost event, persist
  `activity-log.loss`, and report readiness (`ready`, `degraded`, `unavailable`) in `/api/health`,
  `keiko status` and the UI. `silent` suppresses ordinary events only.
- **Body-free, always.** Counts, statuses, scopes, hashes, ids, route templates, sizes, durations —
  never prompts, responses, file contents, secrets, paths, endpoints or PII (ADR-0173 D4). New
  fields go into `extra` through [`log-redaction.ts`](packages/keiko-activity-log/src/log-redaction.ts).
- **SSE streams are flow-controlled, never size-limited.** Every server SSE write goes through
  `writeSseFrame`; a `false` from `res.write()` waits for `drain`, and only a reader stalled for
  `SSE_STALLED_READER_TIMEOUT_MS` is torn down. Never reintroduce destroy-on-false or a frame-size
  limit.
- **Keep one logical, bounded Activity Log** of immutable segments in `<stateDir>/logs/`
  (ADR-0173 D14). Never add a second stream, never loosen a disk bound, and enumerate files only
  through the closed name grammar (`orderActivityLogFileNames`).
- **Saved reports remain under human control.** A support export is written only by a
  user-initiated local export; Keiko never uploads, attaches or discloses it automatically. Content-bearing optional sections
  need their explicit consent, and a new destination or disclosure path is a separate authority and
  privacy decision.
- **The log is part of the definition of done.** A test asserts the emitted line(s) — `op`,
  `correlationId`, `errorKind`, the evidence fields — and a user-visible or failure-prone surface is
  checked against `keiko support analyze` showing the operation in its timeline.
- **Keep the contract converged.** A change to this contract updates the owning code, its
  failure-first proof, ADR-0173, this section, `CONTRIBUTING.md` and the affected operator docs
  together.
- **One command is the gate.** `npm run check:activity-log` builds the packages and evaluates the
  complete registered inventory (`check:op-catalog`, `test:activity-log-scenarios`,
  `check:error-observability`, `arch:check` with `arch:check:negative`, `check:release-impact`).
  It takes no changed-file input; the only sanctioned reuse is ADR-0178's byte-identical tree.
  Run it before every pull request that changes product runtime behaviour.

### Rule 2 — when you debug, the log is your primary source

Before you read code, form a hypothesis, or ask a human for a screenshot, read what the product
already recorded:

1. **Get the artifact.** `keiko support export --incident <id>` or a correlation selector; for
   local debugging `keiko support query --correlation-id <id> --json`. Received evidence is one
   canonical private report — never raw logs or legacy bundles — and must pass the canonical
   offline validator before any renderer or agent uses it; matching historical registries are
   repository-owned, never report-supplied (ADR-0173 D8/D9;
   [support workspace guide](docs/observability/support-workspace.md)).
2. **Validate before reconstruction.** `keiko support analyze report.json --json` emits the
   body-free machine view only after complete offline validation. Give agents that projection,
   never unvalidated report bytes.
3. **Investigate from the validated timeline:**
   `keiko support analyze report.json --correlation-id <exported-ref> --json > timeline.json`, then
   `keiko investigate --from-timeline timeline.json`.
4. **Read sufficiency and integrity before trusting a seed.** Never replace a named evidence gap
   with invented reproduction text, or assume a historical PID is running locally.
5. **Turn the seed into a red-then-green test** following
   [`docs/observability/reproduction-harness.md`](docs/observability/reproduction-harness.md).

The join keys — `(pid, instanceId, seq)`, `correlationId`, `parentCorrelationId` — are defined in
ADR-0173's "How an agent reads the log". If a defect cannot be located from the log, that gap is the
first defect to fix: add the missing evidence under Rule 1, then fix the behaviour.

---

## 9. Traps specific to this repo (learn these once)

Repository lessons live in [EXPERIENCE.md](EXPERIENCE.md). Before changing UI styling, performance
evidence, package exports, workflow branch lists or coverage gates, read the matching entry there.
Keep new lessons evidence-backed and scoped there, and prefer executable regression protection to
growing this always-loaded file. Reviewers use the existing
[review standards](docs/qa/review-standards.md).

---

## 10. Tests

- **Co-located:** `foo.ts` → `foo.test.ts`. Vitest with `environment: "node"` for packages;
  `keiko-ui` and `keiko-editor` use jsdom (+ `axe` assertions).
- **E2E** lives in `tests/e2e/` on Playwright; chromium is the reference browser — don't gate on
  WebKit timing. Smoke: `npm run test:e2e:smoke`; performance-evidence and per-feature suites have their own
  `test:e2e:*` scripts.
- **Determinism rules for test files** (`scripts/lib/eslint-test-determinism.mjs`): no measured
  wall-clock comparison outside `KEIKO_ENFORCE_WALL_CLOCK_BUDGETS`, no fixed sleep outside a polling
  loop, no negative substring assertion of at most four hex characters. The root
  `eslint-suppressions.json` may only shrink: after removing an entry, run
  `node scripts/lint-repository.mjs --prune-suppressions` and lower the ceiling in
  `scripts/__tests__/test-determinism-register.test.mjs`.
- Cover the input space: empty, boundary, malformed, and hostile inputs; both branches of every
  guard you add.
- **Pure text rules also get seeded property tests** (`*.property.test.ts`) on
  [`tests/support/property-testing.ts`](tests/support/property-testing.ts). Replay with
  `KEIKO_PROPERTY_SEED=<n>` and `-t "<test name>"`, widen with `KEIKO_PROPERTY_RUNS=<n>`, derive
  vacuity floors from the runs actually made (`propertySettings`), guard each property against
  vacuity, and prove it red against its defect class first. The harness has no third-party
  dependency; `measureScaling` proves linear time by comparing two input sizes.

---

## 11. Git, branches, and PRs

- **Signed commits are required** — configure commit signing before you commit.
- **`dev` is the integration branch** and the PR base (not `main`): linear history, signed squash
  merges. Only `oscharko` may merge into `dev` or enable auto-merge; required checks must be green on
  the exact current head and every review conversation resolved (ADR-0135). Contributors cannot
  authorize integration: green gates and settled threads are necessary, not merge authority. No
  additional approving review is required for `dev`.
- **The `dev` run reuses the pull request's evidence** for a byte-identical tree and fails closed on
  any difference; coverage and the full SonarCloud analysis always run on `dev`
  ([ADR-0178](docs/adr/ADR-0178-reuse-proven-tree-evidence-on-integration-runs.md)). Never treat a
  fast `dev` run as permission to leave a pull request unmeasured.
- **Agent reaction SLO.** Push one repair within 10 minutes of a review finding on the current head,
  harvesting every already-published finding into that head; do not wait for CI to turn green or for
  a reviewer that has not yet spoken
  ([`docs/qa/review-settlement.md`](docs/qa/review-settlement.md)).
- **Branch naming** `type/short-slug` (`feat/…`, `fix/…`, `issue/<n>-…`, `codex/…`, `claude/…`,
  `release/…`). Never work directly on `dev`.
- **Commit subjects** are imperative and conventional-ish (`feat(scope): …`, `fix: …`) and reference
  the PR/issue (`(#1234)`).
- **Required checks** are listed in [`CONTRIBUTING.md`](CONTRIBUTING.md), which is authoritative.
  CodeRabbit reviews every push; its status is not required, but every inline finding blocks until
  repaired and its conversation resolved. Qodo (ADR-0167), Keiko for Quality (ADR-0176) and the
  ADR-0169 dashboard and paced reviewer are retired; do not reintroduce them.
- **A review finding thread is never resolved without a reply** — by any agent, human or script,
  including one that only waits for a merge. The resolution carries a **fix reference**
  or an **evidenced refutation** (what was claimed, and the guard, line or call that disproves it).
  A silent resolve also makes the finding return on the next push.
- **GitHub Actions are pinned to full 40-hex commit SHAs** with a version comment.
- Fill in the [PR template](.github/pull_request_template.md) honestly; report failures and
  skipped steps truthfully; "green" claims must be backed by output you actually ran.

---

## 12. Decisions and docs

- **ADRs (`docs/adr/`) are guardrails, not authority over working code.** Read the relevant ones
  before changing a boundary and update their affected sections when a repair proves them outdated.
  A new ADR takes the next free number and is registered in the index (`check:adr-index`); never
  renumber existing ADRs.
- There is intentionally **no root `CHANGELOG.md`**; release notes live in GitHub Releases and the
  release-impact catalog.
- Operator failure modes go in [`docs/troubleshooting/`](docs/troubleshooting/) using its template
  (Symptom / Root Cause / Diagnostic Steps / Resolution) — redacted, no live endpoints or logs.
- Per-feature behaviour, per-operation log fields and owner-decision detail go into the documents
  named at the top of this file, never into AGENTS.md.

---

## 13. When you are unsure

Stop and ask the human rather than guessing across a trust boundary, a governance gate, a release
process, or the human-control invariant. Do not stop solely because an ADR contradicts a verified
requirement or safe product behavior: repair the code and bring the ADR into line in the same
change. A blocked gate is a signal, not an obstacle: understand _why_ it exists before you try to
move it. Reuse beats rebuild; redaction beats disclosure; failing closed beats a convenient bypass.
