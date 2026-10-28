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

The independent Jira 10.3.26/PostgreSQL 16 lab now has trusted local HTTPS and a
normally bootstrapped, synthetic licensed session. Checkout dependencies, USearch and
ripgrep are provisioned. The earlier session expired; a fresh independent session was
bootstrapped on 2026-10-28. License validity is checked at each group's opening and
completion rather than inferred from a previous session's expiry or container health.
Read/write preflights, browser read/write/lifecycle groups and both complete 14-operation
normal-Chat catalog groups passed within their recorded artifact/session scopes.
These scoped proofs do not establish full acceptance; the checkpoints below record
what ran and the remaining obligations.

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
`Partial` includes implemented behavior whose complete acceptance evidence is still outstanding.
The [complete catalog groups](#complete-live-catalog-groups-and-cancellation-recovery),
[retained consent](#incremental-qualification--retained-consent-and-controlled-empty-evidence-answers),
[UI/Data-surface proofs](#incremental-qualification--capability-empty-evidence-and-current-jira-pages)
and [fresh setup](#incremental-qualification--renewed-laboratory-and-reproducible-cold-setup)
are scoped evidence; live receipts from prior artifacts do not establish acceptance at the final PR head.
The initial 10/10 fault receipt interrupted by an artifact rebuild is diagnostic only.
The subsequent [stable-artifact fault group](#stable-artifact-fault-qualification-and-custody-races)
passes all ten cases on `6c63f33a0f7a`; its scope remains separate from browser transport loss.
The [latest licensed lifecycle groups](#licensed-jira-pat-availability-and-retained-consent)
add real LiteLLM/Gemma evidence for PAT revocation, Jira recovery and consent across a process
restart and credential rotation. All eight canonical issues were reread on 2026-10-28:
their 55 AC statements still match this map exactly. No checkbox is completed by these scoped proofs.

### #4082 — Support Jira Data Center PAT connections through the existing Atlassian connector

- [ ] **AC1:** A generated PAT for a non-admin lab user verifies against real Jira 10.3.26 at REST v2. Invalid/revoked PAT, insufficient permission, redirect, HTML/login response, unsupported version, stopped Jira and timeout have distinguishable safe outcomes; an HTML 2xx is never `ok`. Cloud Basic/v3 behaviour passes its existing regression tests, and a non-mocked UI-client → route test proves real Cloud and Data Center creation (the omitted `authScheme` defect fails this test before the fix).

Status: **Partial — not accepted**. The real UI-client → route creation defect is repaired; Cloud compatibility and closed Data Center REST-v2/PAT probe outcomes have retained tests. Licensed non-admin HTTPS verification and browser creation ran. The latest complete live groups additionally prove native PAT revocation, invalid-token refusal, stale-success rejection and stopped-instance recovery through production verification. Complete response-class/permission regressions and delivered-artifact qualification remain open.

- [ ] **AC2:** Name/base URL/deployment/credential reference persist through the current owner; cleartext PAT is absent from saved metadata, responses, browser recovery, MCP configuration, logs and evidence. Resolve the PAT only at outbound execution; Keiko-managed rotation/revocation updates the connector generation for dependent consumers. Jira-side revocation is enforced by Jira on each call; an observed auth failure invalidates local readiness and pending work.

Status: **Partial — not accepted**. Vault-only custody, generation-pinned materialization and public projections are implemented. Observed current 401 invalidates readiness, authority, read grants and write approvals; 403/stale observations do not revoke a replacement. The latest native revocation and actual-Chat rotation groups prove generation invalidation and a stale verification refusal. Their retained product/log sweep finds no tested secret; no Gateway vault is duplicated. Final browser-persistence/leak and complete lifecycle qualification remain open.

- [ ] **AC3:** Root and non-root Jira context paths work. Exactly admitted enterprise/private and trusted local-lab HTTPS targets work; other hosts/ports, path escape, Keiko's own listener, metadata/link-local addresses, DNS rebinding and mixed-class answers, cross-origin redirects, untrusted certificates and expired certificates remain refused, including the proxy path. Admission cannot be enabled through environment variables or the global private-egress flag.

Status: **Partial — not accepted**. Exact operator-owned targets, context paths, direct/proxy DNS pinning and TLS/redirect refusals have retained transport tests. Real trusted HTTPS/admission-removal probes passed. Final direct/proxy boundary regression and delivered-head qualification remain open.

- [ ] **AC4:** Existing saved Cloud connectors and Data Pods load without migration loss. Live Jira Pod creation and readiness do not require USearch, an embedding model, indexing or a sync job. A Data Center connector refuses sync with a closed reason and performs no sync request; Cloud sync is unchanged.

Status: **Partial — not accepted**. Cloud metadata remains readable, Data Center sync refuses before HTTP, and real Live-Pod Hub/Chat groups require no embedding or index setup. Direct BFF Live-to-Data refusals and a real Data control pass within 227 credential/Data-handler cases. Complete saved Data/synced-Jira and Cloud compatibility on the final artifact remains open.

- [ ] **AC5:** A repeatable local-only bootstrap/preflight produces every listed fixture class, verifies license validity and both reads and writes, preserves volumes and never prints credentials. The published timebomb license is re-entered per qualification session by owner decision; there is no clock change, license modification or customer licensing.

Status: **Partial — not accepted**. Synthetic fixture groups and licensed read/write preflights are recorded. The corrected first-run script completed an independent empty-volume setup without manual continuation; the fresh session also passed supported-field, transition-screen, permission, pagination and hostile-content fixture checks. Native verification recovery now waits for the read-only license check after container readiness, preserving the inspected containers and volumes. Fixture setup is not normal-Chat acceptance. Final combined qualification and fresh opening/closing checks for every remaining group are required.

- [ ] **AC6:** Real adapter and registered Activity Log tests prove successful and failed paths without retaining tokens, endpoint strings, identity data, request bodies or raw provider errors. All applicable gates pass on the actual implementation head.

Status: **Partial — not accepted**. Registered body-free credential, verification, host/admission, grant/approval and mutation evidence has writer/reader and real-adapter proofs, plus live marker/PAT absence sweeps. The source failure-path inventory is clean after the parser/store/UI repairs; the complete regenerated Activity Log, error-observability and final-head gate run remains open.

### #4089 — Establish a shared MCP host for Keiko-managed providers and governed non-OpenCode consumers

- [ ] **AC1:** A real SDK client and server execute MCP 2026-07-28 through the modern in-process request path without sockets or spawned processes. Tests exercise `server/discover`, `tools/list`, `tools/call`, required per-request metadata and unsupported-version rejection, and record the actual protocol revision. Malformed messages, unknown tools and schema-invalid arguments are refused before a handler runs. A legacy `initialize` handshake or linked in-memory transport alone does not satisfy this criterion; legacy compatibility is tested separately only if deliberately implemented.

Status: **Partial — not accepted**. The official SDK host explicitly enables MCP 2026-07-28 over injected in-process fetch; actual SDK discovery/list/call, metadata, malformed-input and unsupported-version tests are retained. Final host, package and architecture qualification remains open.

- [ ] **AC2:** Every tool the model can see originates from a compiled `keiko-tool-catalog` projection through the bound gateway advertisement; a hand-written, unknown or post-admission-drifted tool cannot be advertised or dispatched. Existing `projection-mismatch` protection stays green.

Status: **Partial — not accepted**. Canonical discovery compilation, bound gateway offers and drift/schema/projection refusals compose into ordinary buffered/SSE Chat. Both complete 14-operation real-model groups exercised this path on the preceding assembled artifact. Final catalog/gateway and Coding compatibility checks remain open.

- [ ] **AC3:** Call context is injected server-side only; routing and authority overrides are refused. Ordinary links in supported issue content remain data. Interleaved calls from two differently bound consumers, with cancellation and reversed completion order, cannot observe or use each other's context. Unsupported SDK input fulfillment or retries cannot bypass canonical admission and invocation accounting.

Status: **Partial — not accepted**. Server-only invocation context, override rejection and interleaved/cancelled SDK calls have retained proofs. The actual-Gateway suite now proves same-Pod and different-Pod Chats with reversed completion, separate grants/call IDs and correct credential routing. Real custody/PATCH routes additionally prove selective invalidation while another Pod completes. Final integrated and gate qualification remains open.

- [ ] **AC4:** The admission pipeline composes stricter-wins in all three modes; a denied call performs no handler call; approval and grant redemption re-validate binding, generation, envelope, mode and budget; cancellation and timeout settle exactly once.

Status: **Partial — not accepted**. Shared stricter-wins policy, cumulative reservation, read consent and exact-action approvals run through ordinary Chat. Eight regression-first buffered/SSE read/write cancellation cases and actual buffered HTTP disconnects now drain composite-signal waits, revoke unfulfilled decisions and make zero Jira calls; granted read consent remains valid within its original scope. Full expiry/race/budget/restart qualification on the final artifact remains open.

- [ ] **AC5:** An import of `@modelcontextprotocol/*` outside the host fails `arch:check`, proven by a negative fixture in `arch:check:negative`; dependency matrix, currency, hygiene, SBOM and package-surface gates pass.

Status: **Partial — not accepted**. The SDK import boundary, negative fixture and package registration are implemented. Final architecture/negative, dependency currency/hygiene/matrix, SBOM and assembled-package gates remain open; no final package-surface acceptance is claimed.

- [ ] **AC6:** Registered body-free Activity Log events reconstruct provider admission and the call lifecycle with correlation and failure classes; existing Workbench MCP registry, relay and OAuth suites are unchanged and green. All applicable gates pass on the actual implementation head.

Status: **Partial — not accepted**. Registered host/catalog/Chat events reconstruct the retained scoped proofs; unchanged failure-path scanning reports no unregistered production catches. Existing scoped Workbench regressions are retained. Complete registry/relay/OAuth, regenerated Activity Log and final-head gates remain open.

- [ ] **AC7:** A hermetic non-Coding consumer executes through the production catalog binder and admission pipeline without a synthetic Coding session or workspace authority. Existing Coding identity, mutation and approval guards retain their regression coverage.

Status: **Partial — not accepted**. The hermetic non-Coding consumer and ordinary product Chat use the production binder/shared host without a synthetic Coding session. Complete buffered/SSE 14-operation live groups prove that composition on a preceding artifact. Final Coding identity/approval/mutation compatibility remains open.

### #4083 — Expose Jira Data Center ticket operations as the first managed provider on the shared MCP host

- [ ] **AC1:** Real modern MCP discovery, per-request protocol metadata, `tools/list` and `tools/call` through the shared host exercise the production Jira provider and list exactly the implemented typed capabilities; every listed tool has a catalog descriptor and an ADR-0128 D4 row. Unknown tools, malformed arguments and caller-supplied credentials, arbitrary destinations or connector switching are refused before HTTP execution.

Status: **Partial — not accepted**. All nine reads and five writes have canonical descriptors and ADR-0128 D4 mappings. Complete buffered and SSE normal-Chat groups exercised every advertised operation through the actual gateway/binder/SDK. Schema/routing/credential override refusals have retained tests; current-head full host/provider qualification remains open.

- [ ] **AC2:** Against local Jira 10.3.26, a non-admin PAT searches/reads and performs create/edit/assign/comment/transition where Jira permits them, and the restricted identity is refused truthfully without escalation. The recorded supported-operation matrix names each tested operation, endpoint family and unsupported capability; it never claims full Jira REST coverage.

Status: **Partial — not accepted**. Both complete 14-operation normal-Chat groups passed against licensed Jira 10.3.26 with the verified Qwen model and non-admin API identity: nine reads plus create/edit/assign/comment/transition, independently checked remotely. The separate restricted buffered catalog passed 14/14 with zero effects; both focused permission groups passed 8/8. These are prior-artifact receipts. The complete restricted SSE catalog and final-artifact repetition through the selected LiteLLM/Gemma Gateway remain open.

- [ ] **AC3:** Required supported custom fields, constrained fields and workflow-specific transitions are discovered/validated from real metadata through the post-9.0 endpoints. A real transition-screen fixture requires a supported field; omitting it fails, and the approved field value and transition succeed in one request. Undeclared mutation verbs, worklogs and unsupported compound effects are refused before HTTP. Unknown plugin-specific field types are reported as unsupported with no fabricated values. Missing/invalid values and unauthorized issues/actions produce honest safe errors without escalating to an admin identity.

Status: **Partial — not accepted**. Current Data Center pagination and endpoint-selected create context were repaired from real failures with zero writes before refusal. Both complete catalog groups created with supported required fields and transitioned with the required custom value and resolution in one action, verified remotely. Both focused restricted groups additionally refused omitted create/transition fields before mutation dispatch. Unknown plugin/verb and metadata-bound value refusals have deterministic proofs. Remaining invalid-field/unsupported-field presentation and final-artifact qualification stay open.

- [ ] **AC4:** Pagination, empty results, partial results, bounds, timeout and cancellation behave deterministically. Jira content and tool metadata cannot modify the tool allowlist, credential, chat binding, read grant or approval state.

Status: **Partial — not accepted**. Bounded pagination/results, schema/context override refusal and cancellation have retained domain/SDK tests. The real catalog groups read the hostile-comment fixture; their single-key search is not a pagination proof. A separate complete LiteLLM/Gemma SSE group now traverses all 26 reference issues through the real provider with exact request cursors and bounded pages, then proves an empty terminal page and zero writes. Mixed empty results require an actual successful sanitized observation. Full per-operation bounds/failure, hostile-content and final-artifact qualification remain open.

- [ ] **AC5:** Tests distinguish malformed/truncated acknowledged 2xx from unknown remote effects, and prove no blind mutation replay after timeout, committed-then-5xx or cancellation. They cover intervening field/assignee changes and operation-aware retry safety, not only duplicate POST. Route, canonical tool outcome, activity and UI folds agree; an empty reconciliation search never authorizes a retry. Approved action changes invalidate stale approval. Document the concurrency limit of operations without an atomic Jira precondition; do not claim universal exactly-once execution or lost-update prevention.

Status: **Partial — not accepted**. Durable canonical-turn journaling, GET-only retries, operation-aware confirmation and distinct acknowledged/unknown outcomes are implemented. The complete stable-artifact real-model fault group passes all five mutations under lost observation and committed-then-503, with canonical duplicates, fresh-process restart, Regenerate and independent remote counts. Four separate foreign PUT changes remain preserved. Browser transport-loss qualification and final gates remain open; Jira concurrency limits remain explicit.

- [ ] **AC7:** With no explicit ceiling configured, the connector policy evaluates Chat-consumer and Coding-run calls against the same resolved `autonomous-delivery` ceiling; `KEIKO_CODING_DEPLOYMENT_CEILING=governed-assist` clamps both, and an unrecognized value fails closed to `governed-assist`. Proven through the production policy and composition, not a hand-built deps object.

Status: **Partial — not accepted**. The shared deployment resolver composes into Coding and Chat, including default/narrow/invalid ceilings. Server-derived effective modes and real browser Ask/Full journeys are recorded, with all-mode comment groups separately retained. Complete ceiling/clamp browser coverage and final policy/consumer regression remain open.

- [ ] **AC6:** Tool descriptions, inputs and output envelopes contain no PAT; activity/evidence contain no Jira content or private endpoints. Existing Cloud v3 services and Workbench MCP tests remain green.

Status: **Partial — not accepted**. Private context and registered events retain secret-absence and Cloud tests. Post-merge preservation tests also prove that the content opt-out keeps configured credentials out of mixed prompts, answers and private history, while buffered/streamed tool arguments retain unconditional protection. Final Cloud/Workbench and full redaction/evidence gates remain open.

### #4084 — Bind one Jira Pod to ordinary Chat with per-chat mode, Chat authority and a one-time read grant

- [ ] **AC1:** Server-side concurrent connect/replace requests cannot leave two Jira Pods attached to one Chat. The binding, grounding identity and generation update atomically through the authenticated PATCH pattern; restart/reload restores valid bindings without cross-chat or cross-token reuse. A registry entry, guessed ID, client-side edge or another Chat's binding grants no access, and a Chat without a binding offers no Jira tool to the consumer context.

Status: **Partial — not accepted**. Authenticated PATCH atomically persists one owned verified binding and its generations, with conflict/reopen tests; tools require that binding and edges await acknowledgement. The latest real-model lifecycle group reopens the persisted Chat in a fresh Node process and reuses its still-valid read consent under newly admitted authority. Complete browser restart and simultaneous two-Chat live qualification remain open.

- [ ] **AC2:** All three modes have explicit regression coverage through the shared action-class policy, including per-chat mode persistence, the unconfigured `autonomous-delivery` tool-source ceiling delivered by the one server resolver from #4083 and an explicitly narrower ceiling: required approval precedes network/effect, denied actions make no call, bounded allowed actions execute without invented extra approval. The read grant is requested once, covers only read-class tools of the current binding and credential generation, and never covers writes. Missing/expired authority remains denied in every mode.

Status: **Partial — not accepted**. All three modes have real buffered/SSE/browser comment receipts, separate from the complete 14-operation Ask groups. Read consent, exact action approval/claim, denial, expiry and narrower ceilings have owner/route proofs. Valid consent is reusable across later turns and fresh registries, without restoring authority or budgets. Complete permission/all-operation mode coverage and final-head qualification remain open.

- [ ] **AC3:** Disconnect, replacement, Pod deletion and Keiko-managed token rotation/revocation revoke read grants and invalidate pending approvals and queued calls. Jira-side token revocation is enforced on the next Jira call; observed auth failure invalidates local readiness and pending work without introducing polling or webhooks. Tests cover these changes during approval and before effect; no stale request uses the old or newly substituted credential.

Status: **Partial — not accepted**. Lifecycle commits invalidate work through existing custody/store owners. Direct credential routes, shared-Pod Chats, stale verification and observed current 401 have route proofs; a rebuilt browser lifecycle group exercised rename, distinct token replacement, grant revocation, reverification and removal. New live verification and consent groups prove native PAT revocation, stale-success refusal and actual Chat rotation to a different identity with fresh disclosure. Pending-decision tests drain with zero Jira calls. The complete queued/in-flight live race matrix with independent remote counts remains open.

- [ ] **AC4:** Two chats using different Pods are isolated; two chats deliberately using the same Pod share neither grants nor approval state; a new or copied Chat identity cannot inherit grants or approvals. Data-Pod-only grounding is byte-for-byte unchanged in behaviour and existing Workbench MCP works unchanged.

Status: **Partial — not accepted**. Owner/route tests isolate actors, Chats, Pods and shared credentials; retained consent cannot cross its exact subject or generations. Mixed/Data-only/Memory regressions pass, including the merged content-policy compatibility checks. Complete simultaneous product isolation and final Data-only/Workbench qualification remain open.

- [ ] **AC5:** Production-path lifecycle logging for binding, mode, grant and approval is registered and body-free. Restart and authority/mode changes cannot revive expired grants, approvals or queued effects. All applicable gates pass.

Status: **Partial — not accepted**. Registered binding/mode/grant/approval lifecycle evidence is retained. Granted consent persists in the existing bounded SQLite owner with exact subject, generations, disclosure and original expiry; new turns independently re-admit authority and budgets. A complete live group proves reuse in a fresh process and invalidation after rotation. Pending decisions revoke on shutdown, and read-only history recovery never resumes a turn. Complete expired/mode-change/browser cases and final gates remain open.

- [ ] **AC6:** Through the trusted non-Coding test consumer against local Jira 10.3.26, an admitted read-class call reaches the real provider only with a valid grant, and a write-class call only under the mode matrix or a redeemed approval that re-ran the complete pipeline; a denied, expired or revoked call performs no HTTP request.

Status: **Partial — not accepted**. The ordinary-Chat consumer reached licensed Jira for all 14 operations in buffered and SSE groups on a preceding artifact. Earlier all-mode comment groups prove read disclosure and required write approval; hermetic routes and actual HTTP cancellation prove zero calls after refused/cancelled work. Complete live denied/expired/revoked cases and final-artifact qualification remain open.

### #4091 — Run a governed tool loop in ordinary Chat through the shared MCP host

- [ ] **AC1:** Before this child closes, an authenticated normal Chat API performs a read and a governed write through the real gateway → production catalog binder → shared MCP host → local Jira 10.3.26, using a verified tool-capable real model and checking remote state. Exercise both buffered and streaming turns; the unfinished UI is not a substitute runtime or a reason to defer this proof to #4087. A normal Chat with a valid connected Jira Pod discovers and invokes the real provider through the shared host; a Chat without that binding is offered no Jira tool. A registry entry, guessed ID, client-side edge or another Chat's binding grants no access.

Status: **Partial — not accepted**. Authenticated normal buffered/SSE Chat completed all 14 operations through the verified Qwen gateway, production binder/shared host and licensed Jira, with independent remote readbacks. The latest LiteLLM/Gemma lifecycle group adds real buffered/streamed reads and an approved streamed write with exactly one independently verified effect. Binding/capability denial tests remain retained. Full catalog repetition and final delivered-head acceptance remain open.

- [ ] **AC2:** In-flight cancellation never reports a false rollback or false success. An already applied Jira effect is shown as completed; uncertain outcomes are reconciled or clearly shown as unknown, without automatic duplication.

Status: **Partial — not accepted**. Catalog settlement and durable remote outcome remain separate in history, compaction and UI. Late acknowledged effects survive cancellation and fresh SQLite reads without dispatch; cancellation before consent/approval makes zero Jira calls and closes the canonical turn. The later stable-artifact ten-case fault group passes with independent remote counts; the earlier mid-build run remains diagnostic only. Physical browser interruption and final-artifact qualification remain open.

- [ ] **AC3:** Data-Pod-only grounding is byte-for-byte unchanged in behaviour, the mixed-scope schedule is tested through actual gateway admission, existing Workbench MCP works unchanged, Jira works with no embedding/index setup, and a model without verified tool calling yields the truthful unavailable state instead of silently answering without tools.

Status: **Partial — not accepted**. Actual-Gateway mixed tests cover Data evidence before tools, local Data Pods, usable empty results, unchanged Data-only abstention, missing-path refusal and independently narrower Memory admission. Failed/denied/unconfirmed tool observations cannot unlock fabricated empty-pack answers. Bound models without current tool proof fail before model/Jira dispatch with EN/DE guidance. Post-merge preservation/grounding regressions pass; final Workbench and comprehensive compatibility qualification remain open.

- [ ] **AC4:** Production-path tool-loop lifecycle logging (offered, started, grant-required, approval-required, completed, failed, unknown) is registered and body-free; the provider receives only authorized scoped calls; tool output and prompt injection cannot extend authority, select a credential or change the binding. All applicable gates pass.

Status: **Partial — not accepted**. Existing registered owners cover offers, consent, exact approvals/claims, dispatch, settlement and late observations without content. Scoped calls, schema/authority injection refusal and hostile-result controls have retained tests; failure-path scanning is clean after the observation repairs. Full normal-Chat hostile-content qualification and final logging/gates remain open.

- [ ] **AC5:** Response-loss, duplicate-delivery, streaming fallback, context-window retry, reconnect, reload and Regenerate tests assert Jira mutation counts. Completed or unresolved effects are not replayed; crash recovery presents unknown outcomes truthfully. Compaction and provider-adapter round trips preserve tool-call/result IDs, relationships and cumulative usage.

Status: **Partial — not accepted**. Canonical duplicates, response loss, late/unknown recovery, journal restart, paired history and compaction have scoped proofs. The 27-case public/Gateway suite now also proves one POST after a committed write followed by context overflow: retries preserve tool/result IDs, canonical replay adds no calls, and the original two-synthesis ceiling blocks a fourth repair request. Pre-admission SSE-to-buffered fallback remains green. Complete reconnect, browser response-loss/Regenerate and final live remote-effect-count qualification remain open.

- [ ] **AC6:** Mixed Jira/Data-Pod turns retain separate source attribution and the existing physical grounded-synthesis ceiling across orchestration, retries and repair. Production-path tests exhaust each cumulative budget without resetting it. Restart and authority/mode changes cannot revive expired grants, approvals or queued effects.

Status: **Partial — not accepted**. Data packs precede tools; one cumulative meter and the physical synthesis/repair ceiling span orchestration and retries, with Jira results outside Data citations. Retained production-Gateway tests cover post-write overflow and the original synthesis ceiling; the later 90-case normal/mixed suites add input/output, 30-call, retrieval/excerpt, deadline and ten-round exhaustion. Empty-pack safety and independent Memory admission remain covered. Live retained consent restores no authority or budgets. Final budget regression, mixed-source live execution and complete browser lifecycle qualification remain open.

### #4085 — Create and manage Jira access Pods in the existing Knowledge Pods hub

- [ ] **AC1:** The existing Knowledge Pods hub offers Data and Jira creation. A Jira Pod is created using name, address and PAT against the real local lab through the production API; Data creation and existing saved Pods, including synced Jira knowledge Pods, still work and remain distinguishable.

Status: **Partial — not accepted**. The existing Hub offers Data and Jira creation. Rebuilt real-browser groups create, verify and connect Jira through production APIs, and a lifecycle group covers rename/rotation/reverification/removal. Direct Data-surface controls preserve a real Data capsule. Complete saved/synced-Jira compatibility and final-artifact qualification remain open.

- [ ] **AC2:** The PAT is write-only, cleared on save/cancel/unmount and never returned in later reads, stored in browser persistence, placed in URLs, screenshots, analytics or error strings. Duplicate submits/retries do not create duplicate Pods or orphan credentials.

Status: **Partial — not accepted**. Write-only PAT clearing, duplicate creation intents, late-response refusal and canonical recovery are implemented with custody/UI proofs. Real browser creation and token replacement used synthetic credentials, with private Activity Log content checks. The complete browser persistence/screenshot/error/retry matrix and final-artifact qualification remain open.

- [ ] **AC3:** The card reports actual verification status. Bad/revoked token, inaccessible Jira, trust failure, redirect/HTML response, permission refusal and, where observable, license or read-only restrictions have actionable bounded presentation; saving or probing identity does not promise every action is permitted.

Status: **Partial — not accepted**. Authoritative verification metadata, uncertain-state readiness suppression, bounded EN/DE errors and permission-limit guidance are implemented. Status-union/race tests and successful rebuilt-browser lifecycle states are retained. The complete revoked/inaccessible/TLS/HTML/permission/license negative presentation matrix remains open.

- [ ] **AC4:** Rename, reverify, token replacement and removal survive reload and use the existing server owner. Tests delete/replace a Pod-owned credential through the existing credential route while two Chats share the Pod and deliver stale verification replies after rotation; neither alternate entry points nor late replies restore stale access. Removal deletes the owned credential and dependent Chat bindings; token rotation preserves their visible association but invalidates authorization, read grants and pending work until re-verification; deleting one Pod never damages unrelated credentials or Data Pods.

Status: **Partial — not accepted**. Generation-bound rename/rotation/removal and canonical GET recovery use existing owners. Route tests cover alternate credential entry points, shared-Pod Chats, unrelated Pods and stale replies. A rebuilt real-browser lifecycle group verifies rename, distinct token replacement, grant revocation, reverification and removal of credential/binding/edge. Complete process restart and in-flight approval races remain open.

- [ ] **AC5:** The ordinary Jira form requires no email, MCP configuration or vector-index setup. The initial implemented ticket capabilities are explained plainly without claiming all Jira APIs or guaranteed write permissions.

Status: **Partial — not accepted**. The Jira form requires name, HTTPS address and PAT only. It omits email/MCP/index configuration and explains bounded read/write capabilities with Jira permissions and Chat approval constraints. Focused UI tests pass; final design/browser qualification remains open.

- [ ] **AC6:** The relevant design-state matrix, keyboard/focus/screen-reader behavior, English/German text, light/dark/high-contrast and reduced-motion/zoom proofs pass with synthetic visible data. UI and wired browser gates pass.

Status: **Partial — not accepted**. The fidelity matrix names the implemented Hub/Chat owners and states. The later wired five-case Jira browser lane covers EN/DE, keyboard/focus, 83 axe checks, themes/contrast, reduced motion, narrow layouts and explicit 200% viewport emulation, with inspected source-bound captures. This is Jira-specific evidence; native screen-reader/zoom execution is not claimed. Final UI/browser gates and remaining assistive-technology qualification stay open.

- [ ] **AC7:** Live-access Pod variants cannot enter capsule-set composition, capsule export or indexing through either UI or direct server requests. They advertise no fabricated capsule, retrieval or storage state, and unsupported Cloud sync controls are absent. Existing Data and synced-Jira Pods preserve these capabilities.

Status: **Partial — not accepted**. A custody-owned Live Pod receives public-BFF refusals for capsule read, index/reindex and source connection; mixed Live/Data composition creates no partial set, while a real Data control retains its capabilities. The 227-case route/Data run and 12-case card run prove no fabricated capsule/storage or sync/export controls. No capsule-export HTTP route exists in the mounted inventory. Complete synced-Jira compatibility and final gates remain open.

### #4086 — Connect Jira Pods to Chat using existing workspace connectors and in-Chat tool cards

- [ ] **AC1:** Drag/drop and the existing keyboard alternatives (port buttons and the Chat header select) can place and connect the same saved Jira Pod. The server acknowledges the connection before the UI indicates active tool access; a failed operation leaves no phantom edge or duplicate authority.

Status: **Partial — not accepted**. Existing drag/drop, keyboard ports and the Chat selector activate only after server acknowledgement, with failure/supersession/wrong-target tests. Rebuilt real-browser groups passed keyboard connection with Ask approval and native drag with Full access, each with one independently verified remote comment. Final artifact and full header/edge/browser qualification remain open.

- [ ] **AC2:** Connecting a second Jira Pod requires an explicit replacement interaction, and the server still enforces one. Cancel or a failed replacement preserves the old binding. Successful atomic replacement invalidates old grants and pending work without granting both Pods, and replacement/disconnect updates edge, source indicator and tool availability coherently. Data Pod connections continue to function.

Status: **Partial — not accepted**. The shared explicit replacement interaction and server-owned atomic single binding preserve the old binding on cancel/failure and reject stale acknowledgements. Browser lifecycle removal clears binding and edge; Live-only/mixed Data-source labels now retain independent grounding behavior. Complete replacement/disconnect races and Data-Pod browser compatibility remain open.

- [ ] **AC3:** Before this child closes, the assembled browser journey creates/connects a Pod and performs a read and governed write through normal Chat to the real local Jira lab, verifying remote state. The user can search/read/create/edit/assign/comment/transition via normal Chat through the actual MCP path and see clear sources, progress and remote outcome. Identical ticket keys on different Jira instances are distinguishable in authorized presentation.

Status: **Partial — not accepted**. Real-browser creation/connection/read/comment writes passed, followed by rebuilt keyboard/Ask and drag/Full groups with independent one-effect counts. Separate buffered and SSE normal-Chat groups completed all 14 operations with remote readbacks on a preceding artifact. Complete browser operation coverage, cross-instance source presentation and final-artifact acceptance remain open.

- [ ] **AC4:** The read-grant request appears when the current binding/credential generation has no valid grant; a still-valid grant, including one restored after restart, does not prompt again. Approval UI appears exactly when current policy requires it; both identify the proposed scope or action and support deny/cancel. Stale grants or approvals after disconnect/token change cannot execute; pending/expired/unknown/partial/error states are truthful.

Status: **Partial — not accepted**. Current-state GET controls actionable cards; exact previews, disclosure, deny and closed outcomes have UI/route/live-mode proofs. The latest actual-Chat lifecycle group reuses valid consent after a fresh Node process, requires new disclosure after rotation, and asks once for its exact streamed write. History recovery cannot revive work, and cancelled pending decisions revoke. Full browser cold restart, stale/expired/partial states and final-artifact qualification remain open.

- [ ] **AC5:** Reload, network interruption, Pod removal, Jira shutdown and token replacement preserve the authoritative state without stale access. Retry, reconnect and Regenerate never silently repeat a completed or uncertain Jira mutation; retain its canonical outcome and show safe reconciliation. Browser tests lose the response after Jira accepts a write, deliver duplicates and regenerate, then assert remote effect counts. Restored bindings cannot recreate missing/expired grants or approvals. All content-bearing presentation follows existing retention/redaction rules and is excluded from diagnostics/evidence.

Status: **Partial — not accepted**. Durable outcomes, exact history projection and generation/request guards prevent automatic replay in scoped tests. Real-browser groups verify confirmed-comment reload and token replacement/removal; cancellation preserves late observations truthfully. Complete stable-artifact lost-response/duplicate/Regenerate, Jira shutdown and process-restart browser groups remain open; the 10/10 mid-build fault receipt is not qualification.

- [ ] **AC6:** Root connector/window/tool/source/permission designs and relevant state/accessibility/theme requirements are met; existing workspace/Data Pod/Workbench journeys remain green.

Status: **Partial — not accepted**. The five-case wired browser lane now covers both languages and all principal surfaces, with 83 full-document axe checks, keyboard/focus, themes, contrast, reduced motion, narrow/maximized layout and explicit 200% viewport emulation. Eight inspected redacted captures and source-bound receipts are retained. The question-map target/focus defect is repaired. Native assistive-technology execution is not claimed; final UI coverage and existing workspace/Data/Workbench regression gates remain open.

- [ ] **AC7:** The Chat mode selection persists per chat, defaults to Ask for approval, shows ceiling-clamped modes truthfully, and a model without verified tool calling presents an actionable unavailable state instead of silently answering without tools.

Status: **Partial — not accepted**. Per-Chat selected mode defaults to Ask and persists; the shared control displays server-derived effective/clamped modes. Real browser Ask/Full groups and all-mode comment groups are retained. Missing/stale/unsupported tool proof produces actionable EN/DE refusal before provider/Jira dispatch, including the wired browser case. Full clamp/browser state coverage and final gates remain open.

### #4087 — Qualify the complete Jira Pod to MCP to Chat workflow against local Jira 10.3.26

- [ ] **AC1:** Every initial supported operation has a real end-to-end receipt from normal Chat through the shared MCP host to local Jira 10.3.26, with remote read-after-write verification and only synthetic data. The assembled artifact/source identity, commands, model identity, test versions, wiring class and outcomes are recorded without secrets or bodies.

Status: **Partial — not accepted**. Complete buffered and streamed 14-operation receipts now exist, with nine reads, five governed writes and independent count/field/changelog/status checks against Jira 10.3.26 and the verified Qwen model. Source/artifact and receipt identities are recorded below. They precede later cancellation repairs/dev integration; repeat relevant complete groups on the final assembled artifact.

- [ ] **AC2:** All-mode, read-grant and Jira permission cases pass: no unauthorized effect; allowed operations work; approval denial/cancellation and stale approval or grant perform no new call. Ordinary Chat is tested directly rather than a Workbench-only substitute.

Status: **Partial — not accepted**. All-mode read-disclosure/comment-approval groups and separate complete 14-operation Ask groups passed on preceding artifacts. Both focused permission groups passed 8/8; the restricted buffered catalog passed 14/14 with zero effects and canonical replay checks. Deterministic routes and actual HTTP cancellation cover denied/stale/cancelled no-call behavior. Restricted SSE and the final-artifact permission/mode matrix remain open.

- [ ] **AC3:** Isolation/revocation, replay-prevention and restart tests pass, including two chats, deliberate reuse of one Pod, different Pod credentials, replacement, disconnect during approval and token rotation. Tests assert remote effect counts after lost responses, duplicate delivery, retries and Regenerate. Completed remote effects are not falsely described as rolled back; acknowledged-but-unconfirmed and unknown outcomes remain distinct. Old verification replies and alternate credential-management entry points cannot restore revoked readiness.

Status: **Partial — not accepted**. The stable-artifact ten-case real-model fault group proves single effects through canonical duplicates, real process restart and Regenerate, including four distinct foreign PUT changes. Actual-Gateway tests add shared/distinct-Pod reversed completion, credential rotation during two pending writes, selective disconnect and acknowledged deletion races. The latest live group proves consent reuse after a real process restart and rotation to a distinct identity with exactly one approved comment. Browser transport loss and remaining final-artifact groups stay open.

- [ ] **AC4:** The small UI flow matches the root design reference and passes keyboard, screen-reader, theme/contrast, reduced-motion and constrained-layout checks. Product readiness does not depend on embedding/indexing.

Status: **Partial — not accepted**. Jira browser/Chat groups run without embedding/index setup. The later five-case Jira browser producer and inspected captures add bounded theme/contrast, reduced-motion, constrained-layout and 200% viewport evidence to EN/DE/keyboard/axe/drag/lifecycle proofs. Native screen-reader/zoom execution and final-artifact visual/gate qualification remain open.

- [ ] **AC5:** Existing Data Pod grounding, Cloud connector and Workbench MCP regressions pass, and the deterministic lane runs in its wired CI class. Timeout, pagination, cancellation and response-size tests show bounded behavior; existing performance ceilings remain unchanged.

Status: **Partial — not accepted**. Scoped Data/Memory, Cloud, Workbench, provider bounds and cancellation regressions are retained; post-merge content/grounding/approval suites pass. The blocking per-PR three-case browser lane previously passed through the assembled BFF/gateway/catalog/MCP with isolated HTTPS fixtures. Final lane/wiring freshness, complete compatibility and unchanged performance ceilings still require final-artifact checks.

- [ ] **AC6:** The independent local lab preflight proves license validity and both read and write availability. A stopped instance, expired license or missing trusted test endpoint is reported as blocked real qualification; no silent skip, customer fallback, clock change or license modification is accepted.

Status: **Partial — not accepted**. Opening and closing HTTPS/license/read/write checks passed for the complete catalog groups. Independent empty-volume setup completes without manual continuation. The latest complete recovery group reports a stopped Jira as unreachable, restores only the inspected Jira container, waits for actual license readiness and repeats production-port HTTPS/read/write preflight. Interrupted groups and their independent reconciliations remain retained. Every remaining group requires fresh license/availability checks; no expired or incomplete run qualifies.

- [ ] **AC7:** Applicable local gates including Sonar and the complete required PR checks pass on the delivered head; all review findings are settled. Only then are final evidence and AC completion recorded, with owner-authorized merge verified before issue closure.

Status: **Partial — not accepted**. Scoped post-merge tests, typechecks and lint/format do not replace acceptance. Full local coverage/architecture/evidence/Sonar, final current-head required GitHub checks and review settlement remain open. All 55 checkboxes stay unchecked; merge/issue closure require separate owner authorization and verified integration.

- [ ] **AC8:** User/developer runbooks and release-impact metadata accurately describe initial API coverage, setup, privacy (ticket content reaches the configured model), mode and read-grant behavior, troubleshooting and remaining limitations. No claim of generic full-API coverage, all-source MCP migration or customer-network certification is made.

Status: **Partial — not accepted**. The connector guide, troubleshooting runbook and ADRs now describe Live setup, privacy, modes/consent, exact approvals, field limits, mixed attribution and safe uncertain-write recovery. Stale Cloud-only/future-Data-Center claims and unsafe retry advice were corrected; the design matrix names implemented states. Validate the normalized release-impact record and complete final runbook/evidence review, without claiming generic Jira or customer-network coverage.

- [ ] **AC9:** Before the live run, record the finite acceptance scenario/operation matrix, qualified model configuration and expected outcomes. Every required operation has successful live evidence and every required refusal has evidence of no unauthorized effect. Record failed attempts and repairs as well as the successful run; model retries or selective reruns must not hide failures. The report states the exact Jira/model/deployment scope proved and does not extrapolate to arbitrary customer workflows, plugins or networks.

Status: **Partial — not accepted**. Finite 14-operation and all-five-write/two-fault matrices and qualified model configurations are recorded; failed attempts and independent reconciliations remain retained. The initial mid-build 10/10 fault run is diagnostic only; its later stable-artifact repetition passes all ten cases. Complete normal catalog, restricted buffered and latest lifecycle receipts identify their actual tested artifacts. Restricted SSE, the final bounded receipt index and complete final-artifact repetitions remain required; no broader Jira/plugin/network claim is made.

## Acceptance audit at checkpoint `2f4f4928495c`

The eight linked GitHub issues were reread on 2026-10-27; their 55 AC statements
remain unchanged and unchecked. The current statuses above supersede stale pending
implementation prose; historical checkpoints below retain their original scope.
No new runtime or live qualification was executed by this documentation audit.

Prioritized work identified at that checkpoint (later repairs are reflected in the AC statuses above):

1. Repair bound-but-unverified model fallback (#4091 AC3, #4086 AC7), complete the
   mixed empty-evidence edge, and implement safe restoration of still-valid read
   grants after restart (#4086 AC4). Current cold restart fails closed; stored public
   consent/approval views must never become authoritative by themselves.
2. Predeclare and run all nine reads/five writes through normal Chat, including
   required create/transition fields and restricted/edit-only identities. Seed and
   direct REST proofs are prerequisites, not normal-Chat operation receipts.
3. Complete lifecycle and no-replay qualification with two Chats, alternate credential
   routes, in-flight approval invalidation, response loss, restart, duplicates and
   Regenerate; assert independent remote-effect counts and retain failed groups.
4. Qualify the rebuilt Hub/Workspace/header/edge artifact, explicit Live-Pod
   capsule/export/index refusal, and the complete design-state/accessibility matrix.
5. Wire the deterministic assembled journey into its CI lane; complete user/developer
   runbooks, source/artifact-qualified evidence and normalized release impact.
6. Run the final full quality/compatibility/coverage/evidence/Sonar and required PR
   checks on the delivered head, then settle reviews. No merge authority is implied.

## Verification checkpoints

### Bounded Jira pagination through actual streamed Chat

On merge head `3e5c1469385a756d4b8a8640aecc6a7707318729`, the real LiteLLM/Gemma
SSE Chat → catalog/binder → managed MCP → Jira group passed in the licensed synthetic
session. The independent ordered reference contained 26 issues. Actual cursors were
`0,10,20,26`, with `10,10,6,0` returned records: the two nonterminal pages exposed
`nextStartAt=10,20`, while the final content page and empty terminal page exposed no
continuation. The combined ordered keys matched the full independent reference exactly.

The unchanged pass-through observer counted four physical search requests, each with the
requested cursor/query, `maxResults=10` and status 200. There were zero mutation attempts
and zero mutation-journal rows. Read-grant counts were `1,0,0,0`; no write approval occurred.
The actual saved model configuration had zero retries. Per-call result counts were
`10,10,6,0`, and result sizes were `4471,4414,2672,58` bytes. The reference count/digest
remained unchanged after every page. The 6,932-file runtime/helper inventory was identical
before and after the group, SHA-256
`b23c896e92c25af3fea7cf668ea3b7900721cbb4786d9e31ce41b64daa4ebbdd`;
opening/closing license checks reported 8,249/8,166 seconds remaining.

An initial incomplete attempt incorrectly required a repeated public grant projection
on an already authorized later turn. Its two product pages had succeeded; independent
SQLite/Jira reconciliation proved zero mutations and unchanged remote state. That attempt
is retained as interrupted/reconciled. The helper now accepts the existing production
grant-reuse form after the exact grant's authenticated route check, and refuses missing
first grants or contradictory projections. The actual failure has a red/green regression;
46 focused helper/consent/lifecycle cases, scoped lint and formatting pass. No product
pagination or policy change was necessary. This supports #4083 AC4 and #4087 AC5/9 within
the recorded artifact scope; full catalog/refusal/browser and final gates remain open.

### Licensed Jira PAT, availability and retained consent

On 2026-10-28, three complete groups passed against the fresh synthetic Jira 10.3.26
session through the existing production ports and the actual Docker LiteLLM Gateway with
`gemma-4-31b-it`. The Gateway configuration and credential were resolved from their existing
private owners; no provider credential was copied into the retained product configurations
or a second vault. Each group required production HTTPS/read/write preflight and positive
opening/closing license checks. The runtime/helper inventory contained 6,919 files and was
identical before and after each group; the distinct digests below record the actual artifacts.

| Complete group                | Result and independent observation                                                                                                                                                                                                                            | Artifact SHA-256                                                   | Opening / closing license seconds |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------- |
| Native PAT verification       | 2/2: revoke only the group's generated non-admin PAT; current verification fails authentication and a delayed prior success receives `CREDENTIAL_CHANGED`. An invalid synthetic PAT also fails.                                                               | `aae3cc2bf7e089d98dfd3a7075822c7aeddcbd581f5928ad76a46f9de170fa6a` | 5,629 / 5,625                     |
| Stopped Jira and recovery     | 1/1: stopped Jira reports unreachable and invalidates verified readiness; the same Jira container restarts, peers/volumes remain intact, and renewed preflight plus verification pass.                                                                        | `ecce474a860dfda0c7118db5cc4b99603379af13b7dc00baeceed3f4689de3ec` | 10,295 / 10,777                   |
| Retained consent and rotation | 4/4 real Chat turns: read-grant counts `1,0,1,0`, write-approval counts `0,0,0,1`; an actual child-process restart reuses valid consent, rotation invalidates it, and an approved streamed comment has exactly one remote match authored by the new identity. | `5c7b85246ec67bf26b6710a8c12c669237f58863a2f7a313f914fe0e72103c91` | 10,422 / 10,226                   |

Two earlier attempts remain incomplete and preserved. Recovery initially reached container
health before Jira's license endpoint was ready; the existing bounded wait now retries only
that read-only readiness check while continuing to verify container/volume ownership. Consent
qualification initially timed out during model readiness because the helper replaced the selected
Gateway's timeout; it now retains that configured timeout. Both defects have failure-before and
pass-after regressions. Independent reconciliations checked actual Jira effects and retained
product state before archiving the interrupted markers; no uncertain mutation was repeated.

The five affected helper suites pass 90 tests; scoped lint, formatting and whitespace checks
pass. A private credential-floor sweep checks eight actual synthetic secret values across 31
retained log/product files with zero matches, and five retained product states contain no newly
created Gateway vault files. The separate current-session fixture checks prove required-field
and transition-screen setup, distinct search pages, hostile content, and permission separation;
these direct setup/oracle reads are not normal-Chat operation acceptance.

These receipts support #4082 AC1/2/5/6, #4084 AC1/3/5, #4091 AC1 and #4087 AC3/6/9
within their recorded scopes. They do not complete those criteria. The full normal catalog on
the final selected Gateway artifact, restricted SSE catalog, physical Jira browser response-loss
and Regenerate groups, remaining compatibility/visual proofs and final aggregate/Sonar/current-head
checks remain outstanding. Private paths, endpoints, identities, tokens and raw receipts are not
part of this public evidence.

### Central HTTPS MCP: actual Settings, Chat and OpenCode UI

The 2026-10-28 browser group ran at `8318665ff248f2e48cb7a2de326d46c09d1181b5`
through the running Docker LiteLLM gateway and its configured Gemma model. An independent
synthetic HTTPS/Bearer MCP server supplied three tools and a durable remote effect counter.
No customer endpoints, tokens, screenshots or issue content were used.

- Settings created the server through its ordinary form. The explicit private-network option
  and operator-provided CA were required; discovery displayed **Connected · 3 tools**.
  A preceding public-target attempt was refused before the server received a request.
- A new ordinary Chat, without a Jira binding or Coding session, displayed read disclosure
  and exact-action approvals. Its write had zero matching effects before approval and one
  afterward. The following read returned the actual record ID and original synthetic text;
  both tool cards settled as confirmed.
- A separate OpenCode task used that same configured server in **Ask for approval**.
  The real Code Mode and network-action approvals preceded its write and read. It finished
  **Succeeded, revision 13**, with the actual second record ID and matching text.
- Independent server inspection measured one baseline preflight write and exactly two
  additional writes: one from Chat and one from OpenCode. The Coding repository remained clean.

The retained local screenshots and receipt are private qualification artifacts. This group
proves the normal modern HTTPS/static-token path through both real UI consumers. It does not
claim native durable acknowledgement, legacy-SSE disconnect recovery, the complete original
Jira acceptance matrix or final aggregate gates. The earlier uncertain-write UI group separately
proved persisted **Recovery required** and one effect after reload. Its synthetic remote effect
was reconciled before a fresh, different HTTPS task was accepted; it was never replayed.

### Deterministic normal-Chat browser CI lane — #4087 AC5 (partial)

`npm run test:e2e:jira-chat` owns `playwright.jira-chat-4081.config.ts` and
`jira-chat-4081.spec.ts`. Its blocking UI workflow step is classified
`runs-per-pr` by `check:e2e-suite-wiring`; no unwired-suite exemption was added.
The fixture composes `buildUiHandlerDeps` and the real BFF, gateway HTTP adapter,
canonical catalog/binder, managed MCP host, vault, consent/approval and mutation
journal. The only controlled peers are an OpenAI-compatible HTTP provider and a
Jira REST-v2 HTTPS fixture with an ephemeral trusted certificate, exact loopback
allowance and a `/jira` context path. It creates no Coding task or session.

The three browser journeys cover:

- Hub creation and verification, server-confirmed Chat binding, mandatory read
  disclosure, real project read, exact write preview, explicit approval, one
  confirmed comment and persisted `claimed` approval history.
- A wrong action digest refused with 409 and a disconnect invalidating the pending
  action before dispatch; the stale decision is refused with 404, the canonical
  turn is cancelled, and write/readback counts remain unchanged.
- A bound model without verified tool calling presenting actionable unavailability
  while every physical provider/Jira request counter remains unchanged.

The full fresh-build invocation first passed two journeys; the cancellation test
incorrectly expected `failed` although disconnect correctly settles `cancelled`.
After correcting that fixture assertion, all three journeys passed against the
same assembled product without rebuilding during the separate live lab group.
Final counters were 8 model requests (including readiness), 9 Jira HTTP requests
(including six verification probes), 1 project read, 1 write, 1 readback and zero
credential disclosures to model bodies. Earlier fixture preparation also corrected
an incomplete synthetic identity and a Chat snapshot request missing project scope.
These fixture results do not qualify a real Jira deployment or a real model.

Scoped ESLint, root typecheck, formatting, 422 workflow-consumer tests, 87 wiring
gate tests, wiring classification, branch parity, required-workflow names and
Zizmor anchors passed. Logs are `/tmp/keiko-4081-e2e-{lane,assembled,lint,types,workflow-tests,wiring-tests,wiring,final-format}.log`.
The delivered-head full invocation and all remaining final gates stay open.

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

### Credential-owned Chat invalidation — #4084 AC3, #4085 AC4

- Current failed/aborted verification and credential deletion notify the server through the existing
  custody owner, including direct credential-management routes. Notification follows durable
  generation revocation or ciphertext removal; metadata cleanup failure cannot skip it.
- The existing UI store changes all matching Chat bindings in one immediate transaction, advances
  scope generations and preserves Pod association on credential-generation changes. Deletion
  disconnects the Pod. Repeated/older generation notifications do nothing; unrelated Pods remain
  unchanged. Exhausted generations roll back the complete affected set.
- The existing turn serializer cancels matching active generations. An actual authenticated DELETE
  test covers two Chats on one Pod and a third on another; a direct Verify route test covers failed
  re-verification and rejection of the old scope identity. Real Activity Log writer/reader evidence
  reconstructs both applications and both cancellation requests without Pod/authRef values.
- Three focused custody/store regressions fail before implementation. Targeted final results are
  recorded in the PR checkpoint. This increment does not complete restart reconciliation, token
  rotation, Chat authority/grants/approvals or UI lifecycle integration; the affected ACs remain partial.

Final focused results for this checkpoint: 217 custody/HTTP-route/store/serializer tests and 97
registry tests pass, with package build, root typecheck, changed lint/format, staged semantic and
ADR-index checks. Full aggregate, assembled-package, licensed live and UI qualification remain pending.

### Durable token replacement and removal primitives — #4085 AC4, #4084 AC3

The existing custody owner now accepts a generation-checked Live-Pod rename/token replacement.
Replacement retains Pod identity, advances the credential and verification generations, clears
readiness and notifies existing Chat invalidation before changing ciphertext. Rename leaves the
credential generation unchanged. A private pending-operation marker blocks execution and
verification before vault reads until replacement has fully settled; interrupted replacement
requires an explicit fresh replacement at the current generation. A deletion intent is now retained
and invalidated before ciphertext removal, so either cleanup failure leaves a durable denied state.
Retry completes deletion without reopening verification, rename or replacement.

Four focused tests fail before implementation. Coverage includes retained-store custody reopening
after vault and metadata settlement failures, explicit recovery, stale probe/transport refusal,
invalid input and impossible persisted states, failure before the pending intent is written, and
retrying interrupted removal. This is not a real-process restart or authenticated update-route
qualification: the update endpoint/UI, startup reconciliation and grant/approval integration remain
pending. All affected acceptance criteria remain partial.

Focused checkpoint results: 329 custody, metadata, Chat binding, credential/write/search route and
policy-regression tests pass. Package build, root typecheck, changed lint/format, staged semantic,
ADR-index and 97 registry tests pass. Final aggregate/live/UI qualification remains pending.

### Authenticated rename/token replacement — #4085 AC2/AC4, #4084 AC3

The existing credential resource now accepts generation-checked PATCH through the standard
CSRF/body-size/owner/error paths. It accepts only name/token changes to owned Live-Pod credentials;
responses use the public metadata projection. Rotation preserves two shared-Pod Chat associations,
advances their generations and leaves another Pod untouched. Old updates and delayed verification
cannot restore prior access. Two HTTP regressions fail against the previous route table. Additional
HTTP coverage checks CSRF and a paused verification during replacement.

The new registered `atlassian.credential.updated` event reconstructs rename, token replacement and
combined update with generation counts only. Real writer/reader proof checks the absence of token
and credential reference; logging failure after mutation does not turn success into a retryable
operation. Canonical failure-class obligations and generated inventories include the event. The
existing semantic baseline needed a location refresh: all 938 group membership multisets were
compared and remained identical; no group or exception was added. Management UI, startup
reconciliation, grants/approvals and full live qualification remain pending.

Focused results: 130 custody/credential-route/activity tests, 109 route-table/diagnostic regressions
and 97 registry tests pass. Package build, root typecheck, changed lint/format, semantic membership
comparison and refreshed gate, ADR index and error-observability checks pass. Full aggregate,
assembled-package, management UI and licensed live checks remain pending.

### Corrupt-row isolation during invalidation — review of #4084 AC3 / #4085 AC4

Confirmed the review finding that syntactically invalid JSON in an unrelated Chat could abort the
bulk query. A guarded SQL expression now excludes unreadable JSON from binding selection. The
regression fails before the change and passes afterward: a valid matching binding is revoked while
the corrupt Chat remains unreadable and its state is not reset. All 70 binding/credential-route
tests, package build, root typecheck, changed lint/format and staged semantic checks pass.

### Causal credential lifecycle evidence — #4084 AC5 / #4085 AC4

The trusted request correlation now passes through credential deletion, replacement and verification
settlement into the existing binding invalidation and turn cancellation. It is separate from user
payload fields and grants no authority. Operations outside a request retain the server-generated
correlation fallback. The actual DELETE regression fails before this change; real writer/reader
proof now ties all its binding effects and cancellation records to the HTTP response. Replacement
proof similarly reconstructs both shared-Pod Chat updates under each credential update's request.
All 122 custody/HTTP tests, 97 registry tests, package build, root typecheck, changed lint/format,
staged semantic and ADR checks pass. Final acceptance and remaining lifecycle/Chat/UI work stay open.

### Ordinary Chat authority contract checkpoint — #4084 AC2–AC4

The additive `ChatToolAuthorityEnvelope` and subject validator bind actor digest, Chat,
Pod, binding generation and credential generation without a repository, branch or Coding
session. The existing mode ordering and budget dimensions remain authoritative. Only Jira
scopes and connector/network action classes are accepted; file-patch capacity is zero.
Malformed or widened inputs fail with closed diagnostics, including unknown hostile keys.

The new contract suite initially failed to load because this capability was absent
(`/tmp/keiko-4081-chat-authority-contract-before.log`). The new and retained Coding contract
suites pass 198 tests after implementation. This is a structural contract checkpoint:
registry admission, current-state enforcement, consent, approvals and the ordinary Chat
execution loop are not yet implemented or accepted. Final assembled-package qualification
remains pending and runs after the other gates because it prunes the live dependency tree.

### Shared authority registry checkpoint — #4084 AC2–AC5

The existing registry now retains discriminated Coding/Chat records in the same bounded
store. It uses the existing canonical digest, cumulative budget rules, expiry and revocation.
Every Chat resolution compares current actor, Chat, Pod, binding generation, credential
generation and deployment ceiling. A private immutable snapshot prevents caller mutation.
Coding consumers cannot resolve or refund Chat records, and Chat consumers cannot resolve
Coding records. Duplicate registration preserves usage and revocation; Chat-wide revocation
leaves other Chats and Coding records untouched. This private API is not an HTTP authority
registration route and does not yet compose human acceptance, read grants or approvals.

Before implementation, 14 new registry tests fail while 33 retained tests pass. Afterward,
249 contract/registry tests and 235 existing connector-policy, agent-run and Coding-runtime
consumer tests pass. Three additional regressions fail before rejecting inherited subject,
budget and envelope facts; required facts must be own fields. A real Activity Log writer/reader
proof reconstructs register, changed-generation refusal, cumulative reservation, exhausted
budget, revoke and revoked-reference refusal under one correlation. Repeated revocation records
zero affected entries. No raw Chat/Pod/run identifiers enter those records.

Package builds, root typecheck, changed lint, staged semantic and the 97-test operation-registry
check pass; the generator resolves 611 proofs and 30 scenarios with no violations. Final
aggregate gates and product Chat/lifecycle integration remain pending. No AC is accepted by
this checkpoint alone. Retained logs: `/tmp/keiko-4081-chat-authority-registry-*.log` and
`/tmp/keiko-4081-chat-authority-own-facts-before.log`.

### Graph-owned authority lifecycle checkpoint — #4084 AC3–AC5, #4085 AC4

Production composition gives each server graph its own instance of the existing authority
registry and clears it on disposal. Credential invalidation passes that same instance to the
existing Pod/Chat lifecycle callback. Committed Chat mode/binding changes, closure and deletion
revoke the affected Chat's authority. Unchanged mode selection and rejected stale PATCH requests
do not revoke valid authority. This does not replace the still-pending current-state checks
at actual Chat tool dispatch, grant/approval invalidation or the complete restart scenarios.

Three regression cases fail before implementation: graph ownership/disposal, committed Chat
changes and direct credential deletion across two shared-Pod Chats plus an unrelated Pod.
After implementation, 387 tests pass across dependency composition, actual credential/Chat HTTP
routes, existing store handlers and the authority registry. The shared fixture contains only
ordinary Chat facts and uses the production mode resolver. Build and root typecheck pass;
changed lint is green after simplifying the graph fixture's optional access. The registry dependency is declared once for composition input and output. The duplicate
baseline is unchanged; no new groups or exemptions are admitted. Final aggregate gates and complete ordinary Chat execution remain
pending; no AC is accepted by this checkpoint alone.

The final focused registry rerun passes 48 tests and the regenerated operation catalog passes
all 97 gate tests. Regeneration was repeated after the dependency interface extraction moved
source positions; neither operation definitions nor the duplicate baseline were relaxed.

### Current-state authority checkpoint — #4084 AC2–AC5, #4085 AC4

The private Chat authority resolver reloads the current Chat, server principal and owned
credential metadata on every call. Closed/deleted/unbound Chats, changed ownership or
generations, pending/failed verification, pending custody work, absent authority ownership,
mode drift and narrowed deployment ceilings fail closed. It returns private credential metadata
only after the shared registry accepts the current subject. Consent, action approval, budget
reservation and actual Chat dispatch are separate gates and remain to be composed.

The Chat binding PATCH now shares that readiness check. A real HTTP regression returns 200
instead of the required 400 on the previous implementation when a previously verified Pod is
undergoing re-verification. After the repair it refuses attachment until verification finishes.
The new resolver suite first fails to load before its implementation. Afterward all 119 resolver,
actual credential/Chat HTTP and registry tests pass. The real Activity Log writer/reader proof
reconstructs ready, verification-required, authority-denied and unbound decisions under one
correlation without raw subject identifiers or credential metadata.

Build, root typecheck, changed lint and staged semantic checks pass; the 938-group semantic
baseline is unchanged. All 97 operation-catalog tests pass; generation resolves 612 proofs and
30 scenarios with zero violations. Logs: `/tmp/keiko-4081-jira-current-authority-*.log` and
`/tmp/keiko-4081-jira-pending-verification-before.log`. No complete AC is accepted here; full
normal Chat execution, licensed live acceptance and final aggregate gates remain pending.

### Shared policy and reservation checkpoint — #4084 AC2–AC5

Ordinary Chat now has private adapters to the existing Atlassian action policy and shared
cumulative authority budget. The policy accepts the same mode/scope/action-class facets from
Coding and Chat envelopes, with the strictest mode winning. Ask for approval and Supervised
workspace return review-required for network access; a future active read grant must satisfy
that read disposition. Full access still needs separate read consent before model transmission.
Read-only authority cannot gain Jira writes or Confluence access. Policy inspection does not
consume budget. Reservation reloads current Chat/credential readiness immediately beforehand;
this adapter does not itself satisfy consent/approval or execute tools.

Six valid ordinary-Chat policy regressions fail on the previous resolver exports. After the
implementation, 82 current-state, existing Atlassian policy and authority-registry tests pass.
The real Activity Log writer/reader reconstructs review-required, allowed, denied and reserved
states with their closed action types and one correlation; ordinary pending review logs at info
level. Build, root typecheck and changed lint pass. Catalog generation resolves 613 proofs and
30 scenarios without violations. Final aggregate gates and actual permission/dispatch composition
remain pending; no complete AC is accepted here. Logs: `/tmp/keiko-4081-chat-policy-*.log`.

### Read-consent contract checkpoint — #4084

The additive private read-grant contract binds actor, Chat, Pod, both generations and an
ordered lifetime. The fixed disclosure version covers model transmission and retention in
this conversation; it confers neither writes nor import rights. Pending/rejected grants have
no acceptance proof; granted state requires a SHA-256 consent proof, retained if that grant
later expires or is revoked. Unknown fields, broadened scopes, inherited required facts,
invalid lifetimes and unknown disclosure versions fail with closed diagnostics. Structural
validation itself confers no authority; runtime retention, human acceptance and dispatch
composition remain pending. Browser projections must omit the private actor and proof facts.

Before implementation, 30 new tests fail while all 45 prior authority tests pass. Afterward,
101 contract, retained Coding validation and ordinary Chat adapter tests pass. The final
contract-only rerun passes 75 tests after replacing mutation of a test object's dynamic key
with explicit construction of its own fields. Package build, root typecheck, changed lint,
format and semantic checks pass; no baseline exemption is added. Logs:
`/tmp/keiko-4081-read-grant-contract-*.log`. Public package assembly and full gates remain
scheduled for final acceptance; no complete AC is accepted by this contract increment.

### Shared read-grant owner checkpoint — #4084 AC2–AC5

The existing Atlassian approval registry retains discriminated legacy approvals and private
Chat read grants in the same capacity-bounded map. Legacy get/list/consume/reject cannot see,
consume or replace Chat grants. Requests must be pending, within the existing approval TTL and
bound to an immutable subject/authority snapshot. Acceptance checks the exact actor, Chat,
Pod, generations and original authority reference. Repeated acceptance preserves the first
proof and expiry. Reuse checks the current subject; rejection/revocation cannot be revived.
Per-Chat revocation preserves other Chats, and graph disposal clears only its owner's grants.

Twelve new owner tests fail before implementation while 38 legacy tests pass. Afterward, 191
approval, real existing write/search/sync route, Chat-adapter and authority-registry tests pass.
The real writer/reader proof reconstructs pending, granted, reused, revoked and expired records,
including zero affected entries on reuse/already-inactive expiry, without raw subject or grant
identifiers. All 97 operation-catalog tests pass; generation resolves 614 proofs and 30 scenarios
without violations. Build, root typecheck, changed lint/format, staged semantic and ADR checks
pass; the duplicate baseline remains unchanged.

This is a private retention API: current authority/readiness must still be checked at human
acceptance and use. Authenticated consent routes, once-per-binding request orchestration,
credential/Chat lifecycle wiring and actual tool admission remain pending. No complete AC is
accepted here. Logs: `/tmp/keiko-4081-read-grant-registry-*.log`.

### Read-grant lifecycle composition checkpoint — #4084 AC3–AC5, #4085 AC4

Existing invalidation paths now receive both existing authority/approval owners from the same
server dependency graph. Only committed binding/mode changes revoke access; no-op mode changes
and stale PATCH conflicts preserve valid grants. Chat closure/deletion and project removal
revoke the affected grants. The credential-owner callback applies the same revocation to token
replacement, failed direct re-verification and direct credential deletion. Two shared-Pod Chats
are revoked while an unrelated Pod's Chat remains granted. Disposal carries its correlation
through the existing approval reset.

Six actual HTTP regression cases fail on the previous implementation because grants remain
granted. The fixtures use one current clock for authority and grant records; the earlier mixed
historical/current fixture timestamps are not acceptance evidence. After implementation, all
395 composition, credential/Chat-route, store-handler and approval-owner tests pass, along with
97 operation-catalog tests. A real writer/reader proof joins credential deletion to the single
read-grant revocation using the response correlation, without raw Chat/Pod/credential identifiers.
Build, root typecheck, changed lint/format, staged semantic and ADR checks pass. Generation
resolves 615 proofs and 30 scenarios without violations. Logs:
`/tmp/keiko-4081-read-grant-lifecycle-*.log`.

At 13:45 Europe/Berlin on 2026-10-27, the production Node connection verifier was rerun against
the existing Docker Jira lab: trusted HTTPS/PAT succeeded, an untrusted certificate produced
TLS failure and revoked target admission produced unreachable. This is connection-only evidence
(`/tmp/keiko-4081-jira-verifier-latest.log`); the lab license remains expired, so licensed live
mutation/model/browser qualification is still pending. Human grant acceptance, action approvals,
observed tool-call auth failure and the ordinary Chat execution path remain open. No complete
AC is accepted here.

### Authenticated read-consent checkpoint — #4084 AC2/AC4/AC5

The existing approval API now exposes a typed `chat-read-consent` subresource for a retained
Chat read grant. GET returns only the public card contract. POST accepts a closed decision and
current disclosure version, with a 4 KiB body limit and the existing CSRF guard. It re-resolves
current actor, Chat/Pod generations, verification, original authority, read scope and expiry
**after** reading the request body. It computes acceptance evidence server-side; caller-supplied
authority, proof or scope overrides fail. Repeated approval preserves the original proof and
expiry; rejection cannot become approval. Legacy approval routes continue to exclude these grants.
No tool or Jira request is executed by this endpoint.

Three actual HTTP regressions return 404 before implementation and pass afterward. The
204 targeted credential/consent, legacy write/live-search/sync-policy and approval-owner tests
pass, including malformed/oversized bodies, CSRF, stale state, mismatched subjects, excessive
lifetimes, absent read scope and expiry. A real writer/reader proof joins the human consent
request to its response correlation without private identifiers or payloads. Root typecheck,
changed ESLint, build, formatting, semantic and ADR checks pass; 97 operation-catalog tests pass.
Registration uses the existing named route-group pattern; semantic baseline remains unchanged.
The final route-group integration rerun passes all 83 HTTP tests. A direct native ESM import
exposed an eager cycle, repaired by importing the existing `route-error` owner directly; the
same native import then succeeds. Generation resolves 616 proofs and 30 scenarios without
violations. Logs:
`/tmp/keiko-4081-consent-route-*.log`.

This endpoint acts only on a request already retained by the trusted server owner. Automatic
first-read request production, the complete admission/dispatch path, normal Chat orchestration
and user-facing consent cards remain pending. No complete AC is accepted in this checkpoint.

### First-read request admission checkpoint — #4084 AC2/AC4/AC5

The current-state authority owner now requests/reuses read consent through the existing bounded
approval owner. All three modes initially require consent. Requests for the same subject reuse
a pending grant across current authority references without replacing its issuing reference or
expiry. Granted consent is reused only after validating both the caller's current authority and
the retained issuing authority. Invalid retained requests are revoked; rejection does not cause
an automatic repeat prompt within the same authority. A new human-turn authority may request
consent again. Creation caps expiry at the earlier of the issuing authority deadline and the
existing approval TTL; a deadline crossed during creation and exhausted registry capacity fail
closed. The result contains only the public grant projection, shared with the HTTP endpoint.

Eight initial new cases fail before the API exists, while 22 unchanged authority cases pass.
After implementation, 168 authority/request, real HTTP consent/credential and approval-owner
tests pass. A registered writer/reader proof reconstructs one request and reuse with affected
counts `[1, 0]` and a common correlation without private facts. Build, root typecheck, changed
lint/format, semantic, native ESM import and ADR checks pass; 97 operation-catalog tests pass.
Generation resolves 617 proofs and 30 scenarios without violations. Logs:
`/tmp/keiko-4081-read-admission-*.log`.

This primitive neither reserves a tool budget nor dispatches a tool. The trusted non-Coding
consumer and ordinary Chat still need the complete catalog → policy → consent/approval → budget
→ MCP/provider → settlement composition. No complete AC is accepted by this checkpoint.

### Private Chat read consumer checkpoint — #4084 AC2/AC4/AC5, #4089 AC4, #4091 foundation

The private ordinary-Chat consumer now binds the nine read routes to the shared canonical binder
and actual SDK host, using the existing Harness counter owner through its public composition
seam. No workspace or Coding session is fabricated. Catalog offers do not create consent
requests. Dispatch requests consent before reserving a budget; the notification callback cannot
approve a grant. Admission requires the existing owner to retain actual accepted consent in all
three modes. It rechecks authority, binding, credential readiness and consent at the final HTTP
effect. The catalog owns single settlement, pre-effect refund and receipt validation; its existing
invocation registry and cancellation path remain in use. Paginated results explicitly report
truncation and retain the provider's nextStartAt instead of claiming a complete result.

185 scoped authority/consumer, Harness-budget, real HTTP credential/consent and non-Coding
catalog tests pass. They exercise SDK calls after approval in all three modes, grant reuse,
notification without approval, argument authority/routing injection, last-slot budget refusal and
invalidation after connection selection but before HTTP. A real Activity Log writer/reader proof
reconstructs review-required, allowed and refused read admission without private facts. Build,
root typecheck, changed lint/format, ADR, native ESM imports and semantic checks pass; the 938-group
semantic baseline is unchanged. The 97 operation-catalog tests pass. Disabling only the final
read guard in an isolated synthetic fault-injection run makes all four late-invalidation cases
fail; restoring the exact source makes all four pass. This is a negative guard proof, not a
claim about an earlier product Chat path. Operation generation resolves 618 proofs and 30
scenarios without violations. Logs:
`/tmp/keiko-4081-catalog-consent-*.log`.

The tests compose the production consumer/binder/SDK and budget owners with a synthetic Jira HTTP
port and retained server authority. Application graph composition, accepted-human authority
minting, concrete write approvals, normal Chat/model orchestration and UI remain pending. The
issuing-authority lifetime across actual normal-Chat turn settlement remains an explicit auditor
integration point. The complete assembled-package gate for the additive Harness export remains
part of final qualification. No complete criterion or current licensed live pass is claimed.

The laboratory was rechecked at 15:35 Berlin on 2026-10-27: the production HTTPS/PAT verifier
passes, untrusted TLS is rejected and revoked target admission is unreachable. The license check
still reports invalid; current licensed live-write/model/browser acceptance remains blocked.

### Observed-authentication and transport-guard checkpoint — #4082 AC2, #4084 AC3, #4085 AC4

Both existing credential HTTP factories now forward private final-dispatch and response hooks;
the shared factory composition still captures credential generation before token resolution.
The custody owner handles an observed 401 only for the selected, currently verified Live Pod
generation and verification revision. It commits auth-failed and advances the generation before
notifying the existing lifecycle owner. Repeated/stale responses, an in-progress or newer
verification, deletion and ordinary 403 permission denial cannot invalidate a current credential.
The response observer captures identity/revision by value, including if caller metadata later
changes. A caller's acknowledgement hook runs before credential invalidation and before body
consumption, preserving the mutation journal's existing response-observation seam.

The new factory-guard and current-401 cases fail before implementation; the 403 baseline already
passes. After implementation, 271 scoped custody/transport/Chat tests pass. The subsequent
credential/write/policy/operation-catalog regression run passes 374 tests (including the 97
operation-catalog cases; the runs overlap). A registered real writer/reader proof reconstructs
request-status invalidation and acknowledgement → invalidation → body ordering without secret
or endpoint bytes. Build, root typecheck, changed lint, semantic checks and their 938-group
unchanged baseline pass. Generation resolves 619 proofs and 30 scenarios without violations.
Logs: `/tmp/keiko-4081-observed-auth-*.log`.

This closes the observed-status custody/transport gap; complete ordinary-Chat and write-approval
composition and final licensed qualification remain pending. No complete AC is accepted here.

### Late read-result admission checkpoint — #4084 AC3–AC5, #4089 AC4

A read admitted before an access change previously could publish its successful result afterwards.
The managed route now receives its private invocation context when projecting the result. The
Jira read consumer uses that existing effect guard again before publication; a disconnected,
reverifying, differently owned or revoked scope cannot forward the returned Jira data. The shared
binder keeps the performed-effect charge and settles once. This changes no mutation outcome
contract and creates no replacement authority, budget or settlement owner.

All four late-result cases fail before the correction and pass afterwards. The 218-test scoped
run covers Chat admission, managed/non-Coding catalogs, settlement and the 97 operation-catalog
checks. A real shared writer/reader proof observes the refusal and exactly one committed
settlement. Build, root types and semantic checks pass; the semantic baseline remains 938 groups.
Generation resolves 620 proofs and 30 scenarios without violations. Logs:
`/tmp/keiko-4081-late-read-*.log`.

The production graph, ordinary Chat/model loop, concrete write approvals and UI still require
composition and complete qualification; this component checkpoint accepts no complete AC.

### Verification observation repair — 2026-10-27 (#4082, #4081)

CodeRabbit identified that a verification HTTP 401 also emitted a stale ordinary-request
observation. The real authenticated verification route reproduces two connection-check records
before the fix. Server-owned port purpose now excludes the request observer for explicit probes;
the verification owner still records its applied/stale outcome and invalidates the generation.
Ordinary request acknowledgement, 401 invalidation and 403/stale-response isolation are unchanged.

The regression fails before and passes after the correction. All 89 credential-route tests,
package build, root typecheck and changed-file lint pass. Existing Activity Log writer/reader
proof verifies exactly one `verify` record without secret bytes. Final full gates/Sonar remain
pending; this checkpoint does not close an acceptance criterion.

### Application-owned managed catalog — 2026-10-27 (#4089, #4084, #4081)

`buildUiHandlerDeps` now installs one lazy managed Jira catalog per application graph.
Concurrent consumers share initialization and the nine canonical read bindings. Independent
graphs retain independent SDK hosts. Disposal before/during discovery rejects late consumers;
normal disposal closes the host before the remaining services. Discovery emits exactly one
listing/admission pair through the injected existing Activity Log and resolves no credentials.
The invocation connection resolver checks current Chat authority and uses custody's existing
HTTP factory with the final dispatch guard; no token is exposed to the catalog.

The missing-composition regression failed before implementation. The 159-test affected run
(dependency assembly, Chat authority and managed catalog), plus four final lifecycle cases,
package build, root typecheck and changed lint pass. The final lifecycle assertions cover
registered listing/admission evidence. Normal Chat orchestration, accepted-human authority
minting and write approvals remain open; no complete AC or final gate is claimed.

### Accepted-turn authority and renewed live group — 2026-10-27 (#4084, #4082, #4081)

The accepted-turn helper now mints private authority from an existing human message and fresh
owned/verified binding facts, with server-derived mode, ceiling and acceptance digest. Its five-minute
deadline starts with the turn, with 30 tool calls and 100,000 prompt tokens. It does not grant
read consent or write approval. The retained issuer survives separate later turn admission;
component tests prove one accepted read grant is reused without replacing its issuer/expiry.
Normal Chat must still call this once and preserve it throughout all phases.

Two new cases failed before implementation. All 55 authority tests, package build, root typecheck
and changed lint pass after the correction. These are test counts, not 55 accepted epic criteria.
The complete Chat entrypoint/lifetime proof and final gates remain pending.

A new independent synthetic Jira 10.3.26 session passed licensed fixture creation, restricted
identities, required create/custom fields, required transition screen, pagination/hostile content,
project isolation, trusted HTTPS, untrusted-certificate denial and admission revocation. Its
production-custody/HTTP write preflight verified assignment, description edit and exactly one added
comment by independent readback. The final license check reported 10,045 seconds remaining.
The prior session is stopped with volumes retained. No license or clock manipulation occurred.

Fresh Jira onboarding overlays blocked the fixture's mouse Publish action. The supported keyboard
action fixed that reproducibly; the complete fields group was rerun successfully. A consolidated
normal-first-run setup script now retains a private pending marker on uncertain completion. Its
individual form operations established this session; fresh end-to-end script qualification is still
pending. These live groups do not yet establish normal Chat, model or browser acceptance.

### Auditor correction — canonical accepted-turn mint (#4084, #4081)

The auditor found that the helper's random run identity and caller-provided start could create
fresh budgets from the same stored message. Two focused regressions failed before correction.
Minting now requires the latest persisted accepted user message, pending canonical state (or the
current legacy message) and its exact stored timestamp. The deterministic Chat/message identity
makes duplicate admission consumers share the existing registry budget; a changed envelope under
the same identity fails closed. Revoked authority cannot be replaced. The canonical store admission
regression runs two concurrent mint callers after exhausting the first budget and proves neither
gets another budget. Normal HTTP Chat orchestration is still the next integration step.

### Structured ordinary Chat history — #4091 / #4081

Migration 50 retains call/result pairs and the public read-consent view on the canonical human
message through the existing store. Private authority/binding handles are excluded from calls;
configured secrets are redacted. Updates are bounded, atomic, idempotent for identical deliveries,
and immutable after terminal settlement. Public create/PATCH routes do not expose this write seam.
Legacy messages remain unchanged and corrupt transcript JSON fails closed. The existing history
revision and Coding History isolation apply.

Verbatim gateway context now preserves assistant/tool roles and matching call IDs. Compaction
retains or summarizes the complete human-turn unit, including tool observations in accounting.
An interrupted observation is projected as unavailable with unknown effect. Three context regressions
failed before the change; 140 scoped store/migration/history/prompt/compaction tests passed afterward
before two additional bounds/consent tests. The new registered Activity Log proof checks redaction,
production formatting and analyzer projection. Normal Chat execution/UI wiring remains pending.

### Buffered Chat execution checkpoint — #4091, #4084, #4089 / #4081

The canonical buffered Chat handler now mints authority from the admitted human row,
uses the graph-owned catalog and the actual gateway binding, awaits the existing
read-grant owner, and resumes only after fresh binder admission. No Coding session is
created. The same turn object survives context-window retries. Physical gateway
attempts, including retries and memory/compaction calls, use the existing admission
hook and cumulative authority budget; uncertain usage fails closed. Harness counters
bound iterations and tool calls. Model capability/fingerprint proof is checked each round.

The deterministic normal-route test proves zero HTTP requests before consent, one
read afterward, matching gateway tool/result IDs, persisted completion, read-grant
reuse on the next human turn, and no new effect on duplicate canonical delivery.
An unverified model receives no tool advertisement. This uses a synthetic model and
injected Jira HTTP response; it is not the real-model/live Chat acceptance.

Two integration faults were repaired: catalog/projection/binding wrappers no longer
consume the individual descriptor/schema depth budget (the descriptor, argument,
byte and shape limits remain unchanged); completed transcript results retain a private,
validated descriptor/projection snapshot so reload can qualify them. This snapshot
is stripped from the public message. Redaction requalifies the result and byte count.

Checks: 566 catalog, gateway bridge, normal Chat, grant/store and operation-registry
tests pass. The nested-schema regression failed before the correction. Earlier waiter
regressions covered acceptance, rejection/revocation, reset, cancellation and expiry.
Package build, root typecheck and scoped lint pass. Streaming, concrete mutation
approval/journal wiring, UI and real-model/browser qualification remain pending;
this checkpoint does not complete an acceptance criterion.

### SSE and visible read-consent checkpoint — #4091, #4086, #4084 / #4081

The existing SSE Chat route now owns the same bounded Jira turn object and metered
model port as buffered Chat. The provider uses its real streaming interface; tool
round text is withheld until the completed round distinguishes an invocation from
a final answer. The final answer then uses the existing redactor/chunk/backpressure
writer. Context-window retries retain the same tool/usage counters and observations.
Disconnect during a pending grant cancels the canonical turn and dispatches no Jira request.

A bounded `tool-read-consent` SSE event carries only the public consent projection.
Its shared closed validator rejects private authority fields and unknown disclosure
versions. The ordinary Chat UI displays translated consent and result cards. Explicit
approval/rejection calls the authenticated existing owner; failed requests never imply
consent. Buffered sends observe only their scoped canonical turn digest through the
existing GET messages API. Cancellation suppresses late reads; observation never
replays the send POST. Fresh server revocation overrides an earlier local response.

Checks: 356 wire, normal Chat/SSE, transcript and operation-registry tests pass;
228 UI/API/observer tests pass, including keyboard activation, disclosure text,
actual decision payload, rejection, failure, stale updates and an accessibility scan.
Package build, root/UI typechecks, server lint and complete UI lint pass. Existing
lint suppressions were preserved unchanged. The loaded local model
`keiko-qwen36-35b-8bit:latest` passed the real production tool-calling probe; this alone
is not a live Jira Chat or browser acceptance. Hub creation/binding, write approvals,
live journeys and final full gates remain open.

### Real normal Chat read and public Pod identity — #4085, #4091, #4084 / #4081

The public credential API now returns a separate typed Live Pod view: connectable Pod
identity, current credential generation, verification status/revision and supported
`live-read` capability. Private owner digests, creation intents and incomplete custody
operation details remain omitted. Incomplete custody work projects unverified. Cloud
responses retain their shape. The HTTP projection regression failed before repair;
all 90 credential/lifecycle cases now pass. Older assertions were narrowed to the
actual private facts, and a lifecycle fixture now uses a new invocation identity for
a new post-revocation authority rather than replaying the revoked identity.

The real normal Chat HTTP group found a separate canonical-store defect: completion
returned the pre-commit user projection with a pending state. The store now reloads
both canonical messages inside the same completion transaction. The targeted normal
Chat regression failed before correction; 231 route, Chat, store/transcript and
operation-registry tests pass afterward. Build, root/UI typechecks and affected lint
pass. Existing completion and credential Activity Log owners are retained.

A licensed Jira 10.3.26 group on 2026-10-27 passed with the actual local
`keiko-qwen36-35b-8bit` model after the production tool-calling probe. Launcher pairing,
HTTP Pod creation/HTTPS verification, authenticated binding, normal buffered Chat,
explicit read consent, Gateway → catalog/binder → shared SDK MCP → Jira, structured
result persistence and final completion all ran live. One `jira_projects` call
returned the synthetic project. License checks before and after were valid. The
reproducible command is `scripts/testing/jira-chat-lab/chat-read.mjs`; its retained
logs contain counts/status only. A first teardown emitted a log-sink warning; a
trace-warnings rerun did not reproduce it. The harness now rejects that warning as
a failed run instead of accepting a successful read with lost diagnostics.

This is one live buffered read journey, not complete AC acceptance. Normal Chat
writes/approvals, Hub management and binding UI, full browser/mixed-grounding journeys,
all-operation failure/isolation/restart qualification and final gates remain open.

### Existing Hub creation surface — #4085, #4086 / #4081

The Knowledge Pods Hub now composes the existing connector panel in a Jira Live Pod
mode. The existing write-only form accepts name, HTTPS address and PAT, omits the
Cloud-only email/provider fields, and leaves exact private-target authorization to
the server. One stable creation intent survives a failed response/retry; a synchronous
submit lock prevents a second request before React renders the disabled button.
The token is cleared on confirmed creation. Existing verification/removal owners and
controls are reused. The Hub filters the returned public Live Pods, uses authoritative
verification state, reloads after verification, and exposes neither Data Center sync
nor legacy Coding approvals. All Cloud defaults remain unchanged.

The new creation test failed before implementation. The affected connector/Hub suite
passes 121 tests including duplicate submit, retry identity, existing Cloud behavior,
Live Pod filtering, verification refresh, keyboard interactions and accessibility.
The status-rendering test now exhaustively covers the existing nine-member verification
contract. Full UI typecheck and lint pass. Management rename/token controls, Chat source
connection/mode controls, drag/drop and the real browser group remain pending.

### Chat connection and selected mode — #4086, #4084 / #4081

The existing Chat source header now exposes a keyboard-operable Jira disclosure.
It lists public verified Live Pods, persists one binding and the selected canonical
three-mode value through the existing PATCH/scope-conflict helper, and only publishes
the server-confirmed Chat. Replacing a non-empty Pod requires explicit confirmation.
Unavailable Pods cannot be selected; failed refreshes cannot admit a new stale choice.
The default remains Ask for approval, and the disclosure explains that read consent
and narrower server limits still apply. Memory authority is not reused or widened.
The mode control reuses the canonical mode enum and existing translated mode labels.

Scoped view identity suppresses late success and conflict-refresh callbacks after
context replacement/unmount, a synchronous mutation lock prevents duplicate PATCH,
and external scope changes discard the stale local draft. Escape closes the control
and restores summary focus. The new cases and existing Chat/API/scope suites pass
398 tests; UI typecheck, lint and production static build pass. Browser qualification,
drag/drop, effective-ceiling presentation, rename/token controls and the complete
write/mixed-source workflows remain pending. No full AC acceptance is claimed.

## 2026-10-27 browser checkpoint (19:48 Europe/Berlin)

The actual production UI build and Chromium now reach launcher pairing, Hub Pod
creation, real Jira HTTPS verification and server-confirmed Chat binding. This
exposed misleading empty-Hub copy: the Live Pod surface inherited the Cloud
sync invitation. A new regression failed first; the corrected DE/EN text offers
connecting Jira to Chat. All 11 focused Hub/connection tests, the production UI
build (including TypeScript), full UI lint, harness lint, scoped format and the
unchanged 938-group semantic baseline pass.

The browser harness now uses the existing accessible composer control and records
its stages without contents. The complete browser read is still pending: the
next full attempt was correctly refused with 269 seconds of license time left,
below the existing admission minimum. Earlier partial browser stages do not
constitute a completed qualification group. An independent fresh synthetic
session is being prepared; the previous session's volumes remain retained.

No full acceptance criterion is newly claimed. Chat write/approval composition,
mixed grounding, drag/drop, remaining Pod lifecycle UI, complete scenario lanes,
and final quality/Sonar/current-head qualification remain open. PR #4093 remains
the only PR, against `dev`, with auto-merge off.

## 2026-10-27 licensed browser read (20:00 Europe/Berlin)

An independent synthetic Jira session completed normal first-run setup with the
published test license. The basic identity/permission seed, required create field
and real transition-screen group, pagination/hostile/isolation fixtures, and the
actual product HTTPS/read/write preflight all passed in that session. Setup now
waits for `FIRST_RUN` before opening its mutation marker. Re-entry on the running
instance was refused before a new marker or setup mutation; the cold-start wait
itself remains to be qualified on a subsequent fresh instance.

The complete Chromium group passed twice with the actual production UI and a
freshly verified local Qwen model. The second run explicitly waited for visible
"Reading allowed", "Completed" and the final project-key answer, in addition to
checking the canonical completed turn and persisted real `jira_projects` result.
The journey covers launcher pairing, Hub creation/HTTPS verification, confirmed
Chat binding, the normal composer, explicit read consent and streamed model/tool
execution. License checks bracket both groups; the second closed with 10,194
seconds remaining. Private synthetic screenshots were inspected.

The first completed run's existing Activity Log reconstructs one credential
creation, one verification and scope update, two started/completed gateway
streams, one started/settled tool invocation, four transcript updates and one
final response message. No log-sink warning was observed. Diagnostics and this
checkpoint retain counts, not bodies or credentials.

Harness lint/format and semantic duplication checks pass without changing the
938-group baseline. The preceding UI build/typecheck, UI lint and 11 focused
Hub/connection tests remain applicable; this increment changes only the lab
harness and documentation. This proves a concrete read journey, not all 55 AC.
Chat mutations/concrete approvals, mixed grounding, remaining lifecycle and
drag/drop UI, the broader failure/isolation matrix and final quality/Sonar/CI
qualification remain open. No merge or auto-merge authorization is inferred.

## 2026-10-27 normal Chat write and approval checkpoint

Refs #4081, #4083, #4084, #4086, #4089, #4091, #4087. The public Pod projection now truthfully declares read and write capabilities separately
from verification, authority and issue-level Jira permissions. The ordinary Chat-owned
catalog now advertises all nine reads and five governed mutations through the same
production binder and managed MCP host. Canonical user-turn/call identity owns the
durable mutation intent. The existing credential owner supplies the outbound HTTP
factory; metadata reads do not consume a write approval. The exact approval is claimed
once at journal dispatch, and invalidation revokes read and write work together.

The existing authenticated action-approval routes expose current state and explicit
approve/reject decisions. They recheck the actor, authority, retained read grant,
binding and credential generations after bounded body parsing. They perform no remote
mutation. Persisted approvals bind the Chat/message/call/action, have monotonic states,
and do not imply a successful write. Duplicate settlement cannot replace its observed
outcome. Historical approval cards perform a fresh GET before offering decisions;
failed POST responses require a user-initiated state refresh and are never retried.

Catalog cancellation and remote effect are separate observations. A validated journal
`mutationOutcome` remains on the original exchange even when its catalog envelope has
null data. The existing history/compaction owner projects both observations to the
model; the UI distinguishes success, acknowledged-unconfirmed, rejection and uncertainty.
The exact action preview is focusable and keyboard-scrollable. Existing Activity Log
owners record new phases without arguments, results, credentials or endpoint strings.
ADR-0181 D5 now describes this implemented ownership and dispatch boundary.

Targeted evidence:

- 218 contract tests, 164 owner/policy/real-HTTP-route/log proof tests and 40 combined
  transcript/ordinary-Chat tests pass. The Chat subset covers all three modes over both
  buffered and SSE delivery, repeated delivery without another model call/effect, and
  rejected writes with zero outbound requests.
- 91 mutation transport/outcome tests pass, including actual SDK/binder execution of all
  five operations through credential custody, acknowledgement-before-cancellation,
  response loss, and no automatic write replay. History/compaction: 33 tests pass.
- UI/API: 268 tests pass. Separate UI typecheck/lint and production UI build pass.
  Package builds, root TypeScript check and scoped lint/format pass. Meaningful red/green
  proofs cover missing normal-Chat mutation discovery, approval and durable corruption,
  outcome loss after cancellation/reload/compaction, and keyboard access to the preview.
- Six live groups using the verified local Qwen model pass: Ask for approval, Supervised
  workspace and Full access, each buffered and streamed. Every group requires the first
  Chat read disclosure; the first two modes require exactly one concrete write approval,
  Full access requires none. Independent Jira readback proves exactly one matching
  synthetic comment and total comment-count increase of one. GET reload retains the
  succeeded outcome. The live harness uses an exclusive durable pending marker and
  retains private product state on uncertain failure; it does not blindly repeat writes.

Remaining: actual browser-write qualification, complete operation/failure/lifecycle
matrix, mixed-source grounding, remaining Hub lifecycle and drag/drop UI, full
compatibility/quality/evidence/Sonar/current-head checks. No AC is promoted to final
acceptance by this checkpoint. PR #4093 remains open against dev with auto-merge off.

## 2026-10-27 late observations, mixed scope and Pod lifecycle checkpoint

Refs #4081, #4084, #4085, #4086, #4091, #4087. A regression demonstrated a
cancelled Chat retaining `unknown` after Jira had subsequently acknowledged the write.
The existing message owner now projects the durable journal for the exact canonical
turn, call, operation and arguments. It preserves the original catalog envelope and
never dispatches or reacquires authority. A fresh SQLite reader sees the late
`succeeded-unconfirmed` observation; no-result history can also recover it. Active
prepared work remains pending. Tampered identity/action metadata is not attached to
another exchange. The new registered body-free observation event records only a digest
and count; independent failure-class obligations include the new operation.

Mixed scope now assembles the existing Data-source evidence pack before Jira tool
orchestration. One accepted-turn meter covers preparation, retrieval model calls, tools,
answer and repair. The physical synthesis tracker only releases the exact fully
observed tool-call attempt; discarded/ambiguous attempts and every token remain charged.
Jira results stay outside the numbered Data-source citations. The normal desktop
buffered adapter uses that same owner. Mixed streaming explicitly returns
`STREAMING_UNSUPPORTED` before turn admission/effects and the existing client falls back
to buffered execution with the same canonical identity. Empty Data evidence remains a
separate open qualification edge; this checkpoint does not claim that case complete.

The existing Hub now owns rename, token replacement/reverification and removal with
fresh generation checks, secret clearing, duplicate-submit/unmount guards and GET-only
recovery after uncertain mutation responses. Jira creation leaves exactly one canonical
Pod verification owner; the Cloud inline flow remains. Shared mode controls show the
server-derived deployment ceiling/effective mode. Existing saved-Pod drag/drop and
keyboard ports reuse the explicit replacement form and authenticated Chat PATCH; visual
edges follow server acknowledgement. Remaining connection races/header presentation and
fresh production-browser qualification are recorded as open.

Scoped evidence (suite counts overlap):

- Late outcome/transcript/ordinary Chat: 92 tests pass, including the meaningful
  before-failure and fresh-reader recovery. Package build and operation-catalog
  generation pass with no typed-registry violations.
- Mixed: 6 actual-gateway integrations, 15 physical budget tests, 45 retry tests,
  320 plural/local grounding regressions, 217 UI observer/hook tests, 31 schedule-log
  proofs and 16 selected desktop regressions pass.
- Hub/API/accessibility/DE-EN/style: 73 tests; custody: 71 tests. Ordinary UI lint and
  UI typecheck pass; obsolete suppressions are removed, none added.
- Mode projection: 182 server tests. Connection/workspace/Coding UI regression group:
  787 tests pass before the final small port re-acknowledgement fix; its focused
  regression failed before the fix and then passed with all 10 Jira connection tests;
  the related AppShell suites pass 193 tests. The semantic baseline only shrank from 938 to 932,
  with zero new normalized fingerprints or clone groups.
- All nine real-model write groups passed on the preceding UI artifact: three modes
  over buffered API, streamed API and browser. Each independently observed one matching
  Jira comment and count +1, with the correct disclosure/approval matrix. The current
  Hub and shared-mode layout must be rebuilt and browser-qualified again. Twelve live
  Activity Log files contain neither the nine synthetic comment markers nor the PAT.

Final full quality/coverage/compatibility/UI-evidence/Sonar/current-head acceptance
remains open. This remains one regular PR against dev with auto-merge off.

### Incremental qualification — capability, empty evidence and current Jira pages

Epic #4081 / #4083 / #4084 / #4086 / #4091 / #4087: bound Chat now refuses absent, stale, unsupported or unverified tool-calling proof through the existing readiness error. Ten failing server and two failing locale cases precede the repair; 23 normal Chat cases, 267 desktop/readiness regressions and 260 UI formatter/hook cases pass. Eighteen actual mixed-handler cases and 510 grounding/Memory regressions cover valid empty Data evidence, settled Jira results, missing-path denial, unchanged Data-only abstention and independently bounded Memory.

The rebuilt real browser artifact passes keyboard connection plus Ask/approved writing and a separate native drag/Full writing group. Both observe exactly one matching remote comment and a total increase of one. The lifecycle group verifies rename, a distinct token replacement, revocation of the previous grant, reverification, removal of credential/binding/edge, and private Activity Log content checks. These are working-artifact qualifications; the final exact-commit full matrix remains pending.

The new finite 14-operation normal Chat driver exposed an actual Jira10.3.26 metadata-envelope incompatibility before any mutation. Independent reads confirmed no remote change. The shared parser now accepts each complete known envelope separately, rejects mixed or contradictory fields, and supplies the same normalized terminal flag to read and create consumers. The regression failed before correction; 81 targeted metadata/mutation tests pass afterward. The API shape is independently observed in the licensed laboratory and documented by the [Atlassian REST examples](https://developer.atlassian.com/server/jira/platform/jira-rest-api-examples/). The rerun progressed through seven reads, then exposed a harness expectation against an empty comment fixture; that case now targets the deliberately seeded hostile-comment fixture. The complete 14-operation group has **not yet passed**.

Four normal Chat tests also reproduced an approval transcript remaining `approved` after consumption; the turn owner now refreshes the exact approval identity from its existing registry before settlement. All 23 normal Chat tests pass, including claimed state in buffered/streamed Ask and Supervised modes and no approval in Full mode. New durable-grant restoration, deterministic browser CI, the remaining live/failure matrix and final aggregate gates remain separate outstanding work. No acceptance checkbox is closed by this checkpoint.

The final bound-Jira source-label correction has two meaningful failing-before/passing-after
locale cases. A Live-only Chat now labels the existing picker **Data sources / No Data sources**
(with German equivalents); a mixed Chat retains its selected Data grounding, and clearing that
selection does not disconnect Jira. The unchanged unbound labels remain covered. The three owning
suites (`ChatWindow.test.tsx`, `ChatWindow.a11y.test.tsx`, `JiraChatConnection.test.tsx`) pass
**177/177**; the UI typecheck, scoped normal ESLint, Prettier and whitespace checks pass. This last
copy change is included in the fresh production UI build used by the passing canonical updater
evidence regeneration below.

Three existing operator documents now match the implemented path: the connector guide describes
Live-Pod creation/ports, selected and effective modes, read grants, exact write approvals, field
limits, mixed citation attribution and lifecycle; ADR-0128 records acknowledgement before body
consumption and the separate durable remote outcome; the troubleshooting runbook removes unsafe
write-retry advice for timeouts and 429/5xx responses. False Cloud-only, unchanged-generation
rotation and unrestricted Chat-ACL claims were corrected in place. The ADR index and scoped
Markdown formatting checks pass. These corrections do not close an acceptance criterion or imply
that the remaining live/final gate matrix has passed.

Direct Data-surface compatibility proof now uses a verified, custody-owned Jira Live Pod and an
independent real Data capsule through the public BFF. Live identity receives 404 on capsule read,
index, reindex and source connection, and mixed Live/Data set composition fails without creating a
partial set. The Data control still reads, composes, and reaches its proper empty-source 409 indexing
response. No Jira calls, embedding requests, fabricated capsules or indexing jobs are created by the
refused requests. The complete credential-route and Data-handler suites pass 227/227. Two pre-existing
unrelated-Pod invariance assertions now compare a complete stored-before snapshot with stored-after,
because server-projected effective-mode fields intentionally are not persisted. Scoped lint,
no-emit TypeScript, formatting and whitespace checks pass. There is no capsule-export HTTP route in
the mounted server inventory; this proof does not invent an export endpoint or claim a new Data
export capability. A semantic Hub regression confirms real Verify/Rename/Add-to-workspace controls
while no index, reindex, sync, export or fabricated capsule/storage state appears; the two owning
Live/Cloud card suites pass 12/12. The remaining complete synced-Jira regression is a separate
acceptance obligation.

The design-system fidelity matrix now names the actual Hub/Chat owners and their implemented states,
with pending visual acceptance retained. The update-UI source-digest check correctly detects stale
shared API/catalog evidence. One canonical producer run was interrupted before its final evidence
case because its build overlapped the reserved live-API qualification slot; its 8 completed updater
cases are not counted as accepted regeneration. The subsequent complete canonical run passes all
9 cases (49.1 seconds), including the real-BFF outage journey. Its unchanged freshness gate and
23 focused updater/editor evidence contract tests pass. All 17 artifacts were produced through the
original browser harness; 3 PNGs and the 3 provenance records differ, with 25 actual source digests
and 4 harness digests verified. Changed renders were inspected. This is updater evidence, not Jira
visual acceptance. The macOS editor bundle measurement meets B1/B2/B3 budgets, but `check:editor-release-evidence` fails its
committed fingerprint comparison. Existing repository guidance requires a Linux build/check for this
platform-sensitive record; no committed fingerprint was replaced by macOS measurements.

### Incremental qualification — retained consent and controlled empty-evidence answers

Epic #4081 / #4083 / #4084 / #4086 / #4087 / #4091: granted read consent now persists through the existing bounded private UiStore/registry, with exact-entry state transitions before publication. Later turns still require their own current authority, actor, binding and credential generations, expiry and budgets; an old authority is never restored. Pending decisions are revoked on disposal. Owner, route, migration and actual Gateway restart/next-turn coverage totals 358 distinct tests, including the separately rerun 109-case composition suite after correcting its stale tool-count fixture. Read-only public-history recovery for a crash between consent commit and transcript publication is still being completed separately.

The auditor correctly identified that any settled tool result was too broad a permission for an empty-Data answer. A true failing public-path test reproduced model fabrication after denied consent. Only a successful non-null sanitized observation appended by this exact turn now permits the answer; denied/failed/unavailable and unknown/unconfirmed mutations use the existing abstention, while their structured cards remain available. Successful empty lists remain usable observations.

All nine operations in the finite live catalog read group passed. Creation then exposed another real Jira detail: the endpoint-selected issue type advertises no editable operations. Before dispatch, the old field validator rejected it; remote project digest/count and the unique creation marker independently prove zero writes. The correction treats only canonical endpoint-selected project/issue-type values as create context, rejects caller overrides, preserves ordinary field operations and still checks allowed values. The new case failed before repair; 87 targeted metadata/mutation cases, root TypeScript and scoped lint pass afterward. The full buffered/streamed 14-operation acceptance groups remain pending until complete receipts exist.

The new blocking per-PR browser lane passed all three finite cases against the assembled product: read consent, exact approved mutation, claimed history, forged approval digest, revocation/cancellation, and actionable unverified-model refusal. It uses the actual BFF, gateway transport, catalog, MCP and a deterministic HTTPS Jira fixture; it is distinct from the real-Jira/model live lane. There were 509 passing workflow/wiring tests and no weakened gate classification. The complete owned lane command will run again on final artifacts.

### Linux editor bundle qualification — #4081 / #4087

The platform-sensitive bundle obligation above is now resolved on Linux. An isolated source
snapshot of the current worktree (8,885 files; archive SHA-256
`5950af139c188b8965a7078363d4dc3069ba4b6312299c1f0b1120ea4c1bacee`) was built as the non-root
`node` user with the existing local-gates image
`sha256:11a52911268b6a1eb5bc57ba366921a3043f7bd00816839161193b8ff5b9a349`, Linux arm64,
Node 24.18.0 and npm 11.16.0. No shared checkout, host dependencies or active Jira build outputs were
mounted; only the ordinary npm cache was reused. This is deterministic bundle evidence, not D12
wall-clock evidence or the full local-gates aggregate.

A clean install and canonical package/root/UI build reproduced the stale-record failure:
`staticExport.fileCount` was 384 while the actual export contained 380 files. The Linux editor
fingerprint already matched the committed record. A second fresh build of the identical snapshot
ran the canonical `editor-release-evidence.mjs --json` producer and the unchanged freshness check;
both passed. The 50 existing release-evidence/bundle-size tests also passed inside Linux. B1 has
zero Monaco/editor markers across 21 initial scripts; B2 is 1,026,605 / 2,621,440 gzip bytes; B3 is
110,896 / 768,000 bytes. The generated JSON changes only the measured static-file count to 380;
fingerprint, byte measurements and budgets remain unchanged. Relevant UI/editor/contracts/security/
design sources were compared with the shared worktree before copying the generated record back.
The targeted reproduction is documented in the existing performance-evidence runbook. Final
exact-head integrated checks remain separate.

### Complete live catalog groups and cancellation recovery

Both complete 14-operation normal Chat groups passed against the licensed Jira10.3.26 HTTPS laboratory and the actually verified `keiko-qwen36-35b-8bit` model: one buffered, one streamed. Each group recorded 14 first-read grants and five exact write approvals, nine successful reads and successful create/edit/assign/comment/transition. Independent Jira queries checked project counts, fields, changelog increments and exactly one comment. Transition supplied the required custom value and the required resolution together; its resulting status, resolution and field value matched. Both opening and closing license checks passed. Private receipt SHA-256: buffered `d5b7c0ae7f71c444de372819357a1a90f7ef96baf3ab0b35bbb61219dfe8eb39`; streamed `3e31d8fe788e37e273a1ddbcf3a7df0ff0e06a27fd5c7057c7eed45ef610c40c`. These cover the assembled working artifact before the subsequent cancellation fix/dev integration; final relevant qualification remains necessary.

Earlier failed groups were retained and reconciled independently before new intents. The missing resolution was correctly rejected before dispatch. A model-proposed wrong issue key was never approved; the existing project digest and target fields were unchanged. No ambiguous write was repeated. That abort exposed product consent waiters using the outer signal instead of the turn's composite cancellation. Eight buffered/SSE read/write regressions failed first; the repair and actual HTTP response-disconnect proofs now cancel canonical turns and revoke unfulfilled decisions with zero Jira calls. Already-granted read consent remains reusable. The owning final run passed 223 tests, root TypeScript and scoped lint/format.

Read-only consent-history recovery also closes a crash between committing consent and updating its original transcript, pinning the original canonical message and exact grant identity, subject, generations, disclosure and timestamps. It never writes rows or resumes work. The reusable live harness now drains through the existing Chat serializer before closing SQLite, preserves state on timeout, and atomically fsyncs private intent updates. Twenty focused fault/lifecycle/private-intent tests pass. The finite all-five-write/two-fault live matrix is prepared but has not yet run.

The ordinary PR CI was absent because the PR had merge conflicts with advancing `dev`; the workflow itself remains active. A regular merge of current `dev` into this same feature branch is being prepared. No force-push, new PR, gate bypass or integration into `dev` is authorized by this maintenance step.

### Incremental qualification — renewed laboratory and reproducible cold setup

Epic #4081 / #4082 / #4087: a new isolated synthetic session uses the published test license
through Jira's normal setup forms, with no clock, licensing-code or database modification.
Its license expires at `2026-10-28T00:25:46.347Z`. Seeded API/restricted/editor/assignee identities,
project permissions, required custom field, real transition screen, pagination, hostile-content
and isolated-project fixtures passed their setup checks. Exact TLS admission, untrusted-CA denial,
read/write preflight and independent mutation readback passed. Only the previous owned session was
stopped; its volumes were retained, and the unrelated development Jira was not changed.

Independent empty-volume reproduction found two setup-helper gaps: `FIRST_RUN` can precede the
normal database-page redirect, and the license wizard requires its existing `next` submitter.
The helper now waits for the actual application-properties phase, posts that normal submitter once,
and accepts only the expected same-origin redirect. Body-free stage/status diagnostics preserve
reconciliation without printing keys, filled values or URLs. Failure-first regression checks cover
both gaps and foreign redirect refusal. The full corrected script subsequently passed on another
fresh isolated project without manual continuation: license and mail returned their expected 302s,
license validity and `RUNNING` were confirmed, the completion receipt existed and the pending marker
was gone. This proof project was then stopped with its volumes retained and never occupied the main
HTTPS frontend. Earlier incomplete proof states remain preserved without uncertain POST replay.

The existing normal-Chat helper can now select only a seeded non-admin identity's private PAT;
its default API identity is unchanged, and unknown/path-like identities fail before HTTP. Six of seven
custody-selection checks failed meaningfully for the old implementation; the unchanged default-API
baseline passed. All seven now pass alongside seven setup checks (14 total); scoped lint and formatting pass. This helper change prepares restricted
identity qualification and does not itself claim that the restricted normal-Chat matrix has run.

### Regular dev integration and observed failure boundaries

The single feature branch incorporates `dev` at `44cfbbb3e` by a regular merge. The five
Chat/grounding import conflicts preserve both the governed Jira tool loop and the upstream
authorized-content policy. Cross-policy tests cover both Jira rounds, credential protection,
separate citations, private Chat content, unconditional tool-argument protection and structured
history/compaction pairs. This integration does not merge the feature into `dev` or enable auto-merge.

The complete failure-path scan identified six catches needing an explicit observable boundary.
Pure call validation now reuses the existing safe parser and refuses unserializable or hostile
arguments; mutation-history projection reuses nonthrowing validation, and corrupt transcripts
propagate the same fixed body-free error to their existing owner. UI decision, connector and
consent-observation failures use the existing client diagnostic sink with the original request
correlation, closed error classification and sanitized evidence. Three UI regressions failed first;
22 affected UI tests now pass, including the real diagnostic wire validator and unchanged refusal,
state-refresh and read-only retry behavior. The six contract/store/schema suites pass 251 tests.
Actual databases at versions 46 through 50 upgrade correctly; only test fixture rewinds required
correction for the current schema. No migration, legacy exemption or observability gate was weakened.

Canonical operation/failure inventories and tool-catalog migration metadata were regenerated.
The duplication baseline shrinks from 932 feature-branch entries (933 on dev) to 927. The one
changed normalized fingerprint is a strictly contained shrink of the same six prior source
instances after upstream removed a diagnostic string; each range was checked against the prior
committed group. No new duplicate instance or baseline allowance was added.

All ten real-model normal-Chat fault cases completed: all five mutation types under lost observed
response and committed-then-503 injection. Independent remote state confirms ten single Chat
effects and four explicitly separate foreign PUT changes; duplicate canonical delivery, fresh
process restart and Regenerate preserve the recorded unknown outcome and never add a Chat effect.
This first group remains diagnostic evidence: the Activity Log gate automatically rebuilt shared
packages during the run, and no prior artifact digest was captured. A complete fresh-intent repeat
with frozen before/after artifact inventory is required for qualification. Its completed receipt
and the post-build inventory are retained privately; no uncertain intent was replayed.

Full final quality/Sonar, current-head CI/reviews, restricted identities, browser fault recovery
and the remaining integrated evidence remain open. Earlier scoped receipts are not promoted to
final-head acceptance by this merge.

The architecture aggregate now reaches the catalog performance gate: dependency direction,
imports, contract boundaries and catalog conformance pass, but the inherited paired measurement
does not bind the merged producer. It must be reproduced on the committed subject using the
canonical paired-host procedure and unchanged thresholds; no evidence digest is hand-edited.

### Review corrections and stable-artifact qualification

For #4089/#4091, failed lazy catalog initialization now clears only its own cached attempt so a
later request can retry. Shutdown handles failed initialization and pending admission without
masking a real host-close error. Buffered Chat settles already-admitted legacy and canonical turns
when preparation fails, restores legacy recency, and returns the existing bounded catalog error
classification. The affected server suites pass 345 cases; the final catalog lifecycle suite
passes five cases and reconstructs actual formatted events without claiming the MCP package's
proof ownership. Canonical operation/failure generation has zero violations.

For #4084/#4086, read-consent SSE events reject extra outer and data fields. The UI validates the
grant contract and its exact Chat, Pod, generation, disclosure and time bindings before accepting
it. Negative cases failed before the fixes. Contract and client suites pass 124 and 47 cases.
History tests through the real disk store and production redactor preserve distinct Jira browse
URLs for identical issue keys across Pod replacement and restart: 18 store and 14 UI cases pass.
Both root and UI typechecks pass on the final fixture source.

The proposed raw-argument digest bypass is deliberately rejected. The real gateway, store and
binder path proves that additional configured-secret redaction of the saved proposal prevents
both approval creation and Jira dispatch in all three modes. Thirty mixed-source tests pass,
including these three regressions and the existing post-write overflow/repair budget controls.
The invariant is documented at the existing write guard; no hidden payload acquires authority.

For #4082/#4087, all lab browser imports use the declared Playwright dependency. A browser launch
failure before any Jira request removes only the setup helper's own pending marker; uncertainty
after launch and replaced markers remain protected. The setup, actor, restricted-case and
failure-report tests pass 56 cases. Browser fault drivers share the existing lifecycle reporter;
26 driver/fault tests and the semantic duplication gate pass with the unchanged 927-entry
baseline. The new restricted and browser fault runners are ready, but their live groups are still
pending. Their outcomes must not be inferred from harness tests.

The canonical paired Linux catalog performance producer measured committed `d3fc521a9404` against
`44cfbbb3e` in independent clean checkouts. The two evidence files and the budget's calibration
reference were regenerated; all numerical ceilings remain unchanged. Architecture checking now
passes. Current updater evidence was regenerated through its canonical nine-case browser suite;
the three-case wired Jira browser lane also passes. These checks do not replace final aggregate,
Sonar, current-head CI, Linux editor qualification or the remaining licensed live groups.

### Regenerate retains the current durable tool observations

The clean fault repeat stopped in its fourth case after one independently verified Jira comment.
The duplicate request and fresh-process duplicate had preserved that one effect, but Regenerate
returned a registered `ProviderEmptyAnswerError` after consuming its output allocation. Before and
after inventories match across 6,824 compiled/helper files, with digest
`b4ad065a4065d0d793a6403eeba8270da8a1929e2f98705b31a8b16e23983ffa`.
The incomplete group, pending marker, private reconciliation and database remain retained. It is
not a ten-case acceptance receipt and its mutation is never replayed.

Two failing regressions then demonstrated the real context defect: Regenerate discarded the
current user row's stored tool exchanges while rebuilding its prompt. The existing prompt owner
now includes complete durable call/result pairs and their canonical outcomes in the protected
current-turn scaffold, counts them before history compaction, and refuses an oversized scaffold.
Images attach to the latest user message even when tool observations follow it. No tools are
offered or dispatched by Regenerate; no output budget, retry allowance or authority is widened.
The eight affected Chat/context suites pass 447 cases, with root typechecking, scoped lint/format,
semantic duplication and error-observability checks green. The compiled context-quality gate also
passes, including short-session compatibility and calibrated tool accounting.

Two additional actual-Gateway mixed tests hold the first Jira read until a second Chat completes,
using the same Pod and distinct Pods. They prove separate grants and call IDs, correct credential
routing in reversed completion order, and exactly two reads. The final mixed suite passes 32 cases.
This is hermetic production-path evidence, not a licensed live two-Chat receipt.

The live consent observer now follows the newly admitted durable user row rather than the first
historical user row. Explicit consent reuse validates the exact current subject/generations before
the turn and again before write approval. Nine tests failed before this correction; the combined
helper suite passes 72 tests. A four-turn driver now covers a real process restart, fresh read with
retained consent, token replacement/reverification, fresh consent and one approved comment with
independent replacement-identity authorship. Its live execution remains pending. Catalog and
restricted group receipts also require an explicit final license check.

A new independent project completed normal cold setup, all fixture classes and the production
HTTPS/read/write preflight. Its license expires at 2026-10-28 02:01:30 UTC. The preceding project is
stopped with volumes and incomplete records retained; unrelated Jira installations are untouched.
The corrected artifact requires a new complete fault group with fresh intents on this session.

Separately, exact checkpoint `4269b438c538` passed the isolated canonical Linux package/root/UI
build, editor release-evidence gate, bundle-size gate and 50 related tests. The existing editor
evidence matched without regeneration or changed limits. All nine reviewed bot conversations were
answered with fixes or the documented raw-digest rebuttal and resolved. Final aggregate/Sonar,
current-head checks, remaining live groups and complete Jira visual acceptance remain open.

### Stable-artifact fault qualification and custody races

Epic #4081 / #4083 / #4084 / #4091 / #4087: the fresh real-model fault group passes **10/10**
on committed `6c63f33a0f7a`. Every create/edit/assign/comment/transition case covers a lost observed
response or a committed-then-503 observation, original duplicate delivery, a duplicate from a
fresh Node process and actual-model Regenerate. Independent Jira state confirms exactly ten Chat
effects and four separately requested foreign PUT effects. No duplicate, restart or Regenerate
adds a remote effect. The fault injection changes the journal-visible response after real Jira
acceptance; it does not claim a physical browser socket interruption.

All 6,824 compiled/helper files match before and after the complete group, with inventory digest
`6836cb923f68d84e603dce9182e23a0ad2d89d2ae7d4b6030e2ea75c011bf876`.
The retained private completion receipt has SHA-256
`2c6bbe7c67b81e837ce6f688a134d3085c5cfe2d6a815257356c2a6ee65f0bdd`.
Opening and closing license checks found 9,571 and 9,145 seconds remaining. There is no pending
intent for this group. Earlier diagnostic/incomplete groups remain retained and are not relabelled.

Three additional hermetic production-path tests use actual credential creation/verification,
vault custody, Chat PATCH, Gateway, catalog/MCP, grants and approvals. Token rotation cancels
both same-Pod pending writes with zero effects while the distinct Pod writes once. Disconnect
discards a delayed private result while another Pod completes. Credential deletion after remote
acknowledgement retains `succeeded-unconfirmed` even when delivery is cancelled. Only the remote
HTTP tail supplies controlled responses/barriers. No product change was needed for these proofs.
The complete mixed suite passes 35 cases; its final three targeted cases, root TypeScript,
scoped ESLint/Prettier and unchanged semantic-duplication gate pass.

Restricted identities, live consent reuse and rotation, physical browser response loss, complete
visual acceptance, final aggregate/Sonar and required current-head checks remain outstanding.

### Browser accessibility and bounded live-model correction

Epic #4081 / #4086 / #4087: the wired deterministic Jira browser lane now passes five cases,
including English/German journeys through the actual UI, BFF, Gateway, catalog, MCP host and HTTPS
fixture. Its 83 full-document axe checks report zero violations, without exclusions. All five
surfaces are checked across themes, contrast/forced colors, reduced motion, narrow/maximized
windows and explicit 200% viewport/device-scale emulation. Keyboard controls remain reachable.
The [retained producer receipts and eight inspected captures](../design-system/evidence/4081/README.md)
state the exact source hashes, environment and limits; native zoom/screen-reader execution is not
claimed by this evidence.

The browser run exposed a real question-map target-size failure: existing targets were 48×6 CSS
pixels, only eight pixels apart. The existing global stylesheet now gives them 48×24 targets,
visible focus and bounded vertical scrolling, while keeping their two-pixel marks. Thirty actual
questions remain keyboard reachable and first/last navigation adds no Jira request. The two
existing component regressions also pass. No light-theme color change was retained: the initial
contrast sample occurred during an animation; stable measured contrast already passed.

The unchanged canonical Updater producer passes all nine cases and regenerates its required
source-bound evidence. Its freshness gate and 23 evidence contracts pass. Both Linux Editor
bundle gates pass without restamping evidence or changing any limit. Root TypeScript, scoped
lint/format and E2E wiring pass. These checks supplement, rather than replace, the final aggregate.

Restricted live runs exposed malformed optional model arguments before tool admission. Failed
groups retain their incomplete receipts; independent reconciliation found no mutation-journal row
or remote effect. The lab can now explicitly select one existing Gateway retry, with its schema
correction and original budgets; the default remains zero. A composed normal-Chat regression
observes three physical model requests, remote-effect snapshots of zero/zero/one, and only the
valid call persisted. The affected Gateway/Chat/helper suites pass 173 cases. Seven configuration
checks failed before the helper correction; the unchanged default baseline passed throughout.

Both focused restricted groups now pass 8/8, buffered and SSE, with one allowed edit each,
zero denied-write effects, canonical no-replay and both required-field refusals before dispatch.
Their before/after inventories match across 6,827 files, digest
`6886b63c775c83ca19306b78d354027b21b75cbb92c2c2b71b7b7743be458904`.
The buffered receipt SHA-256 is
`60b1802bf014f32348a1e304300281de506d7dbd3457479097c6395d3a52104c`.
The complete restricted catalog groups and live retained-consent lifecycle remain in progress.

Browser fault drivers now share their canonical recovery observer. A separate fixture physically
destroys the actual BFF response only after it observes a durably completed approved turn; real
loopback HTTP tests prove interruption and refuse premature completion. This harness proof does
not claim the licensed browser group has run. An independent mixed-source driver creates and
indexes a real Data Pod with an explicitly selected embedding model, then checks ordinary mixed
read/approved-write turns and Data-only citations. Its live group is also pending. Existing
defaults are preserved, and no product retry, schema, authority or budget was widened.

### Completed mixed-source and browser recovery groups

The stable `55ba6ff64` browser build passes both unknown-result journeys: keyboard connection
with a lost observed Jira response, and native drag connection with committed-then-503. Each
approved comment produces exactly one independently observed Jira effect. Canonical duplicate
delivery, browser reload and visible Regenerate retain the unknown outcome without replay.
Receipt SHA-256: `e76c288a6309cff4c8a6c6c2a2076f1d7f5ea49d16c4bcbadc70d3b84228b868`.
A separate real BFF-to-Chromium interruption destroys the actual response after durable tool and
assistant completion. Chromium observes the network failure; there are zero automatic buffered
fallbacks. Explicit duplicate/reload/Regenerate preserve the confirmed result and one remote
comment. Receipt SHA-256: `6d4ccbea70223517c0c6737dddb092df0ef0a7d53ee8b976a93797fa21ac2dd5`.
Both groups retain matching 6,832-file runtime/helper and 381-file served-UI inventories, valid
opening/closing license checks and no pending intent. The physical socket-loss group injects no
Jira fault; its confirmed result is distinct from the first group's unknown Jira observation.

The complete real-model mixed group passes two turns through ordinary Chat: Jira projects read
and approved comment, each combined with a freshly created, connected and indexed Data Pod.
The explicit embedding model is `qwen3-embedding:8b`; synthesis uses `keiko-qwen36-35b-8bit`.
Each turn has one first-read grant; the write has one exact approval and one remote effect.
Both answers correctly report eleven review steps, retain one Data-only citation, and identify
Jira separately. Receipt SHA-256:
`9da82b396b2421c2b81439f74513aa2918238ccc81d4afa17ea384cd9ba186f7`.
All 6,825 runtime/helper files match before/after, inventory digest
`775c169e79a1e9fad58a44a294f8f598960ebcccae1137d4bb639dc73f8c0b4f`; closing license has
6,466 seconds remaining. The earlier ambiguous-question attempt answered only the Data question
with zero Jira calls and zero effects; its incomplete receipt and reconciliation remain retained.
The successful fresh group clarifies the natural Jira question without forcing tool choice,
replacing a provider or weakening acceptance assertions.

### Verification failures through the actual Hub

The existing browser-client integration fixture now also mounts the real Hub panel. Nineteen
additional cases carry all nine closed verification outcomes in English/German and a later
revoked-token response through the actual client, HTTP route, custody and visible card. Only the
remote fetch tail is synthetic; this does not claim a native Jira token was revoked. The tests
check generation invalidation, removal of stale success, registered body-free outcomes and no
raw provider details or tokens in the UI. All seven unchanged Cloud/Data Center creation and
compatibility cases still pass.

Four new checks failed before correction: the shared authentication copy requested an account
email which PAT connections do not have, and the forbidden copy asserted authentication and a
permission-only cause. Existing English/German messages now request the account/token check and
include site/license restrictions as possible causes to inspect. No new outcome is inferred from
provider text. The 26 integration cases and two existing status/axe tests pass; scoped UI types,
lint and format pass. The required visual/update evidence refresh follows this source change.

Restricted catalog qualification now has an explicit native-401 case for assignable-user lookup
and assignment metadata. The harness expects existing fail-closed credential invalidation,
cancelled delivery, unchanged canonical identity, no mutation dispatch and no duplicate replay.
It does not reinterpret 401 as permission403. Sixty-five scoped helper cases and the unchanged
927-entry semantic baseline pass; complete licensed catalog/lifecycle groups are still pending.

The independent Linux full-gate run on `55ba6ff64` has passed root/UI typechecking, lint and
formatting and is running the full unit matrix. Complete final-head coverage, evidence, Sonar,
required checks and review closeout remain outstanding; no criterion is marked fully accepted.

### Cumulative budgets, current metadata and measured MCP coverage

Seven additional tests in the existing normal/mixed Chat fixtures close the finite budget gaps:
original input/output exhaustion after a successful Jira read; thirty cumulative tool calls;
physical retrieval and the exhausted excerpt allowance carried into later phases; the original
deadline after consent/tool time; and the actual ten-round Jira loop in buffered and streamed
Chat. The complete suites pass 90 cases (41 mixed, 49 ordinary), including all earlier isolation,
approval, custody, replay and Gateway schema-correction cases. No runtime budget changed.

The aggregate exposed a stale non-Coding SDK expectation: a complete current
`startAt/maxResults/isLast` metadata page was still listed as invalid after the licensed
Jira10.3.26 parser repair. Both current and legacy positive page shapes now run through the real
binder/SDK; the negative remains a genuinely contradictory terminal page. All 49 consumer cases
pass. No payload validation was loosened.

The new MCP package was absent from the coverage baseline, and five existing source inventories
were stale. Ten additional public-host cases exercise unsafe schema/name/risk declarations,
registry bounds, duplicate provider/tool identities and actual two-provider SDK discovery with
zero handler execution. All 28 host cases pass. A scoped V8 measurement over the complete MCP
source surface records lines98.73%, statements93.75%, branches86.46%, functions100%; every metric
exceeds the existing85% new-package floor. The canonical coverage collector creates only this
new entry; the existing source-inventory refresh updates counts. All existing measurements,
policy, tolerances and governed file floors are byte-for-byte unchanged. The 70 baseline reality
tests now pass. Full three-producer coverage remains a separate pending gate.

Canonical UI producers were rerun on `71d84996c` after the verification-copy repair: Jira5/5 with
83 full-document accessibility checks, Updater9/9, all 93 screenshot digests and source
fingerprints,23 evidence contracts and both unchanged Linux Editor gates pass. Four changed
screenshots were visually inspected; evidence is retained in the existing4081/3405 directories.

The complete restricted buffered catalog now passes14/14, including native401 cancellation for
assignable-user lookup and approved assignment, with zero mutation dispatch in both cases.
All14 cases together produce zero remote effects. Before/after6829-file inventory digest:
`1029de48bd8f1637abd0a21d673d2fe1691fbe61e64f41539e444b9df89e9de6`.
The earlier exact-null and missing-CSRF harness defects were proven red/green and corrected;
66 scoped helper tests pass. Incomplete groups remain reconciled and retained. One later SSE
group stopped after a successful search because the model returned an empty final answer;
zero journals/effects and an unchanged inventory were independently confirmed. It remains an
unsuccessful diagnostic group; a fresh complete group and the consent lifecycle are pending.

The first aggregate Linux run exposed unsupported-host assumptions in native Linux-x64 tests
when run on ARM64. A separate x64 container now uses the committed gate image and its documented
namespace settings, with separate native dependencies. No product platform boundary or test
assertion is bypassed. A separate macOS reproduction of the failed customer-shape CI job passed;
targeted investigation then reproduced a report-validator error involving optional non-causal
context. The existing report validator now follows its validated operation registry: optional
`causal:none` probe context does not invent mandatory ancestors. True causal-parent, mandatory
member, integrity and budget checks remain unchanged. A staggered startup/probe fixture fails
before the correction;628 support/query/registry/analyzer/CLI cases pass afterward. The unchanged
canonical macOS customer-shape producer passes after its isolated package/root/UI rebuild
(90,165ms). ADR0173 now agrees with its existing registered-closure rule. The failed CI run did
not retain its private report, so its exact opaque ancestor is not claimed as recovered.

The remaining native verification helper has18 focused guard/recovery cases. It persists owned
PAT creation intent before dispatch, refuses blind replay, and can restart only its inspected
synthetic Jira service even if recording recovery fails. Native execution remains pending.
Natural read questions now precede the exact operation payload in the catalog/lifecycle fixtures;
14 wire regressions preserve arguments, identities and all five mutation requests. The80-case
helper run passes. No shared API helper, model budget, expected effect or runtime policy changes.
Final qualified aggregates, full coverage/Sonar and required current-head checks remain open.

## Shared external MCP priority — foundation checkpoint, 2026-10-28

The owner expanded the primary delivery to central Settings configuration for local stdio
and remote HTTPS MCP servers, with tools shared by ordinary Chat and OpenCode. Jira Pods
remain in this same PR. Resources/prompts are not prerequisites for the tools delivery.
All original 55 criteria remain subject to acceptance; this checkpoint is not closeout.

This increment adds additive registry contracts for automatic discovery and sealed local
environment references, safe native action collision rejection, and the Settings persistence
owner over the existing registry, private JSON writer and MCP credential vault. It checks
revisions before writes and binds immutable stored credentials to their configured target.
The registered Settings event contains only counts, outcome and a registry digest.

The five focused contract, registry and credential suites pass 69 tests. New capability
cases first failed against the old contract. Persistence tests cover restart, stale writers,
private file permissions, corrupt state, target changes, immutable credentials and body-free
Activity Log reconstruction. Package build and scoped lint/format are checked separately.

Settings routes/UI, external SDK transport composition, discovery admission, Chat integration,
OpenCode secret launch/relay integration and lifecycle invalidation are still pending at this
checkpoint. The accepted earlier Jira live evidence does not qualify those new paths.

### Shared Settings API and credential removal checkpoint

The production dependency graph now owns the shared Settings store, mounted at authenticated
GET/PUT `/api/mcp/servers`. Reads are non-cacheable; writes use the existing bounded JSON reader
and reject an app session revoked during body delivery. Invalid requests do not reach persistence;
a stale revision returns a conflict instead of silently replacing the current registry.

Secret resolution checks the currently enabled configuration and its exact transport before
opening a credential. Deleted references are removed from the MCP vault without touching OAuth
entries. This is storage/resolution invalidation; revocation of already-bound runtime transports
remains a separate outstanding integration obligation.

The targeted route, store, credential, route-template and stack-frame suites pass 53 tests.
This increment also corrects concrete earlier failures: the Activity Log recognizes the real
`keiko-mcp` package and preserves the literal consent/approval/MCP-settings route segments.
The full Activity Log gate passed seven checks on the previous foundation checkpoint; error
observability also passes. Settings UI, external transports/discovery and shared consumer
execution remain pending; these API tests are not an end-to-end MCP tool qualification.

### Auditor finding: recoverable Settings persistence across partial failures

Confirmed against `6d08fc0cb`: registry publication followed by failed vault cleanup could
report failure after configuration was committed; a failed registry write after sealing could
also make a repeated immutable-reference request fail. Three new fault cases fail on that
commit and pass after the fix (78 tests across six focused suites; registry gate 97 tests).

Identical sealed reference/value/target writes are now idempotent; different values remain
refused. A credential-free update does not open a nonexistent vault. Registry publication is
the configuration commit point: cleanup failure returns the committed revision with
`credentialCleanup: pending`, recorded in body-free Activity Log evidence. Access resolution
still refuses inactive references. Reads and subsequent updates reconcile orphan ciphertext
against the durable registry, including after a fresh store/process; malformed registry state
never authorizes cleanup. The fault tests simulate registry-write failure and an unavailable
vault key and verify successful retry/restart and actual eventual credential removal.

### External MCP protocol client checkpoint

`keiko-mcp` now owns an external SDK client alongside its in-process host. It negotiates
modern and legacy protocol versions, supports local stdio, Streamable HTTP and explicit
legacy HTTP+SSE, and exposes SDK-free tool metadata/results to consumers. Server composition
must still supply admitted process parameters or policy-controlled HTTP transport.

Discovery has bounded pagination, tool counts and payloads. Input schemas are validated
before tool dispatch; the current invocation authority is rechecked at the transport boundary.
Invocation context is process-local, and remote fetch composition receives it separately from
MCP arguments. Local launches explicitly override SDK ambient environment inheritance and
discard process stderr. Lifetime cancellation closes the connection; tool requests do not
reconnect/replay after an uncertain response. Registered lifecycle evidence carries no payloads.

The existing host plus new client suites pass 41 tests, including a real child-process legacy
server, real SDK Streamable HTTP and HTTP+SSE exchanges, revoked authority during validation,
unsafe targets, bounded discovery, cancellation, body-free lifecycle proof and exactly one
remote effect after a lost successful response. Typecheck/scoped lint/format, architecture and
negative architecture checks are run independently. This qualifies the protocol adapter;
Settings discovery, Chat/OpenCode composition, complete runtime invalidation and product UI
remain required before external MCP tools are usable end to end.

### Configured MCP tools in OpenCode: real UI and approval repair

The Settings connection manager now serves admitted tools through the existing authenticated
native relay. One server-owned SDK connection owns stdio/HTTP and credential materialization;
OpenCode receives a scoped loopback capability. Disable, replacement and removal revoke the
generation and abort its relay. Modern and legacy MCP requests carry isolated, private invocation
context. Managed tools remain external actions under the selected mode, including local stdio
processes owned by the server: Ask for approval and Supervised workspace require approval;
Full access permits execution inside the existing authority. Direct remote access below Full
access remains denied.

The real browser journey exposed two approval defects. A hyphenated MCP tool permission was
copied into the narrow public evidence contract and rejected as `sidecar-event-denied`; its
public projection is now the fixed `mcp` category with the registered `native-mcp` command
label. The authenticated private review retains the actual tool identity. The UI also incorrectly
required a Research destination for these native requests; it now uses their existing bound
native review. Red-before/green-after regressions cover both defects without relaxing the
public contract or admitting unbound approvals. Runtime failures record a closed, body-free
reason code rather than arbitrary error text.

On 2026-10-28, the in-app browser configured a synthetic three-tool stdio server and used the
running Docker LiteLLM gateway with Gemma. Actual Workbench journeys succeeded for:

- Full access: read, then a write followed by readback; exactly one new remote record.
- Ask for approval: read after the visible program/tool approvals.
- Ask for approval: create and readback after the visible program/tool approvals. Independent
  fixture inspection found zero matching records before the MCP write approval and exactly one
  afterward. The UI returned the new record ID and its original text, with a succeeded run and
  zero changed repository files. Earlier failed approval attempts produced no remote write.

These checks used only synthetic fixtures and an isolated test repository; no customer
screenshots, service addresses, tokens or response bodies are included. The original failed
runs remain truthful history; fresh runs demonstrate the corrected behavior.

Focused validation passes: 673 server tests, 345 UI tests, four actual-SDK relay tests, package
build, root/UI TypeScript, scoped server/UI lint and formatting. After the final UI display
adjustment, 13 targeted native/research approval tests pass again. Activity Log passes all
seven inventory checks, including error observability and architecture; the ADR index also
passes. Final aggregate coverage, UI evidence, assembled-package qualification and Sonar
remain pending under the owner's final-qualification workflow.

Ordinary Chat consumption of configured external MCP tools is still being integrated. This
checkpoint does not accept all 55 original criteria, qualify every transport/model combination,
or establish durable mutation/restart safety for the new native path. The PR remains open and
not merge-ready, with auto-merge disabled.

### Native MCP follow-up: replacement races and complete private action identities

An independent review reproduced a replacement race: a request awaiting an older connection
could attach its endpoint to the new entry with the same server name. The relay now captures
the owning entry before awaiting it; the revoked request fails and the replacement remains
usable. A deterministic old/new-generation regression fails before and passes after the fix.

The private native policy, sidecar parser and review also capped permission names at 64
characters, although an admitted MCP server/tool pair can legitimately form a 129-character
native identity. These three private boundaries now share the existing bounded MCP name
grammar. Unrelated overlong permission names remain refused; the public fixed `mcp` evidence
projection is unchanged. All four new regressions failed before the fixes. The six focused
contract/server suites pass 298 tests; scoped lint, formatting and contract build pass.
Complete final qualification remains pending.

### Ordinary Chat consumes centrally configured MCP tools

The ordinary Chat buffered/streaming owners now consume the configured MCP catalog without
requiring a Jira Pod, Coding session or synthetic workspace. The existing bounded Chat loop
serves both the Jira adapter and the configured-MCP adapter; its gateway capability checks,
Harness meters, cancellation, transcript pairing and grounding/synthesis limits remain shared.
The existing authority, read-disclosure and exact-action approval owners use an additive
configured-MCP subject bound to actor, Chat and current configuration. The existing SQLite
mutation journal records durable intent before external dispatch, protocol acknowledgement
and uncertain outcomes without invented HTTP status or Jira identities. Automatic replay and
Regenerate cannot repeat the mutation. The existing tool-access panel and DE/EN cards present
these subjects and results. Unknown remote tool annotations never confer read-only authority.

On 2026-10-28 the actual in-app browser used the running Docker LiteLLM gateway and Gemma
with the same synthetic Settings server already accepted in OpenCode:

- A normal Chat with no bound Jira Pod requested the status tool. Visible read disclosure and
  exact action approval preceded the real SDK invocation. The model returned the actual
  fixture marker, and the Activity Log recorded a completed invocation with an effect.
- A write request left unapproved reached its execution deadline. Independent inspection
  established zero matching remote records. It was not retried automatically.
- A separate, explicitly requested write was approved in the UI, followed by approval of the
  readback of its returned identifier. The model returned that identifier and the exact text
  read from the server. Independent inspection found exactly one matching new record; the
  unapproved request still had zero effects. This used real model and transport calls, not a
  mocked model or an API-only substitute for the UI journey.

The first live normal-Chat attempt exposed an action-decoder defect: catalog metadata was
spread into the strict authority action. The adapter now projects only its seven canonical
identity fields. Regression tests cover this production consumer path and the real UI rerun
succeeds. All fixtures are synthetic; private customer material remains excluded.

Focused evidence includes six production Chat/catalog/binder/SDK integration scenarios,
56 mutation-journal tests, 165 legacy Jira/journal/transcript tests, 531 authority/approval
regressions, 74 UI cases and 332 external-schema/SDK/catalog cases. Package builds, scoped
TypeScript/lint/format checks are recorded separately. These counts overlap and are not a
claimed aggregate run. Final aggregate coverage, UI evidence, assembled-package, Sonar and
current-head CI qualification remain open. Combining a bound Jira Pod with configured MCP
tools in the same Chat is also still under review. This checkpoint does not accept all 55
original criteria or every external transport/model combination.

The follow-up review reproduces and closes configuration A→B→A revival: every real Settings
commit stores a fresh private generation atomically with its definitions. Deletion/recreation,
restart and interruption immediately after commit cannot recover an older consent subject.
Changing an already active secret requires the existing fresh-reference rotation flow. The
105-case Settings/connection/authority regression group passes. No-op saves retain their revision.

The live unapproved timeout also exposed incomplete cancellation propagation. Binder approval
waiters now observe the invocation deadline signal; both Chat adapters revoke pending decisions
when it expires without increasing budgets. The eight focused consumer/journal/Jira/binder suites
pass 214 tests, and root TypeScript including tests plus UI TypeScript pass independently.

The operation registry resolves 628 proofs and 30 scenarios with zero violations. The first
Activity Log gate run found three unobserved catches and an unregistered validator import
boundary; these are repaired through the existing error owners and an exact pure-validator
import allowance with negative fixtures. Error observability, import policy and 78 negative
architecture fixtures now pass. Catalog conformance passes; the portable performance receipt
correctly reports stale producer provenance and must be regenerated from the committed source
with its pinned baseline/candidate toolchain. No measurement or budget is manually changed.

Remaining configured-MCP qualification includes an independently reproduced native ambiguous-write
retry and the SDK's raw schema-warning diagnostic path. The following checkpoint completes
the focused Settings redesign/lifecycle journey; final qualification remains open.

### Settings overview, management and truthful live status

Refs #4081, #4086, #4089 and #4087. The existing Settings panel now opens with a server
list instead of a disabled creation form. Each card offers connection checking, editing,
disable/enable and confirmed removal. Add/edit forms use the existing design tokens and
DE/EN messages, preserve keyboard focus and remain editable after a failed initial load.
Saving still requires a valid paired snapshot. Failed observations cannot retain a green
connected badge; connection state and tool counts come from the actual shared SDK owner.
A browser reload therefore retains real status rather than resetting a component-local flag.

Editing preserves manually admitted tool policies and stored credentials for unchanged
targets. Changing a credential-bound target requires new credentials; transport changes
clear incompatible draft secrets. Stale GET responses cannot overwrite a newer mutation,
while importing an environment draft does not discard the initial Settings response.
Independent UI review reproduced three credential/scope failures before repair and added
stale-response/import race regressions. The two focused UI suites pass 23 tests, including
accessibility, exact failed-load behavior and status truthfulness; UI TypeScript and scoped
lint/format are checked independently. The connection/route/SDK/consumer group passes
38 tests, with root TypeScript including tests and scoped backend lint also passing.

On 2026-10-28, the actual in-app browser created a separate synthetic local MCP entry,
connected it and displayed its three discovered tools. Editing its launch arguments,
saving, reopening and inspecting the form proved persistence. Disable showed Disabled;
Enable showed Not connected until the explicit successful connection check. Cancelling
removal preserved the entry; confirming removal deleted only that test entry. The original
server remained present, reconnected with three tools and still displayed Connected after
a real browser reload. The retained screenshot contains only synthetic fixture metadata.
This journey uses the production Settings UI and API, not direct API substitutes.

SDK close and tool-list change invalidate the actual connection/catalog and pending Chat
consent. A possibly lost individual response leaves other consumers' connection lifecycle
intact. Discovery commits reconnect under the final stored generation before success is
reported. All final aggregate/coverage/evidence, package, performance, Sonar and current-head
CI requirements remain pending; native ambiguous-write recovery and combined Jira/MCP Chat
composition are separate ongoing work. This is not acceptance of all 55 epic criteria.

### Combined Chat sources, SDK metadata admission and native recovery

Refs #4081, #4089, #4091, #4084, #4086 and #4087. A Chat with a bound Jira Pod now
combines its Jira catalog with centrally configured MCP tools before compiling one projection.
One binder and one existing Chat tool loop retain the cumulative Harness budget. Source
registration is atomic before first use; both authority envelopes share counters, actor, Chat,
mode and deadlines. Neither source can be added later, and invalidating either source stops the
accepted combined turn. Existing adapters continue to own their own exact consent, approval,
mutation and transport boundaries. Additive readGrants retains both independent consent cards;
readGrant remains the backward-compatible latest projection. Legacy transcripts remain readable.
The buffered UI consent observer also now covers configured MCP without a Jira binding; the
regression produced zero observations before the fix and passes afterward.

The combined normal-handler tests use the actual shared binder and SDK hosts with synthetic
model and upstream ports. They prove both model offerings, separate consent and write approvals,
both durable journals, canonical replay without duplicate effects, invalidation by either source,
and shared tool/prompt exhaustion. This is deterministic integration evidence, not a claim that
the combined Jira/MCP scenario has already run through a real model/browser. An isolated test
loading the previous factory fails specifically on the missing MCP offer in a Jira-bound Chat.

External tool-list responses are now bounded and validated at the public SDK transport boundary
before its recursive header scan or cache. Invalid metadata rejects the whole list; there is no
schema pruning or global console override. Actual SDK regressions reproduce the previous raw
warning with synthetic private metadata, including an invalid array-shaped properties map.
Valid metadata and parameter headers remain supported. A separate Host-override hypothesis was
refuted through the real SDK: parameter headers are prefixed and do not replace HTTP Host.

Native MCP writes with observed transport/protocol uncertainty now synchronously revoke that
run's relay capabilities and use the existing recovery owner. The persisted Coding snapshot
retains recovery-required despite late stop/failure events and refuses resume. The UI explains
that an external effect may already exist and asks for result reconciliation before a fresh run.
This does not claim that the still-open unobserved relay-to-OpenCode response-loss case already
has stable per-invocation identity or a durable acknowledgement journal.

The actual in-app browser, Docker LiteLLM and Gemma completed a separate synthetic failure
journey: Settings connected a local two-tool server; a fresh Ask-for-approval Coding run displayed
and received its Code Mode program approval and exact MCP action approval. Independent fixture
inspection counted zero effects before tool approval. The tool persisted and fsynced one effect,
then exited before replying. The Workbench displayed Recovery required, revision 9, with the
reconciliation instruction. An actual browser reload preserved that status and the effect count
remained exactly one. The isolated workspace had zero changed files. This is intentional fault
injection, not a successful ordinary tool result or a production-service outage.

Focused verification: 246 authority/single-source/transcript cases; 65 single/combined Chat turn
cases; 308 native relay/orchestrator cases; 249 Chat UI cases and 131 Workbench label cases;
70 MCP cases followed by a 40-case SDK/metadata/combined rerun. These overlap and are not one
aggregate. npm run typecheck, independent UI TypeScript, scoped lint, import policy, contract
boundaries, error observability and ADR index pass. Final aggregates, coverage, UI evidence,
package/performance/Sonar and exact-head CI qualification remain open.

A new independent synthetic Jira session was set up through the normal first-run workflow on
2026-10-28 using the published Atlassian test license. License checks, identity/permission seed
and production-port HTTPS/read/write preflight all passed; the closing preflight reported
10,389 seconds remaining. The prior expired session is stopped with its volumes retained.
Each subsequent qualification group still requires its own opening and closing license checks.

The SDK review additionally reproduced an automatic mutation replay after an upstream commit
followed by HEADER_MISMATCH. The client now supplies the official callTool option with the
validated frozen definition, disabling that refetch/re-dispatch branch. The actual SDK
regression counts exactly one remote effect after the fix, compared with two before it.
The final 35 client/metadata cases, scoped lint and MCP build pass independently.
