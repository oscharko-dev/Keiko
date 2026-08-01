# ADR-0167: Zero-cost autonomous quality gates

## Status

Accepted (owner decision, 2026-08-01). Hosted-check promotion remains subject to the live proof in
D5; repository-owned gates and reviewer configuration take effect with this change.

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

Fallow 2.104.0 is exact-version locked and runs semantic duplicate analysis only over the changed
surface. Any introduced semantic clone group of at least 100 tokens and 10 lines fails. Ignoring
imports avoids punishing required module boilerplate while still detecting renamed-variable and
restructured copy/paste that text-only duplication misses.

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

CodSpeed uses deterministic CPU simulation; regressions above 5% against `dev` fail. It supplements
but never replaces D12 evidence, bundle budgets, retrieval latency, or end-to-end performance gates.
The live dashboard-policy comparison runs in a separate `pull_request_target` workflow loaded from
the protected base. It downloads only the candidate `.codspeed-policy.json` as exact-head data and
executes only the base-owned validator. The benchmark workflow remains on the candidate head but
cannot validate or self-approve its own policy contract.

### D5 — External checks enter branch protection only through an atomic live cutover

CodSpeed, Greptile, and CodeRabbit may become app-bound required statuses only after one live pull
request proves, for each producer: exact current-head emission, two successive updates, a deliberate
negative case, repaired success, stable name and App ID, and bounded settlement. CodSpeed and
CodeRabbit additionally require proven zero-cost continuity without quota pacing. A status that
reports success after omitting review fails promotion. The cutover removes the retired bridge and
adds only proven checks in one branch-protection update; no same-named unbound context is accepted.

By explicit owner decision, Greptile may be required during its no-payment trial after the same
technical probes pass. This is a time-bounded activation, not continuity proof: the promotion ledger
must record the provider-reported expiry and an active owner-bound rollback automation. Unless the
pending zero-cost OSS exception is approved and verified, that automation removes and verifies the
required contexts and installation no later than 24 hours before expiry. No generic approval,
payment method, star purchase, fabricated popularity, admin bypass, finding dismissal, or threshold
relaxation is an accepted continuity mechanism.

## Consequences

- A stopped review subscription can no longer deadlock or falsely satisfy Keiko's core quality bar.
- New semantic copies and secrets are blocked by fast, reproducible OSS tools.
- Automated review findings can block agent delivery without adding a human approval bottleneck.
- The longest deterministic jobs still dominate pull-request latency; the new gates run alongside
  them instead of serially extending the path.
- Hosted services remain replaceable supplemental producers and are represented honestly as such.

## References

- [Autonomous quality gates](../qa/autonomous-quality-gates.md)
- [External quality-gate runbook](../qa/external-quality-gates.md)
- [Review standards](../qa/review-standards.md)
- [Quality-gate implementation Issue #2875](https://github.com/oscharko-dev/Keiko/issues/2875)
- [Sonar OSS migration Issue #2874](https://github.com/oscharko-dev/Keiko/issues/2874)
