# Epic #2092 run-verify-fix loop security review

Final security review for Epic #2092 and child issues #2210–#2215. The reviewed claim is narrow and
testable: human and agent verification use the same governed execution boundary; untrusted inputs
are bounded and projected before use; package-script and agent authority cannot be asserted by a
run body; execution and failures remain observable without persisting raw command output.

## Policy baseline

- ADR-0126 defines the editor run/event, Problems, failure-location, execution-effect, explicit
  workspace trust, and pre-execution agent-admission decisions.
- ADR-0007 owns deterministic verification planning, limits, classifications, and report semantics.
- ADR-0043 owns fail-closed network isolation and honest `SandboxAttestation` reporting.
- ADR-0062 and ADR-0125 own editor-agent classification, Authority Envelope composition, session
  governance, human review, and content-free audit.
- The executable request surface is the closed `VerificationKind` set. No route, tool schema, or UI
  affordance accepts free-form command, argv, environment, endpoint, or working directory.

## Boundary matrix

| Boundary                   | Enforced behavior                                                                                                                                                                                                                    | Regression proof                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Human package-script trust | explicit same-origin CSRF-protected local action; BFF binds grant to registered canonical project + regular non-symlink `package.json` digest; change/revoke/missing state fails closed                                              | `workspace-script-trust.test.ts`, `verificationRoutes.test.ts`, `useEditorVerificationRun.test.ts`    |
| Human run input            | closed unique kinds, contained target path, bounded request id; catalog controls availability; no client-supplied trust                                                                                                              | `editor-verification.test.ts`, `verificationRunner.test.ts`, E2E                                      |
| Failure output → location  | parser reads only already-capped/redacted output; canonicalizes to workspace-relative POSIX; rejects escape, NUL, foreign drive/UNC, invalid coordinates, overlong path/line/rule/message; Unicode cap never leaves a lone surrogate | `failure-location.test.ts`, `verification.test.ts`                                                    |
| SSE/report wire            | exact event variants; complete deep report/result/applied-limit/count validation; terminal report only, content-free intermediate events                                                                                             | `editor-verification.test.ts`, `verificationRoutes.test.ts`                                           |
| Agent request              | exact schema; `targeted-test` requires one target and other kinds forbid it; target remains classifier/deny-list checked                                                                                                             | `editor-agent-verification.test.ts`, `editor-agent-schemas.test.ts`, `editor-agent-tool-host.test.ts` |
| Agent authority            | reference resolves for canonical workspace and deployment ceiling, binds on first use to the live session, then reserves bounded budget                                                                                              | `agentAuthorityRegistry.test.ts`, `agentVerificationRoute.test.ts`                                    |
| Agent admission visibility | classify → compose → reserve → mandatory admission audit; audit failure returns 503, rolls back the reservation, and leaves runner call count at zero                                                                                | `agentVerificationRoute.test.ts`, `agentAuthorityRegistry.test.ts`                                    |
| Agent response             | closed reason enums; exact deep projection strips unknown nested fields; counts and overall status match steps; client requires exactly one step of the requested kind                                                               | `editor-agent-verification.test.ts`, `editor-agent-client.test.ts`                                    |
| HTTP lifetime              | loopback origin only, redirects rejected, body/response/time bounded, CSRF on mutation, disconnect listener installed before parsing and cancellation reaches the shared run                                                         | `editor-agent-client.test.ts`, `agentVerificationRoute.test.ts`                                       |
| Execution                  | human and agent share planner, registry, orchestrator, resource limits, enforced-network probe, sandboxed spawn, cancellation, terminal evidence, and diagnostics                                                                    | `agentVerificationBoundary.test.ts`, `verificationExecution.test.ts`, `verificationRunner.test.ts`    |
| UI aggregation             | project-scoped store, producer ownership, deterministic caps/order, bounded messages, no cross-window/project eviction or disclosure                                                                                                 | `editorProblemsStore.test.ts`, `ProblemsPanel.test.tsx`, `useEditorVerificationRun.test.ts`           |

## Human-control and trust conclusions

Script-backed `test | typecheck | lint | build` can execute repository-defined code only after a
local human grants manifest-bound trust. `targeted-test` remains exempt from package-script trust
because Keiko synthesizes the closed `npx vitest|jest` invocation, but it still executes only after
an explicit human run action or an allowed agent Authority Envelope decision and still requires the
same fail-closed network sandbox and limits.

The execution effect is intentionally classified as non-mutating product intent: the verification
surface itself has no write API and returns only a report. This is not a false claim that arbitrary
repository test/build code is filesystem-read-only; such code can have side effects permitted by the
existing verification sandbox profile. The new explicit script trust and agent Authority Envelope
are therefore load-bearing. This epic does not widen that inherited ADR-0007/ADR-0043 filesystem
profile or create an alternate spawn path.

No agent run starts merely because the model supplied a plausible reference. Workspace, deployment
ceiling, session binding, local-action binding when present, composed policy, budget, and admission
audit must all succeed. Review-required is a terminal not-run outcome for this synchronous tool;
there is no hidden auto-approval path.

## Audit, diagnostics, and data minimization

- The admission ledger contains identifiers, enums, bounded relative target metadata, policy
  disposition, and outcome only. It never contains command output, argv, environment, manifest body,
  source, secret, endpoint, or absolute path.
- The verification evidence ledger records redacted statuses, counts, durations, and hashes; an
  interrupted/cancelled execution receives a content-free terminal record. Evidence write failure
  is a real terminal failure, not a swallowed promise rejection.
- Unexpected execution failures emit a static, correlation-keyed operator diagnostic. The browser
  receives only a bounded static failure reason; raw thrown messages are not put on SSE.
- Agent results omit command, args, script names, `outputSummary`, workspace root, and unknown fields.
  Structured diagnostic messages are deliberately user/model-visible only after producer redaction,
  path canonicalization, and strict caps.

## Adversarial outcomes

| Attack/failure                                                      | Outcome                                                                |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| forged/expired/wrong-session authority reference                    | denied; no runner call                                                 |
| review-required or exhausted budget                                 | audited not-run; no runner call                                        |
| unavailable audit sink                                              | HTTP 503; reservation rolled back; no runner call                      |
| `.env`, traversal, absolute, foreign-drive/UNC, NUL target/location | rejected or dropped before dispatch/projection                         |
| unknown kind, target on non-targeted kind, missing targeted path    | schema/parser rejection                                                |
| hostile nested response fields or inconsistent counts/status/kind   | malformed-response; exact projection returns nothing hostile           |
| no enforcing network backend                                        | denied report before spawn; attestation says not enforced              |
| client disconnect before/during parsing or execution                | shared abort signal; no orphaned agent run                             |
| evidence append or async execution failure                          | one static terminal failure plus redacted diagnostic/evidence handling |

## Disposition

Approved for merge subject to the normal protected-branch CI checks. The audit found no remaining
unmitigated Epic #2092 acceptance or trust-boundary defect. Human and agent paths are demonstrably on
one governed execution seam, authority remains server-owned, evidence remains content-free, and no
quality or security gate was weakened.
