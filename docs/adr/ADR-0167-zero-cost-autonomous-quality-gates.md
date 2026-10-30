# ADR-0167: Zero-cost autonomous quality gates

## Status

Accepted and amended. ADR-0169 supersedes every active CodSpeed and Greptile provision as of
2026-08-02. The Qodo/KFQ retirement, deterministic OSS gates, Sonar independence, and zero-payment
boundary remain current.

Accepted (owner decision, 2026-08-01). PR #2878 completed the D5 negative-and-recovery proof before
the App-bound CodSpeed and temporary Greptile settlement contexts were promoted. Greptile later
exhausted its 50-credit trial on an exact canary head, so its contexts, App installation, and
repository integration were removed. Native CodSpeed performance comparison then produced large,
different regressions on two heads with unchanged benchmark inputs because shared-runner provenance
varied; it became advisory while the exact-head `CodSpeed policy` validator remained required.
Repository-owned gates and advisory reviewer configuration took effect with the original change.
ADR-0168 later supersedes the Greptile retirement state and CodeRabbit request-changes setting while
leaving this decision's Qodo/KFQ retirement, deterministic gates, and zero-payment boundary intact.

## Supersedes and amends

This decision supersedes ADR-0142 and ADR-0143, retires their execution artifacts, amends ADR-0135's
review-product and required-check descriptions, and amends ADR-0166's advisory-only staging state.
It does not weaken ADR-0135's exact-head, no-bypass, bounded-runtime, app-identity, or native
auto-merge invariants. ADR-0131 remains the authority for Sonar enforcement.

## Context

Keiko is developed by autonomous agents and therefore needs a higher deterministic bar than a
human-paced repository without turning every pull request into a multi-hour queue. The former Qodo
review stopped producing evidence after its trial, and its free OSS program required a popularity
floor Keiko did not meet. Its repository-owned aggregate had no independent quality signal; it only
converted that unavailable comment into a check. Retaining either component would make vendor
eligibility, not candidate quality, the merge decision.

Hosted review products also are not open-source software simply because public repositories receive
a free entitlement. They may supply independent supplemental evidence, but the durable gate must be
free, repository-owned, and reproducible with open-source tools.

## Decision

### D1 — Retire the unavailable review bridge without weakening Sonar

Remove the Qodo configuration, validator, review policy, application workflow, evaluator, worker,
deployment template, tests, mutation scope, and operational runbooks. Remove the corresponding
required context only in the atomic branch-protection cutover described by D5.

Sonar remains independently enforced twice: the app-bound native check and the repository-owned PR
evidence validator. Both continue to require the exact current head, a passing native gate, zero
unresolved pull-request issues, zero new violations, at least 85% new-code coverage, at most 3%
new-code duplication, A ratings, and 100% hotspot review. Issue #2874 owns a supported migration to
the free OSS plan and a synchronized reduction of duplication to 1%; deletion/recreation and an
intermediate check gap are prohibited.

### D2 — Keep quota-paced CodeRabbit evidence advisory

This subsection records the original rollout state. ADR-0168 now enables request-changes settlement
for emitted findings while keeping CodeRabbit's quota-dependent status outside branch protection.

CodeRabbit runs the assertive profile on every ready pull-request update, including bot authors. Its
repository policy keeps all code-writing and merge features disabled. Findings are repaired and
actual review conversations remain subject to conversation resolution.

Live PR #2876 proved that the Pro Plus trial can exhaust its review limit and then publish a success
status without reviewing the current head. The billing UI also records a scheduled downgrade to the
Free tier on 2026-08-02. That evidence fails D5's no-quota-pacing and exact-head requirements.
CodeRabbit's status and native review rule are therefore removed from branch protection; its
request-changes and status emission are disabled in `.coderabbit.yaml`. It remains advisory and may
be reconsidered only after a later live probe proves durable zero-cost, fail-closed review delivery.

### D3 — Add zero-tolerance OSS gates for semantic clones and secrets

Fallow 3.35.0 is exact-version locked. The repository command uses its native audit attribution
against the immutable comparison commit and rejects every introduced semantic clone group of at
least 100 tokens and 10 lines. The public `--changed-since` argument resolves once; the analyzer
receives that immutable commit through explicit `--base`, so automatic merged-default-branch
attribution cannot change the accepted comparison. For #3918, the accepted comparison remains the
immutable 8c710 base. A closed configuration preserves semantic mode, those floors, a minimum of two
occurrences and import exclusion. It disables default generated-framework ignores, supplies no path
or clone exclusions, and keeps string literal values significant through
`duplicates.normalization.ignoreStringValues: false`; identifier and numeric-value normalization
retain the exact pinned analyzer's semantic-mode behavior. Ignoring imports avoids punishing required
module boilerplate, and semantic normalization still detects renamed-variable and numeric-varied
copies with matching string values. Unrelated literal maps for MIME types, journey phases and exact
failure-path exemptions must not be merged into one abstraction merely because their pair syntax
matches. This choice also means copies that differ in string values may no longer match: it trades
that detection class for preserving domain-significant literals. It is a repository-wide detector
policy, not a path or finding exemption. The native report retains inherited classification, and
adding another matching copy still fails.

