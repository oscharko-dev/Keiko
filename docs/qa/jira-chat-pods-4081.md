# Epic #4081: Jira access Pods in Chat

## Delivery contract

Owner instruction, 2026-10-26: implement the complete epic on branch
`codex/4081-jira-chat-pods` and one regular pull request against `dev`.
No child pull requests; auto-merge stays disabled. Publish signed incremental commits
approximately every 10–15 minutes with targeted checks for the affected behavior.
Run the complete applicable quality gates and Sonar at final acceptance. This scoped
execution amendment supersedes the issues' earlier per-child PR and full pre-push
check cadence; no acceptance criterion, required CI check or security boundary is waived.
Integration requires separate owner authorization. Issues remain open until verified merge.

## Revalidation

Implementation starts from `1c4464abbf1b352d3c280e7c67d9dcf2f1b22f10` (`dev`).
PR #4076 is integrated. Reconcile overlapping work in #4013 (contracts, Chat and
connector tests), #4074 (dependencies), #4080 (guidance filename), and #4092
(release versions/evidence). #3943 remains a separate server-boundary workstream.
This epic owns the Jira/shared-contract subset needed from #2953; its Confluence
acceptance remains open. Existing #2952 performance ceilings remain authoritative.

The independent Jira 10.3.26/PostgreSQL 16 lab is present. Its current bootstrap has
no HTTPS frontend. Checkout dependencies, USearch and ripgrep are now provisioned.
A running container is not a passing license, write-availability or model preflight.
No live qualification or completed acceptance is claimed here.

## Architecture and boundaries

Use the existing connector custody/HTTP, catalog binder, authority, conversation,
workspace and Activity Log owners. Add one `keiko-mcp` package for the official SDK
client/server at exact version 2.4.0 and explicit MCP 2026-07-28 in-process transport.
No per-Pod listener, arbitrary REST proxy, customer fixture or parallel policy store.
Extend contracts additively and preserve Cloud/Data Pod/Workbench behavior.

Persist the canonical mutation identity before dispatch and its observed result before
resuming orchestration. Never automatically repeat a completed or uncertain mutation.
Keep confirmed, acknowledged-but-unconfirmed and unknown outcomes distinct.
A bound Chat gets one current-generation read grant and the existing three-mode write
policy; grants and approvals never survive invalidation by acquiring new credentials.
Mixed-source turns retain original cumulative budgets and grounded synthesis limits.

## Acceptance map

Each numbered row is a separate obligation. `Pending` means unproven, including any
implementation already present. Behavioral changes need a meaningful red/green proof;
compatibility uses baseline/post-change checks; delivery uses the actual artifact/check.
Evidence records the tested source identity, command, outcome and relevant limitation.

### #4082 — Support Jira Data Center PAT connections through the existing Atlassian connector

- [ ] **AC1:** A generated PAT for a non-admin lab user verifies against real Jira 10.3.26 at REST v2. Invalid/revoked PAT, insufficient permission, redirect, HTML/login response, unsupported version, stopped Jira and timeout have distinguishable safe outcomes; an HTML 2xx is never `ok`. Cloud Basic/v3 behaviour passes its existing regression tests, and a non-mocked UI-client → route test proves real Cloud and Data Center creation (the omitted `authScheme` defect fails this test before the fix).

Status: **Partial — not accepted**. Data Center REST-v2/PAT verification and the real UI-client credential request fix are implemented. Retained HTTP/client, verification and Cloud regressions are recorded below. Renewed licensed non-admin/restricted-user qualification remains pending.

- [ ] **AC2:** Name/base URL/deployment/credential reference persist through the current owner; cleartext PAT is absent from saved metadata, responses, browser recovery, MCP configuration, logs and evidence. Resolve the PAT only at outbound execution; Keiko-managed rotation/revocation updates the connector generation for dependent consumers. Jira-side revocation is enforced by Jira on each call; an observed auth failure invalidates local readiness and pending work.

Status: **Partial — not accepted**. The existing vault stores tokens; public credential projections exclude private Pod facts. HTTP factories pin the selected credential generation before materialization. Custody and actual HTTP regression proofs are recorded below. Rotation and observed-call invalidation of Chat grants/approvals remain pending.

- [ ] **AC3:** Root and non-root Jira context paths work. Exactly admitted enterprise/private and trusted local-lab HTTPS targets work; other hosts/ports, path escape, Keiko's own listener, metadata/link-local addresses, DNS rebinding and mixed-class answers, cross-origin redirects, untrusted certificates and expired certificates remain refused, including the proxy path. Admission cannot be enabled through environment variables or the global private-egress flag.

Status: **Partial — not accepted**. Exact operator-owned HTTPS targets, context paths, direct/proxy pinning and network refusals are implemented with retained transport regressions below. Final licensed/network qualification on the completed head remains pending.

- [ ] **AC4:** Existing saved Cloud connectors and Data Pods load without migration loss. Live Jira Pod creation and readiness do not require USearch, an embedding model, indexing or a sync job. A Data Center connector refuses sync with a closed reason and performs no sync request; Cloud sync is unchanged.

Status: **Partial — not accepted**. Legacy Cloud custody remains readable and Data Center sync is explicitly refused. Retained Cloud/sync regression evidence is recorded below. Live-Pod Hub integration and the complete Data-Pod regression run remain pending.

- [ ] **AC5:** A repeatable local-only bootstrap/preflight produces every listed fixture class, verifies license validity and both reads and writes, preserves volumes and never prints credentials. The published timebomb license is re-entered per qualification session by owner decision; there is no clock change, license modification or customer licensing.

Status: **Partial — not accepted**. The local synthetic Jira/PostgreSQL/HTTPS lab and fixture work are retained below. Fully repeatable bootstrap and renewed complete licensed session groups remain pending; no current valid license or final live pass is claimed.

- [ ] **AC6:** Real adapter and registered Activity Log tests prove successful and failed paths without retaining tokens, endpoint strings, identity data, request bodies or raw provider errors. All applicable gates pass on the actual implementation head.

Status: **Partial — not accepted**. Registered creation, listing, verification and rejection evidence and real transport/custody tests are implemented. The checkpoints below record executed writer/reader and scoped gate results. Final aggregate and live gates remain pending.

### #4089 — Establish a shared MCP host for Keiko-managed providers and governed non-OpenCode consumers

- [ ] **AC1:** A real SDK client and server execute MCP 2026-07-28 through the modern in-process request path without sockets or spawned processes. Tests exercise `server/discover`, `tools/list`, `tools/call`, required per-request metadata and unsupported-version rejection, and record the actual protocol revision. Malformed messages, unknown tools and schema-invalid arguments are refused before a handler runs. A legacy `initialize` handshake or linked in-memory transport alone does not satisfy this criterion; legacy compatibility is tested separately only if deliberately implemented.

Status: **Partial — not accepted**. The shared official-SDK host explicitly enables MCP 2026-07-28 over injected in-process fetch. Actual SDK discovery/list/call and malformed/protocol regression evidence are recorded in the host checkpoints below. Final complete-head qualification remains pending.

- [ ] **AC2:** Every tool the model can see originates from a compiled `keiko-tool-catalog` projection through the bound gateway advertisement; a hand-written, unknown or post-admission-drifted tool cannot be advertised or dispatched. Existing `projection-mismatch` protection stays green.

Status: **Partial — not accepted**. Managed discovery compiles into the canonical catalog and gateway offer; drift/schema/override rejection is exercised by the retained binder/SDK tests. Ordinary-Chat tool-loop composition remains pending.

- [ ] **AC3:** Call context is injected server-side only; routing and authority overrides are refused. Ordinary links in supported issue content remain data. Interleaved calls from two differently bound consumers, with cancellation and reversed completion order, cannot observe or use each other's context. Unsupported SDK input fulfillment or retries cannot bypass canonical admission and invocation accounting.

Status: **Partial — not accepted**. The host injects isolated invocation context and refuses routing/authority overrides; retained interleaving/cancellation and binder tests are recorded below. Actual product Chat lifecycle integration remains pending.

- [ ] **AC4:** The admission pipeline composes stricter-wins in all three modes; a denied call performs no handler call; approval and grant redemption re-validate binding, generation, envelope, mode and budget; cancellation and timeout settle exactly once.

Status: **Partial — not accepted**. The generalized binder, shared mode policy and once-only settlement are implemented and scoped regression evidence is retained below. Chat-specific grants, approvals and their full redemption checks remain pending.

- [ ] **AC5:** An import of `@modelcontextprotocol/*` outside the host fails `arch:check`, proven by a negative fixture in `arch:check:negative`; dependency matrix, currency, hygiene, SBOM and package-surface gates pass.

Status: **Partial — not accepted**. The SDK import boundary, package registration and negative fixture are implemented. Final complete dependency/SBOM/package-surface and architecture gates remain pending; the paired architecture/performance review stays open.

- [ ] **AC6:** Registered body-free Activity Log events reconstruct provider admission and the call lifecycle with correlation and failure classes; existing Workbench MCP registry, relay and OAuth suites are unchanged and green. All applicable gates pass on the actual implementation head.

Status: **Partial — not accepted**. Registered host/catalog lifecycle evidence and scoped Workbench regressions are recorded below. Final full Workbench suites and aggregate Activity Log/quality gates remain pending.

- [ ] **AC7:** A hermetic non-Coding consumer executes through the production catalog binder and admission pipeline without a synthetic Coding session or workspace authority. Existing Coding identity, mutation and approval guards retain their regression coverage.

Status: **Partial — not accepted**. The independent non-Coding consumer exercises the production binder, gateway and actual MCP host without a synthetic Coding session. Managed mutation tests additionally compose the durable journal. Product Chat authority and final regressions remain pending.

### #4083 — Expose Jira Data Center ticket operations as the first managed provider on the shared MCP host

- [ ] **AC1:** Real modern MCP discovery, per-request protocol metadata, `tools/list` and `tools/call` through the shared host exercise the production Jira provider and list exactly the implemented typed capabilities; every listed tool has a catalog descriptor and an ADR-0128 D4 row. Unknown tools, malformed arguments and caller-supplied credentials, arbitrary destinations or connector switching are refused before HTTP execution.

Status: **Partial — not accepted**. The catalog advertises nine reads and five mutations through the actual SDK host; canonical schema, drift and override refusals are exercised below. Ordinary-Chat tool authority/admission and final qualification remain pending.

- [ ] **AC2:** Against local Jira 10.3.26, a non-admin PAT searches/reads and performs create/edit/assign/comment/transition where Jira permits them, and the restricted identity is refused truthfully without escalation. The recorded supported-operation matrix names each tested operation, endpoint family and unsupported capability; it never claims full Jira REST coverage.

Status: **Partial — not accepted**. The Data Center mutation executor is composed with the durable journal and SDK binder. Executor and real SDK/journal integration evidence is recorded in the mutation/composition checkpoints below. Product Chat authority and the licensed non-admin/restricted-identity matrix remain pending.

