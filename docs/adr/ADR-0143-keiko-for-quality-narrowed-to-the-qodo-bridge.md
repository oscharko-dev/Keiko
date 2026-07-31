# ADR-0143: Keiko for Quality narrowed to the Qodo bridge

## Status

Accepted (Issue #2508, Epic #2504, 2026-07-18; evidence-currency amendment for Issue #2870,
2026-07-31).

## Amends

This decision narrowly amends the aggregate-scope descriptions in
[ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md) D5 and the context of
[ADR-0142](ADR-0142-keiko-for-quality-github-action-execution-shell.md): `Keiko for Quality` (KFQ)
no longer cross-checks the direct required checks, SonarQube Cloud, or Socket. Everything else is
unchanged — KFQ stays advisory and non-required, fail-closed, head-SHA-current, app-id-verified, and
evidence-redacted, and the direct required checks remain branch-protection merge authority exactly
as ADR-0135 D3 defines them.

## Context

KFQ evaluated three failure groups per pull request: a re-aggregation of the 13 direct required
checks (producer app id, completion, conclusion, exact head), a review group (the Qodo summary
comment plus Socket's comment-only package warnings with an owner-acceptance allowlist), and a
stability window across all of that evidence.

The re-aggregation duplicates enforcement that GitHub branch protection already provides: the same
13 contexts are required directly, pinned to their producer App ids, evaluated strictly against the
exact current head, and enforced for administrators. A KFQ re-check of those contexts can never
change a merge decision — branch protection blocks regardless of KFQ's verdict — but it costs a full
check-runs listing on every evaluation, widens the failure surface, and makes the evaluator carry a
per-repository profile of check names.

The Socket comment bridge similarly duplicated a decided control: both Socket contexts are direct
required checks, the organisation-level Socket policy blocks critical CVEs at the check level, and
warn-tier supply-chain hygiene alerts are an explicitly accepted maintainer decision, not a merge
blocker. The `@SocketSecurity ignore` allowlist plumbing existed only to un-block what the direct
gate never blocked.

KFQ's only irreplaceable capability — the reason it exists — is bridging the comment-only Qodo
review (ADR-0135 D5) into a gateable, head-SHA-current check.

## Decision

### D1 — The evaluator is the Qodo bridge, nothing else

`evaluateKeikoForQuality` judges exactly two failure groups: the Qodo review (a current-head or
fresh merge-parent-bound, app-id-verified, parseable summary must exist and report zero blocking
findings) and the stability window over that same review evidence. Unresolved findings publish a
`failure` conclusion; missing, stale, unparseable, unchanged, or still-settling evidence keeps the
check `in_progress` — never a false success, never a terminal failure for absent inputs. The
merge-parent currency rules (PR #2497, hardened for Issue #2503) are unchanged.

The Issue #2870 amendment makes an embedded current-head SHA necessary but insufficient. The
canonical Action normalizes all 40-hex commit IDs in the selected Qodo body, records only its SHA-256
digest in the exact-head, app-bound KFQ check output, and compares it with the digest referenced by
the app-bound KFQ dashboard's last accepted evidence head. A head move with an unchanged digest is
stale. A missing or malformed expected predecessor check is pending, and the dashboard baseline does
not advance. A first-seen or legacy baseline is recorded as pending and becomes accepted only after
a subsequent Qodo production changes that digest. The existing stability window remains unchanged.

### D2 — No re-checking of directly required contexts, not even a lightweight sanity pass

The issue allowed an optional lightweight sanity check of the direct contexts; it is deliberately
not kept. A re-check adds zero enforcement power while re-introducing the API calls, the check-name
profiles, and the failure modes this decision removes. Branch protection is the single authority
for those contexts; the enforced list lives in [`../qa/keiko-for-quality.md`](../qa/keiko-for-quality.md).

### D3 — The Socket comment bridge and its acceptance plumbing are removed

`SOCKET_RISK_ALLOWLIST_JSON` and `SOCKET_RISK_ACTORS_JSON` no longer exist; the evaluator reads no
Socket comments or check outputs. The lockfile-bound acceptance record
(`docs/qa/supply-chain-risk-acceptances.json`) and its repository test remain — they document and
pin accepted risks independently of KFQ.

### D4 — Direct-check listings stay removed; digest evidence is read narrowly

Evidence collection fetches only the pull request's issue-comment stream plus the lazy head-commit
read for merge-commit heads. The canonical Action additionally reads check runs only for the single
full head named by its own app-bound digest-baseline marker; it selects only the exact KFQ check name,
head, and App id. It never lists or re-evaluates direct required contexts. The publish path still
lists current-head check runs once to locate the existing aggregate run to update.

### D5 — Trigger surface is unchanged; check names remain event filters only

The Worker webhook and the Action's `check_run` allowlist still react to direct-check completions:
they are the natural "time passed on this pull" signals that let a stability-window verdict settle
without extra scheduling. The Action's fixed name list is a trigger filter (and the structural
self-trigger-loop guard), not merge authority, and is maintained in the Action shell.

Because the Action is purely event-driven, the triggering event can be the Qodo comment itself with
no later listed completion to re-run the evaluator. When a verdict is pending on the stability
window alone, the Action therefore holds the same run for the bounded remaining time (at most five
minutes) and re-evaluates on refreshed evidence, so the verdict settles instead of stranding an
`in_progress` check. The Worker needs no equivalent: its scheduled reconciliation already re-runs
still-waiting verdicts.

### D6 — Target profiles survive as validated configuration only

`TARGET_REPOSITORIES_JSON` keeps its `profile` field so deployed Worker and workflow configuration
stays valid, validated against the closed profile set; it no longer selects a required-check set.

## Consequences

- **Accepted trade-off:** less defense-in-depth. KFQ no longer independently verifies producer
  identity or head currency of the other products' checks; GitHub branch protection natively pins
  producers and heads for every required context, and that is now the only layer doing so.
- The evaluator drops the required-check profiles, Socket parsing/acceptance logic, and their
  configuration surface. Digest-chain evaluation adds one narrowly bound predecessor-head check
  listing after a baseline exists.
- The dashboard comment reports the narrowed scope (Qodo review, stability window, auto-merge
  state); direct-check status is read where it is enforced — the pull request's checks UI.
- The negative-probe set for ever making KFQ required narrows accordingly (stale head, wrong
  producer, unresolved finding, unparseable summary); failed direct checks block through branch
  protection natively, not through KFQ.

## Verification

- `scripts/__tests__/keiko-for-quality-core.test.mjs` proves the narrowed evaluator fails closed on
  missing, stale-head, spoofed-identity, and unparseable Qodo evidence, blocks on any finding count,
  honours merge-parent currency including the freshness gate, and applies the inclusive stability
  boundary with the 60-second default.
- `scripts/__tests__/keiko-for-quality-worker.test.mjs` and
  `scripts/__tests__/keiko-for-quality-action.test.mjs` prove both shells publish the same
  success/failure/pending check contracts. The Action tests additionally pin unchanged normalized
  bodies across heads, missing and malformed predecessor evidence, spoofed dashboard markers,
  pending-baseline recovery, and repeated stale evaluations.
