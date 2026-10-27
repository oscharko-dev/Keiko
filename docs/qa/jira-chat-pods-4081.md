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

Status: **Partial — not accepted**. Implementation: `jira-managed-tools.ts`, `jiraManagedProvider.ts`, shared catalog/SDK composition. Verification: `catalogNonCodingConsumer.test.ts` (real SDK, synthetic HTTP). Evidence: first-Jira-capability checkpoint below. Only `jira.projects` is currently advertised; remaining operations and actual Chat admission are pending.

- [ ] **AC2:** Against local Jira 10.3.26, a non-admin PAT searches/reads and performs create/edit/assign/comment/transition where Jira permits them, and the restricted identity is refused truthfully without escalation. The recorded supported-operation matrix names each tested operation, endpoint family and unsupported capability; it never claims full Jira REST coverage.

Status: **Pending**. Implementation: pending. Verification: pending. Evidence: pending.

- [ ] **AC3:** Required supported custom fields, constrained fields and workflow-specific transitions are discovered/validated from real metadata through the post-9.0 endpoints. A real transition-screen fixture requires a supported field; omitting it fails, and the approved field value and transition succeed in one request. Undeclared mutation verbs, worklogs and unsupported compound effects are refused before HTTP. Unknown plugin-specific field types are reported as unsupported with no fabricated values. Missing/invalid values and unauthorized issues/actions produce honest safe errors without escalating to an admin identity.

Status: **Partial — not accepted**. Implementation: `jira-field-metadata.ts` bounded field/verb validation. Verification: 26 field tests plus synthetic-lab required-field/transition baseline. Evidence: metadata-field checkpoint below. Production fresh-metadata write composition and live matrix remain pending.

- [ ] **AC4:** Pagination, empty results, partial results, bounds, timeout and cancellation behave deterministically. Jira content and tool metadata cannot modify the tool allowlist, credential, chat binding, read grant or approval state.

Status: **Partial — not accepted**. Implementation: bounded project pages and existing shared host cancellation/bounds. Verification: actual project SDK path and host regressions. Evidence: first-Jira-capability and host checkpoints below. Full operation pagination/cancellation matrix remains pending.

- [ ] **AC5:** Tests distinguish malformed/truncated acknowledged 2xx from unknown remote effects, and prove no blind mutation replay after timeout, committed-then-5xx or cancellation. They cover intervening field/assignee changes and operation-aware retry safety, not only duplicate POST. Route, canonical tool outcome, activity and UI folds agree; an empty reconciliation search never authorizes a retry. Approved action changes invalidate stale approval. Document the concurrency limit of operations without an atomic Jira precondition; do not claim universal exactly-once execution or lost-update prevention.

Status: **Partial — not accepted**. Implementation: GET-only physical retries in the existing HTTP helper. Verification: POST/PUT committed-error and foreign-change regressions plus real route logging. Evidence: mutation-transport checkpoint below. Durable intent, rich outcome and UI/Chat folds remain pending.

- [ ] **AC7:** With no explicit ceiling configured, the connector policy evaluates Chat-consumer and Coding-run calls against the same resolved `autonomous-delivery` ceiling; `KEIKO_CODING_DEPLOYMENT_CEILING=governed-assist` clamps both, and an unrecognized value fails closed to `governed-assist`. Proven through the production policy and composition, not a hand-built deps object.

Status: **Partial — not accepted**. Implementation: shared deployment-ceiling resolver in production composition. Verification: production `buildUiHandlerDeps` and connector policy tests. Evidence: deployment-ceiling checkpoint below. Actual Chat authority composition remains pending.

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
