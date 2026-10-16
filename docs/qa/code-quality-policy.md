# Code-quality syntax policy

Issue #3915 establishes the noncosmetic policy for epic #3914. It supplements the existing
TypeScript, typed ESLint, UI lint, Prettier, Sonar, coverage, security and architecture gates.
The source of truth is `scripts/code-quality-policy.json`; naming and spacing rules are excluded.

```bash
npm run check:code-quality-policy
npm run check:code-quality-policy -- --mode census --json
npm run check:code-quality-policy -- --scope production
npm run check:code-quality-policy -- --scope package:@oscharko-dev/keiko-contracts
npm run check:code-quality-policy:repository
```

The canonical default is repository-wide enforcement with semantic proofs pending. After contracts
reflection activation, default repository/production/contracts scope invocations can correctly fail
on the legitimate pending observation coordinate; they do not establish qualification or a green
scope. Fresh `--qualify-responsibilities` execution is required to admit that exact observation.
`npm run check:code-quality-policy:repository` selects complete current-subject qualification.
Local `npm run lint` builds packages, runs the bounded default fixture, complete repository
qualification, existing raw-reader qualification and then the shared `lint:typed` ESLint/UI tail.
Required CI runs those three policy operations serially in the existing Linux ARM64 Node24/26
matrix; x64 Core quality depends on that matrix and runs the typed tail after build/typecheck.
Build packages first when invoking the canonical CLI directly on a fresh checkout.

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

All 22 rules run in one syntax census. At the public assessment boundary, diagnostics are ordered
by the supplied subject inventory, then numeric line and column, then rule id using deterministic
UTF-16 code-unit comparison. The census retains every original diagnostic and duplicate without
mutating the analyzer input; active violations retain that same order. Native worker arrival order
does not affect serialized report bytes. Only explicitly activated scopes enforce a rule. The
remaining production assertion scopes activate as their owning workstreams migrate; the final
qualification requires all of them. Boundary bans are adapted to validated domain contracts,
module interception belongs to the test-seam migration, Effect rules apply only to the qualified
native host, and array fusion/omission/growing-copy diagnostics require their accepted targeted
review. A raw match is a diagnostic, not a proven defect or a count-based waiver.

The contracts production scope (`package:@oscharko-dev/keiko-contracts`) also enforces
`no-chained-type-assertions` and `require-safety-comment-for-type-assertion` after its assertion
migration. This includes generated production members and newly added files in that package;
other owners retain their separate migration obligations. A safety comment explains an existing
justified representation boundary, such as attaching a nominal brand after structural admission;
it neither validates hostile input nor authorizes a chained assertion. These two syntax rules do
not establish boundary/domain qualification or complete #3918.

The same whole contracts production scope now activates `no-reflect-get`. It includes current,
future and generated production members and the existing production-classified `vitest.config.ts`,
while test/nonproduction and foreign package owners keep their distinct obligations. The prior
`81d441d` inventory contained 244 contracts production members; the scope is not a fixed file list.
The existing `support-raw-property-observation` record may admit only the private
`runtimeProperty` operation in `observability.ts` (1374:29, source span 52211–52222 on that subject)
after genuinely fresh semantic qualification of its exact 15 public proof selectors. Missing,
pending, stale or failed proofs cannot adapt it, and another `Reflect.get` coordinate stays active.
No own-property/descriptor/cache replacement, receiver/read-order change or domain typing is
introduced. The runtime, registered evidence contract, record and proof bodies remain unchanged.
The native census is preserved; only the one qualified active operation can become an adaptation.
The final complete production gate must actually qualify all 51 records on its current candidate
and cover the full contracts production inventory. An earlier qualified report or a constructed
unit input cannot supply that execution. This activation does not complete the 170-owner domain
migration or activate the remaining six boundary rules.

Git status, diff, history, summary, remotes and sync preview/execute parsing reuse concrete admission
in their owning contracts modules. The typed parsers return the original accepted value; legacy validators retain
their result shapes and diagnostics. Status, history-entry, history-ref and remote arrays validate
each indexed member, including sparse positions, without trusting caller-supplied iteration
methods. History retains its strict date and pagination bounds; summary and remotes retain their
distinct URL policies and paired upstream fields. Sync execute now validates its optional upstream
through that same owning guard; preview retains its executable/block-reason complement and execute
retains its closed outcomes. The lazy browser consumers carry the parser's value through the
existing fetch scaffold. An empty 204 on these typed response paths is a contract refusal
with the response correlation and existing body-free diagnostic; ordinary no-content mutation
routes retain their behavior. Sync response admission preserves POST bodies, approvals, authority
and cancellation, and never replays an execution after a malformed response. A real API/browser
transport/registered-writer/support-analyzer scenario proves the correlated body-free refusal with
a healthy control. Other legacy response paths remain separate migration obligations.

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

