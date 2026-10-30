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
reflection and unknown-return activation, default repository/production/contracts scope invocations
can correctly fail on legitimate pending observation/return coordinates; they do not establish
qualification or a green scope. Fresh `--qualify-responsibilities` execution is required to admit
those exact coordinates.
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
module interception belongs to the test-seam migration, Effect rules retain the declared historical
`native-host` scope, and array fusion/omission/growing-copy diagnostics require their
accepted targeted review. A raw match is a diagnostic, not a proven defect or a count-based waiver.

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
The reflection activation checkpoint required the final complete production gate to qualify all
then-registered records on its candidate and cover the full contracts production inventory. An earlier qualified
report or a constructed unit input could not supply that execution. That activation did not complete
the 170-owner domain migration or activate the remaining six boundary rules.

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
190 accepted and 191 rejected cases. These qualify syntax; the five Effect suites do not qualify
a current native runtime. The Node service host qualified in #3988 has been retired. Its three
byte-pinned source snapshots now live only as historical analyzer fixture data; synthetic
repositories preserve the native-scope and global-graph regression checks. The real retired
checkout has no such owner, so selecting its empty `native-host` scope still fails.
The five exact Effect rule obligations remain conserved as `retiredScopes: ["native-host"]`,
with no active scope; every other rule retains its existing activation contract. Only this complete
five-rule cohort can retire under policy version2. Historical fixture policies explicitly reactivate
all five on their byte-pinned owner. Active plus retired scopes remain monotonic through policy
history: neither retirement nor reactivation can erase an obligation. A returned owner requires
reviewed reactivation and qualification.

A retired policy can produce a report only after complete Git membership proves the owner absent
and final currentness confirms the same complete membership count and digest. This includes
non-Source and test-looking members, tracked paths and nonignored untracked paths; existing
inventory safety failures still reject before a witness can be produced. The closed
`scopeRetirements` report witness records absence, five obligations and the membership commitment,
not analyzer visitation or replacement-runtime qualification. Active historical fixtures report an
empty witness list. These checks do not lock the filesystem against later edits. Neither these
fixtures nor the dormant scope establish replacement runtime or SDK/native qualification. The native accumulating-spread rule has a distinct
qualification workstream. Real parser and policy negatives also pin malformed syntax, missing
visits, dropped packages, suppression and invalid scopes.

The retired `check:native-host-code-quality` command is not a current runtime gate. Its five
safe/bad Effect examples and process/parser/output-refusal controls live only in test support;
injected execution results do not attest an Effect runtime or SDK execution. Required Core quality
runs `check:native:linux`: the existing Linux compiler, analyzer and requested protocol scope,
with package builds first. The default protocol-only lane does not claim kernel or staged-release
qualification. Existing macOS/Windows native quality and actual runtime release qualification
remain separate requirements; approved package bytes and receipts alone do not prove execution.

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

The interface bounds retained programs (2), verified source bytes (96 MiB; 64 MiB until the
owner decision of 2026-10-30 recorded in ADR-0167 D4), visited nodes
(5 million), alias traversal (64) and aggregate retained declaration emission and private build-info bytes (16 MiB).
A distinct `collectiveStates` limit defaults to 256 for the complete connected multi-root private
raw-helper union under the discovery requirements below. It changes no request, individual-root,
alias, depth, numeric, captured or consumer-binding bound. Native declaration-only
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

A compiler-owned source-byte refusal is sticky for that live compiler context. The first fixed
`symbol-source-budget` error is retained privately and rethrown outside TypeScript's host-read
catches before Program/checker results or resolved modules can be returned or cached. Subsequent
work, including admitted reads, cached Programs and currentness, refuses with that same error and
performs no further Keiko text admission. Attempted bytes retain the first refused read's overshoot;
the refused source has no admitted witness. Programs actually returned by TypeScript are counted
before an outside refusal, while failed contexts are not cached as qualified. This refusal behavior
changes neither the source ceiling, the node/alias/emission limits nor ordinary production
semantic-pending behavior.
Numeric stats remain readable and close remains unconditional/idempotent; normal work after close
reports the existing closed reason. A new compiler is the recovery boundary. The live private marker
survives exposed counter/limit/snapshot/cache edits, without promising protection against deliberate
closed/preparation-field rewrites or revocation of previously returned raw Programs. TypeScript may
still perform existence/directory probes or keep internal empty SourceFiles while its guarded call
unwinds; this is not a pre-read I/O or heap-allocation quota. Whole-owner real-host proofs distinguish
swallowed declaration reads from direct metadata-resolution failures, preserve exact error identity
and attempted/admitted accounting, and retain healthy unresolved/semantic controls.

Declaration-position lookup visits only parsed raw spans that can contain the requested UTF-16
offset. It charges every inspected node, including a pruned sibling, through the unchanged
cumulative node ruler. Selection still uses token start, exclusive end and the last minimum raw-span
candidate in TypeScript preorder; leading trivia retains the SourceFile fallback. This avoids
walking unrelated descendant subtrees without caching ASTs or changing any budget.

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
parameter's exact annotation, and exact private helper parameter annotations reached
by bounded direct calls forwarding that parameter or its static property projection. Parentheses
and immutable const aliases preserve this origin; assertions, non-null assertions, `satisfies`,
explicit unknown/open-dictionary erasure, mutable or destructured bindings and computed dispatch do not.
The legacy walk remains same-source; the collective module extension below is separately bounded.
Every relevant helper value reference in the owned static graph must be accounted for by that
closure or an immutable callee alias. Unrelated trusted callers, public exposure,
return/container/callback escapes, unused nested
functions, deferred classes and self/mutual cycles withdraw the helper adaptation or leave facts
incomplete. Extra unknown parameters and other APIs remain checked.

Within this closure, `no-runtime-typeof` adapts only an exact raw-origin operand whose checker type
is unknown. A nonempty raw member origin may additionally retain the compiler's intrinsic
non-nullable-unknown residue, optionally unioned only with null or undefined. Raw parameter
refinements remain enforced. Primitive, named-domain and merely structurally empty object types remain enforced;
receiver/index provenance alone does not establish eligibility. Existing erasure and helper guards
remain unchanged.
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

The same existing kind also accepts the exact closed diagnostic envelope used by
`ContextValidationResult`: readonly literal `ok: true` with no value, or readonly literal
`ok: false` plus readonly `reasons: readonly string[]`, with no optional, extra or indexed fields.
The producer must retain its canonical owned alias and its one required unknown parameter. The
additional witness is exactly two statements: `const result = publicValidator(input); return
result.ok ? 0 : result.reasons.length;`, with an explicit numeric return. The call, input and both
property receivers must bind to the same canonical producer/parameter/local. An erased result,
mutable/nonstring reasons, unrelated discriminator, fabricated count, changed polarity or foreign
alias/producer does not qualify. This preserves the existing readonly-string-array witness unchanged;
it does not manufacture a parsed value or grant type-predicate behavior to a diagnostic collector.

Structurally bound diagnostic roots with declared proof selectors may participate in the same
owner/rule collective helper components as public parsers. The existing direct raw-origin,
all-incoming-use, currentness and whole-group budget-withholding rules remain unchanged. Private
string-array collectors already fit that direct raw traversal; this adds no callback, public-helper,
mutation, indexed-origin or body-wide permission. Structural applicability still leaves proofs pending.

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

The collective raw-helper closure accounts for actual connected public-parser or diagnostic-checker
roots, including a single root, across modules in one owning package. For
each rule, every contributing root must be structurally ready with its canonical producer/public
proof binding, declared proof selectors and current source facts, and must explicitly declare that
rule. Imported edges admit only uniquely resolved direct named relative value imports, their named
aliases and the existing immutable const callee aliases, targeting a top-level named function in
the same owner. Target states use the target's own checker/source/declaration/parameter; incoming
edges retain the caller's origin and source coordinates. Reexport chains are not imported edges.
Every relevant helper value reference in the complete owned repository production static graph
must belong to the closed direct raw-origin graph or an eligible immutable alias. An unregistered,
typed, foreign, incomplete, invalid or differently opted-in caller, public exposure, escape,
mutation, cycle or exhausted existing budget withholds the affected helper
and its downstream slots. A sound public root remains ready when a helper cannot join; its unmatched
diagnostics stay enforced. Helper state identity includes the canonical owner/source/declaration
and parameter, not only a source offset. Shared slots retain all contributing responsibility ids
in sorted order and use deterministic attribution independent of record order. Roots are joined
only when canonical helper states connect them, never merely because they share a package.

The multi-root private union uses `SYMBOL_LIMITS.collectiveStates` (256) only after the existing
module-owned discovery owner verifies one complete connected component containing every requested
canonical root and more than one distinct root. Every root must have a current, successful
individual discovery containing its own canonical key within `aliases` (64). A singleton fallback
from a refused discovery is not a positive witness; missing, incomplete, stale or refused facts
retain the original 64-state path even when another root reaches that fallback key. Successful
uncached discovery is eligible, and cached facts retain the same currentness checks. Multiple
record ids for one canonical root and disconnected request lists do not unlock the larger union.

Only the discovered state union uses that selected graph-local ceiling. Request cardinality,
individual discovery, alias traversal and cycle depth retain 64. Root admission stays within 64
and also honors the selected union ceiling when that profile is stricter. Public and
ineligible nodes, edges, global incoming checks, producer identities and sorted contributing
responsibility ids remain present. Numeric, legacy captured and consumer-binding paths retain
their existing limits. A 257th state refuses the entire default-capacity union, not only its tail;
explicit stricter collective profiles retain the same no-partial-adaptation guarantee. Historical
64-state union pins use an explicit `collectiveStates: 64` profile; default-boundary controls derive
their fixture size from the production limit. Source, node, retained-Program, emission and proof
budgets remain unchanged. This is a capacity-contract change, not rule activation or runtime proof.