- [ ] **AC3:** Required supported custom fields, constrained fields and workflow-specific transitions are discovered/validated from real metadata through the post-9.0 endpoints. A real transition-screen fixture requires a supported field; omitting it fails, and the approved field value and transition succeed in one request. Undeclared mutation verbs, worklogs and unsupported compound effects are refused before HTTP. Unknown plugin-specific field types are reported as unsupported with no fabricated values. Missing/invalid values and unauthorized issues/actions produce honest safe errors without escalating to an admin identity.

Status: **Partial — not accepted**. Bounded field/verb validation and fresh metadata checks are composed with managed writes and the journal; retained field, executor and SDK tests are recorded below. Product Chat authority, complete unsupported-field presentation and the licensed metadata/transition matrix remain pending.

- [ ] **AC4:** Pagination, empty results, partial results, bounds, timeout and cancellation behave deterministically. Jira content and tool metadata cannot modify the tool allowlist, credential, chat binding, read grant or approval state.

Status: **Partial — not accepted**. Read pages and complete issue results have aggregate byte bounds; retained SDK/host tests exercise these and cancellation/override guards. Full per-operation pagination/cancellation and product Chat lifecycle qualification remain pending.

- [ ] **AC5:** Tests distinguish malformed/truncated acknowledged 2xx from unknown remote effects, and prove no blind mutation replay after timeout, committed-then-5xx or cancellation. They cover intervening field/assignee changes and operation-aware retry safety, not only duplicate POST. Route, canonical tool outcome, activity and UI folds agree; an empty reconciliation search never authorizes a retry. Approved action changes invalidate stale approval. Document the concurrency limit of operations without an atomic Jira precondition; do not claim universal exactly-once execution or lost-update prevention.

Status: **Partial — not accepted**. Managed writes use the durable canonical-turn journal, acknowledgement/read-back outcomes and GET-only physical retries. Restart, unknown-effect, replay and actual SDK/journal evidence is recorded below. Approval invalidation, product Chat/UI folds and licensed remote-effect counts remain pending.

- [ ] **AC7:** With no explicit ceiling configured, the connector policy evaluates Chat-consumer and Coding-run calls against the same resolved `autonomous-delivery` ceiling; `KEIKO_CODING_DEPLOYMENT_CEILING=governed-assist` clamps both, and an unrecognized value fails closed to `governed-assist`. Proven through the production policy and composition, not a hand-built deps object.

Status: **Partial — not accepted**. Implementation: shared deployment-ceiling resolver in production composition. Verification: production `buildUiHandlerDeps` and connector policy tests. Evidence: deployment-ceiling checkpoint below. Actual Chat authority composition remains pending.

- [ ] **AC6:** Tool descriptions, inputs and output envelopes contain no PAT; activity/evidence contain no Jira content or private endpoints. Existing Cloud v3 services and Workbench MCP tests remain green.

Status: **Partial — not accepted**. Private invocation connections, public projections and body-free registered evidence have retained secret-absence and Cloud regression tests below. Final complete Cloud/Workbench regressions and aggregate gates remain pending.

### #4084 — Bind one Jira Pod to ordinary Chat with per-chat mode, Chat authority and a one-time read grant

- [ ] **AC1:** Server-side concurrent connect/replace requests cannot leave two Jira Pods attached to one Chat. The binding, grounding identity and generation update atomically through the authenticated PATCH pattern; restart/reload restores valid bindings without cross-chat or cross-token reuse. A registry entry, guessed ID, client-side edge or another Chat's binding grants no access, and a Chat without a binding offers no Jira tool to the consumer context.

Status: **Partial — not accepted**. Schema 49 and the authenticated PATCH/serializer now atomically persist one owned verified Pod, mode and scope generations. Reopen/store and actual HTTP conflict/selection evidence is retained below. Tool offers and full Chat authority/lifecycle integration remain pending.

- [ ] **AC2:** All three modes have explicit regression coverage through the shared action-class policy, including per-chat mode persistence, the unconfigured `autonomous-delivery` tool-source ceiling delivered by the one server resolver from #4083 and an explicitly narrower ceiling: required approval precedes network/effect, denied actions make no call, bounded allowed actions execute without invented extra approval. The read grant is requested once, covers only read-class tools of the current binding and credential generation, and never covers writes. Missing/expired authority remains denied in every mode.

Status: **Partial — not accepted**. All three mode selections persist through the actual Chat PATCH; the shared action policy and deployment ceiling have scoped regression evidence below. Once-per-binding read grants, approval redemption and ordinary-Chat execution remain pending.

- [ ] **AC3:** Disconnect, replacement, Pod deletion and Keiko-managed token rotation/revocation revoke read grants and invalidate pending approvals and queued calls. Jira-side token revocation is enforced on the next Jira call; observed auth failure invalidates local readiness and pending work without introducing polling or webhooks. Tests cover these changes during approval and before effect; no stale request uses the old or newly substituted credential.

Status: **Partial — not accepted**. HTTP generation capture, verification ticket settlement and atomic binding generations prevent the implemented stale credential/probe/update paths. Retained real-route proofs are recorded below. Rotation, observed-call failures and coordinated grant/approval/queued-call invalidation remain pending.

- [ ] **AC4:** Two chats using different Pods are isolated; two chats deliberately using the same Pod share neither grants nor approval state; a new or copied Chat identity cannot inherit grants or approvals. Data-Pod-only grounding is byte-for-byte unchanged in behaviour and existing Workbench MCP works unchanged.

Status: **Partial — not accepted**. Actual competing binding PATCH tests preserve one binding and leave another Chat unchanged. Shared-Pod grants/approvals, parallel tool execution isolation and final Data-Pod/Workbench regressions remain pending.

- [ ] **AC5:** Production-path lifecycle logging for binding, mode, grant and approval is registered and body-free. Restart and authority/mode changes cannot revive expired grants, approvals or queued effects. All applicable gates pass.

Status: **Partial — not accepted**. Existing registered Chat scope evidence reconstructs one application, denials and conflicts without private facts; credential lifecycle evidence is recorded below. Remaining authority/lifecycle/restart events and final gates remain pending.

- [ ] **AC6:** Through the trusted non-Coding test consumer against local Jira 10.3.26, an admitted read-class call reaches the real provider only with a valid grant, and a write-class call only under the mode matrix or a redeemed approval that re-ran the complete pipeline; a denied, expired or revoked call performs no HTTP request.

Status: **Partial — not accepted**. A real non-Coding catalog/SDK consumer and normal authenticated Chat binding API exist without a Coding session. Full product Chat authority/policy/tool execution against licensed Jira remains pending.

### #4091 — Run a governed tool loop in ordinary Chat through the shared MCP host

- [ ] **AC1:** Before this child closes, an authenticated normal Chat API performs a read and a governed write through the real gateway → production catalog binder → shared MCP host → local Jira 10.3.26, using a verified tool-capable real model and checking remote state. Exercise both buffered and streaming turns; the unfinished UI is not a substitute runtime or a reason to defer this proof to #4087. A normal Chat with a valid connected Jira Pod discovers and invokes the real provider through the shared host; a Chat without that binding is offered no Jira tool. A registry entry, guessed ID, client-side edge or another Chat's binding grants no access.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC2:** In-flight cancellation never reports a false rollback or false success. An already applied Jira effect is shown as completed; uncertain outcomes are reconciled or clearly shown as unknown, without automatic duplication.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC3:** Data-Pod-only grounding is byte-for-byte unchanged in behaviour, the mixed-scope schedule is tested through actual gateway admission, existing Workbench MCP works unchanged, Jira works with no embedding/index setup, and a model without verified tool calling yields the truthful unavailable state instead of silently answering without tools.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC4:** Production-path tool-loop lifecycle logging (offered, started, grant-required, approval-required, completed, failed, unknown) is registered and body-free; the provider receives only authorized scoped calls; tool output and prompt injection cannot extend authority, select a credential or change the binding. All applicable gates pass.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC5:** Response-loss, duplicate-delivery, streaming fallback, context-window retry, reconnect, reload and Regenerate tests assert Jira mutation counts. Completed or unresolved effects are not replayed; crash recovery presents unknown outcomes truthfully. Compaction and provider-adapter round trips preserve tool-call/result IDs, relationships and cumulative usage.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC6:** Mixed Jira/Data-Pod turns retain separate source attribution and the existing physical grounded-synthesis ceiling across orchestration, retries and repair. Production-path tests exhaust each cumulative budget without resetting it. Restart and authority/mode changes cannot revive expired grants, approvals or queued effects.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

### #4085 — Create and manage Jira access Pods in the existing Knowledge Pods hub

- [ ] **AC1:** The existing Knowledge Pods hub offers Data and Jira creation. A Jira Pod is created using name, address and PAT against the real local lab through the production API; Data creation and existing saved Pods, including synced Jira knowledge Pods, still work and remain distinguishable.

Status: **Partial — not accepted**. The existing credential API can create owner-bound Data Center Live-Pod metadata through the real vault. Public responses omit private metadata. Hub creation/forms, Live-Pod projection and browser/Data-Pod qualification remain pending.

- [ ] **AC2:** The PAT is write-only, cleared on save/cancel/unmount and never returned in later reads, stored in browser persistence, placed in URLs, screenshots, analytics or error strings. Duplicate submits/retries do not create duplicate Pods or orphan credentials.

Status: **Partial — not accepted**. Write-only custody, owner-bound creation-intent conflict handling and explicit public GET/Create projection are covered by retained actual HTTP tests. UI secret clearing/persistence checks and the complete duplicate-submit/retry journey remain pending.

- [ ] **AC3:** The card reports actual verification status. Bad/revoked token, inaccessible Jira, trust failure, redirect/HTML response, permission refusal and, where observable, license or read-only restrictions have actionable bounded presentation; saving or probing identity does not promise every action is permitted.

Status: **Partial — not accepted**. Bounded Data Center probes and generation/revision-aware verification settlement are composed through the actual HTTP route, including failures, deletion races and internal aborts. Cards/actionable UI and licensed restriction qualification remain pending.

- [ ] **AC4:** Rename, reverify, token replacement and removal survive reload and use the existing server owner. Tests delete/replace a Pod-owned credential through the existing credential route while two Chats share the Pod and deliver stale verification replies after rotation; neither alternate entry points nor late replies restore stale access. Removal deletes the owned credential and dependent Chat bindings; token rotation preserves their visible association but invalidates authorization, read grants and pending work until re-verification; deleting one Pod never damages unrelated credentials or Data Pods.

Status: **Partial — not accepted**. Owned credential deletion and stale-verification refusal are exercised through actual routes; binding/readiness generations persist in existing owners. Rename, rotation, dependent-Chat cleanup, restart coordination and grant/approval invalidations remain pending.

- [ ] **AC5:** The ordinary Jira form requires no email, MCP configuration or vector-index setup. The initial implemented ticket capabilities are explained plainly without claiming all Jira APIs or guaranteed write permissions.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC6:** The relevant design-state matrix, keyboard/focus/screen-reader behavior, English/German text, light/dark/high-contrast and reduced-motion/zoom proofs pass with synthetic visible data. UI and wired browser gates pass.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC7:** Live-access Pod variants cannot enter capsule-set composition, capsule export or indexing through either UI or direct server requests. They advertise no fabricated capsule, retrieval or storage state, and unsupported Cloud sync controls are absent. Existing Data and synced-Jira Pods preserve these capabilities.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