The internal #3918 compiler interface supplies descriptive facts to responsibility assessment.
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
context/output ownership before returning facts. Collection retains the existing full tracked
classification. Each currentness check freshly enumerates the same tracked or nonignored path set
with one bounded, NUL-delimited Git query, using Git's status tags to preserve tracked-first
ordering before deduplication and locale sorting. Changes to that path set invalidate the captured
membership, including new root/package consumers, without a second config, program, packaging or
analyzer census. Both ordered fresh content passes remain unchanged. The combined query retains
the existing 20-second and 16-MiB subprocess bounds. That single output budget includes Git's status
tags and is narrower than the full producer's two separately bounded outputs; no capacity is widened.
Callers release retained graphs with `close`; released resolvers cannot be reused.
Unsupported or unresolved semantic situations remain incomplete or fail closed. Runtime semantic qualification and further migration/scope activation remain subsequent #3918 checkpoints.

Incoming member references use actual checker-owned properties and canonical declaration provenance,
including dot access, literal/template element access and bounded immutable const key/callee aliases.
Inert TypeScript syntax preserves call classification. Keys derive from actual literal/const
initializers, so an asserted unknown key cannot borrow a known export identity from its type alone.
Matching members require an actual namespace import binding or its immutable const aliases; an
asserted opaque receiver cannot qualify through its type alone. Mutable, destructured or parameter
callable indirection and unresolved computed members remain
explicitly incomplete. These are compiler/source reference facts, not runtime function-object
identity or higher-order responsibility proofs; they authorize no semantic exemption.

### Responsibility checkpoint (production registrations, pending semantics)

Version 1 retains its exact policy/report keys, rule inventory, scopes and activation history.
Version 2 adds closed responsibility records: stable id, owner, validator or structural-redactor
kind, exact rule obligations, input/transform/output/consumer export selectors and repository proof
paths. The input selector names an exact nonnegative canonical `parameterIndex`; its closed shape
and historical identity reject removal or rebinding of that slot. Historical version 1 has no responsibility records; version 2 history rejects downgrade,
removal or rebinding of an existing obligation. Unknown authorization fields remain rejected.

The production policy registers eight manual ingress/consumer pairs: create and refresh request
route handlers, source-scope composition, source refresh, source INSERT, summary projection,
summary UPDATE, and the public limit diagnostic checker. Each selects only
`anti-slop/no-unknown-parameters` for its observed canonical unknown input parameter 0. Input,
transform and output refer to that same validator; the consumer has its separate canonical owner.
No new rule scope is activated. Other raw-helper, dictionary, return or body slots are not granted
by these records. Proof paths bind owning sources. Default CLI assessment leaves them unexecuted; an explicit qualification phase can execute the declared exact assertions.

Responsibility assessment is global on every CLI invocation, against the complete inventory and
all registered records. A local `--scope` still selects only Native parser input and raw diagnostic
enforcement: `scope`, expected/visited/findings and the raw census describe that selected scan.
Inventory, package membership and responsibility facts describe the complete registered graph.
Invalid or missing registered facts fail static enforcement even when their owner or inactive
rule is outside the selected scan. Adaptations match only actual selected violations at exact sites.
The direct assessment API with explicit partial files still refuses incomplete responsibility
scope; the CLI does not pass a partial file set to that API. CI subset-command refusal is unchanged.

Real-parser fixtures construct their own v2 policy from all current production rule objects,
upstream and runner identities, plus their own actual records. They never copy foreign production
records and remove them from history. Empty ordinary fixtures preserve static PASS/combined FAIL;
responsibility fixtures preserve alpha/beta owners and the complete Native census. Synthetic Git
history remains complete and rejects removal, rebinding, shrink and downgrade through merge parents.

Selectors resolve actual current compiler-owned declarations and emitted public entries. The
relationship validator's root barrel exposes its type identity only; its executable public entry
is `@oscharko-dev/keiko-contracts/runtime/relationships-validation`. Proof paths bind current source
bytes, not test execution. A source-compatible validator signature does not prove its implementation
or its consumer. Structural redaction truthfully returns unknown and preserves structure; it does
not establish domain validity or persistence safety.

The intermediate evaluator reports structural `ready`, `incomplete` or `invalid` separately from
semantic `pending` or `rejected` by default, with `qualified` zero. A present proof file or separately passing old Vitest result does not qualify CLI semantics. Only the explicitly selected fresh execution phase below may change those semantic fields. The combined v2 `outcome` remains failed while any
responsibility remains unqualified, or no semantic subjects have been assessed. Valid empty v2
records request no adaptations: static enforcement can pass with exit 0 while combined qualification
remains failed, with qualified and pending counts both zero. Empty records do not certify migration
completion or remove active raw diagnostics. The explicitly separate `enforcementOutcome` answers only
active syntax and static obligations. Enforce-mode exit follows that static result; text and JSON
disclose both results and semantic counts. Census returns its descriptive exit zero while retaining
actual static failure and pending semantics in those fields; census never supplies an enforce verdict.
This is a disclosed v2 command-contract refinement,
not semantic or migration qualification. Version 1 report shape and command behavior are unchanged.