The command explicitly evaluates the native introduced-group count. Neither the old 3.9.1
standalone command's successful exit nor audit's default warning exit proves zero introduced
groups. A failed analyzer, invalid report or unresolved comparison fails the repository command;
there is no percentage workaround or acknowledgement path. Supported native token-equivalent base
reuse remains valid; unavailable or invalid comparison evidence does not.

The incoming `docs/qa/fallow/dupes-baseline.json` is retained as a historical artifact from a different
coverage and normalization policy. Its location keys and fingerprints do not certify compatibility
with this strict configuration. It neither suppresses the mandatory audit nor creates an additional
acceptance veto from unmatched or stale historical keys. No generated, i18n or manually named owner
is exempted. Native baseline reporting, key-growth checks and `baselines prune` remain available
maintenance capabilities, proven on fixture-owned same-configuration baselines. The historical
production artifact is not automatically pruned, re-seeded or expanded under this different ruler;
configuration or normalization mismatch is not evidence that a clone was repaired. In particular,
matching a baseline cannot rescue an introduced clone, and equal group counts do not authorize
replacing one held identity with another.

Gitleaks 8.30.1 runs from an official checksum-pinned release binary, never from the non-OSS hosted
action. It redacts all finding output and scans the complete pull-request commit range. That range
covers every candidate addition and also catches credentials that were committed and then deleted.

Both jobs run in parallel and feed the existing required `ci` context. Missing or skipped job
results fail the aggregate. No waiver or acknowledgement path exists.

### D4 — Keep depth outside the fast path and strict proxies inside it

The pull-request path keeps strict type/lint/format, architecture and contracts, affected functional
and end-to-end tests, sharded coverage, Sonar, dependency and supply-chain scanning, Socket,
semantic duplication, secret scanning, and deterministic performance/bundle proxies. Full security
mutation, extended end-to-end, and reference-machine performance measurement remain scheduled or
release-owned. This preserves their depth without making multi-hour or hardware-sensitive work a
per-PR availability dependency.

