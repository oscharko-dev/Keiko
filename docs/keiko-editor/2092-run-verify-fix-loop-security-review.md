# Epic #2092 run-verify-fix loop security review

Security review for the editor verification surface (Epic #2092, child issues #2210–#2214). Subject:
every verification run — human- or agent-triggered — stays inside the single governed `keiko-tools`
spawn boundary with sandbox attestation honestly reported, carries no unredacted output into any
persisted evidence record, and gives a docked agent no broader command surface than the human UI.

## Policy baseline

- ADR-0126 (this epic) defines the run/event envelope, the problems-aggregation model, the
  failure→location shape, the `"execution"` effect class, and the `requestVerification` action.
- ADR-0062 governs agent editor-action classification and content-free audit.
- ADR-0043 D4 governs honest network-enforcement reporting; ADR-0019 pins package trust boundaries.
- The executable surface is the closed `VerificationKind` set (`test | targeted-test | typecheck |
lint | build`) and the command-runner's `package.json`-script catalog. No free-form argv is
  accepted on any path.

## Trust boundaries reviewed

| Boundary                                                                                                                 | Verified by                                                                              |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Agent run request parsed/narrowed at the route edge (schemaVersion, sessionId, kind, contained targetPath, authorityRef) | `editor-agent-verification.test.ts`, `agentVerificationRoute.test.ts` (400 on malformed) |
| Escaping/sensitive `targetPath` denied before any run                                                                    | `agentVerificationRoute.test.ts` (classifier `denied-sensitive-path`, run not called)    |
| Authority Envelope gate: composed disposition is stricter-of-two                                                         | `agentVerificationRoute.test.ts` (AC2 classifier-stricter, AC3 envelope-stricter)        |
| Denied / review-required disposition prevents the sandboxed run from starting                                            | `agentVerificationRoute.test.ts` (mocked runner call-count `0`)                          |
| Single governed spawn boundary — agent and human share one execution port                                                | `agentVerificationBoundary.test.ts` (both route through the injected port)               |
| Fail-closed run reported honestly (denied, not upgraded to passed)                                                       | `agentVerificationBoundary.test.ts` (`overallStatus: "denied"` surfaced)                 |
| Agent confined to the requested `VerificationKind` — no broader surface                                                  | `agentVerificationBoundary.test.ts`, `editor-agent-schemas.test.ts` (closed enum)        |
| Content-free audit for every admitted-or-denied request                                                                  | `agentVerificationRoute.test.ts` (exactly one record; no `SECRET`/`outputSummary`)       |
| Redacted tool result — no raw output/argv/command re-exposed                                                             | `editor-agent-verification.test.ts`, `agentVerificationRoute.test.ts`                    |
| Loopback-only, redirect-rejecting, bounded HTTP transport for the tool                                                   | `editor-agent-client.test.ts` (existing hostile-URL + redirect suite)                    |
| Verification call uses a wall-time-appropriate timeout, honors `signal`                                                  | `editor-agent-client.test.ts` (AC7: long timeout, already-aborted → cancelled)           |
| SSE lifecycle events are content-free (no `outputSummary` on non-terminal frames)                                        | `verificationRoutes.test.ts`, `verificationRunner.test.ts`                               |

No boundary is left "assumed safe" without a test.

## Confirmed findings and fixes

### Design: allowed (non-mutating) verification runs were invisible to the audit ledger

The audit ledger recorded only mutating actions or denied actions, so an _admitted_ verification run
(non-mutating, `mutating: false`) would produce no record — undermining the "trust through
visibility" property for the new execution surface. Fix: the ledger's record predicate now also
admits execution-class decisions (`decision.effectClass === "execution"`), so an allowed run is
audited once with `mutating: false` preserved (verification does not mutate). Denied and
review-required outcomes were already audited. Verified by `agentVerificationRoute.test.ts`.

### Design: the redacted report cannot structurally carry raw output

`RedactedVerificationReport` has no field for `outputSummary`, `command`, or `args`; the mapping
`toRedactedVerificationReport` drops them by omission (content-free by construction), keeping only
enums, counts, durations, and structured failure locations. A location message is a
producer-redacted compiler diagnostic and is intentionally surfaced; the regression fixtures assert a
secret placed in `outputSummary`/argv never reaches the wire.

## Adversarial verification matrix

| Attack                                                                    | Outcome                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------- |
| Agent requests a run with a deny-listed `targetPath` (`.env`)             | Denied at classification; no spawn                      |
| Agent presents an unknown/forged `authorityRef`                           | Authority resolution fails; denied; no spawn            |
| Agent presents an envelope lacking the `verification` action class        | Composed denied (`mode-policy-denied`); no spawn        |
| Agent requests a kind outside the closed set (`deploy`)                   | Rejected by schema/parser before any route call         |
| Agent injects extra properties (e.g. its own `authorityRef` in tool args) | `INVALID_ARGUMENTS`; no route call                      |
| Verification response oversized / redirected / malformed                  | Bounded transport rejects; typed error                  |
| Budget exhausted at reservation                                           | Denied (`authority-budget-exceeded`); no spawn; audited |

## Disk mutation and review

A verification run performs no workspace write — it spawns a read-only run through the enforced
sandbox boundary. The only disk mutations in the epic are the human editor's own edits (unchanged
apply path). The agent verification tool cannot write files; its effect class is `execution`, not
`content-mutation`.

## Audit and data handling

Every admitted-or-denied verification request emits exactly one content-free
`EditorAgentActionAuditRecord` (enums, identifiers, workspace-relative path only), re-redacted at the
server boundary as defense in depth. The verification's own pass/fail counts live in the returned
report, never in the ledger. The audit panel (`EditorAgentActionsPanel`) renders and filters the new
`requestVerification` action type so a human can recognize and isolate agent-triggered runs.

## Disposition

Approved. Every trust boundary is verified by a passing test; the agent path is provably as-or-more
restricted than the human path, honestly attested, content-free in evidence, and confined to the
closed verification kind set. No gate was weakened to reach this disposition.