### #4086 — Connect Jira Pods to Chat using existing workspace connectors and in-Chat tool cards

- [ ] **AC1:** Drag/drop and the existing keyboard alternatives (port buttons and the Chat header select) can place and connect the same saved Jira Pod. The server acknowledges the connection before the UI indicates active tool access; a failed operation leaves no phantom edge or duplicate authority.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC2:** Connecting a second Jira Pod requires an explicit replacement interaction, and the server still enforces one. Cancel or a failed replacement preserves the old binding. Successful atomic replacement invalidates old grants and pending work without granting both Pods, and replacement/disconnect updates edge, source indicator and tool availability coherently. Data Pod connections continue to function.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC3:** Before this child closes, the assembled browser journey creates/connects a Pod and performs a read and governed write through normal Chat to the real local Jira lab, verifying remote state. The user can search/read/create/edit/assign/comment/transition via normal Chat through the actual MCP path and see clear sources, progress and remote outcome. Identical ticket keys on different Jira instances are distinguishable in authorized presentation.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC4:** The read-grant request appears when the current binding/credential generation has no valid grant; a still-valid grant, including one restored after restart, does not prompt again. Approval UI appears exactly when current policy requires it; both identify the proposed scope or action and support deny/cancel. Stale grants or approvals after disconnect/token change cannot execute; pending/expired/unknown/partial/error states are truthful.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC5:** Reload, network interruption, Pod removal, Jira shutdown and token replacement preserve the authoritative state without stale access. Retry, reconnect and Regenerate never silently repeat a completed or uncertain Jira mutation; retain its canonical outcome and show safe reconciliation. Browser tests lose the response after Jira accepts a write, deliver duplicates and regenerate, then assert remote effect counts. Restored bindings cannot recreate missing/expired grants or approvals. All content-bearing presentation follows existing retention/redaction rules and is excluded from diagnostics/evidence.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC6:** Root connector/window/tool/source/permission designs and relevant state/accessibility/theme requirements are met; existing workspace/Data Pod/Workbench journeys remain green.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC7:** The Chat mode selection persists per chat, defaults to Ask for approval, shows ceiling-clamped modes truthfully, and a model without verified tool calling presents an actionable unavailable state instead of silently answering without tools.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

### #4087 — Qualify the complete Jira Pod to MCP to Chat workflow against local Jira 10.3.26

- [ ] **AC1:** Every initial supported operation has a real end-to-end receipt from normal Chat through the shared MCP host to local Jira 10.3.26, with remote read-after-write verification and only synthetic data. The assembled artifact/source identity, commands, model identity, test versions, wiring class and outcomes are recorded without secrets or bodies.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC2:** All-mode, read-grant and Jira permission cases pass: no unauthorized effect; allowed operations work; approval denial/cancellation and stale approval or grant perform no new call. Ordinary Chat is tested directly rather than a Workbench-only substitute.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC3:** Isolation/revocation, replay-prevention and restart tests pass, including two chats, deliberate reuse of one Pod, different Pod credentials, replacement, disconnect during approval and token rotation. Tests assert remote effect counts after lost responses, duplicate delivery, retries and Regenerate. Completed remote effects are not falsely described as rolled back; acknowledged-but-unconfirmed and unknown outcomes remain distinct. Old verification replies and alternate credential-management entry points cannot restore revoked readiness.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC4:** The small UI flow matches the root design reference and passes keyboard, screen-reader, theme/contrast, reduced-motion and constrained-layout checks. Product readiness does not depend on embedding/indexing.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC5:** Existing Data Pod grounding, Cloud connector and Workbench MCP regressions pass, and the deterministic lane runs in its wired CI class. Timeout, pagination, cancellation and response-size tests show bounded behavior; existing performance ceilings remain unchanged.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC6:** The independent local lab preflight proves license validity and both read and write availability. A stopped instance, expired license or missing trusted test endpoint is reported as blocked real qualification; no silent skip, customer fallback, clock change or license modification is accepted.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC7:** Applicable local gates including Sonar and the complete required PR checks pass on the delivered head; all review findings are settled. Only then are final evidence and AC completion recorded, with owner-authorized merge verified before issue closure.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC8:** User/developer runbooks and release-impact metadata accurately describe initial API coverage, setup, privacy (ticket content reaches the configured model), mode and read-grant behavior, troubleshooting and remaining limitations. No claim of generic full-API coverage, all-source MCP migration or customer-network certification is made.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC9:** Before the live run, record the finite acceptance scenario/operation matrix, qualified model configuration and expected outcomes. Every required operation has successful live evidence and every required refusal has evidence of no unauthorized effect. Record failed attempts and repairs as well as the successful run; model retries or selective reruns must not hide failures. The report states the exact Jira/model/deployment scope proved and does not extrapolate to arbitrary customer workflows, plugins or networks.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

## Verification checkpoints

### Initial Cloud creation regression (#4082 AC1, partial)

The real UI client previously omitted `authScheme`; the actual HTTP route rejected its
request with `VALIDATION_FAILED` (`authScheme must be basic-api-token`). The new
`tests/atlassian-connector-client.integration.test.ts` failed on that exact defect before
the fix. It now traverses the real client, HTTP server, route, custody, private metadata
store and encrypted vault; only browser-relative URL resolution is supplied by the test.
It verifies successful creation/listing, secret absence and the matching Activity Log
correlation. Data Center creation and real remote verification remain pending.

Targeted local results on the initial implementation diff, 2026-10-26:

- `npm run build:packages`: passed.
- `npm run typecheck --workspace @oscharko-dev/keiko-ui`: passed.
- `npx vitest run tests/atlassian-connector-client.integration.test.ts packages/keiko-server/src/atlassian/credentialActivity.test.ts packages/keiko-server/src/atlassian/credentialRoutes.test.ts packages/keiko-connectors/src/atlassian-credential-custody.test.ts`: 71 passed.
- `npm test --workspace @oscharko-dev/keiko-ui -- src/lib/atlassian-connectors-api.test.ts`: 9 passed.
- ESLint on changed implementation/tests: passed; root invocation emitted the existing Next Pages-directory notice.
- `npm run generate:op-catalog`: passed, zero registration/inventory violations, 604/604 resolved proofs.

These focused results do not substitute for final current-head gates, real-model
qualification or settled reviews. All 55 complete acceptance criteria remain open.

### Data Center custody and verification increment (#4082 AC1/2/4/6, partial)

Shared contracts now distinguish Cloud Basic from explicitly selected Jira Data Center
PAT connections. Legacy Cloud metadata and vault envelopes retain their original shape.
Data Center metadata starts at generation 1. The token is materialized as a Bearer header
only in the existing outbound adapter. Generation changes and invalidation are still pending.

The new Data Center creation tests failed before this increment (unsupported scheme and
rejected UI request) and pass afterwards. The real UI client/HTTP route/custody/vault test
also traverses the actual outbound adapter with synthetic fetch responses: REST-v2 version
and active identity checks preserve the context path, and sync is refused without an extra
outbound request. This is deterministic composition evidence, not a real Jira-lab result.

Verification reads at most 64 KiB per response and shares one 30-second deadline across
`serverInfo` and `myself`. Only Jira Data Center 10.3.26 is admitted. Redirect, invalid/HTML,
authentication, permission, unsupported-version, TLS and network outcomes are closed;
English/German presentation is included. `atlassian.connection.checked` records only the
action and outcome with correlation and completeness/loss markers. An initial proof exposed
redaction of the generic field name `result`; the producer now uses the permitted closed
`outcome` field, leaving the security redactor unchanged.

Targeted results on this increment, 2026-10-26:

- Package build and UI TypeScript check passed.
- Nine affected connector/server/client suites: **178 passed**.
- UI API and status-label suites: **15 passed**.
- Changed-source/test ESLint, formatting and `git diff --check` passed.
- Operation generation: **605/605** resolved proofs, zero registry/inventory violations.

Still pending: exact operator-configured private target admission, lifecycle invalidation,
real HTTPS lab and real-model qualification, complete epic implementation and final gates.
The message catalogs changed; updater UI evidence must be regenerated through its original
producer before final acceptance. Public-contract/export changes still require final package
surface qualification. These pending checks are not represented as passing.

### Exact private-network admission increment (#4082 AC3, partial)

The existing operator configuration accepts `atlassian.privateTargets`, an array of at
most 64 exact HTTPS base URLs with `addressClass: "private" | "loopback"`. The hostname,
port and context path must match the stored Data Center connection. Global permissive
egress flags and request bodies cannot grant this admission. Setup rebuilds and reloads
preserve the operator block. Safe config projections omit it. Context paths are canonical,
without encoded separators, percent escapes, repeated separators or dot traversal.

The existing gateway pins direct and proxied connections to the vetted DNS result and now
enforces the declared address class on every resolved address. Mixed public/private DNS,
metadata/link-local targets and the active BFF listener remain denied. Removing the operator
entry takes effect on the next request. Cloud connectors retain their existing restricted
network posture. A context-path escape regression failed before the containment fix.

Targeted results on this increment, 2026-10-26:

- Package build passed.
- Seven gateway/config/setup/connector/client suites: **907 passed**.
- Final client/transport rerun including actual BFF-listener isolation: **49 passed**.
- Changed TypeScript source/test lint and formatting passed.

This is deterministic transport/configuration evidence; real HTTPS Jira qualification is
still pending. The auditor identified the existing Cloud HTML-2xx false-positive in the
status-only verification path. That finding is accepted and will be fixed next for both Jira
and Confluence Cloud, with real client-to-route regression tests. No complete AC is closed.

The cross-boundary client fixture now lives in the UI test lane and imports the built server:
`packages/keiko-ui/src/lib/atlassian-connector-client.integration.test.ts`. This preserves
separate browser and Node compiler environments while exercising the real HTTP server/vault.
The root TypeScript check and UI TypeScript check pass; the final UI client/integration run
passed **12 tests**. Root test narrowing was updated for the credential discriminated union.
The operation catalog remains **605/605** proofs with zero inventory violations.

The fixture move initially triggered `proof-outside-owner`: a UI test cannot own the server
operation's proof. The follow-up uses the existing `expectRegisteredActivityLogLine` helper
for cross-package evidence; the owner proof remains in `credentialActivity.test.ts`.
Regeneration now passes with **605/605** proofs and zero violations. Two valid review comments
are also addressed: the owner proof asserts `authScheme`, and the real support analyzer must
retain the event in the correlated timeline. Package build, root typecheck, affected lint,
7 owner tests and 3 client/HTTP integration tests passed after the correction.

### Cloud HTML/identity verification correction (#4082 AC1/2/6, partial)

