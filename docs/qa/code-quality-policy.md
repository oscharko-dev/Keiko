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

The internal #3918 compiler interface is descriptive and inactive in the policy entrypoint.
`collectPolicySubject` shares the inventory's already parsed effective compiler contexts and its
single output-to-source map. `collectPolicyInventory` retains its public result. A resolver lazily
builds context-owned TypeScript programs, keeping NodeNext, Bundler and source-path overrides
separate. Alias identities derive from actual declaration owners and producer spans; symbols from
different programs are never compared by object identity or name alone. Incoming-use results retain
untyped, unresolved and partial coverage explicitly. These facts grant no exemption or activation.

Every compiler-loaded owned declaration, including public entrypoints and intermediate reexports,
qualifies only against the installed pinned native compiler using the actual owner build config.
The API compiler retains checker and AST duties. Declaration bytes must match exactly; complete map
payloads must match after canonicalizing only relocation-dependent source paths. Mappings, names,
version, file and all other map fields remain authoritative. Qualification never relies solely on a
selected map position. The builtin Node `SourceMap.findEntry` API maps
zero-based generated positions back to the owning source; owning fixtures exercise real compiler
emission, workspace symlink resolution, public main/subpath reexports and UTF-16 positions.
Missing, stale, changed or escaping provenance fails. Matching names or spans alone is insufficient,
including a same-length producer type change with an unchanged declaration name.

The interface bounds retained programs (2), verified source bytes (64 MiB), visited nodes
(5 million), alias traversal (64) and aggregate retained declaration emission and private build-info bytes (16 MiB). Native declaration-only
emission uses a private output directory and build-info path, a direct platform executable, a
10-second process bound and a 1-MiB diagnostic-output bound. Private output is measured before
retention and cleaned on success or failure; live build outputs are never emission targets. Configured declaration directories are relocated into
that private output; bundled `outFile` contexts fail closed before actuation. The output byte bound
is checked after the bounded compiler process settles, before retention; it does not promise an
operating-system disk quota during emission.
Owner results and closed failures persist across program eviction only for the resolver lifetime,
preventing repeated compiler execution; both are cleared on close.
These are finite resource ceilings, not acceptance thresholds. It rechecks source, configuration,
manifest, declaration and dependency snapshots plus package/file ownership and effective
context/output ownership before returning facts. The existing bounded Git membership producer is shared by collection and
rechecking: changes to the enumerated tracked or nonignored path set invalidate the captured
membership. This includes
new root/package consumers and requires no second config, program, packaging or analyzer census.
Callers release retained graphs with `close`; released resolvers cannot be reused.
Unsupported or unresolved semantic situations remain incomplete or fail closed. Responsibility
assessment, boundary exemptions, migration and scope activation are subsequent #3918 checkpoints.

Incoming member references use actual checker-owned properties and canonical declaration provenance,
including dot access, literal/template element access and bounded immutable const key/callee aliases.
Inert TypeScript syntax preserves call classification. Keys derive from actual literal/const
initializers, so an asserted unknown key cannot borrow a known export identity from its type alone.
Matching members require an actual namespace import binding or its immutable const aliases; an
asserted opaque receiver cannot qualify through its type alone. Mutable, destructured or parameter
callable indirection and unresolved computed members remain
explicitly incomplete. These are compiler/source reference facts, not runtime function-object
identity or higher-order responsibility proofs; they authorize no semantic exemption.

### Responsibility checkpoint (inactive intermediate interface)

Version 1 retains its exact policy/report keys, rule inventory, scopes and activation history.
Version 2 adds closed responsibility records: stable id, owner, validator or structural-redactor
kind, exact rule obligations, input/transform/output/consumer export selectors and repository proof
paths. The input selector names an exact nonnegative canonical `parameterIndex`; its closed shape
and historical identity reject removal or rebinding of that slot. Historical version 1 has no responsibility records; version 2 history rejects downgrade,
removal or rebinding of an existing obligation. Unknown authorization fields remain rejected.