Module export syntax alone establishes neither public API nor privacy. Privacy uses the actual
declared package roots/subpaths and canonical export symbols, including named, star, default and
namespace exposure. The private exposure walk accepts the existing closed `types` plus `import`
and `types` plus `default` manifest target shapes; the public-proof resolver is unchanged. Missing,
unsupported, ambiguous or stale required source, membership, manifest, config or output facts
withhold the helper or preserve the existing currentness/budget refusal. File naming is no witness.
Topology validation follows canonical helper exports through reverse module references and checks
the relevant owner/entry targets. An ordinary import of a public caller does not make the importing
workspace expose every helper behind that caller. An unrelated workspace without `exports` cannot
withhold the helper solely through that absent field. Conversely, absence of `exports` is not a
privacy witness: Node's main/default-index and public subpath semantics still apply to relevant
canonical helper-exporting modules. A known relevant unsupported target remains a refusal.
For a no-exports ancestor, relevance includes physically contained, qualified runtime outputs of
the canonical helper even when a nested workspace is its exact compiler owner and seals its own
exports. An ancestor's `private` metadata does not seal that Node subpath. An explicit closed
ancestor export map still controls access. This checks known declared filesystem/module topology,
not arbitrary JavaScript loader behavior.
Type-only import bindings and references are not runtime callers, including when colocated with a
value import. Direct named type-only reexports retain their declaration/specifier value-visibility
flags in the private exposure walk before canonical alias resolution; they do not create runtime
public exposure. Semantic default imports, including `{ default as local }`, remain outside the admitted
helper-edge grammar; their presence never conceals observed value escapes.

The existing relevant incoming-reference predicate can establish that a raw helper already has a
foreign incoming reference. The resolver checks that owner mismatch before broader exposure work and caches
only the existing unsupported-reference result; it does not classify the helper as public or
change its privacy cache. The complete raw graph, downstream denial and independently valid root
slots remain intact. Irrelevant or type-only bindings cannot supply this early rejection.

Reverse exposure traversal also checks complete named-value imports at an already reached barrel
against that target module's current canonical runtime exports before admitting the consumer's
Program. Source export names, not local aliases or spelling similarity, select the actual symbols;
the existing canonical alias, namespace, provenance and visibility checks decide helper identity.
Only a conclusive unrelated result for every imported value can skip that consumer walk, after
the target retains the existing unique declaration/runtime output binding. That binding qualifies
native declaration/map provenance and observes a regular current guarded runtime file; an
unavailable binding keeps the full consumer walk. The existing separate runtime qualification
executes the shipped implementation; this does not add a fresh JavaScript semantic-attestation
contract. Matching
or missing symbols, unavailable target metadata and uncertain grammar retain the full walk; actual
checker errors and budget refusals propagate.

Both prepared and fallback statement descriptors use their existing unknown (`bindings: null`)
shape for an import with a default clause, including mixed default plus named imports. A semantic
named `default` value binding also retains the full walk. Namespace, star and other incomplete
binding forms cannot certify an unrelated import. Known type-only bindings grant no runtime
authority. This adds no descriptor field or cache and leaves the existing complete export helper's
short-circuit traversal unchanged.

The shortcut leaves incoming edges, graph states and global-use checks intact. An unrelated
exported wrapper that invokes the helper still triggers the existing incoming-call and downstream
denial. Actual source/body requests, both module-resolution modes, source/node/alias limits and
all-input currentness remain authoritative.

When no such foreign incoming reference already establishes rejection, the resolver first tries the existing
canonical public-exposure proof on the producer source's own supported runtime entries. A
positively proven public value export withholds the helper immediately;
its native/policy accounting and legitimate root slots remain unchanged. This can avoid constructing
an unrelated incoming owner's full Program merely to establish an already sufficient public
rejection. An empty, unsupported, untyped, type-only or nonmatching early result supplies no privacy
certificate and retains the complete existing reachability fallback. The same owning checker,
canonical identity, export visibility, output provenance, currentness, alias limits and source-byte
admission remain authoritative. No UI/package source filter, new cache, budget reset or
capacity change is introduced. Whole-owner work-admission proofs compare actual resolver byte and
Program observations with a generous control. Direct-foreign small/large controls retain exact
helper rejection and root slots within an actually measured source grant; a later explicit request
still admits and charges the avoided source normally. The fallback regression uses a same-owner
renamed reexport barrel before its foreign consumer, so a direct owner mismatch cannot replace the
required reachability walk or its source-budget refusal. Private and type-only controls retain
their existing behavior. All-input currentness still covers sources not admitted by this shortcut.

The resolver builds one snapshot-bound module index for the complete owned production membership.
The mandatory inventory syntax visitors
also observe richer detached module references and top-level binding descriptors while their
existing AST is available. No second complete source parse/walk is needed for compatible facts.
Additional expression traversal is checked by the same policy-leaf-owned visit primitive and
the same `SYMBOL_LIMITS` during preparation. Preparation keeps its own source-byte counter against
`SYMBOL_LIMITS.sourceBytes` (96 MiB since the owner decision of 2026-10-30, ADR-0167 D4); those
bytes are not seeded into compiler counters, and a compiler with a larger source limit than the
receipt's uses charged extraction instead of a preparation source refusal. A frozen private receipt binds its actual extra visits and
facts to original source/configuration/ownership/membership/output metadata. Each independent
compiler seeds those visits once into its own cumulative counter; an already-exhausted strict
profile retains an explicit refusal on the first operation. Incompatible alias profiles use the
fully charged extraction path, and partial or stale receipts cannot certify an empty graph.
Receipt data stays outside public inventory JSON and contains no retained AST or Program.
For compatible prepared facts, a row without any specifier-bearing reference cannot create an
incoming entry, so its statement descriptors are never consumed by that index. Such rows remain
in the complete inventory and all-input currentness checks, without an unnecessary compiler
source admission merely to build the index. A later source identity, body or export request still
admits and charges that file normally. Every nonempty reference retains both resolution modes;
preparation failures and the original fully charged fallback remain unchanged. This omits no
production parser visit, rule finding, relevant incoming edge or runtime-witness output.
Source-byte admission, currentness and both-mode module resolution still run in the compiler;
all subsequent actual walks charge the same counter. The two-resident-Program LRU,
alias and request/root cardinality, emission and execution bounds remain unchanged; the connected
private multi-root union alone uses the separate witnessed ceiling described above. Relevant namespace/default imports, concrete
dynamic/computed module dispatch, finite loader specifier alternatives containing the helper
module, mutations and callback/container/return escapes withhold the relevant helper. Unrelated
unresolved loader expressions, such as `import(userPath)` without a statically established helper
link, remain an analysis limitation: they are neither certified consumers nor evidence of another
helper caller. These grants describe the declared owned static graph; they do not prove that
arbitrary JavaScript execution cannot load a function. No observed helper-linked escape is waived.

Dictionary eligibility is unchanged: intrinsic dictionary annotations still need the existing
boolean/predicate checker result. A string-array collector, readonly wrapper, callback or imported
module receives no new dictionary or known-value-widening authority from this extension.

A collective cardinality refusal preserves the independently assessed legacy root slots and adds
no slots from the entire failed collective group, including every already-discovered state. Only
the three owner-created request/root/discovered-state cardinality errors are eligible; their
low-level `TypeError("symbol-alias-budget")` remains unchanged. Request refusals retain 64; root
admission uses the smaller of 64 and the selected union ceiling. Discovered-state refusals carry
that graph-local union ceiling. The join rechecks source
currentness before recording the omission. General alias traversal, depth, cycles, source drift and
unexpected exceptions still propagate.

Affected records carry optional `helperClosures` entries with the closed fields `status: "withheld"`,
`reason: "collective-helper-budget-exhausted"`, canonical `owner`, `sourcePath`, `rule`, `rootCount`,
`limit` and `observedCount`. Counts come only from the module-owned refusal factory, never arbitrary
exception properties. `observedCount` is the attempted cardinality at refusal, not a census of the
unexplored remainder. Entries are deterministically ordered, survive semantic completion/report
round-trips, and are absent when no group is withheld. They do not change root `reasons` or semantic
`obligations`: a qualified root does not establish complete helper coverage. Unmatched helper and
downstream diagnostics remain enforced; a capacity refusal cannot authorize scope activation.

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

Qualified records prove only their reviewed exact runtime/consumer assertions on this assessed subject. Injected route services prove admission/checked forwarding, actual SQLite tests prove physical refusal, and registered physical writer/analyzer scenarios supply their separate evidence. Declaration/body counterfactual controls and independent review remain acceptance obligations; qualified records do not complete the 170-owner/domain migration. Ordinary local scope contracts do not create a mounted server local-manual feature. Optional workspace prototype hardening stays deferred.

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

Pin/unpin retain their public unknown-parameter obligations only; their shared overloaded helper
receives no optional dictionary or typeof declaration. Retrieval's two narrowed typeof operands
and the numeric countUpdatePatches helper remain outside the existing raw-checker contract.
The optional-rule expansion below changes only explicit declarations on supported existing roots;
it does not erase those omissions or claim that every raw annotation is covered.

The documentation navigation and manual-proposal request parsers add two mandatory public
unknown-parameter obligations, bringing the register to 45. Their public wrappers prove normalized
fresh output, bounded primitives, optional-field normalization, exact eager refusals and original
getter phases. The existing BFF consumers use checked target, port and advisory reason fields;
healthy and refused real-server controls preserve redaction and the absence of persistent or model
work. A client-reported lastNavigationReason grants no consent or crawl authority.