Static enforcement fails on active applicable findings and incomplete or rejected required static
facts, including missing/foreign owners, missing/noncallable or unbound consumers, missing proofs and unsafe
unknown or open-dictionary validator outputs. Merely unexecuted runtime and consumer proofs remain
pending without becoming static rejection. The evaluator adapts the assigned canonical raw
parameter's exact annotation, and exact private same-source helper parameter annotations reached
by bounded direct calls forwarding that parameter or its static property projection. Parentheses
and immutable const aliases preserve this origin; assertions, non-null assertions, `satisfies`,
explicit unknown/open-dictionary erasure, mutable or destructured bindings and computed dispatch do not.
Every helper value reference must be accounted for by this closure or an immutable local callee alias.
Unrelated trusted callers, exports/reexports, return/container/callback escapes, unused nested
functions, deferred classes and self/mutual cycles withdraw the helper adaptation or leave facts
incomplete. Extra unknown parameters and other APIs remain checked.

Within this closure, `no-runtime-typeof` adapts only an exact operand whose checker type remains
unknown and whose raw origin is retained. A partially narrowed or typed operand remains enforced.
`no-known-value-widening` adapts only an exact informative argument recheck against an actual
checker-bound type-predicate parameter in the same qualified closure, while retaining informative
local types. It never adapts variable/property/assignment/return erasure or assertions. A structural
redactor's truthful raw return annotation remains the sole `no-unknown-returns` adaptation.
`no-unsafe-dictionary-type` adapts only concrete unknown-valued dictionary annotation members
on an eligible boolean or identifier-predicate checking helper in that same raw-origin closure.
The selected standard-library mapped type, string/unknown arguments and unknown index are
checker-owned facts, not a permission based on the type's spelling. Predicate members must refine
that helper's actual raw parameter. A predicate intersection selects only its dictionary member;
the surrounding intersection, unrelated parameter, property, local or data-return annotation is
not a slot. Aliases, local counterfeits, typed or any-valued indexes and mutated parameters receive
no dictionary-member adaptation. Shallow intersection index facts still reject open validator
outputs and explicit dictionary erasure; they do not recursively certify wrapped payloads.
The raw census retains every finding, and each adaptation carries the responsibility id and exact
checker-owned slot. Native diagnostic line/columns use UTF-8 bytes from the actual source; compiler
start/end offsets and declaration-map ownership retain their UTF-16 contract. Guarded resolver facts
are reused without an additional program or analyzer run; returned facts cannot mutate the cache,
and current source/config/package membership guards still invalidate reuse.
No body, consumer, package, assertion or typed domain output is exempted.
Other rule obligations stay applicable and receive no adaptation from these slots. Historical version 1 behavior and every activation/history guard remain unchanged.

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
A finite checker-bound walk may follow private same-source top-level siblings through direct calls
and immutable aliases. Exported or escaping helpers, cycles and exhausted existing budgets cannot
authorize participation. One public overload signature may map to a unique runtime body on the same
current canonical symbol; public and implementation identities remain distinct. Multiple signatures
or ambiguous bodies remain unsupported. This walk grants no helper raw-origin or dictionary slots.
A decoy call in another export cannot bind the named consumer. Direct inline call-argument callbacks
participate lexically; named nested functions and unused locally assigned lambdas are separate
implementations. Deferred class scopes also remain separate and cannot bind an enclosing consumer.
Mutable, destructured or unresolved computed dispatch remains unbound. Missing
or unsupported implementation facts remain incomplete and grant no raw-slot adaptation.

These call facts establish bounded source participation, not callback execution, validation
dominance, result flow or runtime safety. Semantic obligations remain pending, qualified counts
remain zero, and no proof path or prior test result qualifies them.

### Nonproduction public diagnostic proofs

Version 2 also permits the closed `diagnostic-checker` responsibility kind. Its consumer
is explicitly `{ kind: "public-api-proof", owner, consumerPath, specifier, exportName }`:
a test-local exported function, not a production data consumer. The selected owner test must
appear in the record's proof list. Input, transform and output resolve to the same canonical
production diagnostic callable. The consumer forwards its single unknown parameter to one
direct named value import, stores the readonly string-array result in one immutable local,
and returns that local's length. The result must have the checker's intrinsic readonly-array
identity; a local interface named `ReadonlyArray` cannot substitute for it. Constants,
discarded results, different receivers, local
counterfeits, wrappers, extra statements, mutable/destructured aliases, dynamic dispatch,
assertions and overloaded callables do not qualify this bounded shape. This grants no typed
data output, array-return exemption, dictionary waiver or complete incoming-use proof.