The auditor finding was reproduced through the real browser client, HTTP route, vault and
outbound adapter: both Jira and Confluence Cloud returned `ok` for HTML-200 responses.
Those two regression tests failed before the fix and pass now. Valid JSON responses and
Basic authentication passed both before and after. Both Cloud paths now use the existing
bounded body transport and the same JSON/status parser as Data Center; no parallel verifier
or credential path was introduced. The current-user result must contain a bounded nonempty
account ID and an active Jira user or known Confluence user. Malformed/truncated/oversized
bodies and anonymous users are rejected. Remote content never enters the result or log.

Targeted results: package build, root and UI typechecks, changed-source/test lint and formatting;
**73** connector/server tests and **7** real client/HTTP tests passed. The final route rerun
passed **25** tests. The operation catalog has **605/605** proofs and zero violations.
The accepted HTML finding is fixed; real HTTPS lab qualification and the remaining epic
criteria are still pending.

### Real HTTPS transport checkpoint (#4082 AC3/AC5, partial)

The committed `scripts/testing/jira-chat-lab` tooling creates a private laboratory
CA/server certificate and a loopback-only TLS frontend for the existing synthetic Jira.
It leaves system trust unchanged and forwards only to one fixed loopback backend.
The production custody, encrypted vault, HTTP adapter and domain verifier were exercised
against actual Jira 10.3.26: trusted HTTPS returned `ok`, removing CA trust returned
`tls-failed`, and revoking exact operator admission returned `unreachable`. All three
probes passed; script lint and formatting passed. The temporary vault was removed.

The independent license preflight found the existing ten-user Data Center test license
expired. A normal update did not renew it. The probes above are exploratory transport
checks, not an accepted scenario group: complete live acceptance must run again under a
valid license with the read/write preflight and all required fixture classes. Fresh-session
provisioning and the remaining live prerequisites are open. No AC is closed by this checkpoint.

### Fresh-session provisioning checkpoint (#4082 AC5, partial)

Added pinned Jira/PostgreSQL Compose configuration and a private session launcher.
Each newly initialized session gets an independent Compose project, volumes and
three distinct private passwords; stop retains its data. Existing laboratory data
is untouched. Initializer assertions verify the synthetic manifest, independent
secrets and file permissions; start/status were exercised on the fresh instance.
Script lint and formatting pass.

The normal Jira first-run UI accepted the published test license in the fresh
instance. The admin API then reported `valid: true`, `expired: false` and 10,553
seconds remaining. This resolves the expired-instance prerequisite for the current
session without changing clocks or licensing code. Automated setup, complete
synthetic fixtures and licensed read/write/model/browser qualification remain open.

### Licensed basic fixture and Compose TLS checkpoint (#4082 AC3/AC5/AC6, partial)

The digest-pinned Compose frontend now exposes only loopback HTTPS, mounts its server
key/certificate read-only, and leaves the development CA key on the host. The basic
seed checked license validity, created the non-admin PAT actor and three synthetic
issues, and independently read all three back. Repeating the seed reused the PAT and
issues without another creation. The production vault/adapter/verifier then passed
trusted HTTPS, untrusted-CA refusal and revoked-admission refusal through this
frontend. License checks remained valid before and after the group. Script lint,
formatting and actual Compose startup passed.

This supersedes the original expired-instance transport-only checkpoint for these
three cases. Fixture administration currently uses the private loopback admin path;
product qualification uses HTTPS. Required permission/custom-field/transition-screen,
pagination, hostile-content and isolation classes, automated setup, product mutations,
model/browser qualification and the remaining complete ACs are still pending.

### Permission fixture checkpoint (#4082 AC5, partial)

The reproducible seed now creates four independent non-admin PAT actors and two
projects. Explicit user grants provide full primary-project access, edit without
assignment/transition, an assignable account, and browse-only access to the isolated
project. Five actor/project permission combinations pass. Actual restricted reads
and assignment return 403; an unavailable transition returns 400. Status and assignee
are independently compared before/after the denied mutations. Repeated seeding
reuses the actors, PATs and permission schemes and fails on scheme drift. License
checks, script lint and formatting pass. Complete mandatory-field/screen, pagination,
hostile-content and integrated isolation acceptance remain pending.

### Required-field and transition fixture checkpoint (#4082 AC5, partial)

Supported REST and scripted Jira administration now provision a required built-in
text custom field and a real transition screen. The licensed qualification script
passes missing-field create refusal (400), unchanged issue count, valid create data
readback, missing-field transition refusal (400), unchanged status, and field-plus-
transition success (204) with independent status/value/resolution readback. The legacy
transition fixture is restored for the next consumer. The mandatory requirement is
restored after preparation; no third-party validator or modified Jira code is used.

The Resolution field alone was rejected as qualification evidence: Jira automatically
fills its default when omitted. A legacy issue lacking the newly mandatory custom
field supplies a genuine refusal. Data Center 10.3.26 also requires the paginated
create-metadata endpoints; the retired aggregate endpoint returns 404. Script lint,
formatting, scripted admin reset and the full field qualification passed. Pagination,
hostile fixtures, automated initial setup and remaining integrated acceptance stay open.

### Native response and content fixture checkpoint (#4082 AC5, partial)

The licensed fixture lane now supplies 21 pagination issues, hostile issue/comment
content and an isolated-project issue. Two disjoint pages and exact content readback
pass. The restricted identity can read its project; the primary identity receives
403 there; a forbidden comment returns 400 with unchanged remote count.

The first production-adapter write exposed a native HTTP bug: constructing a Fetch
Response with a body for 204 threw outside the request promise after Jira had already
committed an assignment. Read-only changelog reconciliation confirmed exactly one
assignment effect; that assignment was not replayed. Native 204/205/304 responses now
have null bodies, completion controls socket reuse, and construction errors reject
the request. Three focused cases failed before the fix. The full HTTP/logging suites
pass **130 tests**, including CONNECT reuse across 204; four native integration cases
prove one request, registered body-free Activity Log reconstruction and invalid-status
rejection. Package build, root typecheck and changed lint pass. ADR-0038 is corrected.

A subsequent licensed production preflight passed a distinct description edit (204)
and comment creation (201), independent readbacks, exactly one matching changelog
effect and a one-comment increase. Its exclusive private pending marker prevents
blind reruns after interruption. Trusted HTTPS, untrusted-CA refusal and revoked
admission then passed through the same retained port. Review fixes also make shared
English/German Atlassian errors provider-neutral; 14 UI client/panel tests and UI
typechecking passed. These adapter checks do not claim MCP, model or Chat acceptance.
Automated first-run setup, the shared host and the remaining complete ACs stay open.

The complete Activity Log gate passed its seven checks after recording two exact
observability delegations: bounded Atlassian JSON validation returns invalid-response
to its existing connection-check logger; native Response construction rejects to the
existing gateway failure logger. No legacy failure entry was added. The real
Jira/Confluence client-route tests and native HTTP integration assert exactly one
registered owner outcome and absence of remote content. The observability gate tests
and native integration passed 24 tests; the real client-route lane passed 7 tests.

## Shared MCP protocol checkpoint — #4089 (partial)

The new `keiko-mcp` package owns official client/server SDK 2.4.0 imports and
activates protocol 2026-07-28 on both ends. One in-process handler/client uses
injected fetch without listeners or per-Pod processes. Invocation-local context
is outside protocol arguments; uncached listing checks and declaration digests
reject drift. Provider errors are closed, result sizes bounded, and calls are
not automatically repeated. Read/write hints are descriptive; durable invocation
accounting and server authority remain separate obligations.

Six actual-SDK tests cover discovery/request metadata, list/call, schema and
reserved-argument refusal, drift, concurrent context isolation, failure closure
and registered emission. A separate integration uses a real canonical descriptor
and reconstructs admission and invocation through the existing Activity Log
reader without result content. The generated catalog covers 606/606 proofs and
30/30 scenarios; its 97 drift tests pass. Package build, root typecheck, changed
lint, package graph, dependency hygiene/currency, ADR index and error observability
pass. The negative architecture suite passes all 76 fixtures; positive dependency,
import, contract, vector, governed-tool and catalog-conformance checks pass.

The full `arch:check` aggregate currently fails its final performance-evidence
step because the new lockfile changes the measured subject. The documented
reference procedure requires committed, clean revisions and a paired measurement.
That evidence, complete package surface/coverage qualification and full gates
remain pending for final acceptance as requested. No performance budget or gate
was weakened. The native HTTP Promise rejection is now recognized directly by
the observability checker, removing its temporary exact exemption; only the
previously proved pure JSON-classifier delegation remains.

This checkpoint does **not** complete #4089: generalized production binder
composition, a bound non-Coding consumer, Jira provider admission and downstream
Chat delivery still require implementation and evidence. All 55 complete ACs
remain open. ADR-0181 records the new host decision; affected existing ADRs and
package/dependency documentation are updated in the same change.

## Auditor follow-up — #4089 cancellation and terminal evidence

Two real-SDK regressions first failed against `14d8c9695`: a delayed provider
performed one effect after SDK timeout because its signal/guard remained live;
a sink throwing on `completed` changed confirmed success into `protocol-error`.
The host now combines caller/host/request/SDK cancellation, applies one deadline
across list and call, and revokes the effect guard at settlement. After timeout,
the released provider observes cancellation and performs zero effects. A parallel
invocation still completes once. Terminal logging failure preserves the confirmed
result and counts one `port-sink-failed` in the existing Activity Log loss ledger.
Admission/start evidence failures remain closed before effects.

Eleven SDK tests pass, plus the integration that formats the actual registered loss
summary and projects it through the existing reader. Package build, root typecheck,
changed lint, error observability and all 97 registry drift tests pass. The existing
12 binder suites / 200 tests also passed unchanged before binder refactoring.
No new logging subsystem or error-observability exemption was introduced.

## Binder preparation — #4089 (partial)

Coding action decoding, effect classification and approval decoding now enter the
existing binder through a captured consumer port. The native-read exception keeps
its exact descriptor/profile checks. The decoder functions are frozen at binding;
a regression first demonstrated that replacing a supplied decoder changed an
already bound invocation, then passed after capture. Admission, context checks,
budgets, cursors, invocation records, terminal settlement and lifecycle emission
remain in their existing owners. This preparation still uses Coding context types;
it is not yet the required non-Coding consumer.

All 200 existing binder cases pass before and after extraction; the new replacement
regression raises the total to 201. Package build, root typecheck, changed lint,
dependency/import/contract checks, all 76 negative architecture fixtures, governed
tool contract, catalog conformance and error observability pass. The regenerated
operation inventory reports no violations. The auditor code-reviewed the preceding
MCP cancellation/terminal-log fixes and confirmed both reported paths addressed;
that confirmation is not a full host/binder acceptance.

## Shared binder — #4089 (partial)

The production binder now accepts a consumer context/action/effect-guard specification.
Coding composes its existing adapter explicitly; a non-Coding conversation fixture uses
chat/actor/binding-generation scope and a distinct lookup action, with no workspace or
Coding session. Offers, request identities and cursors capture a bounded scope digest.
Every pre-effect check compares the admitted digest with current scope; replacing the
offer while a delayed old invocation is pending does not revive its authority. The
existing invocation registry, approval/budget ports and terminal lifecycle remain shared.

