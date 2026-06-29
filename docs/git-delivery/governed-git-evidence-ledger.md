# Governed Git Mutation Evidence Ledger and Audit Export

This document describes the governed Git mutation evidence ledger, audit export, and recovery
metadata introduced in Issue #474 (Epic #470) and defined by
[ADR-0083](../adr/ADR-0083-governed-git-mutation-evidence-ledger.md). It is written for engineers
wiring the execution slices (#476–#478) into the ledger, for operators consuming the audit export,
and for reviewers verifying that Git write authority in Keiko is never a black box and never leaks a
secret.

## 1. Overview

Issue #471 (ADR-0080) defined the typed contract surface, Issue #472 (ADR-0081) built the execution
kernel that drives every mutation through one repeatable lifecycle and returns a structured
`GitMutationLifecycleResult`, and Issue #473 (ADR-0082) built the approval and preview presentation
layer. Those layers produce everything a governed delivery needs but persist nothing.

This slice is the **durable record**. For every terminal outcome of a governed Git mutation —
succeeded, blocked, rejected, failed, recovery-required, or held for approval — it produces an
immutable, content-free evidence record, writes it to a bounded append-only ledger, and makes it
exportable as a structured audit packet. An enterprise operator can answer who requested an action,
what policy decided, what was previewed, what executed, what failed, and how recovery should proceed
— without exposing secrets or relying on ad hoc shell history.

The work spans three layers, respecting the ADR-0019 dependency direction (contracts ← tools ←
server):

- **`packages/keiko-contracts/src/git-delivery-evidence.ts`** — the pure, content-free
  `GitDeliveryEvidenceRecord` and exportable `GitDeliveryAuditPacket`, the AC1 outcome-class
  vocabulary, the AC3 three-way recovery disposition, and the deterministic recovery-disposition
  derivations. A strict leaf: no IO, no clock, no crypto.
- **`packages/keiko-tools/src/git-mutation-evidence.ts`** — the pure builder
  `buildGitDeliveryEvidenceRecord` that projects a kernel `GitMutationLifecycleResult` into a record
  for every terminal outcome.
- **`packages/keiko-server/src/gitDelivery/`** — the bounded, date-bucketed append-only ledger
  (`mutationEvidenceLedger.ts`) and the capability-gated `GET /api/git-delivery/evidence` audit
  export route (`evidenceRoutes.ts`).

## 2. The evidence record

A `GitDeliveryEvidenceRecord` is a flat, self-contained projection of a single mutation attempt. It
preserves action intent, policy outcome, approval provenance, preview summary, execution summary,
repository context, recovery metadata, and a workflow correlation — every field the audit needs and
nothing more.

| Field                                               | Purpose                                                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `outcomeClass`                                      | One of `succeeded`, `blocked`, `rejected`, `failed`, `recovery-required`, `approval-required` (AC1).           |
| `phaseReached`                                      | The furthest lifecycle phase the attempt reached (`resolve`→`result`).                                         |
| `actionKind`, `riskClass`, `riskSeverity`           | The action intent and its data-driven risk classification.                                                     |
| `policyOutcome`, `blockReason`, `requiredApprovers` | What the policy decided.                                                                                       |
| `approval`                                          | Approval provenance — the approval token **hash** (never the token), approver id, timestamps.                  |
| `preview`                                           | The content-free preview summary (counts, flags, affected branch).                                             |
| `execution`                                         | Present only when the action executed: outcome, duration, error code, partial-unit counts, hashed external id. |
| `repoContext`                                       | Content-free repository context: local branch name, counts, and hashed repo / remote identifiers.              |
| `recovery`                                          | The recovery metadata (see §4).                                                                                |
| `correlation`                                       | The hashed triggering-workflow run id, the action id, and an optional attempt sequence (AC1).                  |

### Outcome classes (AC1)

The kernel's `GitMutationStatus` and `GitMutationFailureCategory` are mapped onto the contract
outcome-class vocabulary by the builder. A successful attempt is `succeeded`; a governance or
preflight stop is `blocked`; a provider rejection is `rejected`; a transient execution failure is
`failed`; a repository that needs guided recovery is `recovery-required`; a governance hold is
`approval-required`. Every terminal outcome produces exactly one record, so a blocked or rejected
attempt is auditable even though it never mutated the repository.

## 3. Content-free guarantee and redaction (AC2, AC5)

Records carry **counts, flags, branch names, typed codes, and SHA-256 hashes only**. They never carry
diff content, file paths, command strings, raw subprocess output, raw provider artifacts, or
credential-bearing metadata. The discipline is enforced two ways:

1. **By construction.** Sensitive identifiers are hashed in the builder, never stored raw:
   - the approval token is recorded as a hash by the #471 contract (`approvalTokenHash`);
   - the provider external id becomes `execution.externalIdHash`;
   - a push remote alias/branch becomes `repoContext.remoteRefHash`;
   - the repository path/identity becomes `repoContext.repoIdHash`.
     Local branch names are retained as content-free repository context, consistent with the #473
     action-sheet projection.
2. **Defence in depth.** Every record is passed through `deepRedactStrings` (the audit redactor) at
   persist time, and the whole audit packet is re-run through the server redactor on export read, so a
   string that somehow escaped the by-construction discipline is scrubbed to `[REDACTED]` before it
   reaches disk or leaves the server.

## 4. Recovery metadata (AC3)

The recovery metadata answers "what should the operator do next?". Its core is a **three-way
disposition**:

- **`retryable`** — transient; the same action can be retried as-is (network failure, timeout,
  internal error).
- **`user-fixable`** — the operator must change a repository or request condition first (conflict,
  stale precondition, missing/expired approval, a blocking preflight condition).
- **`policy-forbidden`** — governance forbids the action; it is not retryable without a policy change
  (a policy-pack denial, a protected branch, a risk-class ceiling, a fail-closed no-applicable-rule).
- **`none`** — a successful attempt; no recovery is needed.

The disposition is **data** — derived from the closed execution-error-code and block-reason
vocabularies through total, exhaustive tables — never inferred from a free-form message. Alongside it,
the metadata reuses the prospective `GitDeliveryRecoveryActionHint` vocabulary from #473 (for example
`request-approval`, `configure-upstream`, `resolve-conflicts`, `recover-via-strategy`) and the #471
`GitDeliveryRecoveryStrategyHint`, so the retrospective audit and the prospective action sheet speak
the same recovery language. The net-new contribution of this slice is the three-way disposition: the
prospective two-way `GitDeliveryRemediationClass` (`user-actionable`/`internal`) cannot distinguish a
transient retry from a policy denial.

