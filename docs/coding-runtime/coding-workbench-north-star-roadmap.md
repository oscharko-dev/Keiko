# Coding Workbench north-star roadmap

**Status:** accepted roadmap; owner-approved decisions dated 2026-08-23.
**Supersedes:** the wave plan of epic #2473 (`Epic: OpenCode engine in Keiko — activation, live Code
tasks, governed delivery, and capability parity`); #2473 is closed as superseded once the new epic
is open, with its Annex A/B carried forward.
**Companion:** the baseline document under `docs/coding-runtime/` (capability inventory, per-claim
`path:line` evidence, capability parity table) and ADR-0174 (`docs/adr/`, authored in Wave 0), which
records the architectural spine below as the decision of record.
**Sizing legend:** S ≤ 1 agent-day, M ≤ 3, L ≤ 6, XL > 6 — each including its own gates.
**No calendar dates.** Capacity has not been confirmed by the owner; see §6(d).

## 1. North star and yardstick

The Coding Workbench's north star is parity with leading agentic coding assistants in **how** a task
is worked, not in which model runs it: a visible plan, a model-driven tool-calling loop, iteration
against real verification output, and governed delivery — the same mechanics regardless of the
model behind the run. Parity is built _inside_ Keiko's authority envelope — the three autonomy
modes, fail-closed hard denials, body-free persisted evidence — never around it; the human-control
invariant in AGENTS.md §1 bounds every wave below.

The acceptance test is dogfooding: Keiko works a Keiko issue end-to-end under the repository's own
gates — plan, edit, verify, deliver a pull request without a human performing the mechanical steps.
Wave 4's exit journey is this test, executed for real.

Capability parity is tiered **Must** (core-loop load-bearing, owner-accepted, or an existing
strength to protect), **Should** (what a longer-running or multi-machine task needs), and **Later**
(real gaps, off the critical path). The baseline's parity table (§7) has the 30-row detail: Must is
rows 1–8, 15–16, 29–30; Should is rows 9–11, 13–14, 17–18, 21, 23–24; Later is rows 12, 19–20, 22,
25–26, 28. Row 27 (remote/cloud execution) is not applicable by design (AGENTS.md §1; Decision 8).

## 2. Architectural spine

Ten architectural decisions bound every wave below. Each is a seam to extend, not a blank page; each
names what it forbids. Decisions are cited as "Decision N" per the accepted product decisions;
sections are cited as "S1"… as defined here and in ADR-0174.

### S1. Engine placement (Decision 1)

The Keiko-owned engine is `keiko-harness`, amended, hosted **in-process** by the existing
coding-runtime orchestrator as a second runtime adapter kind (`adapterKind: "keiko-engine"`) next to
the OpenCode bridge adapter. It needs no process containment because it executes nothing itself:
every effect goes through the same IPC action vocabulary → `codingToolAuthorityPort` → the governed
ports (`productionManagedWorktreeTools.ts`, `GovernedCodingToolPort`) → `keiko-tools`/`keiko-sandbox`.
The precedent already ships: the read-only child agent runs a real `keiko-harness` `createSession` in
production today (`productionReadOnlyChildRunner.ts`), and `ADR-0137` already documents the runtime
port as "adapter-shaped for multiple engines." S1 forbids a second child process, a second
orchestrator, and a second tool facade.

### S2. One tool registry, one ToolPort (Decision 1)

The `keiko_*` tool definitions are the single model-facing vocabulary for both engines: the bridge
engine via its custom-tool configuration, the Keiko engine via the harness `ToolPort`.
`GovernedCodingToolPort` is **the** ToolPort for both. The fixture-only `WorkspaceToolHost`
(`keiko-tools/src/registry.ts:106`) is retired, not revived — it already implements the harness's own
`ToolPort` shape and has exactly one call site, its own test, so keeping both would be a second,
unused implementation of the same capability (AGENTS.md §5). S2 forbids reviving it as a live
parallel tool host.

### S3. Policy lives where it lives (Decision 2, 5, 6, 7)

Command policy extends the Authority Envelope's existing `commandPolicy`
(`coding-workbench-runtime.ts:159-165`, hardcoded `deny` today in
`productionRuntimeWorkspaceAuthority.ts:113-119`) plus `commandAllowed()`
(`codingToolAuthorityPort.ts:387-397`) plus the `CommandRule` vocabulary in
`keiko-contracts/src/tools.ts` — extended per mode, not a new policy engine. Delivery policy extends
`gitDelivery/execution.ts`, the four existing execution gateways, and
`GitDeliveryApprovalRequirement` (`git-delivery.ts:235`, `{required:false}` already a legal value) —
not a new gateway. MCP authority extends the existing `connectorScopes` double gate
(`connectorAllowed()`). Sub-agent budgets extend the `EditorAgentAuthorityRegistry` parent/child
relation — not a new accounting store. S3 forbids each of these growing a sibling mechanism instead
of widening the one that already owns the decision.

### S4. Visibility principle (Decision 4)

The local human sees content-bearing tool calls — arguments, command lines, outputs, diffs — live,
over the authenticated app-session channel (ADR-0141), extending `coding-safe-activity.ts` and
`codingSafeActivityProjection.ts`; new content fields join `ENFORCED_CONTENT_ROUTE_PATTERNS` in
`contentRouteEnforcement.test.ts`. Persisted evidence (`CodingWorkbenchEvidenceRecord`), diagnostics,
the activity log (ADR-0173), and exports stay body-free. Two artifacts, two rules, never merged: S4
forbids a content body reaching persisted evidence, a diagnostic, or the content-free runtime SSE
union.

### S5. Model agnosticism = the gateway capability registry (Decision 3)

Both engines see `keiko-model-gateway` capabilities — chat, tool-calling, streaming, usage — never a
provider identity. The standard completions protocol is the first-class transport (already proven for
a hosted frontier-class model and for open-weight/local model servers exposing the same shape);
tool-call delta streaming is a gateway upgrade (the `StreamDelta.toolCallDelta` type already exists
with no adapter wired to it); native, non-proxy adapters are Wave 7.2 and land only if the reference
model set shows the proxy path insufficient. The reference model set itself — one hosted
frontier-class model behind an industry-standard chat-completions-compatible endpoint, one
open-weight coding model, one small local model for smoke — is deployment configuration, not code;
the capability registry ships empty by design (`capabilities.data.ts`). S5 forbids a second
provider-calling path outside `keiko-model-gateway` (ADR-0019 trust-1) and forbids hardcoding a
reference model set into product code.

### S6. MemoriaViva is the only memory (Decision 12)

Every memory, knowledge, transcript, or session-persistence need of the coding engine extends
MemoriaViva and the server's existing store patterns. The session content store is new tables in the
existing server SQLite via the `PRAGMA user_version` runner (`store/schema.ts`), sealed with the
vault's secretbox pattern (ADR-0035), composed in `keiko-server` — the only package the dependency
graph allows to combine a `keiko-memory-*` package with `keiko-model-gateway`/coding-runtime.
`coding_runtime_snapshots` stays content-free (issue #2256): a resume mechanism rehydrates authority
from the snapshot table and content from the new session table together, never by adding body columns
to the snapshot. Repository memory is MemoriaViva capture
(`extractCandidatesFromWorkflowOutcome` → `promoteEligibleMemoryRecord`, gated by ADR-0146, scope
`project`) with per-turn recall via `retrieveMemoryContext` into the `working-memory` context lane —
not a model-invoked recall tool, a shape ADR-0116 already built and retired in favor of ordinary
per-turn retrieval. S6 forbids a second memory, session, transcript, or knowledge store, and forbids
reintroducing a model-invoked recall tool without addressing why ADR-0116's version was retired.

### S7. Compaction composition respects the package graph (dependency-cruiser rule 4a)

`keiko-harness` may not import `keiko-workflows`. The 8-lane context allocator and compaction pipeline
are composed in `keiko-server` and handed to the harness through a new `ContextBudgetPort` in
`keiko-harness/src/ports.ts`, following the exact pattern already used for `ModelPort`, `ToolPort`,
and `HarnessShaperPort`. Compaction records persist through the existing `persistCompactionEvidence`
(ADR-0053/0172). The plan artifact **is** the `active-plan` lane — S7 forbids a second plan-storage
format parallel to the context-engineering lanes `keiko-workflows` already allocates budget for.

### S8. Bridge retirement rule (Decision 1)

OpenCode retires only when the engine-parity suite (`keiko-evaluations`: task corpus × reference model
set × both engines) is green on every Must row and every Should row the bridge itself satisfies, for
one release of coexistence. Until that bar holds, both engines ship, and the bridge stays the default.
S8 forbids flipping the default, or removing the bridge adapter, on a partial or aspirational read of
the suite.

### S9. Logging is part of every child (AGENTS.md §8)

Every child below names the `op` catalog values it adds, threads `correlationId` end to end, and
carries a test asserting the emitted lines, so that `keiko support analyze` reconstructs the journey
from the activity log alone — the same discipline PR #3255 made binding for all product runtime
behaviour. S9 forbids a child shipping without its own logging, and forbids a hand-written `op`
string outside the generated catalog.

### S10. No new worlds (AGENTS.md §5)

Every child names the existing seam it extends — file, port, or contract. A child that would
introduce a second implementation of an existing capability is invalid as written and must be
re-scoped before it starts. The reuse table below is this gate made concrete, and the same lens
applies to every wave's own "Reuse and No-Duplication" framing when the epic is authored.

### Reuse and no-duplication gate

| Capability                     | Single owner today (path)                                                                                                                                                               | Extension                                                                                                                         | Explicitly NOT built                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Loop control                   | `keiko-harness/src/loop.ts` (`runLoop`, 12-state machine)                                                                                                                               | Add an open-loop `code-task` type: `model-call ⇄ tool-call` under budgets (S1, Wave 3.1)                                          | A second engine process or a second orchestrator                                                                                             |
| Tool registry / ToolPort       | `keiko-tools/src/registry.ts` (`WorkspaceToolHost implements ToolPort`); coding-runtime's `GovernedCodingToolPort` (`productionManagedWorktreeTools.ts:238`)                            | `GovernedCodingToolPort` becomes the one `ToolPort` both engines use (S2, Wave 3.3)                                               | Reviving `WorkspaceToolHost` as a live parallel tool host                                                                                    |
| Command execution + policy     | Envelope `commandPolicy` (`coding-workbench-runtime.ts:159-165`) + `commandAllowed()` (`codingToolAuthorityPort.ts:387-397`) + `DEFAULT_COMMAND_RULES` (`keiko-contracts/src/tools.ts`) | Mode-derived `CommandRule` sets replace the hardcoded `deny` (S3, Wave 2.1–2.2)                                                   | A fourth parallel "safe command" pattern beside the `CommandRule`, closed-catalog, and human-terminal-allowlist lineages already in the repo |
| Content search                 | `searchText`/`findFiles` in `packages/keiko-workspace/src/repoSearch.ts` (governed pure-JS facade already used by `editor_search_workspace`)                                            | Expose a content query through `keiko_workspace_discover` (Wave 2.3)                                                              | A new indexer, a grep subprocess, or a second search tool                                                                                    |
| File edit/patch                | `keiko-workspace/src/discovery.ts`/`writer.ts`/`patch.ts`, `keiko_changeset_edit` (hash-bound)                                                                                          | None structural — stays the sole mutation path for both engines                                                                   | A second patch format or a git-apply-compatible parser                                                                                       |
| Verification feedback          | `keiko-verification/src/{plan,orchestrator}.ts` + `editor_request_verification` (the one path that already returns to a model)                                                          | Bounded, redacted excerpts into `keiko_verification`/`keiko_changeset_edit` via `HarnessShaperPort` (Wave 1.2)                    | Raw stdout/stderr or per-test names reaching the model                                                                                       |
| Plan artifact                  | — (`planner.ts:8-15` emits a fixed template string today)                                                                                                                               | `keiko_plan` = the `todowrite` schema exposed to the harness; content lives in the `active-plan` lane (S7, Wave 3.2)              | A second plan store parallel to the context-engineering lanes                                                                                |
| Compaction / context lanes     | `keiko-workflows/src/context-budget` (`allocator.ts`, `compaction.ts`, 8 lanes)                                                                                                         | Compose in `keiko-server`, hand to the harness through a new `ContextBudgetPort` (S7, Wave 3.5)                                   | A harness-side reimplementation of the allocator                                                                                             |
| Streaming                      | `Gateway.chatStream`/`GatewayStreamChunk` (content tokens only today)                                                                                                                   | Wire `toolCallDelta` end to end (Wave 3.4)                                                                                        | A second streaming transport per engine                                                                                                      |
| Usage accounting               | `UsageMetadata` in `coding-sidecar-gateway.ts`                                                                                                                                          | Wire the three dead counters (`toolCallCount`/`modelRequestCount`/`patchByteCount`) into a per-run meter (Wave 1.3)               | A currency-cost figure invented ahead of a pricing configuration                                                                             |
| Model selection                | `selectCodingSafeSidecarCapability` (`model-selection.ts:232-243`) over the gateway capability registry                                                                                 | `modelCapabilityId` replaces `runtimePreference`; per-run picker (Wave 1.4)                                                       | A provider-specific selector — capabilities stay deployment configuration                                                                    |
| Live visibility channel        | Authenticated app-session channel (`coding-app-session-channel-api.ts`, `codingSafeActivityProjection.ts`)                                                                              | Content-bearing tool cards join `ENFORCED_CONTENT_ROUTE_PATTERNS` (S4, Wave 1.1)                                                  | A second, unauthenticated content transport                                                                                                  |
| Persisted evidence / redaction | `CodingWorkbenchEvidenceRecord` (`coding-workbench-evidence.ts`) + `redact()` (`keiko-security`)                                                                                        | Same body-free contract extends to every new capability's evidence (S4)                                                           | A bespoke redaction routine per feature                                                                                                      |
| Session store                  | `chats`/`chat_messages` migration shape (`store/schema.ts:41-62`, ADR-0114) + vault secretbox technique (ADR-0035)                                                                      | New content-bearing Code-task session tables via the same `PRAGMA user_version` runner, composed in `keiko-server` (S6, Wave 5.1) | A bespoke encrypted store bolted onto coding-runtime                                                                                         |
| Repository memory              | MemoriaViva capture (`extractCandidatesFromWorkflowOutcome` → `promoteEligibleMemoryRecord`) + `retrieveMemoryContext`                                                                  | Capture at Code-task completion, scope `project`; recall into the `working-memory` lane (S6, Wave 5.3)                            | A model-invoked recall tool, or a second memory store                                                                                        |
| Sub-agent budgets              | `EditorAgentAuthorityRegistry` (`agentAuthorityRegistry.ts`)                                                                                                                            | Parent/child budget relationship for writing sub-agents (S3, Wave 6.1)                                                            | A new accounting store parallel to the registry                                                                                              |
| MCP / connector authority      | `CodingWorkbenchConnectorScope` double gate, `connectorAllowed()` (`codingToolAuthorityPort.ts:376-385`)                                                                                | Widen the scope union with a namespaced `mcp.<server-id>.*` family; MCP tools become `connector` IPC actions (Wave 6.2)           | A parallel tool-authority path for MCP; the native Atlassian connector (ADR-0128) is not replaced                                            |
| Git delivery                   | `gitDelivery/execution.ts` + the commit/publish/PR/merge gateways + `GitDeliveryApprovalRequirement`                                                                                    | Commit/push/draft-PR resolve `{required:false}` once per run in Full access; merge stays `{required:true}` (S3, Wave 4.1–4.2)     | A second delivery execution authority; the merge gateway (ADR-0087) is untouched                                                             |
| Editor docking                 | ADR-0125's `origin: "agent"\|"chat"` docking plane                                                                                                                                      | A third `origin: "workbench"` producer value on the same plane; bridge widens past `applyChangeset` (Wave 6.4)                    | A second apply-to-editor transport                                                                                                           |
| Logging                        | `ServerLogSink`/`ServerLogEvent` (`server-log.ts`) + generated op-catalog (AGENTS.md §8)                                                                                                | Every capability above emits its own `op` values on the same sink, correlation-id threaded                                        | A second log file, a private logger, or a free-string `op`                                                                                   |

## 3. Waves

Sizing follows the header's legend. Every child names the seam it extends (S10); every child's Gates line
starts from the AGENTS.md §3 minimum loop (`typecheck`, `lint`, `format:check`, `test`,
`arch:check`, `arch:check:negative`) plus `gates:sonar`, and adds only the touched-area gates that
apply. Logging `op` values are proposed placeholders — the generated catalog
(`docs/observability/op-catalog.generated.json`) is the source of truth once each child lands.

### Wave 0 — Record and re-baseline (docs only)

Wave 0 is not split into numbered children in the accepted skeleton; it ships as one docs-only
deliverable that unblocks every later wave.

**Goal.** Land the baseline document, this roadmap, and ADR-0174 (amending ADR-0004, 0006, 0018,
0054, 0055, 0090, 0124, 0129, 0137, 0163, with cross-reference notes added to 0138 and 0141); open the
new epic superseding #2473; close #435/#436–442/#460/#463/#466/#468/#854 as superseded; re-point
#464/#465/#467 with a comment; leave #451 and #480 open with a PROPOSED disposition awaiting owner
confirmation; retire the banner on `docs/coding-workbench-codex-subscription-profiles.md`; update
`docs/README.md` and
`docs/adr/README.md`.

**Extends.** `docs/adr/README.md`'s existing index-row format; `docs/README.md`'s "Coding Workbench"
section (the same section already listing `dev-lane.md`, `milestone-1-real-binary-validation.md`, and
`research-content-threat-model.md`).

**Journey.** vitest functional — `npm run check:adr-index` passes against the new ADR-0174 row and
the ten amended rows; a scripted check that every backlog item named above carries the stated
disposition comment.

**Negative pin.** No ADR is renumbered; the ten amended ADRs keep their existing numbers and gain
updated sections, never a superseding duplicate (AGENTS.md §12).

**Gates.** Minimum loop (docs changes do not touch TypeScript, but `format:check` and `arch:check`
still run clean) + `npm run check:adr-index` (ADR added/renumbered) + `gates:sonar`.

**Logging.** None — no product runtime behaviour changes in this wave.

**ADR impact.** Authors ADR-0174. Amends ADR-0004 §D8 (strikes the three-task-type closure and the
blanket ReAct rejection, adds the `code-task` type description that Wave 3.1 implements); ADR-0124
§D5 and ADR-0163 §D6 (retires `chatgpt-codex-subscription-profile` and `codex-cli-adapter` for
good; rewords "disabled for this release" to "retired"); ADR-0129 §D2a
(splits delivery-execute into commit/push/PR-create vs. merge, citing KEIKO-0227 by name so the
reversal's rationale is explicit); ADR-0137 §D2 (confirms the port is adapter-shaped, defers the
multi-run text to Wave 5); ADR-0090 §D1 (notes the singleton is lifted in Wave 5); ADR-0054/ADR-0055
(Status → Accepted, matching shipped code per AGENTS.md §1/§12); ADR-0006/ADR-0018 (cross-reference
note that `keiko_command` is new ground, not a rewrite of the human terminal).

**Exit criteria.** Gates green, PR merged, the new epic open with Wave 1 materialized as real child
issues (Delivery Constitution rule 3), a read-only Artifact published for the baseline and this
roadmap.

**Risks.**

- The ten-ADR amendment surface is wide; a slipped cross-reference (e.g., ADR-0138's matrix left
  unedited when it should stay unedited) reads as an inconsistency later — cross-check every "None"
  disposition in the ADR-conflict table against the actual amended text before merge.
- `docs/README.md` keeps its link to `coding-workbench-codex-subscription-profiles.md` while that
  page carries the retirement banner; the link and the page are removed together in Wave 1.6 — a
  removal in Wave 0 would leave shipped code without its only page.

### Wave 1 — See and steer (bridge engine)

**1.1 Full tool cards (M).**
Goal: content-bearing tool entries — arguments, command line, output excerpt, diff — in the live
Workbench stream. Extends: `coding-safe-activity.ts`/`codingSafeActivityProjection.ts` →
`ToolRow` in `CodingWorkbenchTimeline.tsx` (S4). Journey: vitest functional —
`contentRouteEnforcement.test.ts`'s unauthenticated sweep extended to the new content fields, plus a
`ToolRow` rendering test — and a Playwright smoke pass confirming a live tool card shows arguments
and output in the Workbench window. Negative pin: `CodingWorkbenchEvidenceRecord` and every export
stay body-free — the new content lives only in the paired live stream. Gates: minimum loop +
`typecheck`/`lint --workspace @oscharko-dev/keiko-ui` + `test:coverage:ui` + `gates:sonar`. Logging:
`coding.activity.tool_detail.emitted` (proposed). ADR impact: none — ADR-0137 §D4 and ADR-0141
already ratify this exact design (G.1); no amendment required.

**1.2 Diagnostics back to the model (M).**
Goal: `keiko_verification` and `keiko_changeset_edit` return bounded, redacted diagnostic excerpts so
"repair until verification passes" is possible. Extends: `keiko-workflows/src/observations` shapers
(`shapeTestObservation`, `shapeCommandObservation`) via `HarnessShaperPort`. Journey: vitest
functional — a verification failure produces a shaped excerpt under the byte cap, secrets redacted,
fed back as a `role:"tool"` observation. Negative pin: excerpt ≤ cap; secrets never included.
Gates: minimum loop + `check:error-observability` (server diagnostics) + `gates:sonar`. Logging:
`coding.verification.diagnostic.shaped` (proposed). ADR impact: none.

**1.3 Usage meter (M).**
Goal: per-run prompt/completion tokens, request counts, and context-fill % against the capability's
context window. Extends: `UsageMetadata` in `coding-sidecar-gateway.ts`; wires the three dead counters
(`toolCallCount`/`modelRequestCount`/`patchByteCount`). Journey: vitest functional — the meter matches
gateway `UsageMetadata` for a captured run — plus Playwright smoke that the meter renders. Negative
pin: no currency-cost figure until a pricing configuration exists (Decision 3, "keep it simple").
Gates: minimum loop + `typecheck`/`lint --workspace @oscharko-dev/keiko-ui` + `test:coverage:ui` +
`gates:sonar`. Logging: `coding.runtime.usage.recorded` (proposed). ADR impact: none.

**1.4 Model picker per run (M).**
Goal: the start request carries `modelCapabilityId` (replaces `runtimePreference`); the list is every
capability passing `selectCodingSafeSidecarCapability`'s predicate; `reasoningEffort` passes through
where declared. Extends: `model-selection.ts:232-243` (S5). Journey: vitest functional — the
coding-preferred use-case tag re-examined against a local/open-weight capability fixture — plus
Playwright smoke that picking a capability flows into the start mutation. Negative pin: the retired
subscription lane (Decision 3) never reappears in the list. Gates: minimum loop +
`typecheck`/`lint --workspace @oscharko-dev/keiko-ui` + `gates:sonar`. Logging:
`coding.model.capability.selected` (proposed). ADR impact: none.

**1.5 Project instructions (S).**
Goal: load the target repository's `AGENTS.md`/`CLAUDE.md` chain into the governed system prompt.
Extends: `readWorkspaceFile` and `REPOSITORY_OVERVIEW_FILENAMES`, bounded. Journey: vitest functional
— a fixture repository's chain is loaded, bounded by size, and appears in the assembled system
prompt. Negative pin: `OPENCODE_DISABLE_PROJECT_CONFIG` stays `true` — Keiko, not the bridge engine,
owns loading. Gates: minimum loop + `gates:sonar`. Logging: `coding.instructions.chain.loaded`
(proposed). ADR impact: none.

**1.6 Retire the subscription-profile lane and dead scaffolding (L; contracts-focused PR).**
Goal: delete the whole-file and partial-edit surface named in the baseline's dead-path inventory
(~7,100 LOC + 544 KB vendored JSON), the `delivery-runner` literal, and the unmounted
`autonomousDeliveryRoutes.ts`/`ApprovalStore` (keeping `autonomousDeliveryPolicy.ts`'s denial
vocabulary for Wave 4); drop `PRODUCTION_RUNTIME_QUALIFICATIONS`'s dead export; rewrite the QA matrix.
Extends: nothing — this is subtraction against the seams Wave 4 and Wave 3 will reuse (the
autonomous-delivery policy's denial-reason vocabulary; `WorkspaceToolHost`'s harness `ToolPort`
shape). Journey: vitest functional — the removed routes 404, the enum literals no longer typecheck if
referenced — run last against `npm run check:package-surface:assembled` per the
`node_modules`-pruning trap (AGENTS.md §9). Negative pin: the subscription-profile lane cannot be
re-enabled by any request shape; `runtimePreference: "codex-subscription"` is gone from the closed
enum, not merely unreachable. Gates: minimum loop + `check:package-surface:assembled` (run **last**,
after `npm test`) + `check:version-consistency`/`check:release-impact` (public-surface change) +
`gates:sonar`. Logging: none new — this child removes code paths, it does not add behaviour.
ADR impact: implements the ADR-0124 §D5 / ADR-0163 §D6 text Wave 0 already amended.

**Exit journey (Wave 1).** On a Keiko checkout, start a task with a user-chosen model capability;
every tool call is readable live with arguments and output; the usage meter matches gateway
accounting; the run's evidence export and activity log contain no bodies (pinned by the content-route
sweep); the agent quotes the repository's own `AGENTS.md` rules in its plan. Proven through
production composition (a real run against the bridge engine) and production discovery (the
sweep test runs against live routes, not an injected content-bearing seam) — no injected seam ships
as a production fallback.

**Risks.**

- The i18n catalog (`coding-workbench-i18n.en.ts`/`.de.ts`) must gain matching keys for the model
  picker and usage meter in both locales in the same change (C.8) — a partial catalog fails review,
  not just polish.
- `packages/keiko-ui/eslint-suppressions.json` lists twelve Coding Workbench entries under a
  shrink-only discipline; touching those files in 1.1/1.3/1.4 must not add a new suppressed
  violation.
- 1.6's blast radius crosses `keiko-contracts`' public surface (enum literals, a re-exported auth
  module); running `check:package-surface:assembled` before `npm test` instead of after triggers the
  documented `@napi-rs/canvas` false regression (AGENTS.md §9) — order matters.

### Wave 2 — Hands (bridge engine)

**2.1 `keiko_command` (L).**
Goal: a sandboxed, policy-governed, model-callable shell tool. Extends: the envelope's
`commandPolicy` shape (already declared, hardcoded `deny` today), the IPC action `command`,
execution through `keiko-tools/src/exec.ts` (`shell:false`, env allowlist, cwd = workspace) under
`keiko-sandbox` `planIsolatedRun` (default `network:"none"`, attested; fail-closed when
unenforceable) (S1–S3). Journey: nightly real-binary lane — `keiko_command` executes a real, sandboxed
command against a live checkout and returns an attested `SandboxAttestation`; vitest functional for
the policy/schema surface. Negative pin: `command` still passes the workspace-contained risk cell
before `commandAllowed()` is consulted — a widened `commandPolicy` never bypasses that cell; output
streams into Wave-1's tool cards, never bypassing S4's redaction discipline for persisted evidence.
Gates: minimum loop + `gates:sonar`. Logging: `coding.command.executed`, `coding.command.denied`
(proposed), both carrying the sandbox attestation's enforcement flags. ADR impact: none — the new
action-kind entry fits ADR-0138's existing resource-scope/risk matrix without a matrix change (G.1).

**2.2 Per-mode command policy (M).**
Goal: `commandPolicy` derived from `effectiveMode` instead of hardcoded `deny`. Extends:
`productionRuntimeWorkspaceAuthority.ts`; `CommandRule` sets in `keiko-contracts/src/tools.ts` — Ask
for approval = `governed` + `requirePerCommandApproval`; Supervised workspace = `allowlisted` seeded
from `DEFAULT_SUPERVISED_VERIFICATION_COMMANDS` + `DEFAULT_COMMAND_RULES` + format/build; Full access
= `governed`, broader, still deny-listed. Journey: vitest functional — one fixture per mode asserting
the derived policy shape and that a denied command fails closed with evidence. Negative pin: hard
denials and the workspace-contained risk cell stay in front in every mode; no remote `git`/`gh` in
Full access (delivery is Wave 4); no network by default; the human terminal allowlist (ADR-0018) is
untouched. Gates: minimum loop + `gates:sonar`. Logging: `coding.command.policy.resolved`
(proposed). ADR impact: none.

**2.3 Content search (S).**
Goal: a content query on `keiko_workspace_discover`, not a new tool. Extends: `searchText` and
`findFiles` in `packages/keiko-workspace/src/repoSearch.ts` — the governed, pure-JS repository-search
facade (no subprocess, no ripgrep, by design) that `editor_search_workspace` and
`/api/editor/repo-search` already use, with deny policy, realpath gate, redaction and regex safety
built in; today `keiko_workspace_discover` wraps only `discoverWithStats` (paths, no content).
Journey: vitest functional — a search over a fixture workspace never returns a denied-path match. Negative pin: sensitive-path deny
patterns (`.env`, `*.pem`, `id_rsa`, …) still apply to search results exactly as to reads. Gates:
minimum loop + `gates:sonar`. Logging: `coding.workspace.search.performed` (proposed). ADR impact:
none.

**2.4 Plan gate (M).**
Goal: in Ask for approval, the run enters `awaiting-approval` after the first `todowrite` and before
the first mutating tool call; the human approves or replies with changes. Supervised/Full show the
plan without a gate; a per-run "plan first" toggle can request the gate anyway. Extends: the existing
`pendingPermission` mechanism with a `plan` kind, plus the follow-up channel. Journey: Playwright
smoke — in Ask mode, the first mutating call is blocked until the plan is approved; a reply with
changes re-plans before the gate reopens. Negative pin: Supervised/Full are never blocked by this gate
unless the toggle is explicitly set — the plan gate is additive, not a new default friction point.
Gates: minimum loop + `typecheck`/`lint --workspace @oscharko-dev/keiko-ui` + `gates:sonar`. Logging:
`coding.plan.gate.entered`, `coding.plan.gate.resolved` (proposed). ADR impact: none.

**Exit journey (Wave 2).** "Fix a failing unit test in Keiko": Supervised workspace runs
vitest/typecheck without prompts and iterates on the real failure output; Ask for approval prompts
for the plan and for each command; a denied command fails closed with evidence; `keiko support
analyze` reconstructs the run from the log alone. Proven through production composition and
production discovery — the nightly real-binary lane exercises the live sandbox backend, not a
fixture-only stand-in.

**Risks.**

- `keiko_command`'s sandbox coverage is platform-uneven (B.3): macOS has no native
  `filesystem:"execution-root"` backend, Windows has no native network-isolation backend at all —
  2.1's fail-closed behavior on those platforms must be exercised, not assumed, before the exit
  journey is called proven.
- A `CommandRule` set that is too permissive in Full access re-opens the "allowed-on-paper,
  denied-by-construction" gap D.2 just closed for verification — every new allow entry needs its own
  test, not a broadened wildcard.
- The plan gate's `pendingPermission` reuse must not silently widen what counts as an approval —
  2.4's fixture set should include a rejected-plan path, not only the happy path.

### Wave 3 — Own engine, bridged

**3.1 Harness amendments (L).**
Goal: tool failures become `role:"tool"` observations instead of ending the run; a new open-loop
`code-task` type (`model-call ⇄ tool-call` under the envelope's budgets); `allowsVerification` wired
so it gates like its siblings; `MalformedToolCallError` becomes a correctable observation with a
bounded retry. Extends: `executor.ts:463-477` (tool-error handling), `tasks/policy.ts` (S1). Journey:
vitest functional — a tool failure re-enters `model-call` with a `role:"tool"` error message instead
of terminating; `allowsVerification` gates a call the way `allowsTools`/`allowsPatch` already do.
Negative pin: `maxFailureAttempts` and the harness's other budget caps still apply — self-healing is
bounded, not unlimited retry. Gates: minimum loop + `gates:sonar`. Logging: `coding.tool.error.fed_back`
(proposed). ADR impact: delivers the `code-task` type ADR-0004 §D8 was amended to describe in Wave 0.

**3.2 Plan artifact (S).**
Goal: `keiko_plan` exposes the `todowrite` schema to the harness; same safe-activity projection;
content lives in the `active-plan` lane. Extends: S7's lane vocabulary. Journey: vitest functional —
a plan round-trips through `keiko_plan` into the `active-plan` lane and back out unchanged. Negative
pin: no second plan-storage format — the lane is the only plan store (S7). Gates: minimum loop +
`gates:sonar`. Logging: `coding.plan.updated` (proposed). ADR impact: none.

**3.3 `keiko-engine` adapter (XL).**
Goal: an in-process adapter kind in coding-runtime implementing the same runtime port as the bridge
adapter; `GovernedCodingToolPort` as `ToolPort`; `GatewayModelPort` as `ModelPort`; selectable per run
next to the Wave-1 model picker; the bridge stays default; `WorkspaceToolHost` is retired for real
(S1, S2). Journey: nightly real-binary lane — the Wave-2 exit journey runs end to end against the
Keiko engine, against a live model endpoint; vitest functional for the adapter's runtime-port
conformance. Negative pin: exactly one `ToolPort` implementation is reachable in production at a
time per run — never both `WorkspaceToolHost` and `GovernedCodingToolPort` live. Gates: minimum loop

- `check:package-surface:assembled` (new adapter kind may touch exported types; run last) +
  `gates:sonar`. Logging: `coding.engine.adapter.selected` (proposed). ADR impact: delivers the S1
  adapter-kind confirmation ADR-0137 §D2 recorded at Wave 0.

**3.4 Tool-call delta streaming (M).**
Goal: `openai-adapter.ts` emits `toolCallDelta`; `GatewayStreamChunk` widens to carry it; the harness
uses `callStream`; the sidecar gateway passes deltas through for the bridge engine too. Extends: the
existing `StreamDelta.toolCallDelta` type slot (already declared, unwired) (S5). Journey: vitest
functional — deltas assemble into the same tool call the non-streaming path would produce — plus a
nightly real-binary lane pass against a live streaming endpoint. Negative pin: the sidecar's
SHA-256 nine-tool schema digest pin (A.1) still gates every forwarded call even as streaming widens —
a mismatched tool surface is still refused. Gates: minimum loop + `gates:sonar`. Logging:
`coding.model.stream.tool_call_delta` (proposed). ADR impact: none.

**3.5 Compaction (L).**
Goal: a `ContextBudgetPort` in `keiko-harness/src/ports.ts`; `keiko-server` composes
`allocateContext`/`buildCompactionRecords` over the 8 lanes and hands them to the harness; overflow is
no longer terminal; records persist via `persistCompactionEvidence` (S7). Journey: vitest functional
— `npm run check:context-quality`'s measured corpus extended to cover the harness's compaction path,
holding the same nine hard invariants and three soft floors the chat path already meets. Negative
pin: `keiko-harness` still has zero import edges to `keiko-workflows` — the port, not a direct import,
is the only bridge (dependency-cruiser rule 4a). Gates: minimum loop + `check:context-quality` +
`gates:sonar`. Logging: `coding.context.compacted` (proposed). ADR impact: none.

**3.6 Engine-parity suite (L).**
Goal: a `keiko-evaluations` corpus of Code tasks × reference model set × both engines, run as a
scheduled lane, not PR-blocking, reporting per parity-row pass/fail. Extends: the baseline's
capability parity table as the row vocabulary (S8). Journey: nightly real-binary lane — the suite
itself, scheduled. Negative pin: the suite's report is advisory until S8's bar is met — a green run
on a subset of rows never flips the default (that is Wave 7.1's gate, not this child's). Gates:
minimum loop + `check:e2e-suite-wiring` (a new `test:e2e:*`/scheduled-lane script) + `gates:sonar`.
Logging: `coding.evaluation.parity_run.completed` (proposed). ADR impact: none.

**Exit journey (Wave 3).** The Wave-2 acceptance journey passes on the Keiko engine with the same
tools and policy as the bridge engine; the parity suite reports both engines against the same corpus;
the bridge remains default (S8 not yet satisfied). Proven through production composition (a real run
on the new adapter) and production discovery (the parity suite runs against live model endpoints, not
an injected fixture engine).

**Risks.**

- 3.1's tool-error feedback changes a terminal failure mode into a retryable one — a regression test
  must confirm the harness still fails closed once `maxFailureAttempts` is exhausted, not loop
  indefinitely.
- 3.3 is the largest single child in the roadmap (XL); splitting it mid-flight is explicitly against
  the Delivery Constitution (§4) — if planning shows it exceeding six agent-days including gates, it
  must be re-scoped into smaller children before work starts, not split once underway.
- 3.5's `ContextBudgetPort` composition in `keiko-server` must not become the second place lane
  allocation happens — the chat path's existing composition in `chat-prompt-budget.ts` is the pattern
  to mirror, not a parallel one to invent.

### Wave 4 — Deliver

**4.1 Delivery tools (L).**
Goal: `keiko_git_commit`, `keiko_git_push`, `keiko_pull_request` as IPC `delivery` actions routed
through `gitDelivery/execution.ts` to the commit-intent, publish, and PR gateways; signed commits
through the identity environment lane; protected-branch, no-force, no-merge pins; the merge gateway
(ADR-0087) untouched. Extends: S3's delivery-policy seam; the denial-reason vocabulary from
`autonomousDeliveryPolicy.ts` Wave 1.6 kept for this exact purpose. Journey: nightly real-binary lane
— a signed commit, push, and draft PR against a real sandboxed git remote; vitest functional for the
gateway pins. Negative pin: protected-branch, no-force, and no-merge stay denied regardless of mode
(given); the merge gateway (ADR-0087) is not touched by this child. Gates: minimum loop + `gates:sonar`.
Logging: `coding.delivery.commit.executed`, `coding.delivery.push.executed`,
`coding.delivery.pr.opened` (proposed). ADR impact: implements the ADR-0129 §D2a split Wave 0
authored.

**4.2 Mode semantics (M).**
Goal: Full access is unattended once the run's delivery confirmation is minted at start — the
`delivery` cell is satisfied once per run, never per merge; Supervised workspace asks before
push/PR; Ask for approval asks before commit. Extends: `GitDeliveryApprovalRequirement`'s existing
`{required:false}` legal value (S3). Journey: vitest functional — a matrix fixture over the three
modes asserting exactly the stated ask/no-ask boundary for commit, push, and PR. Negative pin: merge
stays `{required:true}` unconditionally in every mode — this child does not touch that cell. Gates:
minimum loop + `gates:sonar`. Logging: `coding.delivery.confirmation.minted` (proposed). ADR impact:
none — the ADR-0129 §D2a text is already amended at Wave 0; this child implements it.

**4.3 Delivery evidence and log ops (S).**
Goal: the PR body is built from a body-free run summary; the full set of `op` entries lands in the
generated catalog. Extends: the S4 body-free evidence pattern. Journey: vitest functional — a PR body
built from a fixture run contains no raw command output, diffs, or file contents, only counts and
labels. Negative pin: same as S4 — no content body in the PR description beyond what
`CodingWorkbenchEvidenceRecord` already permits. Gates: minimum loop + `gates:sonar`. Logging: the
full `coding.delivery.*` op family generated and checked (`check:op-catalog`). ADR impact: none.

**Exit journey (Wave 4, dogfooding).** Keiko works a Keiko issue end to end — branch, edits, local
gates, signed commit, push, draft PR — in Full access without per-action approval; push to `dev` and
force push stay denied (pinned); Supervised workspace asks before push. This is Decision 11's
acceptance test, executed for real. Proven through production composition (the actual delivery
gateways, not a stub) and production discovery (a real signed commit against a real remote) — no
injected git seam ships as a production fallback.

**Risks.**

- 4.1's identity/signing lane depends on the per-worktree signing configuration already being present
  (a known trap: a fresh checkout commits unsigned with no obviously-named failure field) — the
  journey fixture must set this up explicitly, not assume it.
- 4.2's "once per run" semantics must not be interpreted as "once ever" — a new run always re-mints
  its own delivery confirmation; a stale confirmation from a prior run must fail closed, not carry
  forward.
- The dogfooding exit journey is the highest-stakes journey in the roadmap; a false green here (an
  injected git remote standing in for a real one) would violate the anti-false-green rule (§4) more
  seriously than anywhere else in the plan.

### Wave 5 — Persist, remember, parallelize

**5.1 Durable session store (L).**
Goal: content-bearing Code-task session tables (turns, plan, tool log) in the existing server SQLite,
sealed with the vault secretbox pattern, composed in `keiko-server`; `coding_runtime_snapshots` stays
unchanged. Extends: S6's session-store seam. Journey: vitest functional — a sealed session round-trips
through the migration runner and the cipher; a fixture confirms `coding_runtime_snapshots` gained no
new content column. Negative pin: `coding_runtime_snapshots` stays content-free — the new table owns
content, the snapshot table owns lifecycle/authority only (issue #2256). Gates: minimum loop +
`gates:sonar`. Logging: `coding.session.persisted` (proposed). ADR impact: none.

**5.2 Resume + history (M).**
Goal: resume after a BFF restart composes the authority ledger and the new session store; a session
list/history rail; the two-column Workbench layout (list left, session right — Decision 9). Extends:
5.1's table plus the existing snapshot-store restart path. Journey: Playwright smoke — a BFF restart
mid-run, followed by a resumed session showing the same plan and tool log — plus vitest functional for
the composition logic. Negative pin: window pairing still fails closed to `"unknown"` on any read
failure (ADR-0141) — resume never bypasses re-pairing. Gates: minimum loop +
`typecheck`/`lint --workspace @oscharko-dev/keiko-ui` + `test:coverage:ui` + `gates:sonar`. Logging:
`coding.session.resumed` (proposed). ADR impact: delivers the ADR-0137 §D2 multi-run text staged at
Wave 0.

**5.3 Repository memory (M).**
Goal: capture at run completion via MemoriaViva (`workflow-outcome` source, scope `project`, ADR-0146
gate); per-turn recall via `retrieveMemoryContext` into the `working-memory` lane of the engine's
context. Extends: S6. Journey: vitest functional — a convention captured at the end of one run is
recalled, gated by mode, in a later run against the same project scope. Negative pin: capture is
gated exactly like chat capture (ADR-0146 D2–D4) — no bypass for the coding engine; no new
`MemorySourceKind` beyond reusing `workflow-outcome`. Gates: minimum loop + `gates:sonar`. Logging:
`coding.memory.captured`, `coding.memory.recalled` (proposed). ADR impact: none — no new ADR
conflict; MemoriaViva's existing scope/gate machinery is reused unchanged.

**5.4 Parallel runs (L).**
Goal: authority keyed by task-workspace/worktree instead of one process-wide singleton; an
active-pointer set instead of a singleton pointer; the same provisioning/health/lock machinery reused;
an explicit concurrency ceiling. Extends: `EditorAgentAuthorityRegistry`'s existing per-worktree
binding pattern; `workspaceLifecycle.getActive()` widened to accept a worktree identifier. Journey:
nightly real-binary lane — two tasks in two worktrees run concurrently, each independently pausable
and resumable; vitest functional for the active-pointer-set invariant. Negative pin: the same
repository still cannot tear its own singleton pointer per worktree (`lifecycle.ts:263`'s invariant
holds per pointer) — parallelism is modeled as multiple bound worktrees inside the one registry, never
a second registry. Gates: minimum loop + `gates:sonar`. Logging: `coding.run.parallel.started`
(proposed). ADR impact: delivers the ADR-0090 §D1 amendment staged at Wave 0 (singleton pointer →
active-pointer set).

**Exit journey (Wave 5).** Two tasks in two worktrees; a BFF restart; both resume; the history list
shows both; a convention learned in run 1 is recalled in run 2 under the mode gate. Proven through
production composition and production discovery — a real restart, not a simulated one; a real second
worktree, not a mocked authority key.

**Risks.**

- 5.1 is the single highest duplicate-subsystem risk in the roadmap (H.7): built without reference to
  `chats`/`chat_messages` and the vault's sealed-column technique, it becomes a second chat-session
  system by accident. The migration and cipher choice must cite ADR-0114/ADR-0035 directly in review.
- 5.4's concurrency ceiling needs an explicit number before this child starts — an unbounded lift of
  the "exactly one run" constraint is a scope change beyond what ADR-0137 §D2's amendment authorizes.
- 5.2's history rail is new UI surface inside a shrink-only eslint-suppressions register (C.8) — new
  files here must not add a fresh suppressed violation.

### Wave 6 — Delegate and extend

**6.1 Writing sub-agents (L).**
Goal: extend `productionReadOnlyChildRunner`/`readOnlyChildOrchestrator` with write authority,
worktree scoping, budget inheritance via `EditorAgentAuthorityRegistry`, and a depth cap; results stay
in-run unless they independently clear the ordinary MemoriaViva capture gate. Extends: S3's
parent/child budget relation. Journey: vitest functional — a writing sub-agent's edits stay inside its
scoped worktree and its budget is deducted from the parent's; nightly real-binary lane for an
end-to-end delegated edit. Negative pin: no unbounded recursive sub-agents — the depth cap holds; a
sub-agent's result is not captured to memory unless it independently passes the same mode-aware gate
a top-level turn would. Gates: minimum loop + `gates:sonar`. Logging: `coding.subagent.write.executed`
(proposed). ADR impact: none.

**6.2 MCP client (XL).**
Goal: one package owns the MCP SDK (isolation rule mirroring the model-SDK rule); server trust
registration; tools exposed through the same registry as namespaced `keiko_mcp_*` entries; authority
via `connectorScopes` + `connectorAllowed()`; body-free outcomes via the `AuxiliaryCapabilityPortV1`
shape. MCP is for servers Keiko has no native connector for — the native Atlassian connector
(ADR-0128) is unaffected; the first server is confirmed by the owner (§6c). Extends: S3's connector
double gate. Journey: vitest functional — the double gate (`connectorScopes` AND
`networkPolicy.connectorScopes`) is exercised over a fixture MCP tool call; nightly real-binary lane
against the confirmed first server once named. Negative pin: a connector scope alone can never open
network egress — both gates must hold. Gates: minimum loop + `check:package-surface:assembled` (new
package/public surface; run last) + `gates:sonar`. Logging: `coding.mcp.tool.invoked`,
`coding.mcp.server.registered` (proposed). ADR impact: new ground — no existing ADR conflict, but the
MCP client's package home and its ADR-0138 action-class mapping need their own ADR-0174 sub-decision
before this wave starts (G.1).

**6.3 Skills and slash commands (M).**
Goal: extend `skillCatalog.ts` (categories, handlers, registration) — no second catalog; composer
slash commands map to skills and run controls. Extends: `skillCatalog.ts`'s closed-category,
fail-closed registry. Journey: Playwright smoke — a slash command in the composer resolves to a
registered skill or run control and executes it. Negative pin: no sibling registry — every new skill
is an entry in the same catalog, gated the same fail-closed way the seeded `public-research`/
`documentation-lookup` categories already are. Gates: minimum loop +
`typecheck`/`lint --workspace @oscharko-dev/keiko-ui` + `gates:sonar`. Logging:
`coding.skill.invoked`, `coding.slash_command.resolved` (proposed). ADR impact: none.

**6.4 Absorb the editor-agent producer flow (M).**
Goal: a Workbench `origin: "workbench"` producer on the ADR-0125 docking plane; the bridge widens
beyond `applyChangeset` (open file, reveal diff, diagnostics); `EditorAgentActionsPanel` becomes the
content-free audit index of the Workbench. Extends: ADR-0125 §D2's existing multi-producer docking
mechanism. Journey: Playwright smoke — a Workbench-driven edit opens the file in the editor, reveals
the diff, and surfaces diagnostics, with `EditorAgentActionsPanel` showing the same action
content-free. Negative pin: `EditorAgentActionsPanel` stays content-free — it does not become a
second content-bearing surface duplicating the Workbench's own live stream (S4). Gates: minimum loop

- `typecheck`/`lint --workspace @oscharko-dev/keiko-ui` + `test:coverage:ui` +
  `check:editor-release-evidence` (editor surface touched) + `gates:sonar`. Logging:
  `coding.editor.bridge.widened` (proposed). ADR impact: none — reuses ADR-0125 §D2 unamended, per
  G.1.

**Exit journey (Wave 6).** Investigate via an MCP read tool and a writing sub-agent; implement;
deliver — with the editor showing the diff and diagnostics throughout. Proven through production
composition (a real MCP call, a real sub-agent write) and production discovery (the editor bridge
renders a real diagnostics payload, not an injected one).

**Risks.**

- 6.2 is the second-largest child in the roadmap (XL) and touches a genuinely new package boundary —
  the package-home decision (§6c) blocks starting the work, not just naming the first server.
- 6.1's budget-inheritance math must be reviewed against `EditorAgentAuthorityRegistry`'s existing
  parent/child fields before this child starts, or the depth cap and budget deduction risk drifting
  from the registry's actual semantics.
- 6.4 sits inside the same shrink-only eslint-suppressions register and the SHA-pinned
  `globals.css` gate (AGENTS.md §9) as every other Workbench UI child — component-scoped classes only,
  never a `globals.css` edit.

### Wave 7 — Retire the bridge; breadth

Per the Delivery Constitution's just-in-time materialization rule (§4), Wave 7's children are
one-line placeholders until Wave 6 is substantially merged; sizes below are therefore indicative, to
be confirmed at materialization rather than fixed now.

**7.1 Default flips to the Keiko engine (indicative L).**
Goal: once S8 holds, the default engine flips; the bridge adapter is removed after one release of
coexistence; ADR-0163 §D6 is amended a second time, from "not supported" to "at least one approved
runtime source." Extends: S8's exit bar; the ADR-0163 §D6 wording Wave 0 pre-staged. Journey: nightly
real-binary lane — a full regression pass with the Keiko engine as default and the bridge adapter
absent. Negative pin: the flip happens only when S8's bar is met for one full release of coexistence —
never on a partial suite result. Gates: minimum loop + `check:package-surface:assembled` (adapter
removal changes exports; run last) + `gates:sonar`. Logging: `coding.engine.default.flipped`
(proposed). ADR impact: delivers the ADR-0163 §D6 wording staged at Wave 0.

**7.2 Native provider adapters (indicative XL; conditional).**
Goal: additional first-party model-API adapters beyond the standard completions protocol shape in
`keiko-model-gateway` — built only if the parity suite (Wave 3.6) shows the proxy path insufficient
for a reference model. Extends: `keiko-model-gateway`'s `ProviderAdapter` interface (S5). Journey:
nightly real-binary lane against the reference model that motivated the adapter. Negative pin: the
standard completions protocol path stays the default even after a native adapter ships;
`keiko-model-gateway` stays the only package holding provider-SDK code (ADR-0019 trust-1). Gates:
minimum loop + `gates:sonar`. Logging: `coding.model.native_adapter.invoked` (proposed). ADR impact:
none anticipated; a new adapter is additive to S5, not a change to it.

**7.3 Later-tier breadth (indicative XL; scoped at materialization).**
Goal: hooks (pre/post tool, pre-commit), notifications, background tasks, image input, a Linux
evaluation-lane build; later still, browser automation, computer use, voice. Extends: to be named per
item at materialization — each is its own small vertical child once cut, per the Delivery
Constitution. Journey: to be named per item. Negative pin: Linux stays evaluation-lane only, never
release-qualified, until Decision 8's assumption changes (§6d); remote/cloud execution stays out of
scope by product design (AGENTS.md §1). Gates: minimum loop + `gates:sonar` per child, plus whatever
touched-area gate each item's own surface requires. Logging: per item, named when cut. ADR impact:
none anticipated at this altitude; individual items may need their own narrow amendment when scoped.

**Exit criteria (Wave 7).** 7.1's regression pass is green with the bridge removed; 7.2 ships only if
triggered by 3.6's suite; 7.3's items are cut and closed individually as their own small vertical
children. Proven through production composition and production discovery at the granularity each
item is materialized — no wave-wide "later" placeholder is ever treated as done.

**Risks.**

- Removing the bridge adapter (7.1) is the single highest-consequence removal in the roadmap — it
  eliminates the fallback engine that every prior wave's exit journey validated against; the
  regression pass must cover every Must and satisfied-Should row, not a sampled subset.
- 7.2 risks becoming speculative work if started before the parity suite actually names a
  insufficiency — the conditional gate ("only if the reference set proves the proxy path
  insufficient") must be treated as a hard precondition, not a target.
- 7.3's breadth items are the most likely place for scope creep given the roadmap's own "no calendar
  dates" posture — each item still needs its own one executable acceptance journey before it is
  materialized, per the Delivery Constitution.

## 4. Cross-cutting rules

These rules bind every wave and every child; the Delivery Constitution below is mirrored from the
accepted backlog reconciliation (G.3) and is unchanged, not reinterpreted, for this roadmap.

**Delivery Constitution.**

1. Small vertical children — each ships in roughly three agent-days including gates (≈ size M);
   split before starting if planning shows a child growing past that, never split mid-flight.
2. One executable acceptance journey per child — every child names one Playwright or functional test
   that fails before and passes after its change, and owns extending that same journey; a child's
   proof never lives in a later child.
3. Just-in-time wave materialization — only the current wave exists as real issues; later waves are
   one-line placeholders, cut just-in-time against the then-current `dev` when the prior wave is
   substantially merged (Wave 7 above is written at exactly this altitude).
4. Anti-false-green rule — every user-facing capability claim is proven at least once through
   production composition **and** production discovery (no injected runtime seam) before its wave
   closes; injected seams stay test-only and must never be a production fallback. Every wave's Exit
   criteria above restates this explicitly.
5. Goal over route — child issue text is a route description, not a contract; a deviating
   implementer documents the deviation in the PR and updates the issue rather than silently complying
   or silently skipping.

**Logging is part of every child (S9, AGENTS.md §8).** Every child above names its proposed `op`
values; at implementation, each is added at the call site, `npm run generate:op-catalog` regenerates
`op-catalog.generated.json`, and `npm run check:op-catalog` gates drift. Every op-emitting change
carries a test asserting the emitted lines and threads `correlationId` so `keiko support analyze`
reconstructs the operation from the log alone. No `console.*`, no private logger, no free-string `op`.

**No-new-worlds gate (S10, AGENTS.md §5).** Every child names the seam it extends; a child that would
introduce a second implementation of an existing capability is invalid as written. The reuse table in
§2 is this gate's concrete form; the epic, once authored, carries its own "Reuse and No-Duplication
Gate" section listing the same seams by path so children extend rather than rebuild.

**Body-free evidence vs. content-bearing live stream (S4).** Two artifacts, two rules, never merged:
the local human's live stream is content-bearing over the authenticated app-session channel; every
persisted evidence record, diagnostic, and export stays body-free. A child that adds a new
content-bearing surface joins `ENFORCED_CONTENT_ROUTE_PATTERNS`; a child that adds a new evidence
field reuses the existing redaction pattern rather than inventing one.

**Public wording.** No competitor or vendor product name appears in this roadmap, the epic it
authors, its child issues, or their pull requests — "comparable market products," "leading agentic
coding assistants," and "the market baseline" stand in for named references; the full parity research
and its source list stay in the private baseline scratchpad, never copied into the repository.

**Reference model set is deployment configuration (S5).** The three vendor-neutral classes named in
§2 and §6a are configuration the capability registry ships empty against, never a hardcoded model id
in product code.

**Bridge-retirement rule (S8).** OpenCode is not removed, and the default engine does not flip, until
the engine-parity suite is green on every Must row and every Should row the bridge itself satisfies,
for one full release of coexistence. This bar is a precondition for Wave 7.1, not a target to
approximate.

**Required-CI-is-the-arbiter (ADR-0135/ADR-0139/ADR-0145).** Every child's Gates line names the
minimum-loop and touched-area commands to run locally; the required CI run on each child's pull
request remains the complete, final arbiter, per AGENTS.md §3's local-first gate policy. No child
substitutes a local run for the required CI gates it is bound by.

**Stop conditions.** After three repair attempts with different root causes on the same child, stop
and report the blocker rather than attempting a fourth fix — the same Stop Conditions discipline
#2473 already carried, unchanged for this roadmap.

## 5. Backlog dispositions

Executed in Wave 0 unless marked PROPOSED, in which case the item stays open awaiting owner
confirmation per §6.

| Issue(s)                                                                                          | Disposition                                                                                            | Rationale                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #2473                                                                                             | Superseded by the new epic (linked both ways); closed as superseded, Annex A/B carried forward         | Decision 10 — a new epic supersedes the wave plan this roadmap replaces                                                                                                                                                                     |
| #2552                                                                                             | Keep independent; housekeeping comment that its coordinated pillar is now the new epic                 | Schedules four program epics; implements no feature code itself                                                                                                                                                                             |
| #435                                                                                              | Close as superseded                                                                                    | Inactive more than 2.5 months; its one PR closed unmerged; no other of 1867 repository PRs references it (Decision 7)                                                                                                                       |
| #436–442                                                                                          | Close as superseded                                                                                    | Direct children of #435 with no independent activity; requirements reviewed for reuse in Wave 6's sub-agent work before closing, not silently dropped                                                                                       |
| #460                                                                                              | Close as superseded                                                                                    | Decision 3, named explicitly                                                                                                                                                                                                                |
| #463                                                                                              | Close as superseded; Wave 1.6 adds an explicit removal task since its code already shipped (PR merged) | Decision 3, named explicitly — closing the issue alone does not remove the merged code                                                                                                                                                      |
| #466, #468                                                                                        | Close as superseded                                                                                    | Retired-subscription-lane-specific scope inside the #460 family; superseded with its parent                                                                                                                                                 |
| #854                                                                                              | Close as superseded                                                                                    | Decision 3, named explicitly; its provider-runtime boundary work (already merged) stays valid, only the retired-lane tracking closes                                                                                                        |
| #464, #465, #467                                                                                  | Leave open with a re-pointing comment; candidates for Wave 1.4 and Wave 3.6                            | Generic, not specific to the retired subscription lane, provider UX/capability-model/diagnostics work — not named by Decision 3, reusable for the surviving standard-completions-protocol path                                              |
| #451 family (#451–459)                                                                            | **PROPOSED — awaiting owner confirmation (§6b)**; left open, not closed                                | Not named in any accepted decision; overlaps durable plan/spec territory this roadmap already routes through S7's `active-plan` lane and Wave 5's session store — real duplicate-subsystem risk if left unresolved                          |
| #480 family (#480–484, #486–488)                                                                  | **PROPOSED — awaiting owner confirmation (§6b)**; left open, not closed                                | Not named in any accepted decision; strong thematic overlap with S1's Hybrid engine strategy and Wave 5's multi-runtime/parallel-run consolidation                                                                                          |
| #2289                                                                                             | Absorb into Waves 5–6                                                                                  | Decision 7, verbatim: "#2289 and #2473-Wave-3 items are absorbed"                                                                                                                                                                           |
| #2694                                                                                             | Absorb into Wave 1                                                                                     | Orphaned, explicitly Coding-Workbench-branded product-icon request                                                                                                                                                                          |
| #2387 / PR #2472 lineage                                                                          | Absorb into Wave 6.1                                                                                   | Governed research/skills/read-only-subagent work #2473's own Wave 3 already named as its adoption target                                                                                                                                    |
| #2958                                                                                             | Resolved by Wave 1.6 (routes deleted) plus Wave 4 (policy vocabulary reused)                           | Decision 5 overrides its "just delete" disposition — the client-supplied-authority route layer is deleted, its denial-reason vocabulary and connector-operation shape are reused                                                            |
| #2883 audit program (#2951, #2945, #3102, #3103, #2946, #2949, #2944, #3110, #2956, #3123, #2952) | Coordinate, keep independent                                                                           | Separate, already owner-accepted audit-remediation program; several items are thematically adjacent (sandbox attestation, delivery-gate consolidation, context-eviction) and should be coordinated with, not re-absorbed into, this roadmap |
| #2249                                                                                             | Coordinate, keep independent; Wave 6.2 candidate for the first MCP server                              | Decision 6 cites it as the "first concrete server need," to be confirmed (§6c)                                                                                                                                                              |
| #2198                                                                                             | Coordinate, keep independent; external dependency                                                      | Decision 8 tracks Apple Developer ID / Endpoint Security signing as external, not a roadmap blocker                                                                                                                                         |
| #2687                                                                                             | Coordinate, keep independent                                                                           | Plain workspace bug fix, unrelated to autonomy/epic restructuring                                                                                                                                                                           |

## 6. Open items for the owner

(a) **Reference model set.** Confirm the three vendor-neutral classes proposed in S5/S6a — one hosted
frontier-class model behind an industry-standard chat-completions-compatible endpoint, one
open-weight coding model, one small local model for smoke — or name a different set. This gates Wave
1.4's model picker scope and Wave 3.6's parity-suite corpus.

(b) **#451 and #480 dispositions.** Both families are left open, PROPOSED, in §5. #451 ("Living
Specs") overlaps the durable plan/spec territory S7 and Wave 5 already route through the `active-plan`
lane and the new session store; #480 ("BYOA — Bring Your Own Agent control plane") overlaps S1's
Hybrid engine strategy and Wave 5's parallel-run consolidation. Confirm whether each is absorbed into
this roadmap's waves, ruled out of scope, or kept as an independent program — silence risks a second
durable-plan or a second runtime-adapter registry next to the ones this roadmap is already building.

(c) **First MCP server.** Decision 6 names Jira/Confluence handoff (#2249) as the candidate first
server need. Confirm whether MCP client work (Wave 6.2) is exclusively for systems Keiko has no
native connector for — leaving the existing Atlassian connector (ADR-0128) as the sole Jira/Confluence
path — or whether MCP is expected to eventually front Jira/Confluence too, which would need its own
superseding note against ADR-0128.

(d) **Capacity and calendar dates.** This roadmap intentionally carries no calendar dates (Decision
10). Confirm whether capacity should now be attached to waves, and if so, at what granularity
(per-wave, per-milestone, or left to the epic's own materialization cadence).

(e) **Unsigned evaluation lane through 2026.** Decision 8's working assumption is that the unsigned
evaluation lane (ADR-0163 §D9) remains the default lane through calendar year 2026, with the signing
entitlement (#2198) tracked as an external dependency rather than a roadmap blocker. Confirm this
assumption holds, or name a point at which release-qualified signing becomes a roadmap dependency
rather than an external one.

## 7. Document maintenance

This roadmap is the plan of record; ADR-0174 is the decision of record for the architectural spine in
§2; the new epic (Wave 0's deliverable) is the authoritative progress view — milestone and child-issue
state there, not a re-derived status in this file, answers "where are we." This document is updated at
each wave's closeout: the closing wave's actual exit-journey result, any documented deviation from the
route its children described (Delivery Constitution rule 5), and any newly materialized next-wave
children (rule 3) are folded in as a dated addendum rather than a silent rewrite of prior waves' text.
The baseline document is frozen as of its stated date and is not re-edited as waves land — capability
facts that change with shipped work move to this roadmap's wave closeout notes and, where they affect
the capability parity table, to the epic's own parity-register update, not back into the baseline.
