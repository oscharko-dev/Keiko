# Code-quality syntax policy

Epic #3914 defines a noncosmetic code-quality policy that supplements the existing TypeScript,
typed ESLint, UI lint, Prettier, Sonar, coverage, security and architecture gates. The source of
truth is `scripts/code-quality-policy.json`; naming and spacing rules are excluded. The policy
runs as a shrink-only ratchet (ADR-0167 D6). Complete enforcement, including the epic's
responsibility qualifications, arrives with #3991.

The ratchet runs on the epic branch `codex/epic-anti-slop-quality`, whose tree is the `dev`
snapshot `7bbca2e34`. On 2026-11-03 the owner postponed the rollout to `dev` to a date the owner
sets later.

## Ratchet

**What runs.** The required `ci` context runs:

```bash
npm run check:code-quality-policy -- --mode ratchet
```

It scans the whole repository (about 7,200 files, about 30 seconds on an Apple-silicon laptop) with all 22 rules and counts
findings per (file, rule). It compares those counts with the committed register
`scripts/code-quality-register.json`. Build packages first on a fresh checkout
(`npm run build:packages`).

**What fails.**

| Situation                                             | Result                                            |
| ----------------------------------------------------- | ------------------------------------------------- |
| A (file, rule) count is higher than the register      | Fails, naming file, rule and line of each finding |
| A file with findings has no register entry (new file) | Fails, naming file, rule and line                 |
| A (file, rule) count is lower than the register       | Fails until the register is pruned                |
| A register entry names a deleted or renamed file      | Fails as stale until the register is pruned       |
| An inline `oxlint-disable` directive or nested config | Rejected by the engine; it cannot hide a finding  |
| A register count is higher than at the base commit    | Fails unless a new ledger entry names that raise  |
| A new ledger entry matches no raised count            | Fails as a stale increase                         |
| An older ledger entry was removed or changed          | Fails as rewritten history                        |

The second output line reports the total before and after, for example `register: 46618 → 45340 (-1278)`.

**How to fix a failure.**

- _New finding:_ fix the code. Do not add a register entry or raise a count; the register is not a
  waiver mechanism. If you believe a rule is wrong for a site, raise it on #3914 instead. The only
  exception is a reviewed increase, described below.
- _Fewer findings, or a stale entry after a delete or rename:_ shrink the register and commit it
  with your change:

  ```bash
  npm run check:code-quality-policy -- --prune-register
  ```

  Pruning only lowers counts and removes entries. It refuses to widen the register, so it cannot
  absorb a new finding. A renamed file with findings therefore needs those findings fixed, not
  re-registered.

**Reviewed increases.** The owner allows a count to rise in five cases, and only through a
reviewed entry in `scripts/code-quality-register-increases.json`:

| `reason`                     | Use it for                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `qualified-boundary`         | A validator that a responsibility record adapts                                                                                        |
| `pending-boundary-migration` | A boundary check that a later reviewed migration moves (see below)                                                                     |
| `test-witness`               | A test or test fixture that exercises hostile input, or a binder-mandated witness                                                      |
| `proof-fixture`              | A test helper, typed fixture or type-level assertion that builds or checks the expected value of a proof and receives no hostile input |
| `dev-cutoff-sync`            | A finding that the last `dev` sync (release 1.4.0) brings in unchanged from `dev`; usable once                                         |

`pending-boundary-migration` covers findings of the four boundary rules (no-runtime-typeof,
no-unknown-parameters, no-unsafe-dictionary-type and no-known-value-widening) while those rules are
not yet active for the file's package. No responsibility record adapts these checks yet, so
`qualified-boundary` would be untrue for them.

`dev-cutoff-sync` exists for one change. Release 1.4.0 is the `dev` cutoff and code freeze (owner
decision 2026-11-04), so the epic branch syncs `dev` one last time and takes its findings as they
are. The ratchet refuses a new `dev-cutoff-sync` entry when the base ledger already holds one, so
no later change can use the reason.