One resolver derives a detached owner-to-selected-test-root manifest before assessment. Proof
contexts retain the owner's original production roots, strict options and project references,
adding only declared owning test roots and `noEmit: true`. Production contexts and Native
emission remain unchanged. Derived roots and plain compiler-option collections are detached
and immutable; the original config AST and project references stay untouched. Currentness
is checked before proof cache reuse, including cached compilation refusals. Both roles share
the existing two-Program LRU and cumulative
source, node, alias and emission budgets. Manifest, ownership, configuration, membership and
observed source/declaration/map changes invalidate the resolver; closing clears both roles
and declaration caches. A foreign test must genuinely compile under its own owner before
ownership refusal can be evidenced.

Public imports use the actual importing source's resolution mode and effective options.
The supported package entry has exactly `types` and `import` targets and uses ES module
import mode. Actual resolver package identity and the literal requested export subpath must
agree with the guarded package manifest and inventoried declaration/runtime output ownership.
Matching source overrides and unsupported conditional export forms remain incomplete. The
runtime target must exist as a regular current guarded file. Every actual declaration entry
and supported named value reexport passes the existing original-production Native byte and
complete normalized-map guard, including source-redirected entries; the final canonical
producer must match the proof checker's source identity. This proves declaration/source
binding, not arbitrary JavaScript semantics. Ordinary owning Vitest tests execute the shipped
public runtime with healthy and malformed controls separately.

Default static CLI proof facts remain `executed: false`, semantic `qualified` remains zero, and combined
qualification stays incomplete while proofs are pending. Separate static enforcement and
actual owning tests/current CI/independent audits retain their existing meanings. Production
policy version 1, activation inventory, legacy selectors and historical obligations are
unchanged. The optional current-subject phase below reuses this evaluator; there is no pre-PR wrapper or source-hash trust certificate.

### Closed public parser proof

The separate v2 `public-parser` kind supports a shipped named parser without a production caller.
Its only initial obligation is `anti-slop/no-unknown-parameters` on required parameter 0. Input,
transform and output select the same canonical producer; its declared public proof belongs to that
owner. Existing public package/declaration/map/runtime, strict proof-program, currentness, history
and cumulative resource guards remain mandatory. No production record or scope is activated by
supporting this kind.

A public-parser record may additionally opt into exactly `anti-slop/no-runtime-typeof` and/or
`anti-slop/no-unsafe-dictionary-type`, retaining the unknown-parameter obligation and parameter
zero. These additions require nonempty, exact declared `proofAssertions`. They authorize only the
existing checker-unknown operands and intrinsic dictionary members described above; they grant no
return, body-wide, known-value-widening or typed-domain exemption. Supporting these optional rules
does not change any production record or activate a scope.

The collective raw-helper closure can account for multiple public parsers in the same source. For
each rule, every contributing root must be structurally ready with its canonical producer/public
proof binding, declared proof selectors and current source facts, and must explicitly declare that
rule. Every helper runtime reference must belong to the closed direct raw-origin graph or an
eligible immutable local alias. An unregistered, incomplete, invalid or differently opted-in
caller, export, escape, mutation, cycle or exhausted existing budget withholds the affected helper
and its downstream slots. A sound public root remains ready when a helper cannot join; its unmatched
diagnostics stay enforced. Helper state identity includes the canonical owner/source/declaration
and parameter, not only a source offset. Shared slots retain all contributing responsibility ids
in sorted order and use deterministic attribution independent of record order.

This is structural applicability: default static reports still have pending semantics, zero
qualified records and unexecuted proofs. Fresh actual public runtime qualification remains required
before scope activation or acceptance. The legacy single-root closure and its second-caller refusal
are retained, and raw-reader/property-observation slots keep their separate semantic-only condition.
Dynamic numeric indexed origin, new responsibility kinds and additional rule scopes are outside this
capability.

The proof consumer makes exactly one named public import call with its unchanged unknown parameter,
binds the result to an unannotated immutable identifier and returns that identifier unchanged. Its
explicit return type is the actual producer-owned result in the same checker and instantiation.
The supported envelope has exactly required `ok: true`/`value` and a closed failure arm containing
`ok: false` with either `errors` or `reasons`. The selected failure field must be the intrinsic
readonly string array. Both fields together, optional fields, extra fields, mutable arrays and
array-like substitutes remain unsupported. Unsupported binding or envelope facts remain incomplete.
Immediate unknown/any payloads and direct unknown/any-valued indexes are rejected. Typed indexes,
recursive named outputs and nested unknown fields are not recursively certified or blanket banned:
this deliberately shallow participation check leaves semantics pending.