Six new consumer tests cover successful settlement, changed chat/actor/generation,
re-offer during a delayed invocation, and model-supplied chat routing rejection. The
201 Coding binder regressions remain required alongside these tests. At that checkpoint the consumer did
not yet invoke the managed MCP host: provider composition and the complete #4089 AC7
path remain open. No full acceptance criterion is marked complete by this increment.

Focused validation also passes: 97 gateway catalog tests, 97 registry drift tests,
package build, root typecheck, changed-file lint, governed-tool contract, regenerated
catalog conformance and error observability. The operation inventory has 606/606
proofs, 30/30 scenarios and no violations. Full final qualification remains pending.

## Managed provider composition — #4089 (partial)

Server composition now admits one SDK host and converts its verified metadata into
an existing `createKeikoToolCatalog` registration set. Only that compiled projection
feeds the bound gateway advertisement. The shared binder invokes SDK tools through
captured server routes, validates canonical results and retains its authority,
approval, budget and settlement ports. No Pod creates a separate host. Provider
declaration drift refuses new offers and calls. Host metadata contains no handler or
consumer context and is immutable; its absence was demonstrated by a failing test
before the catalog method was added.

The hermetic non-Coding consumer now traverses the actual gateway/binder/SDK/provider
path. Two differently bound consumers complete in reverse order; cancelling the
first leaves exactly one effect in the second and one settlement per consumer.
Unknown model tools are rejected. Existing Coding authority and approval suites run
alongside the binder tests. This qualifies the scoped runtime path, not the unfinished
Jira provider, Chat authority/mode composition or the full #4089 acceptance.

Additional review coverage exercises captured action/effect/scope/approval decoders
and rejects every missing/non-function port member. ADR-0019 now records the MCP
boundary revision and SDK confinement. The dependency matrix distinguishes actual
client/server declarations from their reviewed transitive closure; all rows render
as tables. The server-to-host edge is explicit in both package and architecture
gates; the host remains restricted to contracts/security and all SDK import
confinement rules remain active.

Focused results: 353 server tests across 16 suites (220 catalog/consumer tests plus
133 Coding authority/approval tests), 12 actual-SDK tests, 5 integration/package-graph
tests and 97 registry tests pass. Package build, root typecheck, changed lint, package
graph, dependency hygiene/currency, supply-chain decision matrix, ADR index and error
observability pass. Full final performance, SBOM/assembled-package, coverage, Linux,
Sonar and GitHub qualification remain open.

## Auditor follow-up — admitted handler continuity (#4089)

Against `a284d25bc`, two real-SDK regressions failed: an unchanged declaration with
a replaced execute function ran the replacement, and a delayed original handler
still reached its effect after replacement. The host now captures immutable tool
bindings, checks handler references as well as metadata, executes only those captured
references, and revalidates continuity before execution and around the final effect
guard. Stable provider ports remain invocation-local; metadata exposes no functions.
The corresponding fixtures now declare stable handler references instead of creating
new functions during each registration query. Both regressions require zero unwanted
effects; cancellation and independent concurrent invocation coverage remain in place.

After the repair, all 14 SDK tests, 353 server tests, the registered Activity Log
reader/loss-summary integration and 97 registry drift tests pass. Package build,
root typecheck, affected lint/format and error observability pass. The generated
inventory still resolves all 606 proofs and 30 scenarios without violations.

## Mutation transport replay safety — #4083 AC5 (partial), Epic #4081

The existing shared Atlassian HTTP helper retried PUT after 5xx/429 and POST after 429. Three new regressions failed because a committed first attempt was resent;
the PUT cases could overwrite an intervening actor change. Automatic retries are
now restricted to GET. Every POST/PUT dispatches once, regardless of Retry-After,
while bounded GET backoff/deadline behavior remains covered. This also protects
existing Cloud Jira and Confluence write callers.

The existing action activity owner now projects its outcome into the registered
Activity Log without credentials, targets or Jira content. A real server-route
fixture proves one PUT attempt after 503 and reconstructs the failed/unavailable
outcome through the formatter and reader. A terminal sink failure records loss
without changing an observed successful write. ADR-0128 D3 reflects the retry rule.

Focused transport/Jira/Confluence tests: 50 passed. Existing write/live-search route
suites including the new route and log-loss proofs: 69 passed. Package build, root
typecheck, affected lint, error observability and ADR index pass. The regenerated
inventory resolves 607 proofs and 30 scenarios with zero violations. All 97 registry
drift tests and changed-file format checks pass.

This is not complete AC5 acceptance: existing route failure reasons still do not
prove absence of a remote effect. Durable invocation intent, distinct uncertain
and acknowledged-but-unconfirmed results, reconciliation and Chat/UI folds remain
to be implemented. No automatic retry is permitted to bridge that gap.

## Shared connector deployment ceiling — #4083 AC7 foundation

Production `buildUiHandlerDeps` previously left the connector policy ceiling unset,
while Coding resolved all-mode availability or configured limits. Six regression
cases failed through actual composition. Both now consume the same resolver,
including narrower retained compatibility options. Two further failure-before
cases showed that a runtime option could hide a narrower or invalid environment
value; explicit configuration is now intersected instead of widened by precedence.
Invalid values fail closed. The existing action outcome records the resolved
ceiling for reconstruction, and ADR-0124/0128 describe the corrected behavior.
ADR-0128's stale Supervised table cells now match its existing ADR-0138 amendment.

All 354 tests in 15 affected server suites pass, including actual composition and
connector policy, existing Atlassian routes, Coding context and Memory isolation.
All 97 registry tests pass. Package build, root typecheck, affected lint, error
observability and ADR index pass; the generated registry has zero violations.
The selected mode and scoped authority remain separate requirements. Memory keeps
its explicit-or-Ask default. Chat authority integration and the full AC7 acceptance
remain open; no artificial Coding session is presented as a Chat proof.

## Jira metadata field matrix — #4083 AC3 foundation

Added additive shared field-capability types and a bounded connector-owned parser/validator.
Supported standard and explicitly named core custom-field types cover text, finite numbers,
calendar dates, millisecond datetimes, user/option references and bounded lists. Options and users
are checked against advertised allowed values; Cloud account IDs and Data Center usernames stay
separate. Cloud rich text uses the existing ADF composer; Data Center retains plain text.

Unknown plugin types remain unsupported even when their base schema resembles a supported type.
Required values, current metadata verbs, explicit clearing and omission are distinguished. A
Jira-declared create default can remain omitted without fabricating its value. Add/remove is
implemented only for labels and cannot be combined with replacement of the same field. Metadata,
references and update lists are bounded; malformed objects, duplicate field IDs, invalid dates,
unsupported verbs, extra reference keys and unsupported labels schemas fail closed.

All 62 focused tests pass (26 new field tests plus existing Jira/Confluence writes and ADF tests).
Package build, root typecheck and changed-source lint pass. The first feature test failed because
the implementation was absent. This is pure validation groundwork, not provider/HTTP acceptance:
fetching fresh target metadata, live fixtures, atomic transition requests and shared MCP provider
integration remain open. No #4083 criterion is marked complete by this checkpoint.

Review gate follow-up: the targeted semantic-duplication check currently fails with nine clone
groups and five stale baseline entries, including the reported shared offer-admission preamble
and the Atlassian transport paths. This is recorded as an open gate, not an accepted exemption;
reproduction is complete and the next increment addresses the verified duplication. No new
clone is reported in this field-validation increment.

## Review repair — shared binder and unchanged gate policy (#4089 / #4082)

The two offer paths now reuse one admission preamble, preserving context/scope capture,
compatibility, expiry and minted-ID checks. The native Coding adapter no longer requires a
consumer port that it replaces. A failing managed-host close no longer replaces the original
admission failure; a focused regression failed before the repair and now verifies the original
error plus two content-free diagnostics. The duplicate Atlassian base-URL check is also shared.

The semantic gate was reproduced against both this branch and an isolated clean `origin/dev`
source snapshot with the same pinned toolchain: dev passed with 938 baseline groups. After
extracting the two actual new code clones, remaining reports involved data vocabularies or
completely unchanged dev sources regrouped by Fallow. The existing exemption Map now uses keyed
object data; an AST comparison verified all 90 exact keys/reasons unchanged and in order against
`2714df157`. The existing ratchet command refreshed only the baseline representation and retained
938 groups. No threshold, matching rule or exemption was added; the full semantic gate now passes.

267 affected server tests, 97 registry tests and 48 gate/propagation regression tests pass. Package build, root typecheck, changed lint,
error observability and the 607-proof/30-scenario registered inventory pass. The prior semantic
failure is repaired. The separate clean-revision performance measurement and final full gates
remain open; this increment does not complete any unfinished Jira/Chat acceptance criterion.

## Collection transport — #4083 AC1 / #4081 (foundation)

The existing bounded Atlassian HTTP helper now accepts explicit JSON-array responses for Jira
collection endpoints while retaining object-response validation, byte/deadline limits and GET-only
retries. Empty collections are valid; objects in an array response, malformed JSON and truncated
arrays fail closed. Three new cases failed before implementation; all 55 transport/Jira/Confluence
write tests now pass, including the unchanged mutation no-retry tests.

The shared pure JSON decoder replaces the previous legacy-listed `parseJsonRecord` catch. One
exact file/function ownership rule documents propagation to `atlassian.action.outcome`; two real
transition-route regressions prove exactly one reconstructed failure and no mutation after invalid
metadata. The legacy register shrank from 1453 to 1452 entries. All prior 90 exceptions are retained;
this increment explicitly adds one scoped ownership rule, with no generic parser exemption.
46 route tests and 20 observability-gate tests pass, as do package build, root typecheck, changed
lint and error observability. Fallow's two regrouped data-only windows involve the added ownership
text and otherwise untouched translation data; its existing baseline refresh retains 938 groups
and the semantic gate passes. No executable clone or matching-rule change was introduced.

Production Jira tool composition, live operation acceptance and the remaining Chat/Pod/UI work
remain open. This checkpoint does not complete #4083 or any other acceptance criterion.

## First Jira capability and complete parser ownership — #4083 / #4089 / #4081

`jira.projects` now executes through the production gateway projection, generalized binder,
shared SDK host and real connector provider. Its canonical server descriptor is the only model
offer; connection/context data remains private. The Data Center v2 collection is fully validated,
bounded, sorted and paged. Only project id/key/name are returned. Provider failures use the
existing managed-host failure event. Four integration cases cover pagination, field minimization,
no second HTTP dispatch for the same invocation, permission refusal and malformed object/JSON
responses. This is a hermetic HTTP fixture and a non-Coding consumer, not a real-model or Chat test.

The auditor correctly identified that the shared JSON-parser ownership justification omitted sync
consumers. Production SyncRun previously wrote only the existing connector activity ring. It now
also calls the existing registered `atlassian.action.outcome` projection. Partial runs remain
explicitly partial, warn, and retain their execution failure rather than replacing it with a
governance rationale. Four metadata-route regressions failed before this fix with no global event;
Jira and Confluence item failures and the live-search route are also reconstructed through the
reader. All five production decoder call sites are accounted for; the new array consumer is
covered through the actual MCP path. The one exact parser rule now names all these owners.