The existing navigation-request record additionally declares `anti-slop/no-runtime-typeof` and
`anti-slop/no-unsafe-dictionary-type`, retaining its unknown-parameter obligation and exact public
proof selectors. Only checker-supported raw-origin operands and intrinsic unknown dictionary members
may qualify; the data-returning error collector and typed checks gain no exemption. Declaration
alone establishes neither eligible slots nor qualification, and unadapted findings remain visible.
The separate manual-proposal record retains unknown-only rules. No scope is activated.

Four Workbench question/research public parsers extend the register from 45 to 49 mandatory
unknown-parameter obligations: answer admission, runtime list response, questions channel and
research channel. Their existing unknown inputs and raw helper dictionaries remain intentional
trust boundaries. Test-only public wrappers pin source/public return types, original and nested
identity, optional presence, exact eager errors and existing getter phases. The actual runtime
list port rejects malformed projections; coordinator and route proofs retain revision/replay,
live authority, authenticated reads and content-free unpaired projections. Validating research
payload structure grants no network, model or approval authority. These four existing records also
declare the optional raw-origin typeof and dictionary rules through the existing public-parser
checker. Only exact eligible checker slots backed by executed public proofs may qualify; declaring
a rule does not grant body-wide coverage, foreign/shared helpers, narrowed operands or overloaded
callables. Runtime API and approval-review validators have no records in this cohort. The 107-record
register, every other record and rule scope remain unchanged. No production API, resolver or
authority changes. Qualification of these exact roots does not establish domain zero or discharge
the remaining accepted-owner obligations.

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

Three run-control public validators extend the register from 51 to 54 mandatory unknown-parameter
obligations: run snapshots, runtime governance requests and runtime governance outcomes. Existing
named public exports are the proof surfaces; no active production validator caller is presumed.
Direct public forwarding wrappers preserve original and nested references, all six operation arms,
all four outcome arms, tagged fact omission and own-undefined refusal, empty and dense collections,
exact eager refusals and the existing getter phases. Strict return pins distinguish source-owned
brands from canonical public DTO brands. Existing sparse/member and changing-observation regression
pins remain selected. These contracts grant no execution capability or authority; missing runtime
capabilities remain unsupported or denied. No production API, runtime bytes, resolver, scope or
optional dictionary/typeof grant changes. Qualification is limited to these three public roots and
does not discharge domain zero or the remaining accepted-owner obligations.

Five acceptance/auxiliary public validators extend the register from 54 to 59 mandatory
unknown-parameter obligations: acceptance contributions, qualification flows/manifests, and auxiliary
requests/outcomes. The contribution reuses its existing rawReaderAcceptanceWitness; four new
test-only functions directly forward existing public parsers. Separate source/public nominal return
pins and existing hostile-member, sparse-array, getter, identity and authority-binding proofs retain
actual admission. Acceptance consumers are repository/qualification tooling; the active auxiliary
callers remain untouched. Public parser proof does not certify those consumers' whole authority
behavior, execute evidence, issue a grant or widen a child's derived parent authority. The separate
raw-reader proof still covers ownField only; this cohort neither narrows its truthful unknown return
nor grants dictionary/typeof adaptation. No runtime API, production bytes, scopes or proof/resource
bounds change, and domain-zero/accepted-owner obligations remain independently open.

### Typed finite public entry rechecks (#3918)

The closed `typed-parameter-recheck` responsibility kind supports only
`anti-slop/no-known-value-widening`. It records a selected required typed parameter of a
non-generic synchronous named public producer. Its declared domain must be a canonical finite
string union owned by the same source. A direct same-source checker-bound Identifier predicate
must accept unknown, assert that exact domain and control the synchronous admission guard.
Discarded calls, aliases, mutations, captures, deferred calls and raw forwarding refuse admission.
Later typed table lookups and intrinsic readonly-array `includes` remain valid domain uses.
This capability does not certify predicate truth: actual healthy and hostile public runtime
assertions are mandatory, along with strict canonical public parameter and result type pins.

Four Task workspace records extend the cohort from 59 to 63: the two transition arguments,
the next-state argument and the cleanup-state argument. Three public forwarding proofs pass
every real parameter in order and return the actual result unchanged. Forwarding expectations call
the public producers; selected independent existing legal/illegal transition, next-row and
five-state cleanup proofs retain normative behavior checks. Task runtime source,
authority, cleanup semantics and existing hostile-input regression pins remain unchanged.
No new rule scope activates. Only fresh semantic qualification can adapt each selected native
argument coordinate; ready/pending records cannot. Predicate bodies, unknown annotations,
other arguments, dictionary/typeof/return/variable/property sites gain no exemption. Existing
membership, emission, source-currentness, proof-process and resource limits still apply.
This bounded pilot neither completes the 170-owner migration nor activates remaining rules.

### Registered acceptance raw reader

The checked-in `actual-code-task-acceptance-raw-reader-return` record extends the cohort from
63 to 64 using the existing `raw-own-property-reader` kind. It selects the actual public
`ownField`, its complete owning acceptance validator and the existing public proof consumer.
Its fifteen existing owning proof selectors cover the truthful unknown result, own versus
inherited properties, getter failures and complete acceptance admission. Only the reader's exact
`no-unknown-returns` coordinate can be adapted after fresh qualification.

The raw-reader smoke now selects this authoritative policy record instead of appending another
definition. It still proves that pending evaluation preserves the native return finding and that
actual selected proof execution adapts exactly that coordinate, without changing the census or
checked-in policy. At that registration checkpoint, complete production qualification separately
proved all 64 records. The registration preserved the previous 63 records, all rule scopes,
production code and public types; the unknown-return rule remained inactive until the other
legitimate raw returns were ready.

The closed `raw-canonical-json-decoder` responsibility registers the existing contracts
`parseCanonicalSupportJson` return without narrowing its truthful `unknown` result. It admits
only the exact return annotation after fresh semantic qualification. The decoder retains its
ordered text/UTF-8/shape preflight, builtin JSON parsing, canonical comparison and unchanged raw
return. A same-owner strict public witness forwards the actual string/number parameters to that
decoder, then the actual raw result to the canonicalizer. Canonical bytes are not SupportReport
schema admission: the existing Activity Log reader and browser proof owners remain required.

This registration extends 64 records to 65 and activates no new scope. The existing maximum16
selected assertions remains unchanged; all three declared proof owners execute completely, with
unselected existing tests retained as owning-suite regressions. Pending, failed or stale proofs
cannot adapt the return; no parameter, helper, dictionary or other return gains an exemption.
Caller `maxBytes` remains a numeric input, not a universal validated ceiling; the existing actual
consumers retain their fixed repository byte limits. The original unknown-result pin is unchanged.

### Contracts unknown-return activation

After the complete 65-record decoder checkpoint, the whole contracts production scope also activates
`anti-slop/no-unknown-returns`. Current, future and generated production sources and the existing
production-classified `vitest.config.ts` are included; canonical nonproduction and foreign owners
retain their separate obligations. The prior a41655f inventory contained 244 such members, not a
fixed file allowlist. All 65 responsibility objects, every other policy field across the 22 rules, product source,
public types and proof bodies remain unchanged by this activation.

The three legitimate raw returns stay truthful `unknown` values. Only fresh semantic qualification
can admit the exact selected return annotation of `ownField` in `code-task-acceptance.ts`
(284:73, source span 14800–14807), `runtimeProperty` in `observability.ts` (1373:60, source span 52173–52180), and
`parseCanonicalSupportJson` in `support-report-json.ts` (248:76, source span 8281–8288), at their source bytes on
that subject. Their existing records are respectively
`actual-code-task-acceptance-raw-reader-return`, `support-raw-property-observation`, and
`support-canonical-json-decoder-return`, with 15/15/16 declared selectors. No static, pending,
missing, skipped, stale or failed proof admits a return. An unrelated return stays active even in
an otherwise qualified file; no body/helper/parameter/dictionary exemption is added.

The native raw census is preserved. The genuine final complete repository qualifier must freshly
qualify all 65 records on the activation candidate, cover the full current contracts production
inventory and yield exactly those three unknown-return adaptations plus the existing exact
reflection adaptation, with zero active violations and a passed, closed/drained proof invocation.
An earlier qualified report, a default pending scan or a constructed unit report cannot supply
that result. This activation does not complete the 170-owner migration, activate the five remaining
boundary rules, or close #3918. The ordinary default can correctly fail until fresh qualification;
`:repository` remains the genuine complete semantic operation.

### Manual document-version public admission (#3918)

The `editor-document-version-public-parser` record extends the cohort from 65 to 66 using the
existing `public-parser` kind and only `anti-slop/no-unknown-parameters`. Its canonical public
forwarder returns the existing `EditorSessionValidation<EditorDocumentVersion>` unchanged.
Source/public/forwarding type pins and public runtime proofs retain the copied scalar fields,
extra-key normalization, unfrozen fresh output, zero size, finite fractional modification times,
ordered refusals and the existing changing-getter admission pins. The active manual Files save
consumers remain unchanged; ordinary Editor agent retirement does not retire manual saves.

This records a genuine unknown-input boundary, without changing product code, public exports,
parser machinery, authority or rule scopes. It grants no optional dictionary, typeof or
known-value argument adaptation, including the captured-version recheck. The existing public-parser
reader can structurally adapt its selected parameter while semantic proofs are pending; that is
not executed runtime qualification or permission to activate the currently inactive unknown-parameter
scope. Complete fresh qualification of all 66 records remains required independently.

### Manual Git diff and blame public admission (#3918)

Four existing Git diff/blame request and response parsers extend the cohort from 66 to 70 using
`public-parser` and only `anti-slop/no-unknown-parameters` parameter zero. One canonical named public
import supplies all four forwarding witnesses and their producer-owned `GitEditorParseResult<T>`
result types. Strict source/public/witness type pins and canonical public normative proofs preserve
original and nested identities, optional-path presence, caps and one-over refusals, ordered errors,
staged/worktree separation, physical sparse/inherited collection behavior, final changing-files
observations, blame privacy and throw-free getter handling. Existing source regression pins remain.