All body/domain findings remain enforced. Exact raw-origin parameter/helper slots are reused without
new output exemptions. Default static CLI proofs still report `executed: false`, qualified remains zero and combined
qualification remains failed. The production Git status and diff records select the required
unknown ingress parameter of each named parser through its existing runtime subpath and owning
public proof. The existing raw-origin call closure also selects the unknown parameter of the private
`isGitDiffScope` checking helper reached by the diff parser: three parameter slots in total. Its
strict primitive comparisons and the public malformed-scope refusal proof support that participation.
Other helpers, legacy validators, the UI's injected callback chain and unrelated response casts
remain unclassified by these records. Qualification requires fresh execution of the declared public
identity, typed-result and malformed-input proofs in the current-subject phase below.
The history, summary and remotes records add six parameter slots: the three public parser inputs,
history's private `isGitRepositoryState` and `isString` guards, and summary's private
`isGitLastSyncMetadata` guard. These are the actual eligible raw-input checking parameters in each
record's existing closure, not a classification of every helper. Their public proofs preserve
identity and typed output and reject malformed inputs; the owning suites retain date, pagination,
URL and upstream checks and prove the sparse/spoofed-array repair. These records do not classify
the injected UI callback graph or complete the remaining boundary/domain migration.
The sync preview and execute records add exactly two slots: the unknown input parameter of
`parseGitSyncPreview` and `parseGitSyncExecuteResponse`. Their public proofs preserve identity,
optional presence, ordered refusals, the executable gate and closed outcomes, and reject malformed
upstream data through the existing guard. Shared private helper slots qualify only when the complete
canonical per-rule incoming closure admits them; the actual helper-inclusive report supplies the
evidence. Exported operation/outcome guards, the imported upstream guard and the injected UI callback
graph receive no blanket classification from these records. The actual browser transport and physical writer/analyzer proofs remain
separate acceptance evidence.
The two Knowledge catalog parsers likewise return the original admitted capsule-list or
capsule-set-list response. Their concrete catalog wire types include the existing legacy case
where only `modelUsePolicy` is omitted or undefined; strict complete Summary producers and their
validator still require that policy. Present policies pass the existing policy validator. The
browser applies the existing sealed, all-operations-denied default to legacy summaries, without
normalizing an incomplete wire object into a complete Summary. Existing display-name redaction,
optional-field omission and list query behavior remain owned by their existing consumers.

The two actual catalog GETs use the shared HTTP validator callback. Each GET owns its request
failure diagnostic, including transport and non-success responses, while the catalog owns
fulfilled-response projection failures and unexpected whole-load failures. An actual empty-body
validator refusal is already reported by shared HTTP; only that invocation's observed refusal
defers to it. An error code alone cannot establish prior reporting. The existing registered
client diagnostic, writer and analyzer path supplies body-free correlation evidence; no second
logging or deduplication subsystem is introduced. Public parser qualification does not classify
the UI callback graph or the remaining domain scope.
The three Memory records classify the existing record, scope and structured-payload validators
through the named public `runtime/memory` import and unchanged domain result types. The public
proof forwards each immutable checked result without a cast. These records append to the prior
18 responsibilities; all 22 rule dispositions and the remaining domain obligations remain intact.
They classify only parameter slots supported by the existing resolver's complete helper graph.
They do not activate the remaining contracts scopes or certify every Memory consumer.

The persisted Memory decoder normalizes the established nullable/ignored column conventions,
then admits the actual stored schema version and complete candidate through the existing record
validator. Scope and structured payload use their existing validators and checked values. Reads
retain exact `pinned === 1`, incomplete model-identity omission, absent retention-policy omission,
global coordinate ignoring and legacy plaintext support. Malformed rows fail directly with a
body-free `schema-mismatch`; the vault retains its local unreadable-row `internal` wrapper. The
actual handler reports its existing correlated opaque error through the registered diagnostic
writer, and its dependency-failure scenario reconstructs that evidence with the support analyzer.
No new log operation, encryption format, database migration or storage policy is introduced.

Three further Atlassian public-parser records select the existing sync change-summary, sync-job
and connector-pod-source validators through the named public runtime import and exact public-root
validation/domain types. They preserve the preceding 21 records and every rule disposition.
Actual producer, close/reopen SQLite and pod-summary projection controls separately preserve
healthy summary bytes and the established absent/malformed/refused-summary omission. They retain
job lifecycle/count/failure pairing, nested references, optional presence and ordered diagnostics.
Only the existing checker-supported helper closure can qualify exact raw-input slots; neither
these records nor their public forwarding proofs classify an entire validator body, callback
graph, connector store or remaining domain scope.

Three further approved-scope Atlassian parser records select the existing descriptor, sync-bounds
and provider-scope validators. They preserve the preceding 24 records and every rule disposition.
Only bounds has the direct persisted metadata consumer: it forwards the validator's checked value
when reconstructing the approved scope. Descriptor and whole-scope records are public-parser
proofs; the existing route keeps its separate wire admission. Public identity, optional-property,
ordered-error, provider-key, JQL-nesting and narrow-only default-ceiling proofs remain distinct
from real writer/close/SQLite/reopen preservation. These records do not widen scope, add egress,
classify every raw candidate or activate the remaining contracts domain rules.