`test-witness` and `proof-fixture` do not overlap. Code that receives hostile input is a test
witness, even when it sits in a fixture file. A proof fixture only builds or checks an expected
value. An entry is wrong if any test passes the flagged code a hostile or malformed value.

Each entry has exactly these fields, in this order:

```json
{
  "path": "packages/keiko-contracts/src/example.ts",
  "rule": "anti-slop/example-rule",
  "from": 2,
  "to": 5,
  "reason": "qualified-boundary",
  "issue": 3918
}
```

`from` is the register count before the change (0 for a new file or rule), `to` is the count after
it, and `to` must be larger than `from`. `issue` is the issue that reviewed the raise. The ledger is
sorted, holds no duplicate entry and has one canonical JSON form, like the register; any other form
fails. To raise a count:

1. Add the entry to the ledger.
2. Run `npm run check:code-quality-policy -- --prune-register`. It raises the count only to exactly
   the `to` of an entry with the same path, rule and `from`, and it still refuses every other
   increase.
3. Commit the register and the ledger together.

In CI the ratchet reads `KEIKO_CODE_QUALITY_BASE_SHA`, the pull request's base commit (on a push, the
previous tip). It compares the committed register with the register at that commit. Every raised
count needs one entry that this change adds, with the same path, rule, `from` and `to`. An entry
that the base already holds cannot approve a new raise. An added entry that matches no raise fails
as stale. Entries are history: a change may add entries but never remove or change one. A CI run
without a base fails closed, and CI still refuses to write the register. To run the same review
locally, set the variable to the full commit id of your pull request's base branch. Until the `dev`
rollout, that is the epic branch:

```bash
KEIKO_CODE_QUALITY_BASE_SHA="$(git rev-parse origin/codex/epic-anti-slop-quality)" npm run check:code-quality-policy -- --mode ratchet
```

The ledger started empty at `7bbca2e34`; #4145 adds no entry.

**Limits.**

- Counts are per file and rule. Fixing one finding and adding another of the same rule in the same
  file nets out and passes. This is the same model as the `keiko-ui` ESLint bulk-suppression
  register (`packages/keiko-ui/eslint-suppressions.json`).
- The ratchet does not run the epic's responsibility qualifications. A green ratchet means "no new
  findings", not "this code is qualified" or "this rule is enforced".