80 affected route/sync tests and 12 binder/SDK tests pass, alongside 97 registry and 20 gate tests.
Package build, root typecheck, changed lint, error observability and ADR index pass. The generated
607-proof/30-scenario inventory has no violations. The two data-only Fallow windows regrouped
because the ownership explanation changed; the existing refresh retains 938 groups and passes.
Production Chat grants/approvals, all other Jira operations, durable write outcomes, Live Pods,
UI and real-model/live-lab qualification remain open. No full acceptance criterion is closed.

The full `check:activity-log` aggregate was also executed: its registry, replay, inventory and
negative checks pass, but the aggregate remains red solely because its nested `arch:check` requires
the already-open clean-revision catalog performance measurement. This is not an Activity Log pass
claim; final architecture/performance qualification remains outstanding. Review prose about
Supervised workspace was corrected to match the D4 table and ADR-0138. The newly reported oversized
Jira allowed-values field issue remains queued for the next metadata increment.

## Bounded metadata review repair — #4083 AC3 / #4081

An oversized allowed-values list now disables only its field, preserving other valid metadata.
Versions, fix versions and components above 500 choices become unsupported with no values or
advertised verbs; requesting that field fails before mutation, and a required unsupported field
without a server default still prevents creation. Unknown plugin choice structures are not
interpreted. Supported fields with structurally invalid reference metadata still fail closed.
The metadata offer now intersects Jira verbs with the implemented matrix: add/remove is offered
only for labels, and unsupported fields offer no verbs.

Five regressions failed before this repair. The metadata and existing Jira/Confluence write tests,
plus the unchanged ADF composer baseline, pass (69 tests total). Package build, root typecheck,
changed lint and semantic duplication pass; no baseline or gate rule changed. This repairs review
comment 4383946211. It does not complete the still-pending provider metadata/live-operation matrix.

## Managed metadata reads — #4083 AC1/AC3/AC7, #4089 / #4081

The existing connector provider now exposes issue types, create fields and edit fields beside
projects. Server-owned canonical descriptors feed the same compiled catalog, non-Coding binder
and in-process SDK host. DC create metadata uses the supported project/type endpoints and validates
`start`, `size`, `last`, optional totals and continuation consistency. Edit metadata preserves the
server's field-map keys; response-supplied field IDs cannot override them. All operations retain
context paths, bounded transport, per-effect checks and private invocation connections. Cloud is
still explicitly refused by this DC provider; the existing Cloud write path remains separate.
Human choice labels are exposed separately from validated mutation identities.

Three integration regressions failed before provider admission. Their successors exercise actual
binder/SDK/HTTP-port calls and registered, content-free Activity Log reconstruction. Controls reject
malformed or inconsistent pages, Cloud pagination shapes and path overrides. This is hermetic
provider evidence, not ordinary Chat or a current live Jira qualification. The expired lab license
must be replaced by a fresh legitimate session before the next full live group. No AC is closed.

Targeted checks for this increment: package build, root typecheck, changed lint/format, ADR index and unchanged semantic-duplication gate pass; 21 binder/SDK tests and 70 connector field/write/ADF tests pass. Final package-surface, architecture/performance, complete coverage and live acceptance remain open.

## Issue content reads — #4083 AC1/AC2/AC7 / #4081

The same provider now includes bounded opaque JQL search, individual issue reads with selected
standard fields and plain-text descriptions, and independently paged comments. Raw self links,
email fields and avatars are excluded. Search never returns descriptions or reporter data even
when an upstream response includes those unrequested fields. Missing totals remain absent; a
nonempty page provides a continuation and an empty page ends that unknown-total traversal.
Cloud ADF in this DC-only lane and oversized content fail closed instead of being silently cut.

Three integration cases failed before these capabilities were admitted. After implementation,
28 binder/SDK tests and 66 existing live-search/document/HTTP tests pass. Package build, root
typecheck, changed lint and unchanged semantic checks pass. The tested HTTP is synthetic; live
DC operation coverage, arbitrary custom-field value reads, transitions, assignable users,
mutations and actual Chat admission remain open. This checkpoint does not accept a complete AC.

## Workflow and assignment discovery — #4083 AC1/AC3/AC7 / #4081

The provider now offers nine implemented read capabilities. Transition discovery includes current
screen-field requirements; absent metadata remains explicitly unavailable and is never converted
into an empty requirement list. Assignable-user discovery requires exactly one issue or creation
project scope. Results contain only username, display name and activity status, without ancillary
email, avatar or self-link fields. Totals remain unknown for Jira's array response. Collection
projection and duplicate-identity rejection share one bounded helper across these and issue reads.

Two capability tests failed before implementation. The resulting 36 binder/SDK integration tests,
package build, root typecheck, changed lint/format, ADR index and semantic gate pass with the
unchanged 938 baseline. The synthetic transition requirements are not the still-pending live
mutation-screen acceptance. Mutations, full custom-field value reads and the normal Chat authority,
grant and durable invocation paths remain open. Review comment 4384251867 on partial-sync failure
classification is accepted and queued immediately after this increment.

## Partial-sync error classification repair — #4081 / #4087, review 4384251867

A partial sync with a sync-only failure (for example `scope-exceeded`) previously emitted
`failureReason: none`, because its legacy UI activity record uses `succeeded`. The registered
projection now derives one effective outcome and maps such partial failures to `other`. A partial
record carrying a governance approval reason still emits `none`; existing detailed transport
failure codes remain intact. One regression failed before the fix and both controls passed.

After repair, 83 route/projection tests pass. The new case uses the registered production formatter
and real Activity Log reader. Regeneration resolves 607 proofs and 30 scenarios with zero
violations; all 97 registry tests pass. Package build, root typecheck, changed lint/format and
semantic gate pass. This closes the concrete classification finding, not the outstanding full
Activity Log/architecture/performance qualification.

## Structured MCP failure preservation — #4089 / #4083 AC4 / #4081

The host previously discarded structured provider failures and retained only `tool-error`.
It now captures and bounds provider results, validates their declared output schema even for
MCP error results, and retains valid failure data through an immutable, non-enumerable accessor.
Arbitrary thrown exceptions, malformed result shapes, unexpected fields and oversized error
results remain generic. The registered failed lifecycle still settles once and contains no data.

One regression failed before the fix. All 18 SDK-host tests, 36 existing binder/provider tests
and 97 registry tests pass, along with package build, root typecheck, changed lint/format,
ADR index and unchanged semantic checks. Catalog failure-envelope propagation, durable mutation
intent and explicit Jira remote-result states are the next integration step; preserving data in
the host alone does not complete the user-visible outcome requirements.

## Catalog settlement retains provider errors — #4089 / #4083 AC4 / #4081

Explicit MCP error results now reach the consumer as `failed` / `provider-reported-error`,
with the admitted schema-validated JSON object, no page, zero result count and exact output-byte
accounting. Other failures and all cancellations retain null data. The binder validates the
payload again, settles invalid/missing error payloads without leaving reservations pending, and
keeps the existing single settlement/replay behavior. The legacy string-returning adapter cannot
claim this structured variant. ADR-0175 and its generated lifecycle contracts describe the addition.

The regression failed in three provider integration cases and one pure result-contract case before
implementation. Afterward, all 252 server catalog tests, 954 selected pure/contract/Harness/gate tests
and 97 registry tests pass. Build, root typecheck, changed lint/format, ADR index and semantic
checks pass; registry generation resolves 607 proofs and 30 scenarios without violations.
Actual emitted settlement lines are registered proofs and both log owners remain body-free.
Durable mutation intent, Jira write outcomes and ordinary Chat admission remain pending.

## Selected issue field values — #4083 AC1/AC3/AC4 / #4081

`jira.issue` contract version 2 accepts up to 20 explicit field IDs and requests the corresponding
values with `names,schema` expansion. The existing field matrix and pure value validator project
bounded text/numbers/dates/datetimes, users/options and supported lists. Empty, unavailable and
unsupported fields are distinct; unrequested and unknown-plugin values are never projected.
Reference projection excludes email/self fields, rejects duplicate identities and bounds lists.
Jira compact datetime offsets round-trip through the shared normalizer. Duplicate field IDs,
wildcards, reserved names and excessive selection fail before connection resolution/HTTP.

