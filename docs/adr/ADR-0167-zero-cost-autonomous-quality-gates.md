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

Fallow 3.34.0 is exact-version locked and runs semantic duplicate analysis only over the changed
surface. Any introduced semantic clone group of at least 100 tokens and 10 lines fails. Ignoring
imports avoids punishing required module boilerplate while still detecting renamed-variable and
restructured copy/paste that text-only duplication misses.

The 2026-10-24 security repair raises the original 3.9.1 pin to 3.34.0 for
GHSA-h4fr-cmh5-qr62 and GHSA-jfwm-3p3c-6hx5. The command, token/line floors and zero-issue
requirement are unchanged. Newly exposed inherited clones remain gate failures until resolved;
the upgrade grants no baseline exemption or suppression authority.

**Amendment, 2026-11-01 (owner decision, epic #3914).** The gate compares each pull request with its
base commit (`fallow audit --only dupes --gate new-only --base <base>`). A clone group that already
exists at the base is inherited. Any group that the change creates is introduced and fails the
gate. String literals stay part of the comparison (`ignoreStringValues: false`), so two
registrations that differ only in their op names, owners or proof ids are not clones. No source
family is excluded: generated files, i18n catalogs and the failure-class tables are measured like
any other source. The shrink-only `docs/qa/fallow/dupes-baseline.json` from 2026-10-24 and its
helpers are removed; the base comparison replaces them. `.fallowrc.json` must equal the
configuration the gate pins, or the gate fails. On failure the gate names each introduced group's
`file:start-end` locations, or the closed check that refused the evidence.

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

### D6 — Anti-slop findings ratchet on `dev` (owner decision, 2026-10-30)

Epic #3914 built a repository-owned code-quality engine: Oxlint 1.78.0 running
`oxlint-plugin-anti-slop` with 22 noncosmetic rules under `scripts/code-quality-policy.json`. Its
complete enforcement depends on responsibility qualifications that remain on the epic branch until
#3991. The owner's "Delivery amendment 2" to #3914 (2026-10-30) lands the engine on `dev` first,
under #4145, as a ratchet rather than as complete enforcement:

- `npm run check:code-quality-policy -- --mode ratchet` scans the whole repository and counts
  findings per (file, rule). The required `ci` context runs it on every pull request.
- The counts are compared with the committed register `scripts/code-quality-register.json`. An
  increase, or a new file with findings, fails with file, rule and line. A decrease fails until the
  register is shrunk with `--prune-register`, which only lowers counts or removes entries and
  refuses to widen. Entries for deleted or renamed files fail as stale.
- Inline Oxlint suppression directives remain rejected, so the register is the only tolerance. It is
  a shrink-only bridge, the same model as the `keiko-ui` ESLint bulk-suppression register, not a
  permanent baseline.
- The ratchet does not run the epic's responsibility qualifications and therefore does not claim
  that any rule is qualified or fully enforced. Rule dispositions, thresholds, required contexts,
  review loops and integration authority are unchanged.
- Baseline on `dev` `3a2979be1`: 7,239 files and 46,598 findings. Epic workstreams and ordinary
  `dev` work prune the register; #3991 removes it at zero and activates full enforcement.

Known limitation: counts are per file and rule, so fixing one finding and adding another of the same
rule in the same file nets out. This is accepted for the bridge period and closes when #3991
removes the register.

Reviewed increases (owner decision, 2026-11-01). The epic's delivery slices add findings that the
epic qualifies elsewhere or migrates later: validators adapted by responsibility records, boundary
checks that HELPER-COMPONENT-MIGRATION-008 on #3918 moves later, tests and fixtures that exercise
hostile input, and proof fixtures. The ratchet does not run those qualifications, so a
strictly shrink-only register would refuse every slice. The owner chose a reviewed increase list
over counting only enforceable findings and over landing the slices before #4145:

- `scripts/code-quality-register-increases.json` (version 1) lists entries of `path`, `rule`,
  `from`, `to`, `reason` and `issue`. `reason` is `qualified-boundary`,
  `pending-boundary-migration`, `test-witness` or `proof-fixture`. The second covers a check under
  the four boundary rules (no-runtime-typeof, no-unknown-parameters, no-unsafe-dictionary-type,
  no-known-value-widening) that a later reviewed migration moves while those rules are inactive for
  its package. `from` is less than `to`, and `issue` is a positive issue number. Malformed,
  duplicated or non-canonical ledgers fail closed.
- `--prune-register` raises a count only to exactly the `to` of an entry with the same path, rule
  and `from`. Every other increase still fails with `code-quality-register-increase`.
- The CI ratchet compares the committed register with the base commit's register. Each raised count
  needs one entry that the change adds; an entry the base already holds cannot approve a new raise.
  An added entry that matches no raise is stale, and a removed or changed base entry is rewritten
  history. Both fail. A CI comparison without a base fails, and CI still refuses register writes.
- The ledger started empty on `dev`. Entries accumulate as reviewed history in later slice PRs.

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
- Existing anti-slop findings on `dev` can only decrease until #3991 activates full enforcement (D6).

## References

- [Autonomous quality gates](../qa/autonomous-quality-gates.md)
- [Code-quality policy and dev ratchet](../qa/code-quality-policy.md)
- [External quality-gate runbook](../qa/external-quality-gates.md)
- [Review standards](../qa/review-standards.md)
- [CodSpeed benchmark variance](https://codspeed.io/docs/instruments/cpu/regression-causes)
- [Quality-gate implementation Issue #2875](https://github.com/oscharko-dev/Keiko/issues/2875)
- [Sonar OSS migration Issue #2874](https://github.com/oscharko-dev/Keiko/issues/2874)
