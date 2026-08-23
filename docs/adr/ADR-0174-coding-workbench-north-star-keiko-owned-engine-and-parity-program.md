# ADR-0174: Coding Workbench north star — Keiko-owned engine behind a bridged runtime, governed
command execution, live visibility, and the parity program

## Status

Accepted, 2026-08-23, owner decision (Coding Workbench north-star review). Amends ADR-0004 (harness
boundary/state machine), ADR-0090 (active task-workspace binding), ADR-0124 (coding autonomy
modes/sidecar authority), ADR-0129 (product-wide authority/autonomy model), ADR-0137 (server-owned
coding runtime contracts), and ADR-0163 (self-contained coding runtime); moves ADR-0054/ADR-0055
(tool observation shaping; context-engineering harness wiring) from Proposed to Accepted to match
shipped code; adds cross-reference notes, no text change, to ADR-0006/ADR-0018 (safe tool
execution; terminal boundary), ADR-0138 (monotonic autonomy semantics), and ADR-0141 (authenticated
local app-session channel). Companion: `docs/coding-runtime/coding-workbench-north-star-roadmap.md`
(plan of record for the waves below) and `docs/coding-runtime/coding-workbench-baseline-2026-08.md`
(the capability inventory and per-claim evidence behind it).

## Context

A baseline audit of the Coding Workbench's production engine found it runs entirely on a pinned
external bridge process (`1.17.17`), wired through a fixed subscription-selector lane the product no
longer offers, with no model-callable command execution, no live tool-argument/output visibility, no
durable session or memory integration, and no parallel-run or delivery path — while a Keiko-owned
agent loop (`keiko-harness`) already ships in production as the read-only child-agent runtime,
unused for the primary loop. Closing the gap against leading agentic coding assistants requires
committing to which engine the product is built on, not only which features it adds.

The owner accepted eleven numbered recommendations plus a twelfth, MemoriaViva-only memory rule as
fixed inputs: a Hybrid engine strategy (bridge now, Keiko-owned loop as target, retired only once
proven); a governed, model-callable shell; any industry-standard chat-completions-compatible endpoint
first, native adapters later; live, content-bearing visibility while persisted evidence stays
body-free; unattended branch delivery, never merge, in Full access; MCP as a client capability;
sub-agents, parallel runs, and resume; a Keiko-only capacity/platform posture; a new superseding
epic; a parity yardstick against the market baseline; and MemoriaViva as the sole memory, session,
and knowledge substrate. AGENTS.md §1's human-control invariant and the three fixed autonomy modes
bound every one of these unchanged.

Several accepted decisions contradict specific ADR text on file: ADR-0004 rejects model-driven
dispatch outright; ADR-0129 §D2a was corrected eight days before the baseline (KEIKO-0227,
2026-08-15) specifically to keep delivery approval-gated in every mode; ADR-0163 names exactly one
approved runtime; ADR-0090 and ADR-0137 each fix a single active run. Per AGENTS.md's opening
principle and §12, an ADR mismatch signals amending the record in the same change, not preserving
outdated text or reopening the decision. This ADR is the required new record because the underlying
choice — which engine the product is built on, how authority extends to a model-callable shell and
unattended delivery, and how memory and parallelism attach — is a genuinely new architectural
decision, not a repair of one on file; each amendment below is scoped to the minimum text change
required, leaving the amended ADR's design otherwise intact.

## Decision

### D1 — Engine placement: one in-process adapter kind, one orchestrator, one tool facade (S1)

The Keiko-owned engine is `keiko-harness`, amended, hosted in-process by the coding-runtime
orchestrator as a second `adapterKind: "keiko-engine"` beside the bridge adapter — never a second
child process, orchestrator, or tool facade. It executes nothing itself: every effect crosses the
same IPC action vocabulary through `codingToolAuthorityPort` into the governed ports
(`productionManagedWorktreeTools.ts`, `GovernedCodingToolPort`) and `keiko-tools`/`keiko-sandbox`
below them. The precedent already ships: the read-only child agent runs a real `keiko-harness`
`createSession` in production (`productionReadOnlyChildRunner.ts`); ADR-0137 already documents the
port as adapter-shaped for multiple engines, and this decision exercises that shape.

### D2 — One tool registry, one ToolPort (S2)

