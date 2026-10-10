# Code-quality syntax policy

Issue #3915 establishes the noncosmetic policy for epic #3914. It supplements the existing
TypeScript, typed ESLint, UI lint, Prettier, Sonar, coverage, security and architecture gates.
The source of truth is `scripts/code-quality-policy.json`; naming and spacing rules are excluded.

```bash
npm run check:code-quality-policy
npm run check:code-quality-policy -- --mode census --json
npm run check:code-quality-policy -- --scope production
npm run check:code-quality-policy -- --scope package:@oscharko-dev/keiko-contracts
```

The default is repository-wide enforcement. `npm run lint` builds packages and invokes that
command before the existing typed ESLint and UI lint lanes. The required Core quality job already
calls `npm run lint`; there is no second analyzer job or alternate CI policy. Build packages first
when invoking the policy command directly on a fresh checkout.

A local scope is explicitly partial. `repository`, `production`, `root-product`, `tooling`,
`native-host`, `tests`, `declarations`, `documentary`, `fixtures` and `package:<manifest-name>`
select exact current file sets from the inventory. A package scope selects its production source;
test infrastructure has the separate `tests` scope. Unknown and empty scopes fail. CI accepts only
default enforcement of `repository`; a census or subset cannot produce a repository-wide verdict.

The first active production guards are `no-widen-then-assert`, `no-reflect-apply` and
`no-reduce-accumulator-copy`. They reject discarded type evidence, reflective invocation and
non-spread copies of reducer accumulators. Genuine unknown boundary input, ordinary typed calls
and fresh locally owned accumulation remain valid. The separate native
`oxc/no-accumulating-spread` rule covers spreads and remains subject to #3989's precise cost and
ownership qualification. A fixed-state copy is not automatically quadratic, and mutation of a
frozen or shared accumulator is never a valid repair.

All 22 rules run in one syntax census. Only explicitly activated scopes enforce a rule. The
remaining production assertion scopes activate as their owning workstreams migrate; the final
qualification requires all of them. Boundary bans are adapted to validated domain contracts,
module interception belongs to the test-seam migration, Effect rules apply only to the qualified
native host, and array fusion/omission/growing-copy diagnostics require their accepted targeted
review. A raw match is a diagnostic, not a proven defect or a count-based waiver.

Policy validation retains the initial guards and rejects any activation shrink against the
complete reachable policy history. Shallow history fails; a second unrelated commit cannot hide
a removed scope. Existing and newly added files inside an active scope are
checked alike. Inline Oxlint suppression directives and nested Oxlint configuration cannot turn
off this policy. Ordinary configuration updates remain reviewed repository changes.

The inventory accounts for git-tracked JS/TS plus nonignored local additions. It derives workspace
membership from the existing workspace graph, build membership from TypeScript's parsed configs,
and package/export membership from real `npm pack --dry-run --json --ignore-scripts --workspaces`
output. Missing workspace metadata or unpacked public export targets fail. Test and hostile
fixture paths remain in the census; `vitest.setup` is test infrastructure. Filename classifications
are provisional: literal runtime imports, re-exports, import-equals, require and dynamic imports
from production sources reconcile test-looking helpers back into their owning production scope.
Declaration-level type-only edges do not grant runtime reachability. Named type-only specifiers
retain a runtime module edge when the owning compiler config preserves their empty import/export
under `verbatimModuleSyntax`; classification follows that actual emission. Public exports, main and bin targets are mapped
back to source using TypeScript's actual output metadata, including transitive runtime helpers;
build-root inclusion alone does not make a genuine test-only fixture production. Config-owned
module resolution and bounded, cached traversal retain the same complete source/analyzer census.
Generated runtime source remains production, while declaration files are type-only. Unknown source
owners fail. This reconciliation does not claim arbitrary computed-loader or virtual generated
staging-module resolution; owning build, package-surface and runtime proofs continue to govern them.

The design-system HTML files are non-shipped reference documentation. Their source digests and
distinct inline-script hashes come from the existing CSP producer; this records documentary
embedded code, not a claim of runtime HTML enforcement. Standalone documentary JS/TS is parsed
with the rest of the source inventory. A new HTML file outside that reference directory fails
classification and requires an explicit owner decision.

Each actual parser visit emits an internal `Program` receipt, including empty files. Exactly one
receipt must match every selected file; missing, duplicate, extra or unknown diagnostics fail.
Parser, plugin, process, configuration and inventory failures also fail. Windows command-line
limits use disjoint batches: each file is evaluated once. Source/inventory identities are checked
again after scanning so concurrent edits cannot qualify unmeasured bytes.

The development-only runner is Oxlint 1.78.0. Its plugin bridge is also 1.78.0. The MIT upstream
plugin is 0.1.2 at immutable commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`, installed from the
HTTPS archive with lockfile integrity. `scripts/code-quality-upstream.json` records its complete
source hashes and attribution remains in the installed LICENSE (Dillon Mulroy, 2026).
Keiko's existing TypeScript API compiles those immutable sources into a temporary ESM directory
under `node_modules`, removed in `finally`; Node does not strip TypeScript inside dependencies.
There is no product runtime dependency, extra formatter or ESLint compatibility bridge.

Owning tests run all 21 upstream noncosmetic fixture suites through that same compilation path:
190 accepted and 191 rejected cases. These qualify syntax; the five Effect suites do not replace
the native-host API qualification in #3988. The native accumulating-spread rule has a distinct
qualification workstream. Real parser and policy negatives also pin malformed syntax, missing
visits, dropped packages, suppression and invalid scopes.

JSON reports contain the subject SHA, policy/tool/config/source/inventory identities, exact
scope, package/build/export metadata, all rule dispositions and counts, outcome, and relative
path/rule/location findings. They omit source text and source-derived diagnostic messages. A
working-tree census binds its observed bytes with source digests and an inventory digest; its
subject SHA alone is not a claim that uncommitted additions are committed or that hosted checks
passed. Publish committed-head evidence in the existing issue/PR record. No permanent violation
baseline, bulk suppression register or separate evidence store is introduced.
