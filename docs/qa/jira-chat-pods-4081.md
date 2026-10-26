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

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC2:** Name/base URL/deployment/credential reference persist through the current owner; cleartext PAT is absent from saved metadata, responses, browser recovery, MCP configuration, logs and evidence. Resolve the PAT only at outbound execution; Keiko-managed rotation/revocation updates the connector generation for dependent consumers. Jira-side revocation is enforced by Jira on each call; an observed auth failure invalidates local readiness and pending work.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC3:** Root and non-root Jira context paths work. Exactly admitted enterprise/private and trusted local-lab HTTPS targets work; other hosts/ports, path escape, Keiko's own listener, metadata/link-local addresses, DNS rebinding and mixed-class answers, cross-origin redirects, untrusted certificates and expired certificates remain refused, including the proxy path. Admission cannot be enabled through environment variables or the global private-egress flag.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC4:** Existing saved Cloud connectors and Data Pods load without migration loss. Live Jira Pod creation and readiness do not require USearch, an embedding model, indexing or a sync job. A Data Center connector refuses sync with a closed reason and performs no sync request; Cloud sync is unchanged.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC5:** A repeatable local-only bootstrap/preflight produces every listed fixture class, verifies license validity and both reads and writes, preserves volumes and never prints credentials. The published timebomb license is re-entered per qualification session by owner decision; there is no clock change, license modification or customer licensing.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC6:** Real adapter and registered Activity Log tests prove successful and failed paths without retaining tokens, endpoint strings, identity data, request bodies or raw provider errors. All applicable gates pass on the actual implementation head.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

### #4089 — Establish a shared MCP host for Keiko-managed providers and governed non-OpenCode consumers

- [ ] **AC1:** A real SDK client and server execute MCP 2026-07-28 through the modern in-process request path without sockets or spawned processes. Tests exercise `server/discover`, `tools/list`, `tools/call`, required per-request metadata and unsupported-version rejection, and record the actual protocol revision. Malformed messages, unknown tools and schema-invalid arguments are refused before a handler runs. A legacy `initialize` handshake or linked in-memory transport alone does not satisfy this criterion; legacy compatibility is tested separately only if deliberately implemented.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC2:** Every tool the model can see originates from a compiled `keiko-tool-catalog` projection through the bound gateway advertisement; a hand-written, unknown or post-admission-drifted tool cannot be advertised or dispatched. Existing `projection-mismatch` protection stays green.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC3:** Call context is injected server-side only; routing and authority overrides are refused. Ordinary links in supported issue content remain data. Interleaved calls from two differently bound consumers, with cancellation and reversed completion order, cannot observe or use each other's context. Unsupported SDK input fulfillment or retries cannot bypass canonical admission and invocation accounting.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC4:** The admission pipeline composes stricter-wins in all three modes; a denied call performs no handler call; approval and grant redemption re-validate binding, generation, envelope, mode and budget; cancellation and timeout settle exactly once.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC5:** An import of `@modelcontextprotocol/*` outside the host fails `arch:check`, proven by a negative fixture in `arch:check:negative`; dependency matrix, currency, hygiene, SBOM and package-surface gates pass.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC6:** Registered body-free Activity Log events reconstruct provider admission and the call lifecycle with correlation and failure classes; existing Workbench MCP registry, relay and OAuth suites are unchanged and green. All applicable gates pass on the actual implementation head.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC7:** A hermetic non-Coding consumer executes through the production catalog binder and admission pipeline without a synthetic Coding session or workspace authority. Existing Coding identity, mutation and approval guards retain their regression coverage.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

### #4083 — Expose Jira Data Center ticket operations as the first managed provider on the shared MCP host

