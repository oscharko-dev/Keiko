# Dependency and Security Currency Closeout (#2296)

Closeout evidence for epic [#2291](https://github.com/oscharko-dev/Keiko/issues/2291). Refreshed
live on 2026-08-28 against the checkout at `dev`.

This document supersedes the version claims in
[`2293-dependency-update-decision-matrix.md`](2293-dependency-update-decision-matrix.md), which
records the reviewing that happened during the implementation waves and is retained as the decision
history. Where the two disagree, this document is authoritative, because it is the one a gate reads
back: `npm run check:dependency-currency` fails closed when any row below stops describing the
resolved dependency graph or the pinned workflow actions.

That gate is the point of this document. #2291's implementation waves landed through
[#2304](https://github.com/oscharko-dev/Keiko/pull/2304) and were closed out with prose alone. Six
weeks later the matrix still documented an ESLint lane held at 9.39.5 and a Monaco line pinned at
0.55 while the repository resolved 10.9.1 and 0.56.0, and it named `actions/setup-node` v6.4.0 and
`github/codeql-action` v4.37.0 after both had moved. Nothing was wrong with the reviewing; nothing
read it back. Evidence that no gate evaluates decays into a sentence that merely looks reviewed.

## Scope of this closeout

- Epic #2291 children #2292, #2293, #2294 and #2295 delivered their implementation through the
  merged PR #2304. Their issues remained open and still carry `status: pr open`; the label is
  stale, not the work.
- TypeScript-7 closeout #2270 is a different case and is **not** delivered. PR #2304's own body
  excludes it ("Out of scope: … Final #2270/#2296 closeout"), and the issue carries
  `status: triaged`. It is waiting on an upstream release that has not shipped: the newest stable
  TypeScript is 7.0.2 and there is no stable TypeScript 7 programmatic API to migrate to, while
  `typescript-eslint@8.68.0` independently caps the API package at `<6.1.0`. The split toolchain is
  therefore a governed end state for now, recorded below as `major-deferred` — not a half-finished
  migration this closeout may claim.
- This closeout re-runs the live inventory rather than restating the merged waves, because registry,
  runtime and Action releases are temporally unstable and the previous inventory had drifted.

## Security posture

| Source                     | Result                                                                     |
| -------------------------- | -------------------------------------------------------------------------- |
| `npm audit --json`         | 0 vulnerabilities across 944 resolved packages (83 prod, 839 dev, 148 opt) |
| Repository secret scanning | 0 open alerts; both prior findings triaged and closed below                |
| Provider-SDK isolation     | Enforced by `arch:check` (ADR-0019 trust-1), unchanged by this closeout    |

### How this queue must be queried — and the trap in it

The count above is 2, not 1, and reproducing it requires the exact query
[`SECURITY.md`](../../SECURITY.md) documents. This is not a detail; it is the difference between a
true and a false closeout, and this closeout got it wrong on the first pass:

```bash
# Surfaces alert #20 only. Generic findings are NOT in this response.
gh api "repos/oscharko-dev/Keiko/secret-scanning/alerts?state=open&per_page=100"

# Still surfaces alert #20 only.
gh api "repos/.../secret-scanning/alerts?state=open&hide_secret=true&per_page=100"

# Surfaces alert #17. Only an explicit secret_type filter reveals a generic finding.
gh api -H "X-GitHub-Api-Version: 2026-03-10" \
  "repos/.../secret-scanning/alerts?state=open&secret_type=password&hide_secret=true&per_page=100"
```

A generic (`password`-type) alert is absent from the default listing **and** from an unfiltered
`hide_secret=true` listing. Only the explicit `secret_type=password` filter returns it. Any
statement of the form "the generic secret queue is empty" that was produced without that filter is
unsupported — the response it was based on could not have contained the finding. Epic #2291's
definition of done turns on this exact question, so the query belongs in the evidence, not in
someone's shell history.

### Dispositions

| Alert | Type | Location | Disposition | Rationale |
| ----- | ---- | -------- | ----------- | --------- |

The queue is empty: both listings return zero open alerts. This table stays because it is the one
`npm run check:secret-scanning-queue` reads — a new alert with no row here fails the scheduled lane,
and a row left behind after its alert closes fails it too. The `Disposition` column takes
[`SECURITY.md`](../../SECURITY.md)'s closed vocabulary (`revoked`, `used_in_tests`,
`false_positive`, `unresolved`), validated against exactly that set; prose there would let a typo or
a `TBD` count as a triage decision.

### Resolved during this closeout

Recorded outside the dispositions table on purpose — these alerts are closed, and a row above would
now be a claim about something that no longer exists. No literal secret value appears here or in any
gate output; both flagged values were synthetic, non-functional, and granted no access.

| Alert | Type                 | Resolution     | Root cause and repair                                                                      |
| ----- | -------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| #20   | provider API key     | used_in_tests  | Synthetic cross-detector parity fixture; literal split, class closed by a self-reading pin |
| #17   | generic (`password`) | false_positive | Documentation placeholder for a loopback mock that ignores the field; replaced             |

**#20** was one of the corpus strings the cross-detector parity test feeds through
`looksLikeSecretShape()`, `containsCredentialShape()` and `isSecretShapedString()` to pin their
agreement. The root cause was real: `gitleaks:allow` suppresses gitleaks only, and GitHub's partner
scanner is a separate detector that alerts on the prefix alone. Its `slack-token` and
`github-classic-pat` siblings were already assembled by concatenation for exactly this reason; the
`openai-key` fixture was not. It is now split — twice, because as one 40-character literal the body
is itself the shape of an AWS Secret Access Key and, next to the `AKIA` fixture, completed a pair
that push protection blocks. A pin in the same file reads the file's own source, so a future fixture
reintroducing a contiguous partner-scannable literal fails in the test suite rather than in the
repository's alert list.

**#17** was the `apiKey` field of a sample gateway config in a local-verification runbook, pointing
at a loopback mock on `127.0.0.1` that ignores the field entirely — the value never had to look like
a credential. It is now an obviously fake placeholder with the reason recorded beside it. It
postdated the #2292 delivery by eight days, which is the substantive finding: #2292 verified an
empty queue once, and nothing re-asked the question. `check:secret-scanning-queue` now does, nightly.

## Governed dependency baseline

Every row is enforced by `npm run check:dependency-currency` against `package-lock.json`. `scope` is
`root` or a workspace directory under `packages/`; a workspace-local resolution wins over the
hoisted root copy. A `root` row governs the **hoisted root resolution** — the copy that is actually
bundled — not a root manifest declaration: `postcss` is governed only through the root `overrides`
block, and `monaco-editor` is the hoisted resolution of two workspaces' declarations. A workspace
row is stricter: that workspace must still declare the dependency, or the row is refusing to
describe anything and fails. Dispositions: `current` (newest reviewed release), `patch-deferred` (a compatible
release exists and is intentionally not taken), `major-deferred` (a newer major is behind a
separately governed migration), `unsupported` (the newer release cannot be adopted on this runtime
or peer graph).

| Package                       | Scope                 | Version | Disposition    | Rationale                                                                              |
| ----------------------------- | --------------------- | ------- | -------------- | -------------------------------------------------------------------------------------- |
| `typescript`                  | root                  | 6.0.3   | major-deferred | Programmatic API lane. TypeScript 7's stable API entry gate is #2269/#2270.            |
| `typescript`                  | keiko-server          | 6.0.3   | major-deferred | Same API lane as root; the language-service consumers bind to it.                      |
| `typescript`                  | keiko-workspace       | 6.0.3   | major-deferred | Same API lane as root.                                                                 |
| `typescript`                  | keiko-ui              | 5.7.3   | major-deferred | The Next.js-supported UI compiler; UI source is proven separately against native TS 7. |
| `@typescript/native`          | root                  | 7.0.2   | current        | The native TypeScript 7 compiler, aliased as `npm:typescript@~7.0.2`.                  |
| `eslint`                      | root                  | 10.9.1  | current        | ESLint 10 lane; the `eslint-config-next` peer cap was cleared by #2777.                |
| `eslint`                      | keiko-ui              | 10.9.1  | current        | Deduplicated onto the root node by #2777; the workspace no longer pins its own copy.   |
| `@eslint/js`                  | root                  | 10.0.1  | current        | Realigned with the `eslint` 10 lane by #2777; one family, one major again.             |
| `typescript-eslint`           | root                  | 8.68.0  | patch-deferred | 8.69.0 published 2026-08-31; held by the reviewed seven-day update cooldown.           |
| `next`                        | keiko-ui              | 16.3.1  | patch-deferred | 16.3.3 available; deferred to a reviewed batch with `eslint-config-next`.              |
| `eslint-config-next`          | keiko-ui              | 16.3.1  | patch-deferred | Kept exactly aligned with `next`; the two move together or not at all.                 |
| `react`                       | keiko-ui              | 19.2.8  | current        | React 19 runtime delivered by #2295.                                                   |
| `react-dom`                   | keiko-ui              | 19.2.8  | current        | Matches `react`.                                                                       |
| `monaco-editor`               | root                  | 0.56.0  | current        | The reviewed editor pin; ADR-0042 was amended to 0.56.0 on 2026-08-16 and agrees.      |
| `monaco-editor`               | keiko-ui              | 0.56.0  | current        | Deduplicated with root.                                                                |
| `monaco-editor`               | keiko-editor          | 0.56.0  | current        | Deduplicated with root.                                                                |
| `vite`                        | keiko-ui              | 8.1.4   | patch-deferred | 8.2.2 available; the Rolldown/native binding delta is not required by any capability.  |
| `vitest`                      | root                  | 4.1.11  | current        | Realigned here; the keiko-ui nested copy is gone and both resolve to this node.        |
| `vitest`                      | keiko-ui              | 4.1.11  | current        | Resolves to the root node; the workspace no longer carries its own copy.               |
| `@vitest/coverage-v8`         | root                  | 4.1.11  | current        | Exact peer match for Vitest 4.1.11; a mismatch here made `npm ls` invalid.             |
| `autoprefixer`                | keiko-ui              | 10.5.4  | current        | UI build baseline.                                                                     |
| `@types/react`                | keiko-ui              | 19.2.18 | current        | Newest release; `@types/react-dom` lags it by one patch.                               |
| `axe-core`                    | keiko-ui              | 4.12.1  | patch-deferred | 4.13.0 changes rule output; an accessibility-evidence refresh is required first.       |
| `@noble/hashes`               | keiko-ui              | 2.3.0   | patch-deferred | 2.4.0 available; no capability requires it.                                            |
| `@types/node`                 | root                  | 26.3.0  | patch-deferred | Declarations only; 26.4.0 available.                                                   |
| `@types/node`                 | keiko-ui              | 26.3.0  | patch-deferred | Deduplicated with root.                                                                |
| `@types/react-dom`            | keiko-ui              | 19.2.4  | patch-deferred | Declarations only; 19.2.5 available.                                                   |
| `@vitejs/plugin-react`        | keiko-ui              | 6.0.5   | patch-deferred | 6.1.1 available; UI build baseline is unchanged.                                       |
| `@testing-library/react`      | keiko-ui              | 16.3.2  | patch-deferred | 16.3.3 available; no test capability requires it.                                      |
| `@testing-library/user-event` | keiko-ui              | 14.6.5  | patch-deferred | 14.6.6 available; no test capability requires it.                                      |
| `@playwright/test`            | root                  | 1.62.1  | current        | E2E reference runner.                                                                  |
| `prettier`                    | root                  | 3.9.6   | current        | Formatter policy is unchanged.                                                         |
| `knip`                        | root                  | 6.32.2  | patch-deferred | 6.32.3 published 2026-08-26; backs the required `check:knip` gate.                     |
| `fallow`                      | root                  | 3.9.1   | patch-deferred | 3.20.0 available; backs `check:semantic-duplication`. Missed by the sweep — see below. |
| `@napi-rs/canvas`             | keiko-local-knowledge | 1.0.8   | current        | Optional host-native backend; deduplicated to one node by a root override (see below). |
| `postcss`                     | root                  | 8.5.26  | current        | Root override; audit reports no known vulnerability.                                   |
| `ws`                          | root                  | 8.21.3  | current        | WebSocket runtime.                                                                     |

The live inventory command is `npm outdated --workspaces --include-workspace-root --json`; it
reported 18 non-current direct entries, every one of which is dispositioned above.

**That command has a blind spot, and this closeout walked into it.** Run in aggregate it silently
omits a direct dependency whose only declaring manifest is the root `package.json`; the same package
reports correctly when queried on its own. Three rows above were wrong because of it —
`typescript-eslint` and `knip` were labelled `current` while newer releases existed, and `fallow`
was missing from the table entirely while eleven minor releases behind. `check:dependency-currency`
cannot catch this class either, by design: it compares the document against the lockfile and never
contacts a registry, so it proves the record describes this checkout, never that the checkout is
current. Cross-check individual root devDependencies before claiming a clean sweep.

## GitHub Actions baseline

Every action is pinned to a full 40-character commit SHA with a version comment. All 14 external
action repositories resolve their documented tag to exactly the pinned commit. Keiko's two trusted
gate actions instead use the non-tag audit label `gate-snapshot-2` and resolve to the separately
reviewed repository commit recorded below; the line-scoped `ref-version-mismatch` dispositions in
`.github/zizmor.yml` suppress only the inapplicable online tag lookup and leave immutable-pin
analysis active.
`check:dependency-currency` enforces the table against the workflow files, in both directions, and
additionally rejects an action repository whose sub-actions have drifted onto different refs —
`github/codeql-action/init` and `/analyze` are not grouped by Dependabot and a one-sided bump is a
guaranteed version-mismatch failure.

| Action                             | Version         | Commit                                   | Disposition    |
| ---------------------------------- | --------------- | ---------------------------------------- | -------------- |
| `actions/checkout`                 | v7.0.0          | 9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 | patch-deferred |
| `actions/setup-node`               | v7.0.0          | 820762786026740c76f36085b0efc47a31fe5020 | current        |
| `actions/upload-artifact`          | v7.0.1          | 043fb46d1a93c77aae656e7c1c64a875d1fc6a0a | current        |
| `actions/download-artifact`        | v8.0.1          | 3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c | current        |
| `actions/cache`                    | v6.1.0          | 55cc8345863c7cc4c66a329aec7e433d2d1c52a9 | current        |
| `actions/attest`                   | v4.2.0          | f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6 | patch-deferred |
| `actions/setup-dotnet`             | v6.0.0          | a98b56852c35b8e3190ac28c8c2271da59106c68 | current        |
| `actions/dependency-review-action` | v5.0.0          | a1d282b36b6f3519aa1f3fc636f609c47dddb294 | current        |
| `github/codeql-action`             | v4.37.7         | ff2f1c621b7f889edc0d3c761ac2e6a3f8cdb0dd | patch-deferred |
| `google/osv-scanner-action`        | v2.5.1          | 6e4298ebc4db23e847df9b2e2de2939d6f066c67 | current        |
| `zizmorcore/zizmor-action`         | v0.6.2          | 3dc1ecc9bcb9e94e9b2c709687979e1298497054 | current        |
| `Azure/login`                      | v3.0.0          | 532459ea530d8321f2fb9bb10d1e0bcf23869a43 | patch-deferred |
| `Azure/artifact-signing-action`    | v2.0.0          | c7ab2a863ab5f9a846ddb8265964877ef296ee82 | current        |
| `oscharko-dev/Keiko-for-Quality`   | v0.25.0         | f1117fb2b56a62bcbec22afbc149d5bd1474060c | current        |
| `oscharko-dev/Keiko`               | gate-snapshot-2 | 2cd863fa0e0b912658042fc2e2fda0c23b981ac8 | current        |

The four `patch-deferred` actions have newer upstream tags (checkout v7.0.1, attest v4.2.2,
codeql-action v4.37.9, Azure/login v3.0.2). They are left to Dependabot rather than hand-bumped
here: this closeout must not change what the required checks execute while it is establishing what
they executed.

## Runtime and toolchain

Enforced by `npm run check:runtime-toolchain` and `npm run check:typescript-toolchain`, which own
these values; this document does not restate them as a second source.

| Surface              | Governed value               | Enforcing gate               |
| -------------------- | ---------------------------- | ---------------------------- |
| Node.js engine       | `>=24.18.0 <25`              | `check:runtime-toolchain`    |
| npm / packageManager | `11.16.0`                    | `check:runtime-toolchain`    |
| TypeScript compiler  | 7.0.2 (native)               | `check:typescript-toolchain` |
| TypeScript API       | 6.0.3                        | `check:typescript-toolchain` |
| Internal versions    | 0.3.17 across all workspaces | `check:version-consistency`  |

## Dependency graph validity (`npm ls`)

#2296's acceptance criteria require that `npm ls` report no invalid graph. It did not, and nothing
in the repository ever asked: `npm ls` at default depth exits 0, which is why this stayed invisible.
At full depth the pre-existing tree reported two invalid packages:

```text
npm error code ELSPROBLEMS
npm error invalid: @vitest/coverage-v8@4.1.10 …/node_modules/@vitest/coverage-v8
npm error invalid: eslint@10.9.1 …/node_modules/eslint
```

**Both are now closed, by two changes that had to be separate.** `keiko-ui` pinned `vitest` at
exactly 4.1.11, whose peer contract demands `@vitest/coverage-v8` 4.1.11 while the root resolved
4.1.10; both root packages now resolve 4.1.11 and the workspace's nested copy is gone — one Vitest
node instead of two, which is what the #2293 matrix said it had achieved and had not. A second
duplicate went with it: `@napi-rs/canvas` resolved 1.0.6 at the root (hoisted through `pdfjs-dist`'s
optional `^1.0.0`) and 1.0.8 under `keiko-local-knowledge`, carrying eleven redundant platform
binaries; a root override collapses them to one node. The ESLint half was
[#2777](https://github.com/oscharko-dev/Keiko/issues/2777)'s: `eslint-config-next@16.3.1` now
declares `eslint: ">=9.0.0"`, `@eslint/js` moved to the 10 lane, and `keiko-ui`'s exact pin became a
range that deduplicates onto the root node.

`npm ls --all --workspaces --include-workspace-root` exits **0** on this branch. Peer validity is
now enforced continuously by `npm run check:eslint-lane` (#2777), wired into the required `ci`
context — it asks npm rather than restating it, which is the right division: npm stays the authority
on peer validity, and this closeout's gate stays the authority on whether the recorded disposition
still describes the checkout.

## Decisions taken here

### `engine-strict` is declined, and this is the reasoning, not a deferral

The question was measured, not estimated: across all 665 `engines` declarations in
`package-lock.json` (1 root, 25 workspaces, 639 third-party), evaluated with the same
`semver.satisfies(v, range, { includePrerelease: true })` predicate npm itself uses, **zero fail**
Node 24.18.0 / npm 11.16.0 — in every class, direct, transitive, dev and optional. The optional class
cannot fail at all: npm's arborist marks an optional node `inert` and explicitly ignores
`--engine-strict` for it. Only four of the 100 distinct ranges even reject Node 25, behind three
packages (`dependency-cruiser`, `jsdom`, `watskeburt`) that a future Node bump must move anyway.

So the flag is safe to set. It is still the wrong instrument here, for two reasons that the
measurement surfaced rather than settled.

**The protection it adds already exists one layer down, in a stronger form.**
`scripts/check-runtime-toolchain.mjs` compares the **executed** Node and npm against the governed
values — not a declaration, the actual interpreter and the actual npm on `PATH` — and it runs at 28
points across eight workflows, in every case before `npm ci`. `engine-strict` would re-ask a weaker
version of a question that is already answered where it matters.

**Its cost is a silent failure mode in exactly the machinery this closeout exists to protect.**
`engines.node` is upper-bounded (`>=24.18.0 <25`) and `engines.npm` is an exact string. Under
`engine-strict` both become hard install-time gates for _every_ npm process that runs in this working
directory — including Dependabot's updater, which brings its own Node and npm and reads the project
`.npmrc`. If either differs, the dependency-update pull requests stop, and they stop **without
notifying anyone**: an absence of Dependabot PRs looks identical to a quiet week. Disabling the
mechanism that keeps dependencies current, inside the change whose subject is dependency currency,
is not a trade worth a marginal gain.

Recorded so the measurement never has to be repeated. What would have to change first: an
`engines` declaration that a third-party tool can satisfy — see the finding below.

### A finding this raised: the published `engines.npm` constrains consumers who have no such requirement

`package.json` publishes `engines` as `{"node": ">=24.18.0 <25", "npm": "11.16.0"}`, and that
manifest reaches every consumer of `@oscharko-dev/keiko`. The exact npm string is true of Keiko's
_contributors_ — `check:runtime-toolchain` enforces it — but it is not true of anyone installing the
package, and an organisation that sets `engine-strict` on its own side cannot install Keiko unless it
happens to run npm 11.16.0 exactly.

Not repaired here. Relaxing it means changing a deliberately governed pin **and** the gate that
enforces it, which is a governance decision with its own reasoning, not a side effect of a currency
closeout. Left as a stated finding for the release owner.

## Follow-ups

1. **Credential-shaped literals remain in pre-existing test fixtures.** A repository sweep found
   contiguous `AKIA…`, `ghp_…`, `github_pat_…`, `hf_…` and `sk-…` literals across roughly ten test
   files under `packages/*/src` and `tests/`. None has fired an alert — GitHub validity-checks AWS
   keys, which filters the sequential fakes, and the required `Secret scan` job only reads
   `base..head` of a pull request, never the whole tree. They are the same class as alert #20 and
   worth one batch pass; splitting them here would have expanded this closeout across ten unrelated
   files for no evidenced risk reduction.

## The measurement-toolchain repairs, and what made them look blocked

[#3304](https://github.com/oscharko-dev/Keiko/issues/3304) was filed for two repairs this closeout
found and could not land: the credential-shaped `apiKey` placeholder in
`tests/e2e/fixtures/keiko.e2e.config.json`, and fourteen hardcoded `24.18.0` / `11.16.0` literals in
`build-d12-bundle-input.mjs`, `build-d12-perf-comparison.mjs` and `check-perf-evidence.mjs` — the
same two-sources-of-truth defect already repaired in `portable-manual-review.mjs`. All four files are
members of a measurement-toolchain digest, so each repair turned `check:perf-evidence` red and
obliged a re-measurement.

**Both are done here**, because the obstacle turned out to be the documentation rather than the
machine. The repairs are in this change, and both evidence documents are regenerated on the
reference environment as its final commit.

The obstacle: the editor D12 evidence had a one-command producer
(`npm run perf:evidence:regen:container`), while the workspace evidence had two lines of prose and
the instruction to run it "on its declared reference environment" — without stating anywhere which
environment that is. A pull request that moved the workspace ruler therefore had to invent its own
invocation, and an invented measurement measures something nobody can compare against the committed
numbers. That ambiguity is the same defect class as everything else in this closeout: an instruction
nobody can follow unambiguously is not an instruction.

Closed in [`docs/qa/perf-evidence.md`](../qa/perf-evidence.md):

- The workspace reference environment is now **evidenced rather than asserted** — `ci.yml` refreshes
  that document on every push to `dev` (`ubuntu-latest`) and only validates freshness on a pull
  request, so the producer is Linux, and a pull request that moves the ruler must bring a
  Linux-produced document.
- Why `ubuntu-latest` and the pinned `arm64` container are both acceptable producers while a macOS
  host is not: unlike the D12 document, this one records no per-machine provenance and its budgets
  carry wide headroom. It is a browser-performance regression detector, not an absolute instrument
  calibrated to one machine class.
- `npm run perf:evidence:regen:workspace` exists, and shares the editor producer's container driver
  rather than growing a second one. A test pins that `--workspace` does not route into the editor
  lane — sending it there would measure the wrong thing for thirty-five minutes.

## Verification

Run on macOS (darwin/arm64) against this branch, after merging `origin/dev` — except the two
performance-evidence documents, which were re-measured in the pinned `node:24.18.0-bookworm`
container on the declared reference environment, with the host verified idle first. Platform
coverage for Linux and Windows is CI's, not this document's: the required checks on the pull request are the
complete arbiter, and no macOS-generated value is offered here as a substitute for
platform-authoritative evidence.

| Command                                                     | Result                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| `npm ci`                                                    | pass                                                     |
| `npm audit --json`                                          | pass — 0 vulnerabilities across 944 packages             |
| `npm outdated --workspaces --include-workspace-root --json` | 18 non-current direct entries, all dispositioned         |
| `npm ls --all --workspaces --include-workspace-root`        | pass — exit 0, no invalid entries (was 2)                |
| `npm run format:check`                                      | pass                                                     |
| `npm run typecheck`                                         | pass                                                     |
| `npm run lint`                                              | pass                                                     |
| `npm test`                                                  | pass — 1729 files, 33 276 tests, 0 failures              |
| `npm run arch:check`                                        | pass                                                     |
| `npm run arch:check:negative`                               | pass                                                     |
| `npm run check:knip`                                        | pass                                                     |
| `npm run check:eslint-lane`                                 | pass — `npm ls eslint` exits 0 (#2777)                   |
| `npm run check:perf-evidence`                               | pass — both documents within budget and internally sound |
| `npm run check:dependency-currency`                         | pass — 37 dependency rows, 15 action rows                |
| `npm run check:secret-scanning-queue`                       | pass — 0 open alerts; both prior findings closed         |
| `npm run check:runtime-toolchain`                           | pass — Node 24.18.0; npm 11.16.0; 25 workspaces          |
| `npm run check:typescript-toolchain`                        | pass — compiler 7.0.2; API 6.0.3                         |
| `npm run check:portable-approvals`                          | pass — node 24.18.0                                      |
| `npm run check:version-consistency`                         | pass — 0.3.17 across every workspace                     |
| `npm run check:dependency-hygiene`                          | pass — 26 manifests, 6006 tracked paths                  |
| `npm run check:workspace-supply-chain`                      | pass                                                     |
| `npm run check:adr-index`                                   | pass — 158 ADRs indexed                                  |
| `npm run check:zizmor-anchors`                              | pass — 17 anchors still on the step they document        |
| `npm run check:release-impact`                              | pass                                                     |
| `npm run gates:sonar`                                       | pass — no unresolved finding on the changed files        |

`gates:sonar` reported three findings on its first run, all in the two new gate scripts, and all
from rules `eslint-plugin-sonarjs` does not ship: a locale-naive `Array#sort`, two consecutive
`Array#push` calls, and a bare `PATH` lookup for the `gh` binary. All three are fixed; the last one
now resolves `gh` through the repository's existing hardened resolver, so a writable directory
earlier in `PATH` cannot substitute the binary that reads this repository's security findings.

Not run locally, and left to the required CI matrix: `npm ci` on Linux and Windows, the assembled
package-surface check, install smoke, SBOM/license publication, and the Linux-authoritative
UI/editor evidence lanes.

## Rollback

Reverting this change is safe but is not a no-op, and an earlier draft of this section said
otherwise. It touches more than twenty files across five kinds of change:

- **Two new gates** (`check:dependency-currency`, `check:secret-scanning-queue`), a shared
  markdown-table reader, one new scheduled workflow, and a new workflow-pin anchor test.
- **Resolved dependency versions**: `vitest` and `@vitest/coverage-v8` move to 4.1.11 and
  `@napi-rs/canvas` is deduplicated to 1.0.8 through a new root override. Reverting restores the
  peer-invalid `npm ls` state and the eleven redundant platform binaries.
- **Workflow edits**: a required step added to `ci.yml`, a toolchain gate added to
  `nightly-perf-evidence.yml`, and five re-pointed line anchors in `.github/zizmor.yml` — revert
  those together, or `check:zizmor-anchors` goes red on an unrelated diff.
- **Two existing gate scripts extended** (`check-runtime-toolchain.mjs` workspace npm engines,
  `portable-manual-review.mjs` derived Node version).
- **Documentation**: this document, the #2293 supersede banner, ADR-0001's status block, and four
  runbooks.

No product runtime behaviour, published surface, or state store changes; the only source edit under
`packages/` is a corrected comment.
