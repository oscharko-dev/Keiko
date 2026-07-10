# Epic #2091 agent docking security review

Date: 2026-07-10

Scope: Epic #2091 and child issues #2114 through #2122, covering the editor-agent producer,
multi-file changesets, live editor context, chat docking, presence/audit surfaces, and Authority
Envelope enforcement.

## Policy baseline

This review uses ADR-0125's maintained three-mode policy. The old blanket rule that every content
mutation requires review and a later manual Save is obsolete:

- **Ask for approval** allows workspace-contained edits, saves, and commands. External files,
  internet use, and delivery require approval.
- **Approve for me** allows low- and medium-risk actions. High- and critical-risk actions require
  approval.
- **Full access** allows file and internet actions inside a validated Authority Envelope without
  per-action approval.
- Commit, push, pull-request creation, and merge remain separately human-approved delivery actions.

Independent hard denials still win in every mode: invalid or expired authority, workspace escape,
sensitive paths, secret exfiltration, unsupported actions, exhausted budgets, and invalid bridge
leases fail closed.

## Trust boundaries reviewed

1. `keiko-tools` model-facing schemas and the bounded loopback HTTP producer.
2. Shared editor-agent wire parsing in `keiko-contracts`.
3. `/api/editor/agent/*` admission, policy, queue, SSE, result, and audit handling.
4. `keiko-tools` patch inspection and atomic apply/rollback.
5. The browser bridge, review surface, terminal result capability, and Monaco reconciliation.
6. Bounded diagnostic detail and the redacted `editor-state` context provider.

## Confirmed findings and fixes

### High: producer POSTs omitted the BFF mutation guard

The default `EditorAgentHttpClient` fetch transport sent JSON POSTs without `X-Keiko-CSRF: 1`, so
the real BFF rejected the first producer request before editor-agent admission. The transport now
adds the guard to POST only, retains manual redirect handling and loopback-only origins, and keeps
response/time bounds. `editor-agent-client.test.ts` proves GET/POST header separation, streaming,
oversized responses, cancellation, timeout, redirects, malformed responses, and redaction.

### High: bare action parsing retained unknown authority fields

The semantic action guard accepted structurally valid objects with unknown fields, and the bare
action parser copied those objects with a spread. A hostile producer could therefore carry unknown
authority or capability canaries farther into the route and SSE path. The parser now emits a deep,
canonical projection of actions and results, including nested targets, edits, changesets,
preconditions, conflicts, and per-file results. Unknown fields are not retained.

`editor-agent.test.ts` proves canonical projection at the contract boundary.
`agentRoutes.test.ts` additionally proves unknown capability and authority canaries are absent from
target SSE, terminal results, and audit records.

No unresolved high or critical finding remains after these fixes.

## Adversarial verification matrix

| Boundary                         | Adversarial cases                                                                                                                  | Passing evidence                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `applyTextEdits`                 | `.env`; Unix absolute path; `../`; Windows drive path; missing/stale pins                                                          | `agentRoutes.test.ts`: sensitive-path policy tests, AC5 containment tests, precondition tests   |
| Single-file `applyPatch`         | denied target; out-of-workspace target; traversal; symlink and hard-link alias; malformed/multi-file patch                         | `patch.test.ts` and `agentRoutes.test.ts` applyPatch preflight tests                            |
| `applyChangeset` sensitive paths | safe member followed by `.env`, `.ssh/id_rsa`, `.keiko/state.json`, or `.aws/credentials`; no reads or writes to the denied member | `agentRoutes.test.ts`: generated `rejects a safe plus deny-listed ... changeset` matrix         |
| `applyChangeset` escape          | safe member plus `../outside.txt`; absolute member; target replaced after queueing by an outward symlink                           | `agentRoutes.test.ts`: escaping-member matrix and commit-time outward-symlink test              |
| Whole-action preconditions       | stale second member; live snapshot made unverifiable; unselected members still validated                                           | `agentRoutes.test.ts`: stale-member, verifiable-counterpart, and selected-file projection tests |
| Authority and capability         | missing/wrong/replayed bridge capability; expired changeset authority; unknown-field smuggling                                     | `agentRoutes.test.ts`: bridge lease, changeset expiry, and canonical-wire tests                 |
| Atomicity                        | browser rejection; stale member; writer failure on a later member; replay; forged result                                           | `agentRoutes.test.ts`: apply-none, rollback, idempotency, and forged-result tests               |
| Authority budgets                | cumulative tool calls and UTF-8 patch bytes; elapsed runtime; text-edit bytes                                                      | `agentAuthorityRegistry.test.ts` and `agentRoutes.test.ts` Authority Envelope budget tests      |
| Diagnostics/context              | item/message caps, ingest rejection, truncation, unsafe-format stripping, redaction                                                | `editor-agent.test.ts`, `agentRoutes.test.ts`, and `codingContextProviders.test.ts`             |

The credential-path case intentionally uses a well-known credential store (`.aws/credentials`). A
generic project directory named `credentials` is not itself denied because it can contain legitimate
domain source. Known credential directories and credential filenames remain always-on denies, while
secret-shaped content elsewhere is handled by the redaction boundary.

## Disk mutation and review

`applyChangeset` uses one server-owned transaction. Every declared file is parsed, contained,
sensitive-path checked, and precondition checked before selected-file projection. The selected patch
is validated again immediately before atomic apply, and an apply failure rolls back prior members.
The server also re-resolves Authority Envelope expiry and policy after the browser's terminal
acknowledgment.

Review timing follows policy rather than an obsolete blanket Save rule:

- A supervised high-risk changeset remains byte-identical on disk until the user accepts its review.
  Accept then commits the complete selected transaction and reconciles Monaco.
- An allowed contained changeset confirms through the live bridge, commits without a visible review,
  and reconciles Monaco.
- Chat **Apply to editor** is an explicit review workflow. Accept changes the active buffer, marks it
  dirty, and requires explicit Save before that buffer reaches disk.

The #2122 Playwright suite verifies all three paths against the real BFF and filesystem.

## Audit and data handling

Editor-agent audit records contain only bounded identifiers, action type/origin, policy disposition,
reason code, status, target label, counts, and byte counts. They do not contain patch text, file
content, diagnostic messages, selections, prompts, credentials, reusable capabilities, full
Authority Envelopes, or private endpoints. The reviewed terminal capability is random, memory-only,
session-bound, and consumed through a live bridge lease.

## Disposition

Security review: **passed after two high-severity fixes**. Sensitive-path, containment,
precondition, authority, capability, budget, atomicity, and redaction controls have named passing
regression coverage. No governance gate or deny was weakened.