`keiko_*` tool definitions are the single model-facing vocabulary for both engines: the bridge via
its custom-tool configuration, the Keiko engine via the harness `ToolPort`. `GovernedCodingToolPort`
is that one `ToolPort` for both. The fixture-only `WorkspaceToolHost`
(`keiko-tools/src/registry.ts:106`) — one call site, no production caller — is retired, not
revived: the product never runs two live tool hosts at once.

### D3 — Governed command execution (S3, part 1)

A sandboxed, model-callable `keiko_command` tool joins the IPC action vocabulary, executed through
`keiko-tools/src/exec.ts` (`shell:false`, env allowlist, workspace-scoped cwd) under
`keiko-sandbox`'s `planIsolatedRun` (default `network:"none"`, attested, fail-closed when
unenforceable). Command policy extends the Authority Envelope's `commandPolicy`
(`coding-workbench-runtime.ts:159-165`) and `commandAllowed()`
(`codingToolAuthorityPort.ts:387-397`) with a mode-derived `CommandRule` set in
`keiko-contracts/src/tools.ts`: Ask for approval requires per-command approval; Supervised
allowlists verification/build/format commands; Full access is broader but still deny-listed, with no
remote `git`/`gh` (delivery is D6). Hard denials and the workspace-contained risk cell stay in
front; the human-typed UI terminal (ADR-0006 §D1, ADR-0018 §D1/D3) is untouched — `keiko_command`
is new ground beside it, not a rewrite.

### D4 — Visibility principle: two artifacts, two rules (S4)

The paired local human sees content-bearing tool calls — arguments, command lines, outputs, diffs —
live, over the authenticated app-session channel (ADR-0141), extending `coding-safe-activity.ts` and
`codingSafeActivityProjection.ts`; new content fields join `ENFORCED_CONTENT_ROUTE_PATTERNS`
(`contentRouteEnforcement.test.ts`). Persisted evidence (`CodingWorkbenchEvidenceRecord`),
diagnostics, the activity log (ADR-0173), and every export stay body-free — a content body reaching
any of them, or the content-free SSE union, is always a defect.

### D5 — Model agnosticism through the gateway capability registry (S5)

Both engines see `keiko-model-gateway` capabilities — chat, tool-calling, streaming, usage — never a
provider identity. The standard completions protocol is the first-class transport; tool-call delta
streaming is a gateway upgrade wiring the existing, unwired `StreamDelta.toolCallDelta` type; native
adapters are conditional on the reference set proving the proxy path insufficient. The reference
model set — one hosted frontier-class model behind an industry-standard
chat-completions-compatible endpoint, one open-weight coding model, one small local model for
smoke — is deployment configuration the empty-by-design capability registry (`capabilities.data.ts`)
ships against, never a hardcoded model id. The retired subscription-selector lane is dropped for
good. `keiko-model-gateway` stays the only package holding provider-SDK code (ADR-0019 trust-1).

### D6 — Unattended branch delivery in Full access (S3, part 2)

In Full access, the agent may commit, push its own feature branch, and open one draft pull request
per run without further per-action confirmation, routed through `gitDelivery/execution.ts` and its
commit/push/PR-create gateways; `GitDeliveryApprovalRequirement`'s already-legal `{required:false}`
value changes, not a new gateway. Merge stays `{required:true}` unconditionally; the governed merge
gateway (ADR-0087) is untouched; protected-branch, no-force, and no-merge denials hold regardless
of mode. This reverses ADR-0129 §D2a's KEIKO-0227 correction (2026-08-15) for a narrower reason: it
mirrors ADR-0135's Keiko-only pattern outward to a repository's own branch — commit/push/PR-create
only, never merge — not a reopening of what KEIKO-0227 settled.

### D7 — MemoriaViva is the only memory; the session store lives in the existing server store (S6)