Three further governed-action Atlassian parser records select the existing activity, pending-approval
and action-execution validators. They append to the prior 27 records without changing any rule
or activating the remaining contracts scopes. These validators are public-only parser responsibilities;
actual routes produce their public projection types without calling these validators. Public proofs
retain reference identity, optional presence, D4 row and reason pairing, ordered refusals, preview
exclusivity and exact domain result types. Actual handler controls separately exercise zero-fetch
approval parking, one-time execution, typed success/failure and content-free correlated activity.
Pending approvals and their activity ring are bounded process state, not a persisted decoder or the
registered Activity Log. A bounded interactive approval preview never becomes permanent activity.
Only a fresh complete checker run can qualify eligible parameter slots; shared helpers and raw
body findings remain assigned unless the existing resolver explicitly classifies their exact slots.

The same bounded batch adds the existing live-search request and result public parsers. The actual
route admits a live request through its checked value; the result parser has a public proof and
an actual connector producer, without claiming a validated UI transport. Free live JQL remains
opaque bounded text, distinct from approved sync-scope grammar. Public and actual producer/route
controls preserve request XOR, templates, default/narrowed caps, result/issue/metadata identities,
ordered errors and total/truncation pairing. Existing sparse/spoofed-array and ephemeral/no-store
proofs remain intact. These five additions retain the committed 27 obligations and all rule
objects; candidate registration alone does not qualify 32 records or the shared helper graph.

Actual owning runtime tests, strict typed consumer pins (including
declaration-only nested unknown/any mutants), current-head required CI and independent audits supply
separate executed acceptance. An unchecked-body mutant and a declaration-only type weakening require
distinct runtime and typed failures. The optional current-subject phase below does not import receipts or use a semantic cache.

### Truthful raw own-property readers

The v2 `raw-own-property-reader` kind supports a named public helper whose result is
deliberately unknown. It never promises a typed domain value. Its only adapted obligation is the exact
`anti-slop/no-unknown-returns` annotation of that reader, with the existing input selector at
parameter 0. Supporting this kind does not register a production responsibility or activate a
rule scope.

The canonical reader has two required identifier parameters: intrinsic `Record<string, unknown>`
and `string`, an explicit `unknown` result, and one return of
`Object.hasOwn(record, key) ? record[key] : undefined`. The reader's Object/hasOwn symbols must
belong to the actual standard library; receiver and key bind to those parameters. Different
bodies, shadows, assertions, callbacks, aliases or signature shapes cannot supply this witness.
The existing public source/declaration/runtime mappings and cumulative resource guards apply.

Input and transform select that reader. Output selects its complete owning validator; the public
proof consumer calls that validator and returns its actual public result unchanged, under the
existing closed parser binding. Both producer sources must belong to the selected scope and their
runtime/declaration outputs must join the fresh proof witness. Missing or unsupported facts stay
incomplete; an explicitly unsafe parser envelope is invalid. Neither can adapt a finding.

Only fresh semantic qualification can adapt the reader's exact RETURN coordinate. Structural
readiness with pending, missing, stale or failed proofs leaves that finding in enforcement. The
native census itself does not change. Caller results, body findings, parameters, dictionaries,
widenings, assertions and other RETURN coordinates retain their own obligations; incoming-use
unresolved or untyped counts are not cleared. This kind certifies no complete downstream-use
closure and introduces no semantic cache. Owning runtime, public type, declaration/body
counterfactual and restoration proofs remain separate acceptance obligations.

### Bounded default CLI regression and complete production qualification

`npm run check:code-quality-policy:cli-smoke` exercises the real enforcing default CLI on the
existing nonempty two-root collective-parser fixture. It checks full fixture visitation, its
package inventory, all 22 rules, zero active violations, repository/nonpartial/enforce scope,
both exact responsibilities ready and pending, zero qualified records and unexecuted declared
proofs. A throwing proof-module sentinel must remain unexecuted. Fixture cleanup runs in
`finally`. The existing 360000ms/SIGKILL/32MiB child allowance, 375000ms whole-test watchdog and
`isolatedPolicyReport`'s 180000ms helper default remain unchanged, as do the genuine child-exit,
deadline-kill and output-limit regression controls.

`npm run check:code-quality-policy:repository` separately invokes the actual current-subject CLI
with `--qualify-responsibilities --json --progress`. Its direct script validates complete actual
inventory visitation, 27 inventory and packed packages, all 22 rules, zero active violations,
passed enforcement and combined verdicts, the exact current checked-in responsibility cohort,
ready/qualified records with no pending/invalid/incomplete/rejected records, every declared exact
proof selector passed and every proof path executed. One successful invocation must have its direct
child closed and owned process group absent. It retains 32MiB capture and all evaluator, compiler,
currentness, semantic-child and resource limits. It adds no replacement whole-catalog timer: the
existing 30-minute required job bounds this complete production operation. Local qualification
must use an explicit operational runner/watchdog and report that environment honestly.