- [ ] **AC1:** Real modern MCP discovery, per-request protocol metadata, `tools/list` and `tools/call` through the shared host exercise the production Jira provider and list exactly the implemented typed capabilities; every listed tool has a catalog descriptor and an ADR-0128 D4 row. Unknown tools, malformed arguments and caller-supplied credentials, arbitrary destinations or connector switching are refused before HTTP execution.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC2:** Against local Jira 10.3.26, a non-admin PAT searches/reads and performs create/edit/assign/comment/transition where Jira permits them, and the restricted identity is refused truthfully without escalation. The recorded supported-operation matrix names each tested operation, endpoint family and unsupported capability; it never claims full Jira REST coverage.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC3:** Required supported custom fields, constrained fields and workflow-specific transitions are discovered/validated from real metadata through the post-9.0 endpoints. A real transition-screen fixture requires a supported field; omitting it fails, and the approved field value and transition succeed in one request. Undeclared mutation verbs, worklogs and unsupported compound effects are refused before HTTP. Unknown plugin-specific field types are reported as unsupported with no fabricated values. Missing/invalid values and unauthorized issues/actions produce honest safe errors without escalating to an admin identity.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC4:** Pagination, empty results, partial results, bounds, timeout and cancellation behave deterministically. Jira content and tool metadata cannot modify the tool allowlist, credential, chat binding, read grant or approval state.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC5:** Tests distinguish malformed/truncated acknowledged 2xx from unknown remote effects, and prove no blind mutation replay after timeout, committed-then-5xx or cancellation. They cover intervening field/assignee changes and operation-aware retry safety, not only duplicate POST. Route, canonical tool outcome, activity and UI folds agree; an empty reconciliation search never authorizes a retry. Approved action changes invalidate stale approval. Document the concurrency limit of operations without an atomic Jira precondition; do not claim universal exactly-once execution or lost-update prevention.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC7:** With no explicit ceiling configured, the connector policy evaluates Chat-consumer and Coding-run calls against the same resolved `autonomous-delivery` ceiling; `KEIKO_CODING_DEPLOYMENT_CEILING=governed-assist` clamps both, and an unrecognized value fails closed to `governed-assist`. Proven through the production policy and composition, not a hand-built deps object.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC6:** Tool descriptions, inputs and output envelopes contain no PAT; activity/evidence contain no Jira content or private endpoints. Existing Cloud v3 services and Workbench MCP tests remain green.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

### #4084 — Bind one Jira Pod to ordinary Chat with per-chat mode, Chat authority and a one-time read grant

- [ ] **AC1:** Server-side concurrent connect/replace requests cannot leave two Jira Pods attached to one Chat. The binding, grounding identity and generation update atomically through the authenticated PATCH pattern; restart/reload restores valid bindings without cross-chat or cross-token reuse. A registry entry, guessed ID, client-side edge or another Chat's binding grants no access, and a Chat without a binding offers no Jira tool to the consumer context.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC2:** All three modes have explicit regression coverage through the shared action-class policy, including per-chat mode persistence, the unconfigured `autonomous-delivery` tool-source ceiling delivered by the one server resolver from #4083 and an explicitly narrower ceiling: required approval precedes network/effect, denied actions make no call, bounded allowed actions execute without invented extra approval. The read grant is requested once, covers only read-class tools of the current binding and credential generation, and never covers writes. Missing/expired authority remains denied in every mode.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC3:** Disconnect, replacement, Pod deletion and Keiko-managed token rotation/revocation revoke read grants and invalidate pending approvals and queued calls. Jira-side token revocation is enforced on the next Jira call; observed auth failure invalidates local readiness and pending work without introducing polling or webhooks. Tests cover these changes during approval and before effect; no stale request uses the old or newly substituted credential.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC4:** Two chats using different Pods are isolated; two chats deliberately using the same Pod share neither grants nor approval state; a new or copied Chat identity cannot inherit grants or approvals. Data-Pod-only grounding is byte-for-byte unchanged in behaviour and existing Workbench MCP works unchanged.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC5:** Production-path lifecycle logging for binding, mode, grant and approval is registered and body-free. Restart and authority/mode changes cannot revive expired grants, approvals or queued effects. All applicable gates pass.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC6:** Through the trusted non-Coding test consumer against local Jira 10.3.26, an admitted read-class call reaches the real provider only with a valid grant, and a write-class call only under the mode matrix or a redeemed approval that re-ran the complete pipeline; a denied, expired or revoked call performs no HTTP request.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

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

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC2:** The PAT is write-only, cleared on save/cancel/unmount and never returned in later reads, stored in browser persistence, placed in URLs, screenshots, analytics or error strings. Duplicate submits/retries do not create duplicate Pods or orphan credentials.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC3:** The card reports actual verification status. Bad/revoked token, inaccessible Jira, trust failure, redirect/HTML response, permission refusal and, where observable, license or read-only restrictions have actionable bounded presentation; saving or probing identity does not promise every action is permitted.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC4:** Rename, reverify, token replacement and removal survive reload and use the existing server owner. Tests delete/replace a Pod-owned credential through the existing credential route while two Chats share the Pod and deliver stale verification replies after rotation; neither alternate entry points nor late replies restore stale access. Removal deletes the owned credential and dependent Chat bindings; token rotation preserves their visible association but invalidates authorization, read grants and pending work until re-verification; deleting one Pod never damages unrelated credentials or Data Pods.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

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
