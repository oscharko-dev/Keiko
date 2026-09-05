# Governed-tool migration and security contract

This is the #3411 architecture baseline at `9348fb9c` (2026-09-04), governed by
[ADR-0175](../adr/ADR-0175-canonical-governed-tool-catalog.md). It is an inventory and implementation
contract, not evidence that catalog runtime or H1 exists. `npm run check:governed-tool-contract`
checks the historical `inventory.path` / `inventory.probe` mappings in the
[normative table](governed-tool-contract.v1.json) against their verified active owners. The 43
audited IDs, paths, probes, owners and dispositions remain frozen as the historical ownership
baseline, with one narrow, checker-shaped exception: a row whose own owning issue verifiably moves
its probe within a file that survives the refactor (not a deletion) is repointed in place to the
live probe, and the retired mapping is preserved in that row's `scope` text instead of via
`inventoryMigrations` — `inventoryMigrations` requires the retired source path to be absent
(`checkActiveInventoryProbe` in `governed-tool-contract.mjs`), which does not hold when the file
survives with an unrelated, retained counter. `harness-executor` is the first such row: its
`RUN_COMMAND_TOOL` probe in `packages/keiko-harness/src/executor.ts` moved to
`descriptorRunsCommand` in `packages/keiko-harness/src/catalog-budget.ts` (#3409/#3411); the row
was repointed to that live probe with disposition `derive projection`, and the retired
`executor.ts`/`RUN_COMMAND_TOOL`/`migrate/delete` mapping is recorded in the row's `scope` text.
`inventoryMigrations` records the already-reviewed #2958 removal at commit
`f60e7bc230e06cd0e58fde0e89904e330b97cf05`: the obsolete `autonomousDeliveryPolicy.ts` must remain
absent, while live authority admission in `codingToolAuthorityPort.ts`, the shared monotonic
`codingWorkbenchPolicyEffectFor` contract and mounted `authorizeGitDelivery` owner must all exist.
Negative tests reject restored scaffolding, a missing replacement or altered migration identity.
The original historical row is neither rewritten nor removed; a repointed row keeps its id, owner and
retired mapping, so the 43-row ownership baseline stays auditable in both shapes.

This is the first verified migration disposition in the existing inventory gate, not a new
runtime registry. #3406 extends this same migration/conformance mechanism when actual catalog
migration changes another baseline source, and introduces its finite active duplicate register
in that same change. Historical ownership rows remain auditable; only the active duplicate count
then shrinks. #3415 completes that register's zero-duplicate proof.

## Audited production inventory

The machine table gives each production definition a unique ID, exact path, source token, scope,
disposition and one issue owner. These probes can also be reproduced with
`rg -n --fixed-strings '<probe>' '<path>'`; no line number survives refactoring by assumption.

| Group                                                     | Inventory IDs                                                          | Observed disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generic gateway and tool wire types                       | generic-gateway, generic-tool-port                                     | #3409 replaces name-only truth with the one additive bound bridge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Six legacy definitions/parser/dispatch                    | legacy-schema, legacy-host                                             | #3409 derives catalog projection, retains execution, deletes duplicates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Editor nine descriptors, host and active producer subset  | editor-schema, editor-host, editor-route                               | #3408 reconciles exact schema/host support and governed active subset; counts mean different things                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Managed OpenCode schemas, names, descriptions and actions | opencode-schema                                                        | #3414 derives seven existing Keiko tools plus conditional repository search; native question/todowrite stay explicit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| OpenCode prompt/config/source/protocol/IPC/digest         | opencode-launch, opencode-source, opencode-protocol, opencode-ipc      | #3414 derives all semantics from one compiled profile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Runtime-supplied arbitrary definitions                    | sidecar-transport                                                      | Retain transport parsing; #3414 prevents entry into governed dispatch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Live policy, ports and handler readiness                  | live-authority, governed-delegate, handler-composition                 | #3413 binds existing authority; #3386 owns operational handlers, including optional backend availability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Child read alias/parser and transient sink                | child-host                                                             | #3407 assigns unique alias, exact result/input validation and real durable event composition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Native provider projection and Realtime compatibility     | gateway-openai, realtime-compatibility                                 | #3409 derives supported projections and rejects unsupported Realtime tools before session startup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Harness and dry-run CLI/server/SDK composition            | harness-executor, cli-composition, server-composition, sdk-composition | #3409 removes name-based charge; dry-run stays nonproductive, bound backend required; harness-executor repointed in place to its surviving `descriptorRunsCommand` probe (disposition `derive projection`; retired mapping in `scope`). Catalog-B audit closeout: `createNativeCatalogToolPort`/`WorkspaceToolHost` remain built and unit-tested but unused by `cli-composition`/`server-composition` — both stay `dryRun: true` with no `bindToolCatalog`, since neither call site holds a server-validated Authority Envelope (#3413's binder, D1) and wiring one ahead of it would be dead composition that could only become live by also relaxing `dryRun`. `DryRunToolPort`'s dead `legacyDefinitions` constructor parameter is removed; `listTools()` now advertises the compiled `legacy-native@1` projection for honest discovery while `execute()` still refuses every call with a closed reason (ADR-0175 D1 addendum) |
| Run and invocation event durability                       | harness-sink, diagnostic-sink, activity-redaction                      | #3413 owns invocation settlement and primary write; #3409 ensures run sink is not mistaken for tool durability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Workspace search, scan, raw reader and Editor selector    | workspace-search, workspace-scan, workspace-raw-read, editor-raw-lane  | Retain owner; #3386 adds H1 after the verified ADR-0165 gate checkpoint; #3408 resolves private Editor search routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Catalog digest primitive                                  | digest-primitives                                                      | Existing security owner retained; #3406 adds validated domain-separated semantic inputs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Diagnostic operation vocabulary                           | diagnostic-generator                                                   | #3412 extends existing generator; does not own runtime log emission                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Browser boundary                                          | browser-contract                                                       | #3413 emits a safe BFF-only projection; no authority, raw root or executable references                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

The legacy aliases are `read_file`, `list_files`, `inspect_package_scripts`, `run_command`,
`propose_patch`, `apply_patch`. The Editor source declares `editor_list_sessions`, `editor_snapshot`,
`editor_navigate`, `editor_navigate_symbol`, `editor_search_workspace`, `editor_git_context`,
`editor_propose_edit`, `editor_propose_changeset`, `editor_request_verification`. The active
`PRODUCER_TOOL_NAMES` subset is a separate production policy boundary, not proof all nine dispatch.
No migration may widen it merely to make a count agree. Policy tables continue to decide risk;
only duplicated projection tables are removed. Workspace retrieval/index, skill catalog and
connector catalogs retain their existing owners and cannot become competing governed registries.

## Bilateral interfaces and write ownership

The normative `interfaces` and `consumers` sections enumerate all field names and map each mandatory
child's input/output to its one producer. ADR-0175 defines types, conditional result fields and
phase vocabulary. The consistency gate rejects unknown mappings and an interface omitted from its
producer. No consumer may redeclare a canonical result, cursor or identity locally.

| Issue    | Consumes                                                                               | Produces and exclusive edits                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #3411    | Existing ADRs and verified source probes                                               | ADR-0175, ADR-0165 amendment, this contract/inventory and architecture gates; no runtime                                                                       |
| #3406    | Verified #3411 contract checkpoint                                                     | contracts + pure catalog package/compiler/manifest; initial finite registry guard and package DAG/exports                                                      |
| #3412    | Verified #3411 phase vocabulary checkpoint                                             | Existing operation scanner, generated operation artifact/provenance and phase fixtures; no runtime emitter/analyzer edits                                      |
| #3386 H1 | Verified #3411 raw-coordinate gate checkpoint; reserved `keiko.repo.search@1` identity | Existing workspace implementation and server typed handler/readiness/containment/cancellation/tests; no aliases, schema projections, prompt, IPC or allowlists |
| #3413    | #3406 projections + #3412 generated lifecycle operations                               | Server binder/readiness/offer/dispatch/result/cursor/receipt; existing support analyzer and runtime log composition                                            |
| #3409    | #3413 binder and receipts                                                              | Sole ToolPort/GatewayRequest additive bridge, normalizer, native gateway/provider/legacy/harness/CLI/server/SDK consumers and outer run counters               |
| #3414    | #3409 bound arm + #3413 binder + reviewed H1 checkpoint                                | OpenCode source/launch/profile/protocol/IPC/prompt/config and semantic digest; durable H1 provenance                                                           |
| #3407    | #3409 bound arm, #3413 binder and #3414 profile                                        | Current read-only child runner, unique alias projection, inherited envelope/budgets/abort and event durability                                                 |
| #3408    | #3409 bound arm + #3413 binder                                                         | Current Editor descriptors/projection/host/active subset and private search route disposition; retains Editor policy                                           |
| #3415    | Every migration and durable H1 provenance                                              | Repository-wide conformance/performance/packaged qualification; delete legacy bridge and drive migration count to zero                                         |
| #3390    | #3415 exact-head closeout and H1 evidence reference                                    | Live pinned OpenCode real-model journey; no duplicate compiler or handler                                                                                      |

Any shared file has one integrator at a time. #3406/#3412 may proceed in parallel after the #3411 contract is verified in PR #3394.
\#3413 follows both. #3409 lands before any consumer migration. H1 can proceed independently of
\#3406 after #3411, since the typed handler is not model-visible and references the reserved semantic
identity rather than a runtime package that does not yet exist. #3414 waits for H1 and #3409.
\#3407/#3408 and then #3415 follow; #3390 consumes closeout and introduces no dependency cycle.

## Compatibility, removal and rollback

\#3406's actual migration register must freeze each remaining duplicate by exact source identity,
owner issue, projection/contract version and digest, reason, expiry/removal checkpoint, source
fingerprint and removal test. New rows, broader scopes, renamed aliases or expanded consumers fail
closed; removal is allowed only with derived-projection/handler conformance evidence. The active
migration register is finite, shrinks monotonically and reaches zero in #3415. The 43-row historical
ownership inventory is not an active duplicate count and does not shrink. #3406 extends this same migration/conformance checker before removing or changing another source;
its active duplicate register and first catalog migration must land together, with negative tests rejecting
new duplicates and a positive test proving an authorized removal. A native extension has its
own declared owner/identity and never counts as a compatibility exception.

\#3409 alone owns the old/new union and normalizer. The old arm is accepted only from its verified integration checkpoint
until the earlier of its explicit seven-day expiry or #3415 closeout, under a server-held exact
`legacy-native@1` projection binding. Both arms together, unbound name-only input, implicit latest
resolution, downgrade and cross-profile replay are invalid. Every new producer emits the bound
arm. #3415 deletes the legacy arm/normalizer after all named consumers prove bound invocation.

The pending-H1 entry introduced by #3406 is separate and **non-authorizing**. It records owner,
`keiko.repo.search@1`, the verified #3411 contract checkpoint and removal issue #3414. H1 producer
identity and evidence references remain absent until an actual checkpoint exists. No model-visible
file, alias, schema, effect, dispatch table or consumer is allowed by this entry. #3414 records
`H1Provenance` for the signed producer commit and Git tree in PR #3394, with applicable verification
and producing-reviewer acceptance references. Checkpoint review may be an independent agent's
review of the exact producer contents with a retained artifact/hash; it requires no intermediate
external GitHub review or required-check cycle and makes no final release claim. It verifies
ancestry and owned source contents in the consuming head using existing Git identity/evidence helpers before removing the temporary entry.
Producer changes require fresh verification and review evidence. Durable provenance survives,
is independently revalidated by #3415, and is not a projection-digest input. Final required-check
and actual GitHub merge evidence are recorded only after they exist; no separate dev PR or merge
is needed for this producer/consumer handoff.

There is no persistent runtime state migration in #3411. Later binder restarts reject stale or
unsupported bindings and in-memory cursors. A rollback selects an exact supported immutable
artifact/profile, revalidates live authority and readiness, and never revives a settled invocation,
expired compatibility rule or uncertain effect. Safe failure is preferable to dual live registries.

## Threat-negative matrix

| Attack or failure                                                                            | Required denial/proof owner                                                                                     |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Fabricated/unoffered alias, confusable, shadowed native extension                            | #3406 compiler collision rejection; #3413 exact offered-set lookup; no handler call                             |
| Unknown version, downgrade, stale projection or expired compatibility                        | #3406 directional compatibility; #3413 invalid; persisted unsupported binding only recovery-required            |
| Schema smuggling, unsupported refs, unknown properties, prototype/accessor/cycle/depth/width | #3406 compiler validation and #3413 input/result validation before effects/allocation                           |
| Missing/orphaned/duplicate/wrong-version handler or digest mismatch                          | #3413 startup/readiness fails closed; runtime loss never fabricated success                                     |
| Revocation/expiry/root drift after offer                                                     | #3413 dispatch live recheck and no effect; all three autonomy modes                                             |
| Replay, same-key/different-request and double charge                                         | #3413 atomic idempotency/budget reservation and receipt; #3409 consumes only                                    |
| Cursor tamper, replay, cross-root, expiry, stale revision                                    | #3413 opaque single-use binding, every page reauthorized/rebudgeted                                             |
| Traversal, denied path, symlink/hardlink alias, replacement race                             | #3386 reuses ADR-0005 descriptor containment and same guard chain                                               |
| Regex abuse, giant repository, output overflow, uncooperative scan                           | #3386 safe-regex/bounds/yields and cancellation; #3415 50,001+ file fixtures                                    |
| Prompt injection in paths/snippets/symbols                                                   | #3386 treats content as data, redacts snippets separately; #3414 no authority from model text                   |
| Stale index/directory identity                                                               | #3386 existing workspace index validation; explicit incomplete/stale result, never invented exhaustive coverage |
| Abort/deadline/result race, throw/rejection or restart                                       | #3413 exactly-one settlement, quarantine late data, no replay after uncertain effect                            |
| Remote/connector/plugin metadata authority smuggling                                         | #3406 trusted local source, #3413 composition-owned fields; #3414 transport data isolation                      |
| BFF serialization of handlers/envelopes/proofs/roots/secrets                                 | #3413 safe structural projection; negative traversal of nested fields                                           |
| Durable query/path/snippet/symbol/content or exception text                                  | #3412 phase fixtures and #3413 existing redactor/structured diagnostics; #3411 table rejects forbidden evidence |
| Primary/auxiliary sink failure or transient-only lifecycle                                   | #3413 one primary attempt, sequence gap/unknown + stderr; #3407/#3408/#3409 durable composition                 |
| New handwritten registry/digest/action switch                                                | #3406 finite guard; #3415 repository-wide zero-inventory gate                                                   |

The architecture negatives prove the _gate_ fails on raw-lane bypass, missing owner/version/status/
bound/interface/consumer mapping and forbidden evidence fields. They do not prove runtime threat
resistance. H1 and subsequent owners must deliver production-port tests for their rows.

## Explicit external and deferred dispositions

- #2952 owns the reference-environment measurement conventions; #3415 owns measured catalog limits.
- #2554 and closed #2556 own semantic/index substrate. Optional #3416 reuses them after mandatory
  closeout with explicit model/network/spend authority; no second vector store.
- #2287 owns future connector/plugin/MCP/Atlassian capability packs; no exposure is added here.
- #2289 owns future Editor/subagent orchestration, consuming this catalog without another registry.
- Optional #3417 reuses approved skill discovery after closeout; the skill catalog stays subordinate.
- Epic #480 and children #481/#482/#483/#484/#486/#487/#488 remain a **non-blocking deferred
  proposal**. They require a separately settled product decision and replanning before any BYOA
  adaptation; they are neither committed consumers nor prerequisites.
- Closed #3316 and ADR-0163 keep Codex production composition disabled. No activation is authorized.

## Verification and delivery evidence

Run the issue's minimum loop, `check:governed-tool-contract`, `check:adr-index`, existing architecture
negative gates and `gates:sonar`. The raw-coordinate regression was executed against the unchanged
import-policy owner first: six negative cases failed while four allowed/control cases passed.
The same fixture then passes with the AST rule; the permanent architecture negative also requires
its exact named firing. Source inventories are checked locally without GitHub/network access.
Applicable local verification and reviewed producer checkpoints establish the in-PR handoffs;
required checks must pass on the exact final PR #3394 head. #3411 stays open until the actual
owner-controlled integration and closure evidence. No separate dev merge is a prerequisite.