- The baseline on the `dev` snapshot `7bbca2e34` was 46,618 findings. Epic workstreams prune the
  register. #3991 activates each rule in the scopes where it has no finding, and the register stays
  for the remaining findings (owner decision 3, 2026-11-06 on #3991). The other activations follow
  the deferred migration children and #4278.

## Responsibility qualification

#3991 restores the hosted qualification that #4165 removed. The required `ci` context needs the
`code-quality-policy` job. Core quality runs beside it, not after it (owner decision 2026-11-07 on
#3991), because the `ci` context already requires both. The job runs on `ubuntu-24.04-arm` once
with Node 24.18.0 (and a 12288 MiB heap) and once with Node 26.8.1. Each leg runs these three
steps in order, with no condition and no `continue-on-error`:

```bash
npm run check:code-quality-policy:cli-smoke   # bounded default CLI fixture
npm run check:code-quality-policy:repository  # complete current-subject qualification
npm run check:code-quality-policy:raw-reader  # the registered raw own-property reader
```

The repository step runs `check-code-quality-policy.mjs --qualify-responsibilities` over the whole
repository. It passes only when every registered responsibility record is structurally ready, its
declared proof assertions pass in one fresh execution, and no active rule keeps a violation after
those records adapt their findings. The raw-reader step qualifies the `ownField` reader on its own.
Its producer is `packages/keiko-contracts/src/contract-validation-primitives.ts`, which the public
`runtime/code-task-acceptance` subpath re-exports.

A `public-parser` record binds its `public-api-proof` consumer in one of two shapes. The first is an
exported wrapper `const result = validateX(input); return result;` whose return annotation names the
checked result alias. The second is a local alias of the imported public validator,
`export { validateX as parseX }` (owner decision 2026-11-07 on #3991). The alias adds no code, so the
binder reads the producer's own declaration instead. That declaration must have exactly one
required parameter declared `unknown` and must name the owner's checked result alias as its return
type. The binder refuses an alias of any other import, a producer with a typed parameter, an inline
or foreign result type and an `export ... from` another module. The 14 memory parser records use
the alias shape in `packages/keiko-contracts/src/memory.test.ts`. Splitting wrappers into runs of
three to stay below the duplication window is still refused (REVIEW-3918-015).

A tree that matches a pull-request head whose full matrix already passed skips this job under the
same reuse rule as the other gated jobs (ADR-0178).

Rule activation follows the owner's #3991 decision: a rule is active in each scope where it had zero
raw findings when #3991 activated it, in addition to the scopes it already had. Before that, five
rules were active only in `package:@oscharko-dev/keiko-contracts`; that contracts-only scope no
longer describes the policy. The four contracts boundary rules (no-runtime-typeof,
no-unknown-parameters, no-unsafe-dictionary-type and no-known-value-widening) stay inactive under
`pending-boundary-migration` (#4278), and the five retired Effect rules stay retired. A scope that
consists only of production files is not listed separately when `production` is active. Policy
validation keeps refusing a shrink, so an activated scope stays active. Later migrations under
#3914 add a scope once its last finding of a rule is gone: no-chained-type-assertions became active
for activity-log, cli, quality-intelligence, security, tool-catalog, tools and ui on 2026-11-09. On the same day
require-safety-comment-for-type-assertion became active for memory-capture, memory-consolidation,
memory-retrieval, verification and workflows, and no-reflect-get for verification (#3933). On 2026-11-10 no-chained-type-assertions and no-array-filter-map became active for
sandbox (#3933), and no-chained-type-assertions became active for harness and model-gateway
(#3933). On 2026-11-11 no-reflect-get became active for cli and tools, and then for security and ui
(#3933). On 2026-11-12 require-safety-comment-for-type-assertion became active for harness (#3933).
The engine refuses an active
scope without files on the real repository. A hermetic test fixture writes its policy with only the
scopes its own files certainly fall in.

Local `npm run lint` builds the packages, runs the same three steps and then `npm run lint:typed`,
the per-package ESLint run from #4182 plus the keiko-ui lint. Core quality runs only
`npm run lint:typed`, so it does not repeat the qualification.

## Engine

The development-only runner is Oxlint 1.78.0 with its 1.78.0 plugin bridge. The MIT upstream
`oxlint-plugin-anti-slop` 0.1.2 is pinned to immutable commit
`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` and installed from the HTTPS archive with lockfile
integrity. `scripts/code-quality-upstream.json` records its complete source hashes; attribution
remains in the installed LICENSE (Dillon Mulroy, 2026). Keiko's existing TypeScript API compiles
those sources into a temporary ESM directory under `node_modules`, removed in `finally`. There is
no product runtime dependency, extra formatter or ESLint compatibility bridge.

All 22 rules run in one syntax census. Diagnostics are ordered by the subject inventory, then line
and column, then rule id, so report bytes do not depend on native worker arrival order. A raw match
is a diagnostic, not a proven defect.

The inventory accounts for git-tracked JS/TS plus nonignored local additions. It derives workspace,
build and package/export membership from the existing workspace graph, TypeScript's parsed configs
and real `npm pack --dry-run` output; missing metadata or unknown source owners fail. Each actual
parser visit emits an internal `Program` receipt, including for empty files, and exactly one receipt
must match every selected file. Missing, duplicate, extra or unknown diagnostics fail, as do parser,
plugin, process, configuration and inventory failures. Source and inventory identities are checked
again after scanning so concurrent edits cannot pass unmeasured bytes.

Policy validation rejects any activation shrink against the reachable policy history, and inline
Oxlint suppression directives and nested Oxlint configuration cannot turn off the policy. Reports
contain identities, counts and relative path/rule/location findings; they omit source text and
source-derived diagnostic messages.