UI diff/blame response consumers and the server blame-request consumer retain their existing
owners; no active direct production caller is presumed for the symmetric diff-request parser.
ADR-0061 retirement does not retire manual Git reads. The four private unsafe parser inputs remain
separate raw boundaries. Registration adds no callback traversal, capability, export, authority,
logging port or scope change; it selects the four public unknown inputs only;
it supplies no optional dictionary, typeof or known-value grants. Actual reader eligibility and
fresh complete qualification remain mandatory. Existing public-parser structural adaptation while
proofs are pending does not establish runtime qualification or activate the inactive unknown-input
scope. This cohort does not establish domain zero or complete the remaining accepted-owner work.

The accompanying owning parser repair bounds inspection failures to fixed `TypeError`, `Error`, or
`unknown error` tags without observing thrown names, messages, stacks or prototype chains. A guarded
single immediate-prototype observation fails closed for hostile or revoked proxies. Its exact
reviewed classifier catch accepts only the literal generic fallback; the existing legacy
`parseSafely` catch entry is not enlarged. Additive canonical-public controls exercise all four
entries, while UI structured-diff/blame consumers use the existing parsed-response transport so
primitive, null, empty and object refusals retain their actual response correlation on the existing
contract-validation diagnostic. This runtime repair and the public-parser registration require
their own actual red/green, coverage and Activity Log evidence; registration alone supplies none.

### Command runner public admission (#3918)

Three existing command request, catalog and run-result parsers extend the cohort from 70 to 73
using `public-parser` and only `anti-slop/no-unknown-parameters` parameter zero. One canonical named
public import supplies three forwarding witnesses with producer-owned result aliases. Strict
source/public/witness type pins and canonical public proofs preserve original identities, optional
fields, observation order, timer and identifier bounds, ordered refusals, and physical sparse and
inherited collection behavior. Existing source regression pins remain authoritative.

Hostile property inspection returns one fixed closed refusal without inspecting the thrown value.
The three exact reviewed catches admit only that literal refusal; the legacy register is unchanged.
UI catalog and run-result admission uses the existing BFF validator transport and correlated client
diagnostic, including primitive, null and empty responses. A malformed run response never replays
execution. Activity Log scenarios carry both refusals through the existing ingest, writer and complete
support analysis. These are execution obligations, not evidence supplied merely by registration.
The existing raw-helper closure also accounts for the request parser's five private scalar predicates
(`isBoundedNonEmptyString`, `isBoundedControlFreeString`, `isValidTaskId`, `isPositiveSafeInteger`,
`isValidRequestId`). They receive raw request fields, are not exported or escaped, and have no callers
outside that admission chain. The actual request assessment has six unknown-parameter slots; catalog
and result each have one. Canonical public bound/refusal proofs detect a bypass of each helper while
original source controls remain healthy. This uses the existing helper-inclusive reader without
changing an engine capability or manufacturing a separate grant. No scopes, exports, authority,
logging ports or optional argument/dictionary/typeof grants change. Actual reader eligibility and fresh full-cohort
qualification remain required; source preparation does not activate the unknown-parameter scope.

### Seven Knowledge validator responsibilities (#3918)

Seven existing capsule, capsule-set, reindex, connector-graph, extraction-checkpoint, pod-summary and
retrieval-activity validators extend the declared cohort from 73 to 80 using the existing
`public-parser` kind and only `anti-slop/no-unknown-parameters` parameter zero. All earlier records,
rule scopes and proof selectors remain intact. This source declaration does not establish that the
seven records are structurally assessed or runtime-qualified; actual early owner-API assessment and
fresh complete-cohort qualification remain mandatory. Existing helper-inclusive closure may account
for additional private raw inputs, while cross-file, exported collector and unsupported roles remain
actual reader obligations. No optional typeof/dictionary/known-value grant or engine change is made.

Canonical public forwarding witnesses use the existing result generic with canonical public domain
types. Source and emitted public nominal brands have independent expected types; a source-domain
brand is not substituted for a public one. Strict unknown/result/nested-field pins and normative
identity/refusal proofs preserve the seven guarded representation casts. Concrete field admission
precedes those casts, which attach erased IDs without copying values or weakening brand separation.
Existing physical-member, sparse/inherited collection, optional-presence, endpoint reread, policy,
privacy, caps and nested identity assertions remain unchanged. No product code or public export is
changed, and this qualification-only addition does not invent a universal hostile-accessor promise.

The reindex route, Knowledge Pod projection/server revalidation, and grounded-answer/store admission
remain the active production consumers where they exist. Other validators retain their same-owner
canonical public API proof rather than claiming a fabricated store consumer. These contract proofs
do not by themselves certify physical SQLite persistence, product logging or final domain activation.

### Batched Workbench admission responsibilities (#3918)

Three existing Workbench authority-envelope, permission-request and runtime-event validators join the
seven Knowledge roots in one declared 83-record cohort. The existing `public-parser` kind selects
only each root's unknown parameter zero. All prior 73 records and the seven Knowledge records stay
intact; no optional rule, engine capability, authority or activation changes. All ten additions are
unassessed and unqualified until actual early owner-API assessment and one genuine full83 run. A
separate full80 result is neither required nor implied by batching.

One canonical static named validation import and public result/domain type imports from the existing
runtime Workbench owner support direct result-forwarding witnesses. Independent source expectations
and public root/nested pins preserve actual generic alias provenance. Existing dynamic public and
source tests remain unchanged, including physical arrays, identity, optional presence, eager error
order and calendar-date refusal. During artifact controls those old dynamic public cases must not
be mislabeled as independent source controls. No production runtime or public exports change.

### Prompt admission responsibilities (#3918)

Six existing request, analysis, grounding-plan, enhanced-prompt, scorecard and selection validators
extend the declared cohort from 83 to 89 using the existing `public-parser` kind and only
`anti-slop/no-unknown-parameters` parameter zero. All earlier records, fields, scopes and proof
selectors remain intact. Source preparation establishes neither actual structural eligibility nor
semantic qualification; the existing owner API and fresh complete-cohort qualification remain
mandatory. Helper-inclusive admission is assessed from actual source rather than presumed to have
one slot per root. No optional grant, engine, export or activation changes.

Canonical public result-forwarding witnesses use the existing public validation generic and
producer-owned DTOs. Source and public nominal brands retain independent expectations. Strict
unknown/result/nested-field pins and public identity/refusal proofs preserve physical members,
optional presence, eager diagnostics and changing healthy observations. Existing source and dynamic
public regression pins stay authoritative. Request workflow and analysis generator consumers remain
unchanged; the other four roots use real same-owner public API proofs without fabricated production
callers. No product runtime change or logging promise follows merely from registration.

Scorecard and selection retain the documented nonthrowing boundary repaired independently before
this registration: unreadable payloads return a fixed refusal without inspecting the thrown value.
Their original operation order, admitted identity and ordered ordinary errors remain authoritative.
This declaration grants no universal hostile-accessor promise to the other four validators and
changes no runtime behavior. The complete 129-record qualification on signed
`a97807bfb020a5300bbbd28714b266d37e236702` assessed and qualified these six Prompt roots; that
historical verdict does not qualify current source. Retained helper-closure refusals (limit 64,
attempt 65) can coexist with qualified roots, and their withheld helper slots remain unadmitted.
Fresh complete-cohort qualification remains mandatory on the final composed source.

## Context compaction diagnostic ownership

Seven compaction diagnostic validators use the existing `diagnostic-checker` role
with a closed `ContextValidationResult` envelope. Their canonical same-owner public
proofs count actual failure reasons through `result.ok ? 0 : result.reasons.length`;
there is no parsed value, new public export, or production behavior change.
The records retain their unknown-parameter-zero obligations, subject to actual capability
assessment and proof qualification. Source preparation alone does not establish
readiness, helper closure completion, activation, or a green 96-record inventory.

Only `context-compaction-record-diagnostic-public-proof` additionally declares
`anti-slop/no-runtime-typeof` and `anti-slop/no-unsafe-dictionary-type`; the other six records
remain unknown-only. The existing checker determines eligibility for exact raw-origin `typeof` operands;
dictionary eligibility is limited to intrinsic string/unknown members in supported boolean or
identifier-predicate checking helpers. Static eligibility does not replace the required fresh
semantic proof qualification. Exact raw-origin `typeof` checks within data-returning collectors can remain eligible. Dictionary
annotations in those collectors, typed `typeof` operands, unsupported callbacks and unqualified helper
references gain no exemption. All existing public diagnostic witnesses,
ordered-refusal proofs, raw-input obligations and unadapted findings remain authoritative;
neither declaration nor structural readiness activates a scope.

Production provenance remains distinct from these public API proof bindings:
`validateContextCompactionRecord` is used by `buildCompactionRecords` in workflows
and by server conversation compaction; `validateContextPreservedFact` is used by
`projectFacts` through its private projection. Other roots retain public API proof
consumers. Existing direct collector, callback, imported-helper and accumulator
limits remain authoritative; unsupported slots remain raw rather than gaining an
implicit family-wide exemption.

## Core Context and shaped-observation diagnostic ownership

Nine additional records reuse the existing closed-envelope `diagnostic-checker` role:
three core profile/budget/assembly validators and six shaped-observation validators.
Canonical same-owner public API witnesses count actual ordered failure reasons; strict
source/public unknown-input and readonly-reason pins preserve the closed success/failure
contract. The existing 96 records, scope activation, budgets and resolver semantics remain
unchanged. Source preparation is not a qualified 105-record inventory.