## 5. The ledger and audit export (AC4)

Evidence is appended to a bounded, append-only ledger: one document per UTC date bucket
(`git-delivery-evidence-YYYY-MM-DD`), mirroring the memory-audit ledger. Stores exposing an atomic
`update()` serialize the read-append-write step so concurrent appenders never drop a record; each
bucket is bounded to its most recent records. An audit-write failure is reported, never thrown — it
must never break the user's mutation — and a corrupt ledger document fails closed and is never
overwritten.

`GET /api/git-delivery/evidence` returns a `GitDeliveryAuditPacket`: the redacted records, per-class
and per-disposition counts, and an honest static list of the limitations the export does not overcome.
The route is always registered with the governed Git delivery surface and returns only redacted,
content-free audit data. It accepts bounded `days` (1–30) and `limit` (1–500) query parameters. Being a
`GET`, it is not covered by the central CSRF guard; a malformed or tampered record is dropped on read
rather than served.

## 6. What this slice does not do

- It does not execute Git mutations. The producer that calls `recordGitDeliveryMutationEvidence` from
  a live execution path is the local execution kernel (#472) wired by the execution slices
  (#476–#478); this slice delivers the contract, builder, ledger, and export seam.
- It does not record provider-side outcomes (merge-block reasons, remote rejections) for a local-only
  deployment — the local kernel does not produce them yet; the provider execution slices do.
- It does not perform recovery. It records the recovery disposition and hint that a later guided
  recovery flow consumes; it never runs a reset, stash, or rebase.
- It does not introduce an external telemetry platform. The ledger is the local, content-free
  evidence store; export is a pull, not a push.