Every memory, transcript, or session-persistence need extends MemoriaViva and the server's existing
store patterns — no second memory, session, transcript, or knowledge store. A content-bearing
Code-task session store is new tables in the server SQLite via the `PRAGMA user_version` runner,
sealed with the vault's secretbox pattern (ADR-0035), composed in
`keiko-server` — the only package allowed to combine a `keiko-memory-*` package with
`keiko-model-gateway`/coding-runtime. `coding_runtime_snapshots` stays content-free (issue #2256);
resume rehydrates authority from the snapshot table and content from the new session table together.
Repository memory is ordinary MemoriaViva capture (`extractCandidatesFromWorkflowOutcome` →
`promoteEligibleMemoryRecord`, ADR-0146-gated, scope `project`) with per-turn recall via
`retrieveMemoryContext` into the `working-memory` lane — not a model-invoked recall tool, the shape
ADR-0116 built and retired for ordinary per-turn retrieval.

### D8 — Compaction is composed in keiko-server behind a harness port (S7)

`keiko-harness` may not import `keiko-workflows` (dependency-cruiser rule 4a). The shared 8-lane
context allocator and compaction pipeline are composed in `keiko-server` and handed to the harness
through a new `ContextBudgetPort` in `keiko-harness/src/ports.ts`, the pattern used for `ModelPort`,
`ToolPort`, and `HarnessShaperPort`; compaction records persist through `persistCompactionEvidence`
(ADR-0053/0172). The plan artifact is the `active-plan` context lane itself — no second
plan-storage format beside the lanes `keiko-workflows` already budgets.

### D9 — Parallel runs keyed by task-workspace, with resume

Authority moves from a process-wide singleton to a set of active pointers keyed by
task-workspace/worktree, admitting N concurrent runs under an explicit ceiling, amending ADR-0137
§D2's "exactly one active run per BFF" and ADR-0090 §D1's single active-workspace-pointer `CHECK`.
The provisioning/health/drift/lock machinery (ADR-0088–0093) is reused unmodified — only the
one-active-row constraint moves to one-per-pointer — and resume composes the content-free
snapshot's authority/revision state with D7's content-bearing session store.

### D10 — Sub-agents and an MCP client through existing authority

Writing sub-agents extend `productionReadOnlyChildRunner`/`readOnlyChildOrchestrator` with write
authority, worktree scoping, and a depth cap, drawing budget from the parent's allocation in
`EditorAgentAuthorityRegistry` — a parent/child relation, not a new accounting store. An MCP client
is a later capability: one package owns the MCP SDK, mirroring the model-SDK isolation rule; MCP
tools surface through the same registry as namespaced entries, authorized through the existing
`connectorScopes` double gate (`connectorAllowed()`); MCP is for systems with no native connector —
the Atlassian connector (ADR-0128) is not replaced. Its package home and ADR-0138 action-class
mapping are new ground for a sub-decision before that wave starts.

### D11 — One agentic surface

The Coding Workbench is the one agentic surface, absorbing the editor-agent producer flow rather
than running a second one beside it. A third `origin: "workbench"` producer joins ADR-0125 §D2's
existing multi-producer docking plane — not a second apply-to-editor transport — and
`EditorAgentActionsPanel` becomes the content-free audit index of the Workbench's own live stream,
never a second content-bearing surface duplicating it (D4). ADR-0129 §D5's parked rename note is
formally closed: the product identity stands as named.

### D12 — Bridge-retirement rule, and logging/anti-false-green as the definition of done (S8, S9)

The bridge retires, and the default flips to the Keiko-owned engine, only when an engine-parity
suite (`keiko-evaluations`: task corpus × reference model set × both engines) is green on every
Must row and every satisfied Should row for one full release of coexistence — never on a partial or
aspirational read. Until then both ship and the bridge stays default; ADR-0163 §D6's "exactly one
approved runtime" is amended only then, to "at least one approved runtime source." Every capability
above ships its own body-free logging on the activity log (AGENTS.md §8:
`ServerLogSink`/`ServerLogEvent`, the generated `op` catalog, threaded `correlationId`) and is
proven through production composition and discovery before its wave closes — an injected seam for
the real bridge, sandbox, delivery gateway, or session store never ships as a production fallback.

## Consequences

**Positive.** One adapter-shaped runtime port carries both engines, so the product never maintains
two orchestrators or two tool facades while the Keiko-owned loop matures. Command execution,
delivery, and MCP authority extend mechanisms the Authority Envelope already owns, so the
fail-closed hard-denial surface widens uniformly rather than growing a parallel policy path per
capability. MemoriaViva absorbing every memory/session need keeps one encrypted, audited
persistence substrate instead of a second one for the coding engine alone.

**Negative.** Coexistence is real cost: both engines, their adapters, and the parity suite gating
retirement ship together until S8's bar is met — possibly more than one release. D6's delivery
reversal reopens ground a very recent correction (KEIKO-0227) closed for a reason; a reviewer must
read its rationale before treating the reversal as settled.

**Neutral, load-bearing.** D8 and D12 both assume `keiko-evaluations` and its scheduled lane exist
independent of the PR-blocking gate surface — the parity suite is advisory reporting, never a
required check; a green run on a subset of rows never flips the default alone (S8). Where a
decision above states a target this checkout does not yet implement, the recorded prior behaviour
in the amended ADR remains the fail-closed implementation until that wave lands.

## Amends

| ADR | Section | Nature of amendment |
| --- | --- | --- |
| ADR-0004 | §D8, Alternatives, Non-Goals | Adds a fourth, open-ended `code-task` type (`model-call ⇄ tool-call` under budgets); strikes the three-type ceiling and ReAct-dispatch rejection; harness still owns every transition (D1). |
| ADR-0006 / ADR-0018 | §D1 / §D1, D3 | Cross-reference, no text change: `keiko_command` (D3) is new ground beside the static allowlist and human-typed terminal, not a rewrite. |
| ADR-0054 / ADR-0055 | Status | Proposed → Accepted — the designs are already fully implemented and verified in shipped code (AGENTS.md: "working, clean, secure, verified code is authoritative"). |
| ADR-0090 | §D1 | Single active-workspace pointer becomes a set, one per task-workspace/worktree, keeping the per-pointer `WorkspaceBinding` invariant (D9). |
| ADR-0124 | §D5, §D7 | §D5's model-source enum drops the retired subscription-selector member (D5); §D7 cross-references ADR-0141: content-free evidence governs durable records, not the live stream (D4). |
| ADR-0129 | §D2a, §D5 | §D2a splits delivery-execute into commit/push/PR-create (`{required:false}` in Full access) vs. merge (`{required:true}` always), citing KEIKO-0227 (D6); §D5's rename note closes (D11). |
| ADR-0137 | §D2 | "Exactly one active run per BFF" → authority keyed by task-workspace, N concurrent runs under an explicit ceiling (D9). |
| ADR-0163 | §D6 | Future-dated, at S8's bar only: "exactly one approved runtime" → "at least one approved runtime source" (D12); no live conflict during coexistence. |
| ADR-0138 | §D2–D3 note | Cross-reference, no text change: `keiko_command`'s action-kind entry fits the existing action-kind → resource-scope mapping unchanged. |
| ADR-0141 | note | Cross-reference, no text change: binding precedent for every future content-bearing surface (D4). |

## Alternatives considered

- **Pure bridge (external engine permanent).** Rejected: caps the product on the bridge's roadmap
  and dead subscription weight, leaving the production-proven Keiko-owned harness unused.
- **Pure rewrite (drop the bridge cold).** Rejected: no parity evidence exists yet; retiring the
  only production-proven engine before measurement violates the anti-false-green rule.
- **A second child process for the Keiko-owned engine.** Rejected: the engine executes nothing
  itself once every effect routes through the existing governed ports, so a second process adds
  containment cost for no isolation benefit and contradicts S1's adapter-shaped port.
- **A new policy engine for `keiko_command`.** Rejected: the Authority Envelope's `commandPolicy`
  and `CommandRule` vocabulary already exist and only need mode-derived population — a parallel
  engine would be a third "safe command" pattern beside the two already on file (AGENTS.md §5).
- **A separate coding-engine memory/session store.** Rejected outright by Decision 12: the existing
  server SQLite/vault patterns cover every persistence shape needed; a bespoke store would be
  exactly the "parallel world" the owner named unacceptable.

## Verification

Each decision is proven by its roadmap wave's own exit journey and negative pin, through production
composition and production discovery, never an injected seam, per the Delivery Constitution's
anti-false-green rule. Mapping: D1–D2, D5 by Wave 3's Keiko-engine adapter passing Wave 1–2's exit
journeys with the bridge's tools, policy, and tool-call-delta streaming; D3 by Wave 2's nightly
real-binary `keiko_command` run and its risk-cell pin; D4 by Wave 1's content-route sweep and
body-free evidence/export pin; D6 by Wave 4's dogfooding journey — a real signed commit, push, and
draft PR, denied on `dev` and force-push; D7 by Wave 5's cross-run memory-recall journey and the
`coding_runtime_snapshots` content-free pin; D8 by Wave 3's `check:context-quality` extension and
the zero-import-edge pin to `keiko-workflows`; D9 by Wave 5's two-worktree parallel-run and
restart-resume journey; D10–D11 by Wave 6's MCP-plus-sub-agent and editor-bridge journeys and their
double-gate/content-free pins; D12 by Wave 3.6's parity-suite report and, at Wave 7.1, a full
regression pass with the bridge removed. Every wave's Gates line runs the AGENTS.md §3 minimum loop
plus `gates:sonar` and its touched-area gates; required CI remains the final arbiter (ADR-0135).