`validateContextBudget` also has the real `connected-context.ts` pack-diagnostic consumer,
whose absent/valid/invalid nested budget proofs remain intact. The other core roots and
observation roots use honest public API proof consumers; the observation dispatcher calls
its four same-file exported validators. No extra production caller is invented. The ordinary
boolean `isContextToolObservationKind` is neither a type predicate nor a diagnostic checker
and receives no record here. Existing UTF-8 excerpt/query byte caps, producer byte-count
cross-checks, optionals and ordered eager diagnostics remain authoritative.

No runtime validator or package export changes. Direct-only helper accounting, callback,
imported/exported helper and accumulator limits remain unchanged: actual assessment must
name unsupported slots rather than granting the entire family implicitly. Future strict
source/public declaration controls, unsafe-body malformed controls and genuine complete
cohort qualification remain required before readiness is claimed.

### Connected path and line-range validators (#3918)

Two existing `validator` records select unknown parameter0 of `isValidScopePath` and
`isValidLineRange` through the real value imports in workspace-search.ts from
`./connected-context.js`. Their real production consumer is the existing
`isWorkspaceSearchResultMatch` implementation: it directly calls both validators before
admitting a result. The consumer selector uses index.ts's existing type-only reference to
`./workspace-search.js` to resolve that production implementation. This is provenance through
a type-only barrel, not a runtime root export or a public-proof consumer binding.

Separate canonical runtime imports provide independent source/public parameter and boolean-result
pins, actual public primitive admission/refusal tests and public result-consumer controls. Path
options retain their defensive unsupported-mode refusal; line ranges retain inherited members and
single captured bound reads. All prior105 records, rule dispositions, scopes and proof selectors
remain intact. These two additional records still require default assessment, actual helper
accounting and fresh107-record qualification. Typed connected-context diagnostics and other
raw-helper obligations are not adapted by this registration.

### Existing Memory and Atlassian raw-checker rule declarations (#3918)

Twenty-three existing qualified public-parser records in the Memory/Atlassian family additionally
declare `anti-slop/no-runtime-typeof` and `anti-slop/no-unsafe-dictionary-type` alongside their
original unknown-parameter obligation. The two pin/unpin records retain unknown-only declarations
because their shared overloaded helper is outside the existing bounded checker. No record identity,
role, selector, proof, public signature, rule scope or registry count changes: the inventory remains107.

These declarations permit only the existing rawCheckingSlots filter, not whole-file coverage. A typeof operand must have a real raw origin and actual checker-unknown type. A dictionary
must be the canonical standard-library Record<string,unknown> annotation in a qualified boolean or
predicate checker; domain collectors, counterfeits, foreign/erased origins, already-narrowed operands,
unsupported callbacks and withheld closures remain unadmitted. Prompt's existing64/65 WITHHELD
helper evidence and every unrelated family remain unchanged.

The actual default-family assessment retains all 75 prior slot memberships and exposes 55 additional
distinct native coordinates: 52 dictionary annotations and three typeof guards. All 25 roots bind
ready with semantic proofs pending; this is structural eligibility, not complete-cohort qualification.
The new coordinates match the actual native scan of the six unchanged production owners. Existing
raw diagnostics outside those coordinates remain visible, and nine already-dictionary-enabled Memory
records gain no additional typeof slot. Pin/unpin remain unchanged.

Existing canonical nominal/result, physical-member, optional-presence and refusal pins are retained.
One additive public Jira malformed-truncated case strengthens the existing selector. Held canonical
emitted pinned/truncated guard controls each fail the owning public assertion while the same-field
source refusal and healthy anchors pass, then pass immediately after exact restoration. Existing
counterfeit, escape, erasure and domain-origin authority controls retain their independent native
refusals. These controls support the changed obligations without a per-root replay grid; the fresh
complete-cohort gate remains required. Actual Memory physical INSERT/UPDATE/persistence closure is
separate evidence.

### Existing Knowledge raw-checker rule declarations (#3918)

The nine existing Knowledge public-parser records additionally declare the raw-origin typeof and
canonical dictionary rules alongside their unknown-parameter obligation. This source-prepared
metadata change leaves all 107 identities, roles, selectors, proof bindings, scopes and runtime
behavior unchanged. It uses the existing bounded checker; declaration alone establishes neither
additional slot eligibility nor semantic qualification. Foreign/shared origins, exported or
escaping helpers, unsupported callbacks, already-narrowed operands and non-checker dictionaries
retain the existing exclusions. Actual default-family assessment and matching controls must
establish the additional slots and retained omissions before this candidate is qualified.

Existing nominal/public parser, original-reference, optional-presence, physical-member, eager
diagnostic and read-phase proofs remain unchanged. Matching historical evidence can be adopted
only with exact source/runtime/proof equivalence; contract parser qualification does not replace
physical persistence or complete integration evidence. No whole Knowledge or contracts scope is
activated by these declarations.

### Managed LSP existing public parser obligations (#3918)

Four source-prepared unknown-parameter-zero public-parser records bind the existing managed LSP
control request, response, mutation-response and runtime-configuration parsers to canonical public
checked-result witnesses in their existing contract test owners. They append to the prior107 records;
all prior identities, rule declarations, scopes and proofs remain intact. The prospective registry is111.
The witnesses use the real producer-owned result aliases and return the actual parser result; they
are public API proofs, not claims that the proof functions are production callers.

Existing production provenance is separate: the server settings route admits requests, the activation
store/control admit runtime configurations, and the UI's dedicated lazy response adapter admits
control and mutation envelopes. Source/public strict pins and normative identity/refusal proofs
retain authority ceilings, revision/ETag and language coverage, safe settings and read-phase
invariants. Existing physical-array and changing-getter pins remain authoritative.

No private callback helper, foreign parser, UnknownRecord alias or arbitrary dictionary is granted by
these records. The existing shared parseSafely callback separates the public roots from direct raw
helper traversal. Revision-ETag's two-unknown helper and typed settings/precondition APIs remain
outside this one-unknown public-parser registration. The bounded default assessment binds all four
roots ready with semantic proofs pending and admits exactly their four public unknown-parameter-zero
coordinates; no private callback helper or UnknownRecord obligation is included. The complete
source/public owners retain their healthy, refusal, physical-array and read-phase controls.

Four held canonical return-any declarations and two shared success-value erasures fail the strict
public type pins. Four held canonical JavaScript root bypasses fail the actual public admission or
fresh-copy assertions while the same-field source healthy/refusal anchors pass. Every held artifact
is restored exactly before the identical first positive control. These bounded results do not replace
fresh complete-cohort qualification or activate a rule scope. No product runtime or shared
throw-classification behavior is changed here.

### Workspace search and replace diagnostic proofs (#3918)

Four prospective diagnostic-checker records bind the existing search, symbol search, replace preview
and replace apply unknown-zero validators to canonical numeric public API proof witnesses. They
append after the independently prepared Managed LSP four-record overlay; that dependency must be
composed before this delta. All existing identities, rule lists, proof bindings and scopes remain
intact. The witnesses return only zero or the actual diagnostic reason count, not a parsed value.
Real server search/replace handlers remain separate production provenance with their retained
consumer tests. No runtime behavior, public signature, engine capability or scope changes here.

Source/public strict result and nested reason pins are independent; ordinary malformed tables pin
ordered closed reasons and actual numeric witness counts. Existing mode double-read/coercion,
relative-path, physical range and backward-edit regression tests remain authoritative. The bounded default
assessment binds all four roots ready with semantic proofs pending, with nine stored unknown-parameter
memberships across the four roots and five same-owner helpers. The collective assignment preserves
contributing IDs; private apply-file/edit traversal and query mode's second unknown parameter are not
claimed covered. No complete helper closure or active rule scope is inferred. Four canonical root
return-any declarations and one shared diagnostic-reasons erasure fail the strict public type pins.
Four canonical JavaScript success bypasses fail public refusal/count assertions while source positive
and refusal anchors pass; all artifacts are restored before identical first positive controls. Fresh
complete-cohort qualification remains mandatory. Raw typeof/dictionary obligations are not granted,
and no universal getter or throw-free behavior is asserted.

### Diagnostics ingress eligibility preparation (#3918)

Two source-prepared `validator` records select the existing diagnostic and binding ingest predicates
through the canonical `runtime/diagnostics` export and the actual exported server ingest handler.
They declare only `no-unknown-parameters`; the original111 records and every active scope remain
unchanged. The standalone prospective count is113; serialized integration must also preserve any
independently accepted cohort before deriving its final count.

The existing contract owner adds independent source/public predicate-target, raw-input and nested
field pins plus healthy identity and malformed admission controls. Existing server route proofs cover
registered restoration formatting and binding admission/refusal. These are real handler consumers,
not invented public-parser witnesses; formatter evidence is not a claim of physical disk persistence.

The two records use actual default eligibility and the existing semantic proof producer. No native
root-slot count or general helper coverage is inferred. In particular, the nine captured unknown
known-widening observations remain unchanged and unadapted. A possible later direct Offer2 precision
capability is separate; the exported Git terminal and optional restoration traversal are deferred,
not waived. No production validator, writer, logging, upstream plugin or rule scope changes accompany
this cohort. Its separate consumer-binding repair is described below.

The existing consumer binding indexes its owned source under the original node/source limits, then
selects the complete selected-root ancestry of actual canonical producer-call witnesses. It validates
all source references of included helpers, excludes outside callers and escapes, and applies the
unchanged64-state budget once to the union of contributing states, including the root. Target-unrelated
logging descendants consume no witness-state grant. Alias-hop, cycle, currentness and raw-checker
closure rules remain unchanged. This is a consumer-binding capability repair, not a native rule or
raw-slot applicability change; incomplete helpers never contribute their producer calls. The actual
short-witness regression first refused on the original engine, then passed unchanged after the repair.
Finite capacity, complete incoming-reference, escape, cycle and currentness controls preserve the
original refusal boundaries and regression pins. Both real ingress records then passed default
eligibility; their declared unknown-parameter slots are not native diagnostic counts.

