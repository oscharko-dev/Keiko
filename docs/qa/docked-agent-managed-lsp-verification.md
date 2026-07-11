# Docked-agent managed-LSP verification evidence

This document defines the release-evidence contract for Epic
[#2094](https://github.com/oscharko-dev/Keiko/issues/2094), child
[#2281](https://github.com/oscharko-dev/Keiko/issues/2281). It specifies the product-path,
cross-language, security, and failure-state evidence required before docked-agent managed-LSP
support can be claimed. It does not itself prove implementation. A claim becomes releasable only
when the required failure-first tests run against the current change and pass without weakened
assertions, policy, bounds, architecture rules, or coverage floors.

The minimum release profile is Python plus Go as the compiled language. Another compiled managed
provider may supplement Go, but it does not replace the Python lane or reduce the requirements in
this document. Tests use injected fake managed providers and must never download a language server,
toolchain, package, module, crate, Maven or Gradle artifact, or other dependency.

## Authority and product-path invariants

The verification suite must preserve these invariants in every row of the matrices below:

- the docked agent enters through the existing `EditorAgentToolHost` and
  `EditorAgentHttpClient.action()` path for queued language actions;
- the HTTP client talks to a real loopback BFF, not an in-memory replacement for the BFF route;
- the BFF dispatches through the existing `/api/editor/agent/actions` and
  `/api/editor/language` control planes to an injected fake managed provider;
- no test calls an agent route handler, language route handler, provider operation, or sanitizer
  directly as a substitute for product-path evidence;
- the selected workspace, current activation revision, current negotiated-capability snapshot, and
  runtime health are re-evaluated at dispatch time;
- only the intersection of product candidate, deployment policy, workspace activation,
  provisioning, current negotiation, runtime health, and the agent's existing operation vocabulary
  is reachable;
- all paths remain canonical and root-relative after sanitization, and workspace escape fails
  closed before provider dispatch or result publication;
- responses remain bounded and typed across provider, language route, agent action result, HTTP
  client parser, tool-host output, audit, and evidence projections; and
- no provider response can grant apply, save, stage, commit, push, pull-request, merge, deployment,
  command-execution, or authority-widening capability.

The fake provider is a protocol test double, not a replacement BFF. It must expose deterministic
controls for initialization capabilities, dynamic registration and unregistration, diagnostics,
operation responses, delay, cancellation acknowledgement, malformed and oversized frames, crash,
restart, and late responses. The suite must assert the fake provider's received requests as well as
the queued agent payload and final parsed tool output.

## End-to-end topology and observations

Every positive language lane must demonstrate this complete sequence in one test process:

1. Create two temporary workspace roots with deterministic Python and Go fixtures. All paths,
   source, diagnostics, and provider traffic remain fixture-local and are deleted at teardown.
2. Start the real BFF on an ephemeral loopback port with isolated state and injected fake Python
   and Go managed providers. No existing developer state, process, port, clock, or network is used.
3. Activate the provider through the server-owned managed-LSP control plane under an allowed policy,
   then complete fake initialization with a versioned negotiated-capability snapshot.
4. Register the real editor-agent session/bridge state needed by the public agent route. The
   session is bound to exactly one selected workspace and current document version.
5. Invoke the docked-agent tool host. For queued navigation, prove the host called
   `EditorAgentHttpClient.action()`, which posted one validated `navigateSymbol` action to the real
   BFF. Prove the BFF, not the host, selected the managed provider.
6. Observe and correlate the queued payload, fake-provider request, language response, agent action
   result, parsed host output, content-free agent audit, and managed-LSP evidence using bounded
   identifiers or hashes rather than source or raw bodies.
7. Dispose the session, BFF, fake providers, timers, temporary state, and both workspace roots.
   Assert no pending request, child process, open listener, or provider state survives teardown.

Diagnostics use the additive `diagnostics` operation on the existing `navigateSymbol` action and
`editor_navigate_symbol` tool. This is not a new action class or authority surface: it remains a
bounded, read-only server-resolved operation. The suite correlates it with the same workspace,
document version, activation state, negotiated provider session, and content-free audit record used
by the real language route. Diagnostics supplied to `codeActions` remain bounded request inputs and
must not be represented as a provider-health or capability grant.

## Language and operation matrix

`Required` means product-path evidence is mandatory for both release-profile languages. `If
exposed` means evidence is mandatory only when the live editor-agent contract exposes that operation
and the provider negotiates it. Otherwise the suite must prove a deterministic unsupported outcome
and absence from effective agent capabilities. `Review only` means generation may return a bounded
proposal but cannot cause a mutation.

| Agent-visible capability | Python      | Go          | Required proof                                                                                                                                                |
| ------------------------ | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Diagnostics              | Required    | Required    | One queued `navigateSymbol` action reaches the negotiated fake provider; diagnostics are bounded and content-free outside the typed result.                   |
| Definition               | Required    | Required    | One queued `navigateSymbol` action reaches the negotiated fake provider and returns only bounded root-relative locations.                                     |
| References               | Required    | Required    | Zero, one, boundary-count, and over-limit references preserve order, deduplicate deterministically, and report truncation honestly.                           |
| Type definition          | Required    | Required    | Dispatch occurs only when present in the live agent vocabulary and current negotiated snapshot; otherwise it is not advertised and returns typed unsupported. |
| Implementation           | Required    | Required    | Same dispatch-time capability intersection and bounded location proof as definition.                                                                          |
| Call hierarchy           | Required    | Required    | Prepare/incoming/outgoing data remains bounded, root-relative, cycle-safe, and unavailable after capability removal.                                          |
| Inlay hints              | Required    | Required    | Hints remain bounded read-only metadata and cannot carry executable commands or edits.                                                                        |
| Signature help           | If exposed  | If exposed  | Current negotiated support is checked at dispatch; result text and collection sizes remain capped.                                                            |
| Prepare rename           | Review only | Review only | The result is a bounded range/placeholder proposal and never invokes rename apply or a browser write action.                                                  |
| Code actions             | Review only | Review only | Only bounded, contained edit proposals are returned; command-bearing or resource-operation actions are rejected.                                              |

The matrix suite must assert both the effective managed-provider capabilities and the narrower
effective docked-agent capabilities. Static candidate descriptors, provider initialization output,
a stale session snapshot, or this table cannot advertise support. An operation outside the live
`EditorAgentNavigateSymbolOperation` union remains unsupported for docked agents even if the
provider and `/api/editor/language` route support it for the human editor.

At least one positive operation per language must use unsaved overlay text so the request proves
that current editor content, not an older disk image, is analyzed. Source text may appear only in
the transient request/response under test; it must not appear in audit, evidence, diagnostics logs,
test names, snapshots committed to the repository, or failure output.

## Effective-state and failure matrix

Every row applies to Python and Go. Unless a row explicitly expects provider dispatch, the fake
provider request count must remain unchanged and no in-process or direct-LSP fallback may run.

| State or transition             | Required setup                                                                                                         | Required docked-agent outcome                                                                                                     | Required negative evidence                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Active                          | Enabled, provisioned, policy allowed, negotiated operation present, healthy, current revision                          | Bounded success through the complete product path                                                                                 | No direct handler/provider call and no absolute path or raw body in projections                     |
| Disabled                        | Workspace activation is `disabled` before dispatch                                                                     | Typed fail-closed outcome tied to `WORKSPACE_DISABLED` or the current public closed mapping                                       | No provider dispatch and no fallback                                                                |
| Policy blocked                  | Deployment policy is `denied` while workspace activation requests enabled                                              | Typed denial tied to `POLICY_DENIED`                                                                                              | No process start, provider dispatch, source projection, or policy bypass                            |
| Missing                         | Approved provider runtime is not provisioned                                                                           | Typed unavailable outcome tied to `NOT_PROVISIONED`                                                                               | No spawn attempt, executable discovery detail, path, or install suggestion that performs a download |
| Unhealthy                       | Runtime health is `unhealthy`, including crash-loop exhaustion                                                         | Typed unavailable outcome tied to `RUNTIME_UNHEALTHY`                                                                             | No last-known-good provider reuse, raw stderr, command line, or retry storm                         |
| Unsupported operation           | Operation is absent from candidate, negotiation, dynamic registration, or live agent vocabulary                        | Typed `UNSUPPORTED_OPERATION` or equivalent closed agent outcome                                                                  | No provider dispatch and no widening from static metadata                                           |
| Timeout                         | Fake provider accepts the request but exceeds the bounded language or client deadline                                  | Typed `TIMED_OUT`; the pending provider request is cancelled/discarded                                                            | No late success, body-bearing error, dangling timer, or reuse of timed-out data                     |
| Cancel before dispatch          | Caller signal is already aborted                                                                                       | Typed `CANCELLED`                                                                                                                 | No HTTP/provider request                                                                            |
| Cancel in flight                | Caller aborts after provider receipt and before response                                                               | Typed `CANCELLED`; cancellation reaches the in-flight request where supported                                                     | No late result publication, audit body, or leaked pending operation                                 |
| Truncation                      | Provider returns exactly the item/byte limit and then limit plus one                                                   | Boundary response is complete; over-limit response is either explicitly truncated where the contract permits it or rejected whole | No silent clipping, partial malformed item, unbounded allocation, or false `truncated: false`       |
| Workspace switch                | Session changes from workspace A to B before dispatch and while a request is in flight                                 | New requests bind only to B; A's in-flight result is cancelled or discarded as stale                                              | No A path, content, capability, provider result, or evidence associated with B                      |
| Stale activation revision       | Agent context was captured before disable, configuration change, rollback, or restart-required transition              | Dispatch re-reads current state and fails closed or uses only the new revision after a completed restart                          | No stale-revision provider dispatch or last-known-good success                                      |
| Stale capability snapshot       | Capability is dynamically unregistered, renegotiated away, or replaced by a newer snapshot before dispatch or response | Request is rejected before dispatch or late response is discarded                                                                 | No operation advertisement or result based on the older snapshot version                            |
| Restart                         | Provider restarts between context capture and action dispatch                                                          | Only the post-restart generation and current negotiated snapshot may serve the action                                             | No cross-generation response, request-id collision, or stale health reuse                           |
| Malformed or oversized response | Fake provider emits hostile JSON-RPC/result shape or an over-cap HTTP body                                             | Typed content-free failure; whole invalid result is discarded                                                                     | No parser exception detail, raw frame, partial result, or process/server secret                     |

For every transition test, capture the state, reason code, policy result, configuration revision,
capability snapshot version, and provider generation before and after the transition. Those values
must be asserted in memory but recorded as release evidence only if they are closed enums or bounded
numbers. Wall-clock sleeps are prohibited; deterministic barriers or injected clocks must control
every race.

## Containment, bounds, and hostile inputs

The security suite must include all of the following for both language lanes:

- empty, normalized, nested, maximum-byte, maximum-byte-plus-one, absolute, drive-qualified,
  traversal, mixed-separator, encoded-separator, NUL-bearing, symlink-escaping, and cross-workspace
  document and result paths;
- duplicate, overlapping, out-of-order, negative, non-integer, overflow, out-of-document, and
  excessive ranges and positions;
- zero, exact-cap, and cap-plus-one collections and UTF-8 byte payloads for diagnostics, locations,
  hierarchy nodes, inlay hints, rename proposals, code actions, route bodies, and tool output;
- invalid language identifiers, unknown operations and fields, mismatched session/action ids,
  duplicate idempotency keys, and malformed provider responses;
- provider results containing absolute workspace paths, executable/configuration paths, loopback and
  remote endpoints, environment values, command lines, stderr, secrets, tokens, and source canaries;
  and
- workspace switch, disable, dynamic unregistration, restart, timeout, and cancellation races at
  every barrier between admission, provider dispatch, response sanitization, action completion, and
  tool-output parsing.

Tests must search the serialized queued result, HTTP response, parsed tool output, audit entries,
managed-LSP evidence, operator diagnostics, and captured test logs for unique canaries. A pass
requires all forbidden canaries to be absent. Merely omitting assertions or replacing values in the
fixture before the production sanitizer sees them is not evidence.

## Redaction and evidence schema

Release evidence may contain only:

- repository commit and immutable test-artifact hashes;
- closed language, operation, state, reason, policy-result, outcome, and test-fixture identifiers;
- schema, configuration revision, capability snapshot, and provider generation numbers;
- bounded request, result, diagnostic, item, restart, cancellation, timeout, stale, and truncation
  counts;
- bounded durations, payload sizes, and memory measurements;
- provider/tool version identifiers that contain no path or environment data; and
- exact gate names, pass/fail outcomes, platform, and execution timestamp.

Release evidence, agent audit, managed-LSP lifecycle evidence, diagnostics, and test logs must not
contain source or replacement text, diagnostic messages, document or workspace URIs, absolute
paths, executable or configuration paths, runtime ids, argv, environment names or values, server
stdout/stderr, JSON-RPC bodies, HTTP bodies, endpoints, credentials, tokens, user identifiers, or
customer data. Root-relative paths may exist only in the transient bounded agent result required by
the user-facing operation; they must be represented by counts or hashes in persisted evidence.

The client must continue to replace route-provided free-form action, conflict, file-result, and
failure messages with the fixed redacted client message. Tests must prove that hostile route text
does not survive parsing even when the rest of the response is structurally valid.

## Review-only rename and code actions

Rename and code-action evidence is generation-only. The docked-agent integration may request
`renamePrepare` and bounded code-action proposals only where the live agent contract permits them.
It must not invoke `renameApply`, apply edits, execute commands, or translate a proposal into an
agent write action.

The suite must prove all of the following:

- no `save`, `applyTextEdits`, `applyPatch`, or `applyChangeset` action is queued as a side effect;
- no editor bridge write event, file-system write, staging operation, commit, push, pull-request,
  merge, deployment, or authority-widening call occurs;
- `workspace/applyEdit`, `workspace/executeCommand`, command-bearing code actions, create/rename/
  delete resource operations, and provider-initiated show-document requests are denied;
- every proposed text edit is bounded, non-overlapping, canonical, contained in the selected
  workspace, and pinned to the current document version or expected-content hash before any later,
  separately governed review path could accept it;
- malformed, duplicate, cross-workspace, symlink-escaping, stale-version, stale-hash, and excessive
  proposals fail closed as a whole; and
- action, audit, and evidence projections record only closed outcomes, counts, hashes, and the fact
  that human review remains required.

Add file-system and delivery spies at the owning boundaries and assert zero calls. A source-tree
hash before and after each generation scenario must be identical. A later human-approved apply flow
is a separate capability and is outside this integration evidence.

## Failure-first and mutation evidence

Each acceptance criterion in #2281 requires a regression test that fails for the intended reason
before the owning implementation is present and passes afterward. The pull request must retain the
failure-first command, failing test name, bounded failure excerpt, and fixed commit relation without
recording source, paths, or provider bodies.

Mutation or equivalent negative-control tests must fail when any of these protections is removed:

- real BFF or `EditorAgentHttpClient.action()` traversal;
- dispatch-time activation, policy, health, revision, provider-generation, or negotiated-capability
  checks;
- workspace containment or root-relative result projection;
- item, byte, response, deadline, retry, restart, or queue bounds;
- cancellation or stale-result suppression;
- explicit truncation or whole-response rejection;
- client-side route-message redaction;
- content-free audit/evidence projection; or
- review-only rename/code-action handling and zero-write enforcement.

Tests that pass after replacing the real BFF with a direct handler call, deleting the fake-provider
request assertion, or allowing an in-process fallback do not satisfy this evidence contract.

## Required evidence record

The pull-request verification log must include one row per language, operation, and failure-matrix
cell with these fields:

| Field          | Requirement                                                                         |
| -------------- | ----------------------------------------------------------------------------------- |
| Commit         | Immutable tested head SHA                                                           |
| Platform       | Operating system, architecture, Node version, and whether Linux/CI is authoritative |
| Language       | Closed managed-language id                                                          |
| Scenario       | Closed operation or failure-state id                                                |
| Product path   | Real BFF, agent action route, language control plane, and fake-provider markers     |
| State versions | Configuration revision, capability snapshot version, and provider generation        |
| Bounds         | Applied item, byte, deadline, queue, and restart limits                             |
| Outcome        | Typed status/error/reason code and pass/fail                                        |
| Redaction      | Canary count expected and observed; observed must be zero                           |
| Mutation       | Negative-control identifier and expected failure observed                           |
| Artifact       | Hash of bounded machine-readable test output; never a raw request/response capture  |

Missing, skipped, flaky, retried-until-green, stale-commit, or platform-inapplicable rows are not
passes. Record them as explicit limitations and keep the corresponding release claim disabled.

## Required gates

Before release or any push, run the exact targeted integration and security test commands added by
the implementation, followed by all applicable local equivalents of repository-required checks.
The mandatory baseline is:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run arch:check
npm run arch:check:negative
npm run test:coverage:quality
```

If the implementation changes a public package surface, also run:

```bash
npm run build
npm run check:package-surface
```

The required GitHub `ci` check and every repository-required action, security, build, scan, SBOM,
dependency-review, and UI check must pass on the immutable pull-request head. The verification log
must record exact commands and outcomes. No coverage floor, assertion, limit, timeout, policy,
redaction rule, architecture boundary, release-evidence check, or governance gate may be lowered to
obtain a pass.

## Limitations and release disposition

Hermetic fake-provider tests prove Keiko's routing, negotiation, failure handling, containment,
redaction, and authority boundaries; they do not prove compatibility with every real provider
version or every project layout. Real-provider compatibility evidence belongs to the corresponding
provider conformance profile and remains subject to operator provisioning and no-download rules.

An unsupported hierarchy or inlay operation, an unproven provider version, or a safe-mode feature
limitation must remain absent from effective docked-agent capabilities and be recorded as an
explicit limitation. It must not be converted into support by static descriptors, UI labels, stale
snapshots, or documentation. Rollback disables the affected agent-visible capability or provider
while preserving the existing TypeScript path, server-owned activation state, content-free evidence,
and review-only edit boundary.