Selectors resolve actual current compiler-owned declarations and emitted public entries. The
relationship validator's root barrel exposes its type identity only; its executable public entry
is `@oscharko-dev/keiko-contracts/runtime/relationships-validation`. Proof paths bind current source
bytes, not test execution. A source-compatible validator signature does not prove its implementation
or its consumer. Structural redaction truthfully returns unknown and preserves structure; it does
not establish domain validity or persistence safety.

The intermediate evaluator reports structural `ready`, `incomplete` or `invalid` separately from
semantic `pending` or `rejected`. No runtime proof execution mechanism is authorized by this
interface, so `qualified` remains zero. Even a present proof file and separately passing owning
Vitest tests cannot qualify CLI semantics. The combined v2 `outcome` remains failed while any
responsibility remains unqualified. The explicitly separate `enforcementOutcome` answers only
active syntax and static obligations. Enforce-mode exit follows that static result; text and JSON
disclose both results and semantic counts. Census returns its descriptive exit zero while retaining
actual static failure and pending semantics in those fields; census never supplies an enforce verdict.
This is a disclosed v2 command-contract refinement,
not semantic or migration qualification. Version 1 report shape and command behavior are unchanged.

Static enforcement fails on active applicable findings and incomplete or rejected required static
facts, including missing/foreign owners, missing/noncallable or unbound consumers, missing proofs and unsafe
unknown or open-dictionary validator outputs. Merely unexecuted runtime and consumer proofs remain
pending without becoming static rejection. The evaluator adapts only an assigned canonical raw
parameter's exact annotation location for `no-unknown-parameters`, and a structural redactor's
truthful raw return annotation for `no-unknown-returns`. The raw census retains every finding;
each adaptation carries the responsibility id and exact checker-owned slot. No body, consumer,
package, assertion or typed domain output is exempted. Additional unknown parameters remain active.
Other rule obligations stay applicable and receive no adaptation from these slots. Existing version
1 production policy and every activation/history guard remain unchanged.

The existing bounded resolver supplies canonical callable slots, call references, flat index-signature
facts and types before inert assertions. Recursive dictionary indexes are classified without walking
an unbounded type graph. Missing or stale source facts grant no adaptation. These facts describe
compiler/source contracts and cannot prove a predicate body truthful. The same ordinary runtime
consumer safety assertions reject unchecked, always-true predicate, open-dictionary and generic
assertion mutants; they do not promote the CLI's unexecuted semantic proofs through a cache,
receipt, proof path, witness or authorization flag.

Actual reference-validator/redactor preservation and counterfeit unknown-output controls live in
the responsibility owning suite. They are useful runtime controls, not complete dataflow,
validation-dominance, hostile-object or physical-sink proofs. Native sibling policy integration,
versioned production records and shared real-parser fixture adaptation remain prerequisites for
publishing the complete responsibility checkpoint.

Consumer selectors require their own nonempty, bounded `owner` (at most 256 characters).
Input, transform and output declarations remain bound to the producer record's `owner`; canonical
consumer declarations are bound to `consumer.owner`. This permits existing cross-package consumers
without relocating code or introducing a foreign-owner permission. Import-anchor paths do not establish
exported declaration ownership. Consumer ownership is part of historical selector identity; missing,
malformed, mismatched or rebound ownership fails closed. Producer selectors still reject extra owner
fields. The resolver keeps that public identity separate from its actual callable implementation, following
bounded immutable const aliases and current checker-bound imports/reexports. The implementation
must retain `consumer.owner` and contain a canonical lexical call to the declared transform producer.
A decoy call in another export cannot bind the named consumer. Direct inline call-argument callbacks
participate lexically; named nested functions and unused locally assigned lambdas are separate
implementations. Deferred class scopes also remain separate and cannot bind an enclosing consumer.
Mutable, destructured or unresolved computed dispatch remains unbound. Missing
or unsupported implementation facts remain incomplete and grant no raw-slot adaptation.

These call facts establish bounded source participation, not callback execution, validation
dominance, result flow or runtime safety. Semantic obligations remain pending, qualified counts
remain zero, and no proof path or prior test result qualifies them.