The private fe68 qualification then completed both records through the existing default semantic
producer, with five selected assertions each and both complete proof-owner files executed in one
closed, drained child invocation. Independent canonical public predicate-target erasures and
always-true runtime controls failed their intended public proofs; source anchors remained healthy,
and exact restoration passed the same checks. The scoped tooling run passed874 cases with only the
five unchanged Linux-only fallback cases skipped on macOS; the existing new-code ruler covered all
52 new line/condition units. These are source-bound cohort results, not a complete integrated
repository qualification or a replacement for current-head CI.

### Existing seven Git parser raw-type checks (#3918)

The existing status, diff, history, summary, remotes, sync-preview and sync-execute public-parser
records additionally declare `anti-slop/no-runtime-typeof`. All prior identities, unknown-parameter
obligations, role/consumer bindings, proof selectors, registry count and active scopes are retained.
No dictionary declaration is added: the bounded default family comparison derived six additional
`typeof` coordinates and zero dictionary coordinates. The original sixteen stored unknown slots
remain deeply identical. All six additions match fresh native coordinates in the four unchanged
production owners; nineteen other raw `typeof` and forty-three dictionary observations remain
unaccounted by this family. Source/proof files, public types, exports and runtime behavior are unchanged.

The canonical summary boolean-guard counterfactual fails its public eager ordered-reasons assertion
at the malformed `available` field while source and healthy controls pass. The sync object-guard
counterfactual fails public preview/execute null-first primitive refusals while source and healthy
controls pass. Exact restoration precedes identical first positive controls. A reporter postcheck
that expected untruncated reason text was corrected using the actual assertion coordinate and
four-versus-five reason counts; it caused no negative replay or test relaxation. These controls
and the structural pending family assessment do not replace fresh integrated semantic qualification
or activate a rule scope. The remaining `Readonly<Record<...>>` and dynamic-array provenance limits
are not bypassed by this metadata change.

### Exact numeric JSON byte-measurement object form

Only an explicit public-parser `anti-slop/no-object-parameters` opt-in can expose this form. The
existing question answer, response and channel records retain every previous rule and proof, adding
aggregate-budget and pre-serialization phase assertions. No scope, responsibility kind, product
export, validator body, cap, logging port, upstream plugin or resource limit changes.

The collective resolver recognizes the closed private JSON.stringify → TextEncoder.encode → length
number-returning leaf, its bare Infinity fallback, original-container forwarder and deliberate
single-property answers envelope. It proves actual builtin declarations/signatures, unchanged
zero-error/read phase, numeric comparison/cap/refusal, complete incoming canonical roots and every
helper/parameter value reference. The answer envelope remains a distinct origin descriptor;
`rawOrigin` still refuses arbitrary object construction. The independent questions validation call
receives no new raw-helper grant after Array.isArray narrows that other parameter to any[].

The Node encoding bridge is exceptional only inside this exact recognizer: canonical installed Node
type resolution, lock/package identity, the reviewed declaration form and node:util binding establish
the sanctioned augmentation alongside actual DOM constructor/encode identities. Project, local or
foreign augmentation remains unsupported. Existing shared builtin identity checks are unchanged;
compiler source snapshots/currentness and proof tool identities still bind the result.

A recognized component exposes exactly two object annotation slots, with separate per-slot
contributors and complete three-root component identities. The forwarder depends on response and
channel; the leaf also depends on answer. An unsupported form atomically exposes neither object
slot and carries deterministic optional `objectForms` metadata: fixed form/status/reason/rule,
canonical owner/sourcePath and sorted requested responsibility ids. This is not the capacity-only
`helperClosures` contract and changes no root reasons, obligations or independently assessed legacy
slots. Currentness, unexpected exceptions, cycles and real capacity errors retain their original
throw/refusal behavior. Metadata survives semantic completion and serialization and is absent on
unaffected records.

Both collective dispatch and generic fallback require the complete nonempty, unique canonical
component, all relevant records ready and semantically qualified, and every exact declared proof
selector/path completed before adapting either numeric object finding. Pending, missing, rejected,
duplicate, foreign or incompletely proven components adapt zero such findings. Existing
raw-property-observation object slots retain their separate existing semantic-only behavior. No
metadata entry proves runtime coverage or authorizes activation; unmatched object observations stay
visible and other object-use forms remain unsupported. These selected source/read-phase proofs do
not assert a new contract for arbitrary JavaScript getters, proxies or toJSON behavior.

The private b8f3 cohort completed the actual default three-record semantic assessment, preserving
all prior slots and qualifying exactly the two additional object coordinates. The four complete
tooling owners passed 926 tests with five existing platform skips; the existing new-code ruler
passed at 86.8% across 963 new line and condition units. This is scoped coverage evidence, not the
full release coverage ratchet. Bypassing only the emitted byte counter failed all three public
aggregate refusals while the independent source anchor passed. Exact emitted-output restoration
preceded the same four positive controls; the four complete TypeScript owners then passed 166 tests.
An external result reader initially counted unselected skipped tests; its correction validated the
original negative result without replaying it. Source, native type, lint and formatting checks passed
on the restored candidate. Integrated repository qualification and current-head CI remain separate.
The earlier synthetic timeout and intermediate withheld results remain separate adverse history;
a later positive does not identify their cause or replace current-head CI.

### Optional owning raw-object and own-key observation

The existing support observation responsibility may explicitly declare `rawObjectInput: true`
and/or the singleton `additionalObservationForms: ["own-key-identity"]`. Absent options preserve
its original three Reflect.get facts. The root option adds only the canonical public validator's
required object input; it does not certify an event DTO, caller or helper graph. The own-key option
adds only both required object parameters of the exact private ownKeys/Set/strict-count/every/has
identity helper. All values, calls, signatures and references bind to current compiler identities;
foreign builtins, modified algorithms, escaped/ambiguous helpers or either unsupported opted form
refuse the complete responsibility. Both options reuse one bounded participating-call traversal,
unchanged budgets/currentness and the existing semantic-only adaptation gate. Raw observations
remain visible. These are responsibility-specific semantic qualifications, not blanket object grants.

The fifteen original selected assertions remain in order. Their inherited/hidden attachment and
public consumer tests add raw-refusal, own-key and separate source/public strict type evidence
without removing any old assertion. The sole sixteenth selector binds the existing public logger's
malformed raw metadata forwarding and real formatter mismatch. Both declared proof owners execute
whole; the complete server-log owner remains a separate mandatory physical gate. A declared proof
path requires its own selected assertion, and the selector cap remains16. Qualification and native
coordinate comparison on the actual candidate are required; metadata alone proves no runtime
coverage. The raw-carrier helper and every other object observation retain their obligations.

### Direct whole-event checker input composition

The same support responsibility may additionally opt into `directRawCheckerInputs: true`, only
with its existing validated actual raw-object boundary contract. The private checker flag does not
implicitly opt the root coordinate into adaptation. This admits parameters only for private,
directly called same-source checkers receiving the unchanged whole original input through bounded
unannotated immutable const aliases. The existing qualified observer is the only permitted use of
the selected receiver inside a checker. Complete incoming references and bounded receiver uses
exclude other public callers, escapes, property/call-result origins, casts, copies, typed aliases,
rebindings, callback captures and parameter initializers. Derived envelopes/field results, canonical arguments and void
remain legitimate and gain no output or other-parameter authority. No general purity/effect
analysis is asserted. Recursive/multi-root checker composition remains unsupported, rather than
silently dropping incoming contributors. Every attributed root requires its current binding and
complete exact executed proof assertions before a new checker slot adapts. Existing default slots,
numeric object forms, scopes, limits, sixteen selectors and physical gates remain unchanged.

The selected public consumer adds fresh-producer unknown-operation, category and envelope refusal
phases without dropping registration via spread. Existing C2 four-read source/public proofs remain;
a held cached-third-versus-fourth control is a later qualification obligation, not metadata evidence.
Raw carrier/registration parameters, shared readers/writers and final DTO authority remain pending.

A validator explicitly declaring `anti-slop/no-known-value-widening` may additionally account for a direct captured-unknown scalar predicate argument. The root must be the actual unknown-input Identifier predicate, and the direct const capture must originate from its already qualified raw helper's standard unknown-valued dictionary. Private same-source predicate reference closure is required; typed erasure, unchecked raw-return roots and unsupported references remain unadapted. These supplemental call slots require current semantic qualification and confer no new helper-parameter, return or writer authority. Legacy raw-helper facts and rule activation stay unchanged.

The captured traversal may follow the exact private, same-source, synchronous optional wrapper
`value === undefined || guard(value)` with two required identifier parameters and its actual
private unknown-input predicate argument. Canonical binding, export/reference/write closure,
cycles, budgets and source currentness remain checked. Mutable wrapper bindings remain unsupported.
This supplemental graph emits captured argument slots only, and only current qualified semantics
can adapt them; legacy raw facts and scope activation remain independent.

The existing `client-diagnostic-ingress-route-validator` record declares known-value rechecks for
this validated ingress. Its current eligibility has nine legacy unknown-input slots, four legacy
direct predicate-argument slots, and six captured restoration count/size argument slots. Only the
six captured arguments correspond to current native known-value findings; eligibility alone does
not remove a finding. The same two proof owners and five selectors preserve source/public identity,
refuse malformed restoration counts and sizes, and prove HTTP admission plus registered body-free
persistence. Coherent over-ceiling count cases detect a held emitted count-guard bypass at both the
public predicate and the actual HTTP route; the existing numeric-string size case detects a size
bypass. No additional wrapper/helper parameter, dictionary, typeof, return or writer grant follows.
The declaration does not activate the repository-wide known-value migration scope.