This decomposition follows the accepted October 13 amendment: a focused regression may replace
an unnecessarily combined test only while genuine complete production qualification runs
separately on the same candidate. Relocating 360000/375000ms to the fixture does **not** prove that
the complete production catalog finishes within six minutes. Those finite integration allowances
are not a product latency SLA, and no performance improvement or hosted equivalence is claimed.
Historically the earlier 180000ms full-input allowance killed correct evaluation on both hosted
ARM Node lines and a local four-CPU ARM reproduction. A
[separate bounded measurement](https://github.com/oscharko-dev/Keiko/pull/4013#issuecomment-6176738539)
on `4887a278` completed report and fresh inventory comparison in 249s, about 2.1GiB peak child RSS,
6200/6200 files, 27 packages, 22 rules, zero active violations and eight ready/pending obligations.
That historical measurement is retained as context, not a current gate verdict or timing promise.

The default fixture and complete qualification opt into existing bounded `--progress` stderr
observations: closed version, phase, started/completed state and elapsed milliseconds. A completed
phase is not a passed policy or delivered output. The shared failure helper exposes only validated
closed child/progress facts; malformed or absent observations remain unavailable. JSON stdout and
all evaluation semantics remain unchanged.

Both existing required Node24/Node26 policy jobs execute fixture integration, complete production
qualification, then the existing actual raw-reader qualification serially and mandatorily on the
same immutable candidate. Runner, matrix, normal install/provision/build, heap choices, job names,
30-minute timeout, required dependencies and reuse checks remain unchanged. The genuine complete
production step prints one body-free Node `os` JSON object (`arch`, `logicalCpus`,
`availableParallelism`, `totalMemoryBytes`), then runs
`/usr/bin/time -v npm run check:code-quality-policy:repository` exactly once as its last command.
GNU time 1.9 is already in the pinned Ubuntu ARM image; no installer, threshold or retry is added.
Its failure status propagates and skips the immediately following raw-reader step. CPU time,
maximum RSS and context switches are command-level context, not phase cause, cgroup memory limit
or process-group-summed peak. Hosted current-head results remain required; local ARM completion
is not a hosted verdict.

The existing raw-reader owner and 195s watchdog remain unchanged. Local `npm run lint` runs build,
fixture integration, complete production qualification, raw-reader qualification and typed lint
in that order. All three direct owners remain outside Vitest/coverage auto-collection. No pending
observation is adapted without genuine complete semantic execution. Native120s, declaration10s,
semantic-proof180s and all other operation-owned budgets remain independent and unchanged. The
canonical `npm run check:code-quality-policy` CLI remains available unchanged.

### Explicit current-subject responsibility qualification

`npm run check:code-quality-policy -- --qualify-responsibilities --json` selects an optional phase;
default static invocations and the bounded fixture smoke do not execute business proof suites.
The required repository command explicitly selects qualification. The fixture integration allowance
is separate from the unchanged 180000ms semantic proof-child bound below. Qualification is enforce-only. V1, empty records and missing registered
exact selectors fail closed when selected. No active rule scope or existing responsibility identity
is changed.

Each v2 responsibility may add closed `proofAssertions` entries containing only an already declared proof `path` and exact Vitest `testName` (fullName including describe ancestors). Duplicates, foreign paths, missing names and unknown command/authorization fields refuse. Existing selector history is monotonic: removal or rebinding fails. Shared actual assertions may support multiple records but execute once in a single Vitest invocation of all declared owning suites.

The selected phase builds packages through the canonical wrapper, captures the current subject and real installed tools, retains the existing evaluator/resolver and all currentness checks across await, and binds actual producer JS/declaration outputs. Actual proof-context compilation checks the owning public typed consumers. Then genuine installed npm/Vitest runs the declared existing suites once. Every exact selected assertion must occur exactly once with passed status; missing/skipped/todo/duplicate/failed assertions and absent proof files never qualify. Whole-suite exit0 or imported/cached results alone are insufficient. Actual proof facts change only after current tool/source/runtime/declaration/policy/membership checks pass again.

The same-library child helper uses the existing180000ms/SIGKILL/32MiB owner bounds and POSIX detached group. Timeout/output overflow kills the owned group and destroys its owned pipe readers before awaiting actual direct close and observing group absence; the failure remains failed. Unsupported/incomplete drain fails closed; no Windows taskkill or new dependency is introduced. This does not promise containment of a deliberately escaped descendant. Default static platform support is unchanged. Structured process/report failures remain body-free and explicit selected-phase failure exits nonzero even when static enforcement passed. No automatic retries, arbitrary policy commands, extra CLI-owner loop or performance qualification are supplied.

Qualified records prove only their reviewed exact runtime/consumer assertions on this assessed subject. Injected route services prove admission/checked forwarding, actual SQLite tests prove physical refusal, and registered physical writer/analyzer scenarios supply their separate evidence. Declaration/body counterfactual controls and independent review remain acceptance obligations; qualified records do not complete the170-owner/domain migration. Ordinary local scope contracts do not create a mounted server local-manual feature. Optional workspace prototype hardening stays deferred.

The actual JSON reporter file is fresh in an owner-private temporary directory and is admitted only after the child closes. The report and captured pipe bytes together must fit the existing32MiB bound. This is post-close report admission, not an instantaneous disk quota. Successful phase output carries actual direct-close/group-absence facts; no arbitrary report body is printed or attached. Installed tool entrypoints and their package/lock identities are checked before and after; this does not attest every transitive npm/Vitest implementation file.

### Private raw property observation

The v2 `raw-property-observation` kind records ordinary property observation, not validation or
canonical write authority. Its public input, transform and output selectors identify the same
owning validator. A compiler-owned, bounded traversal of participating same-source private calls
must reach exactly one supported helper. Unused nested callable bodies are not participation.
The private helper remains private; no product API or autonomy behavior changes.

The closed shape is two required identifier parameters, `object` and intrinsic `PropertyKey`,
an explicit `unknown` return, and exactly `const property: unknown = Reflect.get(value, key);`
followed by `return property;`. Parameter/local names bind through compiler symbols, not spelling.
Reflect/get and PropertyKey must belong to the actual standard library. Third receiver arguments,
shadowing, casts, aliases of the arguments, changed bodies and ambiguous helpers are unsupported.
The private symbol may participate only in direct calls: export lists, aliases that escape the
function value and container/callback exposure do not supply a private observation witness.
Ordinary inherited, symbol, missing/undefined, accessor receiver and proxy observations retain their
existing order and exception behavior; this is not an own-property reader or a snapshot.

The owning public proof consumer passes its required object parameter to the exact named public
validator, binds the result to an unannotated const and returns that identifier unchanged. Its
explicit result annotation must be the same actual producer-owned type. This reuses the existing
public import, source/declaration/runtime and strict proof joins without asserting a parser envelope
or recursively certifying the result's domain.

Only fresh executed semantic qualification adapts the exact private helper object-parameter,
unknown-return and Reflect.get operation coordinates. Pending, missing, stale or failed proof
adapts nothing. The raw census does not change. Other object parameters, returns, direct reflection,
assertions, caller/domain findings and unresolved incoming uses retain their obligations. In
particular the direct parent-correlation reflection is outside this helper shape. Existing
resource, currentness, two-pass and proof-process limits remain unchanged. No rule scope is activated.

The remaining eleven public Memory operation, audit and retrieval validators extend the existing
public-parser obligations to 43 records. Their runtime/memory wrappers retain original objects,
optional presence, branded result contracts, exact eager refusals and physical array admission.
Acceptance has a checked bodyOverride field consumer; the other lifecycle builders validate and
return their original envelopes. Rejection, audit-record and contracts retrieval remain public
proof surfaces; the active MemoryAuditEvent ledger and retrieval engine use distinct contracts.
Optional dictionary or typeof slots require the existing exact same-source checker closure and
executed public proofs. Numeric patch counters and already narrowed operands remain outside it.
No rule scope, authority, persistence decoder or logging surface changes in this batch.

The actual Memory checker retains pin/unpin as public unknown-parameter obligations only; its
shared overloaded helper receives no dictionary adaptation. Retrieval's two narrowed typeof
operands and the numeric countUpdatePatches helper remain unadapted. The other nine new roots
may qualify only the exact dictionary slots admitted by their original same-source closure.

The documentation navigation and manual-proposal request parsers add two mandatory public
unknown-parameter obligations, bringing the register to 45. Their public wrappers prove normalized
fresh output, bounded primitives, optional-field normalization, exact eager refusals and original
getter phases. The existing BFF consumers use checked target, port and advisory reason fields;
healthy and refused real-server controls preserve redaction and the absence of persistent or model
work. A client-reported lastNavigationReason grants no consent or crawl authority. Optional typeof
and dictionary adaptations remain withheld pending actual checker eligibility. No scope is activated.

Four Workbench question/research public parsers extend the register from 45 to 49 mandatory
unknown-parameter obligations: answer admission, runtime list response, questions channel and
research channel. Their existing unknown inputs and raw helper dictionaries remain intentional
trust boundaries. Test-only public wrappers pin source/public return types, original and nested
identity, optional presence, exact eager errors and existing getter phases. The actual runtime
list port rejects malformed projections; coordinator and route proofs retain revision/replay,
live authority, authenticated reads and content-free unpaired projections. Validating research
payload structure grants no network, model or approval authority. No production API, resolver,
rule scope or optional dictionary/typeof adaptation is added. Qualification of these exact roots
does not establish domain zero or discharge the remaining accepted-owner obligations.

Two governance public validators extend the register from 49 to 51 mandatory unknown-parameter
obligations: GovernedActionV1 and CodeTaskExecutionV1. Their unknown input remains a genuine
admission boundary. Direct public forwarding wrappers pin the canonical imported checked return
alias, branded domain values, original and nested identity, absent fact-value omission, exact
ordered refusals and the existing repeated getter phases. The real research-approval consumer
retains healthy forwarding and refuses a malformed optional governed projection; grant registration
precedes that projection, so this refusal neither revokes a grant nor supplies new research authority.
No production API, runtime code, resolver, scope or optional dictionary/typeof grant changes.
Qualification of these two roots does not establish governance domain zero or complete the remaining
accepted-owner obligations.