The repository source-policy resolver's collective raw-helper capability includes bounded,
same-owner private modules (#3918). Only direct uniquely resolved named relative value imports
and supported immutable aliases join actual canonical helper-connected roots, including one root.
Complete owned production static membership supplies relevant import/reference facts; actual public
root/subpath and named/star/default/namespace exposure denies a private loan. Closed `types` plus
`import` and `types` plus `default` targets are recognized by that private exposure walk without
changing public-proof qualification. Concrete helper-linked dynamic/computed dispatch, foreign or
unregistered callers and observed escapes withhold helper slots. A relevant foreign incoming reference
already supplies that rejection, so the resolver checks its existing owner predicate before broader
public-exposure work. It caches only the unsupported-reference fact, never a public or private
classification. The complete graph, downstream denial, root slots, all-input currentness and
subsequent explicit source charging remain unchanged. Without this conclusive rejection, the
existing public-producer proof and complete reachability fallback remain authoritative.
For an already reached barrel, complete named-value incoming bindings are checked against that
module's current canonical exports before compiling its consumer. Only conclusively unrelated
bindings with the existing qualified declaration/map and guarded current runtime-output binding
skip that consumer walk; actual helper aliases, namespaces, missing symbols, defaults
and uncertain forms retain conservative traversal or the existing fault. Prepared and fallback
metadata use the existing unknown binding shape for default clauses, including mixed defaults;
semantic named-default values remain conservative. No new metadata field or cache is added.
Global incoming-call and downstream denial, complete graph states and all existing limits remain.
Unrelated unresolved runtime loaders
remain a disclosed static-analysis limitation, not certified consumers or a universal refusal.
Topology validation is deferred to canonical helper-export reachability and relevant manifest entry
targets; an unrelated workspace's absent `exports` is not a global refusal. Relevant packages without
`exports` retain Node main/default-index and public-subpath exposure, rather than becoming private.
No-exports ancestor relevance includes physically contained qualified helper runtime outputs;
a nested package's closed exports and the ancestor's `private` metadata do not seal those ancestor
subpaths. A closed ancestor export map does. This is known Node topology, not a general loader model.
Colocated type-only references are not runtime callers, and direct named type-only reexports retain
their value-visibility flags before canonical private-exposure resolution. A named import of `default` remains an
unsupported default edge, rather than an ordinary named-helper alias.
The connected private-helper graph has a separate, finite discovered-state ceiling of 256 only
for a component containing multiple distinct canonical roots. Every root must first complete its
current individual discovery within 64 states, including that root; a refused or incomplete
discovery cannot authorize the larger union. The module-owned discovery owner verifies the complete
connected root set. Cached and uncached successful discovery have the same requirements. Duplicate
record aliases and disconnected request lists do not acquire the larger ceiling. Public and
ineligible states still count; they are never pruned to make a component fit. Request/root
cardinality, individual discovery, alias and depth bounds remain 64. Numeric, captured and
consumer-binding analysis retain their existing bounds. An oversized union withholds its entire
helper group, retaining independently valid legacy root slots and every unmatched native finding.

The cumulative 96 MiB source, 5-million-node, two-retained-Program and existing emission/proof
budgets, currentness checks and independently valid root slots remain authoritative. The source
ceiling was 64 MiB until an owner decision on 2026-10-30 raised it: a whole-repository
qualification measured 65.8 MiB of admitted source across 5,877 files (production programs,
prepared-receipt digest verification and declaration-map provenance), each read once and each
carrying a currentness or provenance guarantee, so no guard could be dropped to fit. The ceiling
remains a finite resource bound, not an acceptance threshold; its refusal stays sticky and
fail-closed. The mandatory inventory syntax visitors provide detached private
module facts through a frozen, privately witnessed source/configuration/ownership/membership/output
receipt. Added traversal uses the same unchanged checked visit ruler before compiler creation;
each independent compiler seeds that actual preparation cost once and continues the same counter.
Source admission and canonical dual-mode resolution remain compiler-owned. Incompatible alias
profiles use charged extraction; failed or stale receipts grant no private loan. Public inventory
and record contracts remain unchanged. This is structural applicability with pending semantics; the
existing whole qualification route alone establishes runtime proof success. It adds no per-slot
runtime gate, record kind, generic trusted output, rule scope or product runtime behavior. The exact
source contract and discriminating whole-owner proofs live in the existing
[code-quality policy](../qa/code-quality-policy.md).

The original rollout used CPU simulation with a 5% dashboard threshold and later made the native
comparison advisory after shared-runner provenance produced false regressions. ADR-0169 supersedes
that complete provider-specific design: the benchmark workflow, dashboard policy, validator,
configuration, and required context are removed. Required D12 evidence integrity, bundle budgets,
retrieval latency, and end-to-end performance gates remain repository-owned.

### D5 — External checks enter branch protection only through an atomic live cutover

A hosted producer may become an app-bound required status only after one live pull request proves:
exact current-head emission, two successive updates, a deliberate negative case, repaired success,
stable name and App ID, bounded settlement, and durable zero-cost continuity without quota pacing.
A status that reports success after omitting review fails promotion. A measurement status that fails
unchanged inputs because execution provenance changed also fails promotion. The cutover removes
retired contexts and adds only proven checks in one branch-protection update; no same-named unbound
context is accepted.

By explicit owner decision, Greptile was temporarily required during its no-payment trial after the
technical probes passed. That activation was time-bounded, not continuity proof. When the provider
omitted final-head review after the trial account reached its 50-credit cap, the base-owned
settlement failed closed and the rollback ran early: both contexts were removed, the App was
uninstalled, and the repository integration was retired. A future activation requires an active,
durable zero-cost entitlement plus a new live canary. No pending application, generic approval,
payment method, star purchase, fabricated popularity, admin bypass, finding dismissal, or threshold
relaxation is an accepted continuity mechanism.

ADR-0168 temporarily superseded the rollback's installation state and restored Greptile as a
quota-tolerant reviewer. ADR-0169 supersedes that later state as well: the provider, App,
configuration, and review authority are fully retired.

## Consequences

- A stopped review subscription can no longer deadlock or falsely satisfy Keiko's core quality bar.
- New semantic copies and secrets are blocked by fast, reproducible OSS tools.
- Hosted automated review is advisory unless a future producer proves durable, fail-closed,
  zero-cost exact-head evidence; deterministic findings remain blocking in repository-owned gates.
- CodSpeed and Greptile no longer participate in delivery; deterministic performance and review
  settlement gates retain merge authority.
- The longest deterministic jobs still dominate pull-request latency; the new gates run alongside
  them instead of serially extending the path.
- Hosted services remain replaceable supplemental producers and are represented honestly as such.

## References

- [Autonomous quality gates](../qa/autonomous-quality-gates.md)
- [External quality-gate runbook](../qa/external-quality-gates.md)
- [Review standards](../qa/review-standards.md)
- [CodSpeed benchmark variance](https://codspeed.io/docs/instruments/cpu/regression-causes)
- [Quality-gate implementation Issue #2875](https://github.com/oscharko-dev/Keiko/issues/2875)
- [Sonar OSS migration Issue #2874](https://github.com/oscharko-dev/Keiko/issues/2874)