### Code Task acceptance raw dictionary declarations

The three existing Code Task acceptance public-parser responsibilities may additionally declare
`anti-slop/no-unsafe-dictionary-type` for actual raw `Record<string, unknown>` boolean-validation
parameters admitted by the existing bounded single-root and collective helper machinery. The
contribution, flow and manifest roots keep their existing public consumers, selected proofs and
roles. Each new adaptation still requires complete current qualified contributors and executed
proofs; declaration alone is not coverage. Exported readers and predicates, result-derived values,
external callers, unsupported references and non-boolean dictionary helpers gain no authority.
`no-runtime-typeof` is not declared by this metadata slice: checks on `ownField(...)` results are
outside the existing raw-origin grammar and remain observations requiring separate disposition.

### Optional owned object validators

A validator may opt into `rawObjectInput: true` only for its single exact public `object` input and
`anti-slop/no-object-parameters`, with an explicit optional named result owned by the producer.
The producer roles retain the same canonical identity and the real production consumer remains
bound. The tagged root slot requires completed selected public proofs before either adaptation
path can accept it. Legacy validators and observation options retain their existing behavior.

The public structural registration reader owns this optional-view boundary: a complete attachment
retains its identity while malformed or unreadable structure is refused. The real mandatory-event
consumer guards absence and catches unreadable attachment access. A structural view does not grant
canonical registration or persistence authority; the physical writer still revalidates separately.
This option grants neither private helper parameters nor call-result origins, descriptor transport,
or shared raw carriers. It is a proved boundary responsibility, not an implementation-body theorem.

The additional `ownedPredicateStage: true` opt-in is confined to this same raw-object validator
responsibility. After fresh qualification of the same six selected public/physical proofs and its
real mandatory-event consumer, it may add only the canonical private `completeRegistrationShape`
object input (1089:43), retaining the public `activityLogEventRegistration` root (1123:10).
The existing `rawObjectInput` option alone remains root-only. The stage proves the exact private
predicate/signature/reference relation; it is not a predicate-body or implementation-effect theorem.
The raw registration producer (992), predicate body and other nine object roles remain ungranted.
No typed-primitive, reflection, dictionary, widening, call-result, persistence or quota authority
follows. Declaration alone does not qualify either slot: current canonical/native correspondence,
the same bound consumer and completed parent proofs remain required.

### Workflow handoff request public admission

The `workflow-handoff-request-public-parser` responsibility binds only the unknown input of
`parseWorkflowHandoffRequest` to its canonical public result and the direct
`parsePublicHandoffWitness` proof. Its fifteen exact selected assertions cover source/public
identity, ordered diagnostics and eager reads, independent result and nested declarations,
shaped-token nonauthority, and all five physical array fields despite a replaced iterator.
The complete owning test file remains the proof owner. Shared admission helpers also serve the
legacy validators: this record does not confer helper, dictionary, runtime-typeof, token
verification, server-consumer, or workflow authority. The consumer migration remains separate.
Declaration is not coverage; default structural assessment, actual semantic proof execution and
current native correspondence must succeed before this boundary adapts a finding.

### Public raw metadata sources

The closed `metadataSourceInput` option belongs only to a `raw-property-observation`
record with the object-input rule, source parameter zero and one explicit companion consumer.
Its exported signature takes an exact `object` source plus a caller-owned `Target extends object`,
and returns that same target type. This signature fact grants only the source annotation; it does
not certify either object, helper inputs, returned raw fields or descriptor writes. Both adaptation
paths require the record's selected semantic proofs to complete.

The two declared exported consumers are resolved in the production context, not as test-proof
wrappers. They must belong to the same production owner and source and both reach the actual
producer through the existing bounded consumer graph. The companion seeds the
second root; all helper incoming-reference, escape, cycle, ownership and currentness checks remain.
This is a closed pair, not factory/callback reachability or a general multi-consumer declaration.
Legacy raw-observation options and records retain their existing behavior.

`copyActivityLogEventMetadata` preserves raw registration and closed refusal markers through the
real correlation rebind APIs. Its direct public proof retains the supplied target, hidden immutable
marker and malformed raw identity; existing logger proofs retain closed rejection and the real
formatter's final mismatch. Structural observation and transport grant no canonical write authority.

### Voice control structural validation

The `voice-control-structural-validation` validator responsibility binds only the unknown input
of `validateVoiceControlMessage` to its existing closed diagnostic result and actual exported
`isVoiceControlMessage` consumer through the real package-index reexport. The browser negotiation
decoder calls that guard, and the two browser clients consume its narrower typed result; this
transitive use does not replace the direct guard-consumer binding. Selected source/public proofs
preserve healthy decoder identity, refuse a missing required error code, retain the current-kind
read schedule, and retain optional error-correlation copying. The complete Voice protocol test
file remains the proof owner. No private helper, dictionary, runtime-typeof, decoder-input,
transport or Twin authority is granted. Declaration alone is not coverage: current native
correspondence and completed semantic qualification are required for this exact boundary.

### Recap version validation into the existing audit consumer

The `voice-recap-version-audit-validator` responsibility binds only the unknown version input
of `isVoiceSessionRecapSchemaVersionSupported` to its actual
`validateVoiceSessionRecapAuditRecord` consumer. The index module reference is a canonical symbol
anchor; its type-only export is not a runtime root-index value. Source/public proofs use the
existing `runtime/voice-session-recap` entry and distinguish supported string versions "1" and "2"
from unsupported "3" and numeric 2. The audit consumer retains exact schema refusal, healthy and
user-triggered controls, nonmutating true legacy omission, and current-v2 required-count refusal.
The whole recap test file remains the proof owner. Audit-input, dictionary, runtime-typeof,
normalization and private-helper slots gain no authority. The retained recap route remains dormant
without a current UI caller under ADR-0109/ADR-0154. Declaration is not coverage: actual canonical
binding, native correspondence and completed selected proofs remain required.

### Optional owned refusal-marker pair

The existing metadata-source responsibility may explicitly opt into `ownedMarkerPair: true`.
The finite same-source relation derives the copier's canonical private refusal reader and
writer, their shared private symbol key, the writer's immutable hidden descriptor, and the
reader's existing owned finite-kind guard. It adds only those two `object` input parameters
alongside the unchanged raw copier source slot. Direct callers are reference-accounted, including
parameter initializers; their parameters, bodies and results receive no additional authority.

The `support-public-raw-metadata-source` record retains its actual two correlation consumers and
all six selected public proofs. Both adaptation paths require this same parent to be structurally
ready, semantically qualified, consumer-bound and current, with every selected proof completed.
Default behavior and all other records, rules, scopes, caps and physical writer admission stay
unchanged. No producer, raw-carrier, scalar, return, reflection, dictionary, runtime-typeof or
known-value grant follows. Fresh measured native correspondence is required before this optional
pair can account for the actual marker inputs; declaration alone is not qualification.

### Optional owned raw-registration transport

The existing metadata-source responsibility may additionally opt into
`ownedRegistrationTransport: true`. The finite relation derives the copier's actual raw reader
and descriptor writer, their shared canonical registration symbol, the reader's same-reference
non-null object return and the writer's guarded immutable hidden descriptor. It accounts only for
the reader's first input and the writer's two object inputs. The existing copier source and optional
refusal-marker pair remain unchanged; payload structure, function bodies, results and physical
write admission receive no authority.

The same parent retains its actual two correlation consumers and all six selected public proofs.
Source and public copy proofs require reference identity for both healthy and malformed hidden
registration payloads. The existing logger formatter still refuses malformed registration, and the
physical writer independently validates canonical admission. Both adaptation paths require this
same parent to be current, consumer-bound and semantically qualified with every selected proof
completed. Record order, other flags, rules, scopes, caps and default behavior stay unchanged.
Declaration alone is not qualification; fresh native correspondence and completed proofs are
required before this optional transport accounts for actual input annotations.

### Coding repository request admission and capture

The `coding-repository-request-capture-validator` responsibility connects the existing
`isCodingRepositoryRequest` guard to its actual same-owner `captureCodingRepositoryRequest`
consumer. Its module selector uses the workspace implementation's real public runtime import;
the contracts root index does not reexport these functions. Source and public runtime proofs
cover malformed and accessor-bearing refusal before capture, bounded read/search capture,
freezing and isolation from caller-owned glob arrays. Capture precedes the existing server,
IPC and workspace processing; it confers no filesystem or execution authority.

Only the ordinary unknown-input rule is declared. The guard's type-predicate input is not a
native finding in the retained census. Its direct private query-check inputs are prospective
native matches and require fresh measured helper closure, current source/proof binding and
completed semantic qualification. The capture input and shared or unsupported helpers are not
additional roots. No dictionary, runtime-typeof, known-value, object or output authority is
implied; remaining rule scopes and owner obligations stay unchanged.

### Original raw registration in physical comparison

The existing `directRawCheckerInputs` observation form also recognizes the physical validator's
closed original-attachment comparison. It reuses the canonical registration reader's unchanged
nonnull-object/undefined result, matching registration key and immutable descriptor writer. The
root must retain the original reader result in one immutable local, refuse its undefined value,
and forward that same object through the private physical check and its canonical comparison.
Only the two raw attachment input annotations are accounted; the original whole-event form and
all existing slots remain unchanged.

Complete callable and receiver references, owned canonical type identity, original read order,
resource bounds and currentness remain mandatory. Copies, casts, mutable aliases, default
initializers, outside callers, callback or persistence escapes, and alternate keys do not gain
this form. No general call-result origin, helper body, return value, canonical DTO, cheap loss
pre-count or writer authority follows. Both adaptation paths still require the same physical
parent's current completed source/public/real-formatter proof obligations and bound consumer.

### Command request raw dictionary checks