The original integration test failed before implementation. Afterward, 41 actual binder/SDK
integration tests and 217 selected field/Cloud-write/contract tests pass. Build, root typecheck,
changed lint/format, ADR index and unchanged semantic checks pass. The field read uses the
existing managed-MCP/catalog lifecycle and its body-free result-byte accounting. The REST-v2
expansion is documented in [Atlassian's Server REST reference](https://docs.atlassian.com/software/jira/docs/api/REST/9.12.0/).
Full operation and licensed 10.3.26 live qualification remain pending, as do durable writes and
ordinary Chat authority. This is not an accepted AC or an epic-completion claim.

## Durable Chat mutation journal — #4083 AC5, #4084 AC5, #4091 / #4081 (foundation)

Schema 47 adds the journal to the existing UiStore. It binds a canonical persisted user turn to
server-owned invocation/actor/Pod identities, binding/authentication generations and authority/action
digests. It stores no request, response body, endpoint or credential. A standalone FULL-synchronous
SQLite transaction records possible dispatch before permission is returned to the caller; savepoints
and weaker synchronization are refused. Final synchronous authorization can atomically redeem an
approval, and rejection rolls the transaction back. The journal itself grants no authority.

Equivalent actions in the same turn share a tombstone even with different model call IDs. At most
32 intents are retained per turn, and only one is active. An unknown effect blocks further mutations
in that turn, including already prepared work. A new explicit user turn remains separate. Removing
a message retains the tombstone; deleting the owning Chat removes it. Known rejection, confirmed
success, acknowledged-but-unconfirmed success, unknown effect and no dispatch are distinct and
terminal outcomes are immutable. HTTP acknowledgement must be recorded before body processing;
provider/HTTP composition is still pending. There is no universal exactly-once or lost-update claim.

The original on-disk restart regression failed before implementation. All **704 store tests** now
pass, including restart, duplicate identity, changed context, guard rollback, storage/log failure,
ambiguous status, prior acknowledgement, parallel prepared intents, deletion and schema-46 upgrade.
The schema inventory and shared reverse fixture were extended; no production migration or privacy
gate was relaxed. The registered `chat.tool-mutation` proof reconstructs committed states without
private content. Pre-effect logging failure stops the caller; terminal logging failure preserves the
observed result and enters the existing loss ledger. ADR-0013 documents these boundaries.

The error-observability gate also found a missing explicit diagnostic for rejected structured
provider results in the preceding catalog increment. Three new assertions failed before the repair;
the actual validation catch now emits the existing body-free server diagnostic before single
settlement. All **257 catalog tests**, **97 registry tests**, build, root typecheck, changed lint/format,
ADR index, error observability and unchanged semantic checks pass. Registry generation resolves
608 proofs and 30 scenarios without violations. Jira mutation transport, current-authority wiring,
normal Chat, licensed live qualification and all complete-epic gates remain pending. No AC is accepted.

## Audit repair: status is not effect certainty — #4083 AC5 / #4081

The read-only auditor correctly found that the initial journal classified HTTP 429 as a known
rejection, contradicting the existing committed-then-429 transport regression. The entire status
whitelist has been removed: after possible dispatch, every non-2xx response remains an unknown
remote effect. Diagnostic reasons such as permission denied or rate limited remain separate from
that effect classification. A known local rejection is permitted only before possible dispatch.
Schema 48 also repairs retained schema-47 post-dispatch rejections to unknown before work resumes.
ADRs 0013 and 0128 record the corrected semantics.

Nineteen assertions/cases failed before the repair. Synthetic committed-then-400/401/403/429 tests
retain the unknown state and prevent both queued and new actions across on-disk restart; migration
regressions cover the previously persisted incorrect state. These are store/transport proofs, not
licensed Jira or ordinary Chat acceptance. All **712 store tests**, **31 existing HTTP tests** and
**97 registry tests** pass, along with build, root typecheck, changed lint/format, ADR index and the
unchanged semantic gate. Registry generation remains at 608 proofs/30 scenarios without violations.
The provider/HTTP/authority integration and complete epic qualification remain pending.

## Final transport preparation — #4083 AC5 / #4084 AC3 / #4081 (foundation)

The existing gateway now accepts a trusted synchronous header-preparation callback. Native requests
invoke it after pinned DNS and body preparation; HTTPS proxy requests additionally wait for the
CONNECT/TLS handshake. A refused or cancelled preparation sends no target HTTP request and disposes
an acquired tunnel. Callback/control fields never reach injected fetch implementations. Existing
callers retain their original header and cancellation semantics.

An explicit `singleAttempt` uses the configured native CA trust set on the first HTTPS attempt and
disables fallback, including for TLS-shaped errors from injected transports. It preserves certificate
verification and DNS pinning. This lets the future mutation adapter record durable admission at the
actual request boundary without a hidden second attempt. The gateway itself grants no authority.

Three initial regressions failed before implementation. All **2,290 gateway tests** and **46 existing
Atlassian port tests** pass, including actual native/CONNECT refusal, post-DNS revocation, cancellation,
invalid asynchronous callbacks and first-attempt custom-CA success. Build, root typecheck, changed
lint/format, ADR index, error observability and unchanged semantic checks pass. Existing registered
HTTP lifecycle operations retain their body-free evidence; ADR-0038 describes the boundary.
Connecting the Atlassian credential owner, durable journal and ordinary Chat authority to this seam
remains pending. No AC is accepted by this transport checkpoint.

## Atlassian final request boundary — #4082 AC2 / #4083 AC5 / #4084 AC3

Both existing Atlassian ports now use final gateway preparation for credential resolution. A trusted
synchronous admission callback sees a frozen request snapshot and runs before secret materialization;
false, asynchronous or throwing callbacks stop the request. Credential and admission failures retain
their original identity instead of becoming retryable network errors. POST and PUT select the
single-attempt transport. Response observers run before body consumption, preserving the distinction
between an observed status and a later body failure. Observer failure cancels the unread stream and
emits the existing body-free diagnostic channel. ADR-0128 documents the composition boundary.

The initial three regressions failed before implementation. All **60 port tests** pass, including
held native DNS with subsequent revocation, immutable request identity, cancelled requests, custody
errors, asynchronous callback rejection and response-stream cleanup. All **168 connector integration
and HTTP helper tests** pass. Build, root typecheck, changed lint and error observability pass.
This increment supplies the concrete transport hooks; durable journal/current-authority composition,
managed Jira mutations, ordinary Chat and complete epic qualification remain pending. No AC is accepted.

## Review repair: aggregate issue projection — #4083 AC3 / Epic #4081

CodeRabbit's aggregate `jira.issue` result-size finding is confirmed. Three production SDK/binder
regressions failed before the repair even though the synthetic upstream bodies fit the existing HTTP
ceiling. The projection now charges the complete issue data, including description and metadata,
reserves 4 KiB for the bounded catalog envelope, and accounts for serialized UTF-8 bytes and JSON
escapes. Every selected field's unavailable placeholder is reserved before any value is admitted.
The first value that cannot fit, and all subsequent fields, retain that explicit unavailable state;
supported values and the issue itself remain intact. The unchanged catalog gate still validates the
complete terminal envelope. Individual selected strings also respect its existing string-byte cap.
An unrepresentable base description returns a structured bounds failure. No new truncation state,
larger ceiling or schema exception was introduced.

The SDK/binder regressions now pass, including duplicate standard-field data, escaped control text,
multibyte values, all 20 selected fields and single settlement. Focused projection tests cover exact
byte boundaries, placeholder reservation and invalid budgets. The existing lifecycle still records
bounded result metrics without Jira content. All **261 catalog/consumer tests** and **76 field/Cloud
write regressions** pass, as do package build, root typecheck, changed lint/format and the unchanged
semantic gate. Full epic and live qualification remain pending.

## Mutation journal/transport composition — #4083 AC5 / #4084 AC3 / #4091 AC2

The server now composes the existing durable journal with the existing Atlassian HTTP port. A new
intent alone owns execution; duplicate deliveries only report retained state, including while the
first invocation is still preparing. Final transport admission repeats the injected current-authority
guard inside the journal transaction. Owner-supplied transport admission/response callbacks remain
composed. Metadata GETs do not acknowledge a mutation, and one invocation can send at most one
POST/PUT. The operation's validated receipt identities distinguish confirmed success from 2xx without
usable confirmation. Lost/error responses remain unknown; failed terminal persistence retains the
barrier and returns uncertainty. This composes an injected authority owner; real Chat admission is
still the next integration layer.

An integration regression exposed a missing barrier after `succeeded-unconfirmed`: it failed before
the store repair. Both new and previously prepared mutations in that turn are now blocked, while an
explicit new turn remains separate. The **791 store/port/composition tests** pass, including actual
gateway/port dispatch with synthetic transport, concurrent duplicate delivery, committed-then-error,
malformed and broken response bodies, metadata reads, final guard revocation, missing capabilities,
second dispatch refusal and terminal storage failure. This is not a licensed Jira/normal Chat proof.
No managed mutation is advertised until provider and Chat-authority composition is complete.
Package build, root typecheck, changed lint/format, ADR index, unchanged semantic checks and error
observability pass. The diagnostic emitter is explicit at each caught failure; no legacy failure-path
exemption was added. Registry generation resolves 608 proofs/30 scenarios without violations and its
97 drift tests pass. The narrower 18-test composition suite also passed after the diagnostic repair.

## Auditor repair: non-terminal mutation replays — #4083 AC5 / #4091 AC2

The read-only auditor identified a valid distinction lost in the initial composer: a concurrent
replay of a prepared record said `not-dispatched` while its original owner could still dispatch.
The closed result-state contract now adds `pending` separately from terminal journal outcomes.
Every unsettled replay reports `pending`; only a retained settlement is replayed as terminal.
Missing journal/current admission or a preparation failure also leave prior state unqualified and
cannot justify a no-effect claim. This state asserts neither an active owner nor permission to take
one over. Existing journal settlement rules and dispatch barriers remain unchanged.

Eight composer regressions failed before the repair and pass afterward. They cover a waiting owner
that subsequently writes, a cancelled owner that never dispatches, revocation while HTTP remains
outstanding, failed terminal persistence, and prepared/dispatched/acknowledged records reopened
without an owner. An additional store test refuses to settle `pending` as a terminal outcome.
The full targeted store/port/composer selection passes **797 tests**. Package build, root typecheck,
changed lint, ADR index and error observability pass. Registry generation still resolves 608 proofs
and 30 scenarios without violations; all 97 registry tests and the unchanged 938-entry semantic
baseline check pass. Actual Chat admission and managed writes remain outstanding;
this repair does not constitute complete acceptance of an epic criterion.

## Data Center mutation executor — #4083 AC2/AC3/AC5

The connector's private executor now implements create/edit/assign/comment/transition against REST
v2. Eight initial behavior tests failed before implementation. Fresh create metadata is collected
through bounded post-9.0 pages, then the existing field validator checks the complete field set;
edit and transition metadata are refreshed for their corresponding actions. Transition fields and
transition are one POST. Named assignment checks current active assignable users without depending
on edit permission; clearing requires metadata permission. Input snapshots cannot change during
metadata I/O. Unknown fields/verbs, routing overrides and compound actions are refused. Cloud's
existing v3/ADF executor remains separate. An unexpected 2xx status or missing returned identity
is not confirmation, and POST/PUT are never automatically retried.

The **355-test selection** passes: new executor scenarios, field validation, existing Cloud writes
and the current catalog suites. It covers required fields on later metadata pages, duplicate and
never-ending pages, unsupported required plugin fields, changed edit capabilities, inactive users,
unassignment refusal, contradictory duplicate identities, pending-input mutation, cancellation, rechecking admission between metadata
and dispatch, unexpected statuses and POST/PUT error responses. Package build, root typecheck and
changed lint pass. This private executor is not yet advertised by the managed provider or connected
to normal Chat. The next integration joins it to the durable server composer and actual SDK binder;
real Jira/Chat/browser acceptance remains outstanding. Existing host, HTTP and action-log owners
remain responsible for correlated runtime evidence; no additional logging subsystem is introduced.

The 45 executor tests were rerun successfully after extracting the unique-active-assignee check.
Changed formatting, ADR index and the staged-diff semantic gate also pass.

## Auditor repair: independent mutation confirmation — #4083 AC3/AC5

The auditor correctly identified that an expected 201/204 response was only an acknowledgement.
The private Data Center executor now reads the exact affected resource after every acknowledged
operation and validates identity plus the requested state. Edits, assignments and transitions also
read the relevant state before dispatch; already matching state and self-transitions do not establish
a new effect. Transition metadata must identify its target status. Failed or contradictory readback
returns a failed attempt without repeating the mutation; the existing journal composer retains the
acknowledgement as `succeeded-unconfirmed`. The provider/composer/SDK integration proof is still pending.

Sixteen tests failed against the acknowledgement-only implementation. The resulting **403-test
selection** passes, including **66 mutation tests**. All five operations cover forbidden and
contradictory post-write reads with exactly one mutation; additional cases cover wrong returned
identity, unchanged state, lost authority before readback, refused prerequisite reads, explicit
clearing, reordered replacements and additive label membership. Package build and root typecheck
passed after the runtime changes. This remains synthetic component evidence, not licensed Jira,
normal Chat or browser acceptance. Readback does not establish exclusive causation or atomic
lost-update protection. The earlier ADR choice-list limit is also corrected to the implemented
500 choices (the separate submitted-array bound remains 100).

Changed lint/format, ADR index and the staged-diff semantic gate pass; the clone ceiling remains 938.

## Managed mutation composition — #4083 AC2/AC5/AC7 / #4089 AC4

The existing Jira provider now accepts an explicit server-owned mutation executor. Without it,
write declarations are rejected; the default provider remains read-only. The server builds the five
canonical mutation descriptors and the connector executes only through the HTTP port supplied by
the durable composer. Independent snapshots prevent later argument or connection mutation from
changing the admitted operation. Assignment clearing is explicit and ambiguous combinations fail
before HTTP dispatch. Existing test fixtures were extracted and shared rather than duplicated.

The positive write-declaration test failed before implementation. The **369-test selection** passes
across provider, connector mutations, journal composer and the complete catalog directory. It
includes **16 actual SDK integration cases**: all five operations with verified synthetic remote
state, all five with denied readback and a barrier against further writes in the same turn, all five with a lost
response after the synthetic remote applied the mutation, and explicit/ambiguous clearing. Every
case asserts one mutation at most; repeated actions return retained journal outcomes. This path
uses the real gateway projection, non-Coding binder, MCP SDK, existing HTTP adapter and SQLite
journal. The consumer's authority port is a trusted test port, not the still-pending product Chat
authority implementation. No real model, licensed Jira, normal Chat or browser acceptance is claimed.

Package build, root typecheck and changed lint pass. The fixture refactor and provider snapshot
test are rerun after their final lint/type repairs. Final package, architecture/performance and
full-quality qualification remain deferred to the agreed overall acceptance.

The final 64-test provider/SDK/non-Coding rerun, changed formatting, ADR index and staged-diff semantic gate pass.

## Shared Jira policy vocabulary — #4083 AC3/AC6 / #4084 AC2

The nine managed read actions and `assign-issue` now belong to the existing closed connector action
vocabulary. A single mapping connects the fourteen canonical Jira tools to those policy actions.
Reads require `issue-tracker.read` with low risk; assignment requires `issue-tracker.write` with
medium risk. Existing action-class, scope and strictest-mode decisions remain authoritative.
No Chat read grant or action approval is implied by adding these vocabulary entries.

Ten recognition regressions failed before implementation. The **315-test contract/validation/
policy/activity selection** passes: its expanded integration matrix drives the old HTTP routes and
new managed admission through the real authority registry across all three modes, including absent
scopes. The existing route compatibility cases remain. Every new action also passes the registered
formatter and Activity Log reader proof. All **97 registry tests** pass after regeneration: 608
proofs, 30 scenarios, no violations. The static registry requires explicit closed field literals;
the outcome definition retains that representation and its typed producer and tests prevent drift.

The corresponding English/German labels pass **11 UI tests**, UI typecheck and full UI lint.
Package build, root typecheck, changed backend lint/format and ADR index pass. The optional message
catalog changes require final UI-evidence regeneration; full UI coverage, aggregate Activity Log,
architecture/performance and remaining final gates are not claimed by these focused results.

## Instance-qualified results — #4083 AC1/AC2/AC4/AC7

Issue reads/search hits, issue-scoped read results and mutation results now derive browse links
from the selected connection's HTTPS instance and context path. Remote `self` URLs are ignored.
The existing live-search base-path helper was extracted and reused. Links are attached outside
the durable journal; the existing content-free log tests continue to reject endpoint leakage.
Create replays without a retained issue identity omit a link instead of inventing one.

Two SDK regressions failed before implementation: the missing qualified issue link and an oversized
search-page projection with long context-path links. Read results now account for the complete
serialized data plus the existing envelope reserve. Oversized pages retain a fitting prefix and
resume at the first unreturned item, preserving the remote total; an individually oversized item
fails explicitly. No byte ceiling was widened. Result-schema versions advance consistently.

The **328-test catalog/provider/SDK/field/legacy-live-search selection** passes. All five mutation
SDK cases additionally assert the correct qualified link while journal/MCP logs remain endpoint-free.
Package build, root typecheck and changed lint pass. These synthetic results do not replace the
outstanding licensed Jira, product Chat or browser qualification.

## Atomic Chat state foundation — #4084 AC1/AC2/AC4/AC5

Schema 49 extends the existing Chat row with versioned Jira state: one independent Pod UUID,
binding/authentication generations and the selected tool mode. It stores no endpoint, credential
reference, token, grant or approval. Missing legacy state defaults to Ask for approval and preserves
the previous grounding identity. Effective Pod, authentication or mode changes advance the binding
generation; disconnect retains it and an unchanged reconnect does not reset it. The store requires
a trusted resolved Pod target, rejecting absent/mismatched/invalid targets. Read/preview/commit use
the same codec and scope projection. Corrupt persisted state fails closed with a body-free error.

The existing transaction helper now protects Chat update validation and writes together. Scope
preconditions are rechecked inside that transaction, so a stale combined patch cannot partially
rename or rebind a Chat. Existing registered scope-update logging includes optional Jira counts,
generation and mode; the persisted reader proof rejects title/Pod-ID leakage. Reopen, corruption,
separate-Chat defaults and existing scope/store/migration/serializer/route regressions are covered.

Five behavioral tests failed against the preceding implementation after correcting the test's
temporary-directory prerequisite. The **342-test affected selection** passes, including the actual
registered writer/reader. The first log assertion used the in-memory event shape instead of the
persisted flattened record; it was corrected and the full selection rerun. The **97 registry tests**
also pass; regeneration resolves 608 proofs and 30 scenarios without violations. This checkpoint
does **not** claim authenticated Pod route resolution, current credential readiness, read grants,
approval redemption, ordinary Chat execution or any complete acceptance criterion.

## Private Live-Pod identity and generation capture — #4084 AC3/#4085 AC2/AC3/AC4

The existing custody owns optional Data Center Live-Pod metadata and single-use verification
tickets. Creation needs a trusted owner digest and rejects duplicate creation intent before another
vault write. Latest-probe and credential-generation checks prevent stale completion and deleted-row
resurrection. Failed verification advances the generation. These are owner primitives; normal create
and verification routes required their Live-Pod composition at that checkpoint; see the subsequent
owner/projection checkpoint below.

All existing production HTTP factories now snapshot the selected generation. Resolution checks that
generation before reading ciphertext, including when the caller later mutates its metadata object.
Three new lifecycle tests failed before implementation, followed by a separate stale-resolver test
and a real-factory regression that failed before the generation capture. The **282-test custody,
metadata, route, legacy-write/live-search and policy selection** passes; the new rejection reasons
also pass the real registered formatter/reader proof. All **97 registry tests** pass. Package build,
root typecheck and changed lint pass. Final package, full coverage and product/live qualification
remain open. Token rotation, deletion-driven Chat invalidation and actual binding admission are
not yet claimed by this checkpoint.

## Credential owner and public projection — #4084 AC3/#4085 AC2/AC4

The auditor identified the conditional metadata leak before Live-Pod creation was wired. Three
HTTP regressions first failed against the preceding routes: private GET metadata, missing trusted
owner on Create, and visibility of another operator's Pod. The routes now derive ownership from
the existing server operator, select only owned Live Pods, and explicitly project public credential
fields for both GET and Create. Verify/Delete hide foreign records with the existing not-found
rejection and no outbound Jira call. Legacy Cloud credential behavior remains covered.

The existing Activity Log records only the visible list count, with a registered writer/reader
reconstruction test. Pod verification completion, binding admission, lifecycle invalidations,
grants and approvals still require their subsequent composition. This is not AC completion.

All 83 credential custody/route tests and 97 registry tests pass. Package build, root typecheck,
changed lint/format, ADR and semantic checks pass. Regeneration resolves 609 proofs and 30 scenarios
without violations. The diagnostic vocabulary addition required refreshing clone locations;
the baseline still contains the same 938 group memberships, verified by comparing every member
path before/after. No duplicated implementation or additional baseline group was accepted.

## Verification completion through HTTP — #4084 AC3/#4085 AC3/AC4

Five real HTTP cases failed before ticket composition: retained success/failure readiness,
both newer-success and newer-failure races, deletion during a probe, and an internally aborted
probe. The existing Verify route now uses the custody generation/revision checks. Stale answers
return 409; failed or aborted current probes advance the generation, and internal aborts become
unverified instead of remaining in progress. Existing Cloud verification stays unchanged.

The actual Activity Log writer/reader reconstructs applied and stale verification observations
and aborted probes, without response content. Custody tests also check that a stale start leaves
the stored revision untouched. Chat binding admission, restart/lifecycle coordination and
grant/approval invalidations remain separate work; this checkpoint does not complete an AC.

All 107 focused custody/credential-route/Data-Center-verification tests and 97 registry tests pass.
Package build, root typecheck, changed lint/format, ADR and staged semantic checks pass. Registry
regeneration resolves 609 proofs and 30 scenarios without violations. Final integrated, live,
coverage and aggregate gates remain pending as listed above.

## Authenticated Chat binding PATCH — #4084 AC1/AC4/#4085 readiness boundary

Ten actual HTTP regression cases first failed: connect/replace/disconnect and mode persistence,
foreign/unverified/unknown Pod selection, malformed/server-owned fields, missing scope precondition
and competing updates. The existing PATCH route now admits only an owned, verified Pod and passes
its current generation to the existing atomic store. It requires the current scope identity for
Jira/mode intent, rejects generation overrides, uses the existing turn serializer and rechecks the
Pod during application. Another Chat remains unchanged. No Coding session is created.

Store and route logging avoid duplicate applied events. A real writer/reader HTTP proof reconstructs
one application, two denials and one conflict without Pod IDs or credential contents. This checkpoint
adds binding admission; it does not mint authority, read grants or approvals. Those controls and the
normal-Chat tool loop, Pod lifecycle coordination and UI remain incomplete.

All 239 affected credential-route/Chat-handler/binding-store tests and 97 registry tests pass.
Package build, root typecheck and changed lint pass. The regenerated registry resolves 609 proofs
and 30 scenarios without violations. Final integrated and live acceptance remain pending.

## Review corrections: update bounds and current AC status — #4083/#4081

The review correctly identified that the schema admitted 100 additive updates while the existing
field validator rejected more than 50. Both now use `JIRA_METADATA_MAX_UPDATES` from the connector
owner; mutation descriptors advance to version 3. Actual gateway/binder regressions with 51 and
100 updates first failed against the previous descriptor. The corrected gateway rejects them
before journal preparation and remote writes, with registered body-free rejection evidence.
The existing runtime control accepts 50 supported label updates and refuses the next one.

The AC matrix was reconciled with the retained checkpoints: 29 rows now describe implemented
portions and their specific remaining work, including SDK/journal composition and normal Chat
binding admission. No acceptance checkbox was marked complete. Product Chat authority, live
qualification and final aggregate gates are still explicitly outstanding.

All 103 field/provider/non-Coding-consumer/SDK-mutation tests and 97 registry tests pass after the
correction. Package build, root typecheck, changed lint/format and staged semantic checks pass.
The existing registered gateway rejection is checked through its production formatter; its owning
package retains the canonical proof. Final assembled-package and aggregate qualification remain pending.

A read-only lab recheck on 2026-10-27 confirms healthy Jira/PostgreSQL containers and all three
production HTTPS/PAT connection cases (trusted connection, untrusted certificate and revoked
exact admission). The license check reports expired. This is connection evidence only, not a
licensed write/model/browser qualification; the next complete live group needs a valid session.