The existing `command-request-public-parser` also declares the dictionary rule for the unchanged
raw request-checking phase. The private required-field and optional-field predicates inspect the
original request; their canonical `Record<string, unknown>` input and predicate-member annotations
remain raw until the existing parser admits the checked request. Qualification must preserve the
original unknown slots, public request identity, optional reads, closed field refusals and hostile
inspection failure proofs. No result declaration, helper alias, runtime-typeof authority,
new record or trusted arbitrary dictionary follows.

### Command catalog raw dictionary checks

The existing `command-catalog-public-parser` also declares the dictionary rule for its unchanged
raw catalog-checking phase. Its private catalog-field and task-array predicates inspect the
original catalog before admission. Only canonical raw input and predicate-member annotations
supported by the existing resolver are eligible; the existing source/public identity, repeated
task observations, malformed field, physical-array and hostile-inspection proofs remain required.
Nested task/argument helpers, shared run-result validators and raw event payloads receive no
additional authority. The original unknown slot and all six selected catalog proofs remain.

### Raw marker loss pre-count observation

An existing raw-property observation may declare only `no-object-parameters` together with
`rawObjectInput: true` for one exported non-generic object-to-boolean observation. The existing
canonical private property reader must be reached and validated; only the public root parameter
is a slot. No reader/helper input, return, reflection, dictionary or admission authority follows.
The exact public forwarding proof and every selected owning proof must complete on the same
current parent before adaptation; legacy observation rules and defaults remain unchanged.

`activityLogEventWillBeRejected` observes the refusal marker or absent raw registration so the
logger can count loss before handing an event to the sink. False is not certification: malformed
present metadata keeps its zero pre-count and remains subject to the final formatter refusal.
The record's consumer is honestly the public proof forwarder. The real `writeCounted` caller is
inside the factory's returned logger closure and is not statically bound by the existing consumer
graph. Its source/public logger counter, metadata identity and real formatter proofs remain
separate selected obligations, including healthy zero, malformed-present zero and genuine-refusal
one. Source/public marker ordering and unreadable receiver behavior also remain required.
This adds no scope activation, record-type waiver, generic factory/callback analysis or product API.

### Contracts object-input activation

The complete contracts production scope now enforces `anti-slop/no-object-parameters`, including
future and generated production members and its production-classified `vitest.config.ts`. Tests and
foreign owners retain their existing scopes. The current 244-member qualification accounts for all
21 raw object-input coordinates through their exact owning responsibility and executed proofs; a raw
observation is not an unsafe DTO or a blanket exception. Unmatched new inputs remain violations,
and missing, stale or failed semantic proofs cannot admit registered coordinates. The factory-owned
logger caller remains statically unbound; its runtime counter and physical formatter proofs retain
their separate obligations.

This activates only the object-input rule. Runtime-typeof, unknown-input, unsafe-dictionary and
known-value-widening migration scopes, the remaining accepted owners and whole #3918 are incomplete.

### Auxiliary request and outcome raw dictionary checks

The existing `auxiliary-capability-request-public-parser` and
`auxiliary-capability-outcome-public-parser` also declare the dictionary rule for their
unchanged private, same-owner raw `Record<string, unknown>` boolean checks. The existing
bounded helper/reference/currentness machinery and current semantic qualification decide each
actual slot; this grants neither a trusted dictionary result nor admission authority to a helper.
All fifteen existing selectors remain, including changing-discriminator, exact diagnostic,
identity and checked-return controls. The selected source/public request proof additionally
refuses an absent task identifier and an invalid parent state revision; those authority fields
remain checked before any consumer can receive the original validated request.

No root, record, runtime-typeof rule, call-result origin, shared scalar helper, factory binding,
public API, runtime body, authority, rule scope or capacity limit is added. Real skill, facade
and child-orchestrator consumers retain their separate physical proof obligations. Declaration
alone is not qualification or evidence of a native-slot delta.

### Run-control and runtime governance raw dictionary checks

The existing snapshot, governance request and governance outcome public-parser records also
declare the dictionary rule for their original raw-record boolean checks. Canonical raw argument
flow, complete incoming references, current contributing proofs and existing limits determine
each actual slot. This grants no dictionary result, helper admission or governance authority;
unknown-input declarations, physical member checks and repeated-read refusals remain intact.

## Memory initial-admission correlation proof (#3918)

The initial Memory record gate owns `memory-vault.write.rejected`. The four existing mutation
methods carry an optional per-invocation context; real request, maintenance-pass, salience-turn and
workflow-run ids reach the registered domain port without mutating singleton dependency state.
Buffered, streamed and grounded capture preserve a known request id even without `clientTurnId`.

Whole vault/caller proofs exercise real producers and inspect the actual mutation arguments.
The Activity Log scenario drives the real initial rejection through the registered writer, queries
each invocation with zero optional context and reaches validated support analysis. Its closed
fields distinguish initial invalid-record refusal from a foreign observational exception; selective
transport failure remains explicit loss. Existing healthy, rollback and identity pins remain in the
whole owners. Generated registries and failure inventory must be regenerated and checked together.

The physical post-redaction boundary captures owned fixed-schema values and validates the actual
captured projection before encoding, encryption or SQL. SQL, returned records and success events
share that admitted snapshot. The whole current vault proof retains the four actual400 regression
additions and unchanged row/no-success/reopen controls; serializer, batch/graph rollback, hook,
audit-consumer and cipher/SQL separation proofs own the rest of the invariant.

`memory-vault.write.rejected` distinguishes caller-admission from physical-admission canonical
invalidity. Technical capture failures use the separate existing-port
`memory-vault.write.capture-failed` and exact `memory-write-capture` class. The real process evidence
capability is optional: unavailable evidence is explicitly partial with loss none when retained;
unknown correlation remains degraded, and transport loss follows the existing ledger and fallback.
Whole registered writer/query/report/analyzer proofs retain zero optional context and require honest
complete/degraded/loss outcomes. The five generated outputs require canonical regeneration and a
rebuild. Source proposal, proof authorship and a scope allowance are not runtime qualification or
whole-gate clearance; actual Original/SAME and all applicable gates remain required.

The existing three context-core and four shaped-observation diagnostic responsibilities also
declare `no-runtime-typeof` for their actual raw checking. Current structural assessment identifies
16 additional native-matched coordinates: nine belong to assembly admission (including eight
helper checks jointly owned by the core roots), and seven belong to command, test, search and
browser diagnostic admission. The profile and budget roots contribute the helper admission
contract; their own direct slot sets do not grow. Tool rehydration and tool observation retain
their existing rule declarations. All 129 responsibility identities, original slots and proof
selectors remain unchanged. Structural readiness permits these diagnostic slots to adapt under
the existing checker. Combined canonical clearance still requires the complete core and observation
proof owners and fresh semantic qualification. Dictionary checks, native census and scope activation
retain their existing contracts.

### Runtime commands and readiness parser responsibilities (#3918)

Four public-parser records describe existing typed boundaries in
`coding-workbench-runtime-api.ts`; each declares only `anti-slop/no-unknown-parameters`.

| Responsibility                            | Public parser                                          | Direct unknown-input coordinate |
| ----------------------------------------- | ------------------------------------------------------ | ------------------------------- |
| `runtime-command-request-public-parser`   | `parseCodingWorkbenchCommandRequest`                   | 276:10                          |
| `runtime-commands-channel-public-parser`  | `validateCodingWorkbenchRuntimeCommandsChannelPayload` | 544:10                          |
| `runtime-readiness-request-public-parser` | `parseCodingWorkbenchRuntimeReadinessRequest`          | 1685:10                         |
| `runtime-readiness-public-parser`         | `validateCodingWorkbenchRuntimeReadiness`              | 2237:10                         |

The owning test invokes the real `runtime/coding-workbench-runtime-api` public subpath through
four fixed typed proof consumers. Root-index type exports do not authorize runtime values.
Selected proofs retain identity, optional-property ownership, closed malformed-input diagnostics,
physical listing validation, authority narrowing, availability evidence, observed getter failures
and distinct typed success/failure arms. Existing API and real route/browser consumer obligations
remain intact; no product implementation, public export or behavior changes.

These declarations target four direct unknown-input obligations, not the entire runtime API
backlog. The command-name guard's runtime-typeof coordinate at 263:10 remains unmapped; other
helpers and remaining findings receive no blanket admission. Existing bounded canonical graph,
currentness, exact consumer and executed-proof checks decide any additional actual helper slots.
All four migration activation scopes remain empty. Source declarations and authored proofs alone
do not establish qualified-slot counts, a runtime membership total or whole-gate clearance; those
require fresh complete semantic qualification against the current source and emitted outputs.

### Exact conversation-consumer fixture classification

The existing exact test-infrastructure set also lists
`packages/keiko-server/src/tool-catalog/__fixtures__/conversationConsumer.ts`. Its current
callers are test owners; this exact entry prevents a dormant fixture's imported buffered test-log
helper from becoming a production root. Nearby unregistered source paths retain their package's
production classification. No directory-wide fixture exclusion or root-helper production owner
is added: every file remains in the complete source census with its current byte identity.

Real runtime imports and public exports still promote the registered fixture to its server
package owner. A promoted chain reaching unsupported root test infrastructure remains refused;
healthy promoted fixtures keep their existing production obligations. Exact classification,
complete dormant membership/hashes and both promotion paths require regression proof. This
classification repair does not establish semantic qualification, activate a migration scope,
change a resource limit or close remaining Chat/MCP/runtime API findings.

The actual-workspace regression compares the complete sorted inventory package-name list
with the existing workspace graph producer and requires unique inventory names. This replaces
the obsolete twenty-seven-package count with exact current membership; a missing, duplicate or
extra workspace cannot pass, and future legitimate packages do not require a fixed count ceiling.
