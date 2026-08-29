# Context-Engineering Milestone — Coordinator Decision Log

Living record for the deterministic, offline-first context-engineering milestone (default 128k
effective input budget, model-agnostic). Maintained by the coordinator across the phased PRs.
Design rationale is in [ADR-0052](../adr/ADR-0052-deterministic-context-engineering-layer.md).

## Constraints (non-negotiable)

Offline-first (no embeddings/rerankers/network for core context management); additive + backward
compatible public interfaces; reuse-first (prove existing surface cannot be reused before adding
new); no broad new dependencies (`npm ci` exact); browser summaries path-free + aggregate; no
secrets/customer-data/raw-tool-dumps in long-term memory; M5 semantic/reranking out of scope.

## Toolchain baseline (2026-06-23, branch `feat/context-engineering-foundation` off `release/0.2` @ `567e30af`)

- `npm ci` — 698 packages, 0 vulnerabilities, **no tracked-file changes**.
- `npm run build:packages` — exit 0, clean tree.

## Key architecture finding

Keiko has **two context paths**. The milestone's lanes map almost entirely onto the second:

1. **Grounded repo-QA** — `keiko-server/grounded-orchestrator.ts → grounded-qa.ts → GroundedAnswerer
seam`. Budget = `ExplorationBudget` (`modelInputTokensMax=32_000`). Lanes: system, user-task,
   repo-evidence only. Short-lived.
2. **Agentic harness loop** — `keiko-harness` (`executor.ts`/`loop.ts`/`planner.ts`) → `ToolPort` →
   `role:tool` messages; desktop chat in `chat-handlers.ts`. History = hard last-24 slice
   (`MAX_CONTEXT_MESSAGES=24`), **zero compaction**; budget = `maxContextBytes=512KB` via
   `contextBytes()` (JSON byte length). This is where compaction, tool-observation lanes,
   working-memory, history-summary, verification-evidence, and the 128k window live.

No tokenizer exists anywhere. Existing ratios diverge (bytes/4, chars/4, word×1.3). Decision: **one**
conservative deterministic `estimateTokens` in keiko-contracts, used uniformly across all lanes.

## Decisions

### Reuse as-is (no change)

- `readExcerpt` (keiko-workspace/repoSearch.ts) — **the** deny-gated exact-line rehydration primitive.
- `isDenied` / `containedRealPathInfo` — security gates (must run before any byte read).
- `evidenceAtomStableId` / `fingerprintFor` / `sha256Hex` (keiko-workspace/stableId.ts) — provenance keys.
- `createGovernor`/`applyUsage` (keiko-workflows/planner/governor.ts) — the immutable-budget state
  pattern the allocator follows (fresh objects per step, no mutation, no persistence).
- `selectScoredTextByByteBudget` (keiko-workspace/contextPack.ts) — **ordering pattern only, NOT reused
  verbatim.** It is byte-bound (`size = utf8Bytes(text)`); reusing it would corrupt the single-token
  currency (`estimateTokens`) the allocator requires (ADR gate 3). The allocator's private
  `selectScoredByTokenBudget` mirrors its proven deterministic ordering (score DESC, id ASC localeCompare,
  greedy fill) in tokens, with an inline comment citing `contextPack.ts:53` and why byte-reuse was rejected.
  This is the milestone's "new is justified when existing cannot be cleanly reused" path. No new package edge
  (`keiko-workflows → keiko-workspace` already exists).
- `redact` / `deepRedactStrings` / `createAuditRedactor` / `detectPromptInjectionSignals` (keiko-security).
- evidence persist/redact/retention/report stack (`persistConnectedContextEvidence`,
  `createNodeEvidenceStore`, `applyRetention`, `buildEvidenceReport`, `writeSideFile`).
- UI: `MetricRow`, `formatBytes`/`formatMs`/`formatTokens`, `MemoryPanel` disclosure pattern.
- harness scripts: `runRetrievalQualityCheck` + inline `buildFixtureFs` template.
- `scanForSecrets` / `applyPolicy` (keiko-memory-capture) — secret/PII gate for any compaction body.

### Extend narrowly (additive optional)

- `ContextPackDiagnostics.contextBudget?` (connected-context.ts) — **PR1**.
- `GroundedAnswerContextPackSummary.contextSummary?` (bff-wire.ts) — UI PR.
- `EvidenceManifest.contextAssembly?` / `compaction?` (evidence.ts) — evidence PR.
- `ToolCallResult`/`ToolCallMetadata`/`CommandResult` shaped-observation + omittedByteCount — tool-shaping PR.
- `summarizeCommand` (keiko-tools), `buildGatewayMessages`/`conversationForGateway` (keiko-server),
  `buildUiHandlerDeps` (deps.ts) — wiring PRs.

### New (justified by a measured gap; none exist today)

- `context-engineering.ts` in keiko-contracts — full vocab (Profile/Budget/Lane/LaneId/LaneDiagnostics/
  AssemblyDiagnostics + estimator + validators; CompactionRecord/RehydrationHandle defined-now). No
  equivalent type exists; required for a model-agnostic budget surface.
- Conservative `estimateTokens` — no single deterministic token currency exists; mixing ratios corrupts
  budget accounting.
- Pure lane **allocator** in keiko-workflows — no lane-partitioned allocator exists (only N-way
  byte split + per-excerpt clamp).
- `scripts/check-context-quality.mjs` (+ budget + tests) — no context-quality gate exists.
- (later) compaction-record module + file-content-hash invalidation helper + shaped-observation
  builders + `persistContextAssemblyEvidence` + `ContextStatusPanel`.

### Refinements to ADR-0052 (folded into PR1)

- `ContextProfile.model?` — optional opaque provider/model metadata (never drives behavior); milestone
  lists it as a minimum field.
- `ContextProfile.tokenEstimatorId` — provenance string recording which estimator produced the counts
  (the function itself cannot be a JSON-serializable contract field).

### Deferred (out of this milestone)

- M5 semantic reranking / embeddings; vector DB; autonomous long-term org memory; per-file rationale
  in browser summaries; package publish / release tag / deploy.
- Per-turn compaction is **not** routed through `keiko-memory-consolidation` (confirmed boundary: that
  package is long-term knowledge dedup, not per-turn context shaping).

## Critical gotchas (carry into every PR)

- Do **not** raise `DEFAULT_EXPLORATION_BUDGET.modelInputTokensMax` (breaking) — thread profile override
  via `OrchestratorInput.budget`.
- AC5 byte-identical single-source grounded wire output is invariant.
- `.keiko`/`.claude` are deny-listed → compaction records need a non-workspace I/O path.
- New `AssembleInput` fields must enter `buildCacheAtomIds` or the pack cache corrupts.
- Strict TS: `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, no `as`/`!`,
  ≤10 complexity, ≤50 LOC/function, ≤400 LOC/file → new modules only (store.ts/orchestrator already at cap).
- `detectPromptInjectionSignals` (authoritative, ADR-0044) ≠ QI `scanForPromptInjections`.
- Agent-tool subagents auto-isolate to a stale worktree; Workflow agents edit the main tree → use
  Workflow (sequential, disjoint paths) for code edits and build between waves.

## Phased delivery plan

- **PR1 (foundation, Phases 1–2):** contracts vocab + estimator + `ContextPackDiagnostics.contextBudget?`
  - lane allocator + context-quality harness/CI gate. ✅ **implemented + verified** (see Metrics + Status).
- **PR2 (compaction + rehydration):** rich compaction-record vocabulary (provenance refs, durable facts vs
  assumptions with anti-poisoning, invalidation keys) + `fileContentHash`/`hashExcerptContent` in keiko-workspace
  - `buildCompactionRecords` + bounded deny-gated `rehydrateProvenanceRef`/`rehydrateHandle` in keiko-workflows
  - harness `rehydrationReadiness`/`compactionPreservation`/`invalidationDetected` made load-bearing.
    Design: [ADR-0053](../adr/ADR-0053-compaction-records-invalidation-rehydration.md). ✅ **implemented + verified.**
- **PR3 (tool-observation shaping, ADR-0054):** shaped command/test/search observation contracts (browser
  forward-defined) + `CommandResult.omittedByteCount` capture in keiko-tools exec.ts (model-facing
  `summarizeCommand` byte-identical) + pure shapers in keiko-workflows (`shapeCommand/Test/SearchObservation`)
  with `redact` + **content-free** injection-signal counts + bounded excerpts + rehydration handles + harness
  `toolObservationShapingFidelity`/`shapingRedactionClean`/`shapingInjectionFlagged` load-bearing. **Additive
  projection** — the live tool flow is unchanged; prompt wiring is PR4. ✅ **implemented + verified.**
- **PR4 (orchestrator + harness wiring, ADR-0055):** `contextProfile?` threaded through OrchestratorDeps +
  UiHandlerDeps (DEFAULT_CONTEXT_PROFILE provisioned by default); grounded diagnostics observer populating
  `ContextPackDiagnostics.contextBudget?` (AC5 byte-identity proven structurally — prompt builders never read
  diagnostics); gated history-compaction splice in `conversationForGatewayWithCompaction` (active only when
  profile present AND >24 filtered messages; verbatim passthrough otherwise; summary is a deterministic
  redacted `user`-role digest); shaped observations attached in the harness via an injected port (no new edge,
  model output unchanged); the milestone headline AC ("long sessions compact without losing current user
  instructions") made a **required** harness gate. The **first behavior-affecting PR** — every existing test
  byte-identical (zero pre-existing tests changed). ✅ **implemented + verified.**
- **PR5 (regulated evidence, ADR-0056):** additive `EvidenceManifest.contextAssembly?`/`compaction?` (no schema
  bump, no new TaskType) + index-api shape acceptance; two-layer redaction `persistCompactionEvidence` helper +
  redacted `contextAssembly` on the connected-context manifest (retention reused); grounded path **live** —
  `deriveGroundedContextAssembly` routes the assembly diagnostics into evidence at all 3 grounded persist sites
  (path-free browser summary unaffected; `buildEvidenceReport` never reads the new fields). Chat-compaction
  live-persistence is **deferred to PR6** (helper ships contract-ready + unit-tested; per-turn runId/retention
  needs its own analysis). ✅ **implemented + verified.**
- **PR6 (UI panel + chat-evidence + browser verify, ADR-0057):** structurally **path-free**
  `GroundedAnswerContextSummary` (no string fields) + builder 4th-arg; quiet collapsed `ContextStatusPanel`
  (`<details>` + reused `MetricRow`/`formatTokens`, a11y-clean, null-guarded) + `.ctx-*` globals.css (pinned);
  grounded `contextSummary` wired live at all 3 sites (AC5 byte-identical without a profile); **chat-compaction
  evidence now live** — `deriveCompactionOutcome` + best-effort `persistCompactionEvidence`
  (`chat-<hash16>-t<n>` runId, never fails a send) — resolving the PR5 deferral; **in-app browser verification
  done** (real running app: clean load, 0 console errors, panel correctly absent without grounding; panel
  rendered against live globals.css: collapsed-by-default, aggregate-only, path-free). ✅ **implemented + verified
  — milestone complete.**

## Metrics

**Mutation methodology.** Every "mutation-proven" / "mutation-probed" claim below is manual, targeted
mutation coverage — not automated mutation testing (no Stryker, no PIT). The proof lives in the wave's
own unit tests: for each named invariant the corresponding test file asserts that flipping the
production behaviour (relocating a lane, promoting an injection item, dropping a required field) causes
the gate to fail. General test locations per PR wave:
`packages/keiko-workflows/src/context-budget/` (PR1 allocator + budget),
`packages/keiko-contracts/src/context-compaction*.ts` and `packages/keiko-workspace/src/file-content-hash.ts`
(PR2 compaction/rehydration schemas + bounded hashing),
`packages/keiko-contracts/src/tool-observation.ts` and `packages/keiko-tools/src/exec.ts` (PR3 shaping),
`packages/keiko-server/src/conversation-compaction.ts` and `packages/keiko-harness/` (PR4 orchestrator +
harness wiring), `packages/keiko-evidence/src/context-*.ts` (PR5 evidence redaction/path-free), and
`packages/keiko-contracts/src/grounded-answer-context.ts` + `packages/keiko-ui/src/app/components/` (PR6
UI + grounded builder). See each wave's `*.test.ts` neighbours for the individual mutations.

PR1 baseline (`npm run check:context-quality`, 2 long-session scenarios over the deterministic offline
corpus; the gate enforces these as CI invariants going forward):

| Metric                             | Observed          | Gate              |
| ---------------------------------- | ----------------- | ----------------- |
| budgetOverflowRate                 | 0.0%              | = 0 (hard)        |
| criticalFactPreservationRecall     | 100%              | = 1 (hard)        |
| userInstructionPreservation        | 100%              | = 1 (hard)        |
| currentDiffPreservation            | 100%              | = 1 (hard)        |
| failingTestPreservation            | 100%              | = 1 (hard)        |
| repoEvidenceLineRefAccuracy        | 100% (4/4)        | = 1 (hard)        |
| promptInjectionIsolationRate       | 100%              | = 1 (hard)        |
| redactionCorrectness               | 100%              | = 1 (hard)        |
| pathFreeComplianceRate             | 100%              | = 1 (hard)        |
| determinism (in-proc + cross-proc) | true              | required          |
| assembly latency p50 / p95         | ~2.06ms / ~2.16ms | p95 ≤ 25ms (soft) |

Mutation-proven: relocating a user instruction into an evictable lane drops critical-recall < 1 and fails
the gate; promoting an injection item into `user-task` drops injection-isolation < 1 and fails the gate.

PR2 promoted three metrics to load-bearing (observed): `rehydrationReadiness` 100% (gate ≥ 0.9, full
`readExcerpt` round-trip over excluded repo-evidence), `compactionPreservation` 100% (gate ≥ 0.8),
`invalidationDetected` true (required; mutated-file probe), with a non-vacuous guard (≥ 2 evicting
repo-evidence items; observed 3). PR1 metrics unchanged.

PR3 promoted the last scaffolded metric: `toolObservationShapingFidelity` 100% (22 checks; gate ≥ 0.9) plus
two **required** hard sub-invariants `shapingRedactionClean` true and `shapingInjectionFlagged` true. No metrics
remain scaffolded. Honest limitation: per-test `failingTestNames`/counts are NOT asserted because the live
`VerificationResult` exposes no per-test data (step-level only on `VerificationReport`) — documented in the
budget `$comment` and the harness header; out of scope until a richer test-result producer exists.

- Final (whole milestone): all PR1 hard invariants held at 100%/0/true through PR6; PR2 (rehydration 100% /
  compaction 100% / invalidation true), PR3 (tool-shaping fidelity 100% + redaction-clean + injection-flagged),
  and PR4 (long-session-compaction / current-instruction-preserved / short-session-byte-identical /
  no-profile-unchanged all true) added as load-bearing gate metrics and held. Assembly latency p95 ~1.5–2.2ms
  (soft ceiling 25ms). Full repo suite 11,981 passed / 1 skipped.

## Status

**MILESTONE COMPLETE — all 6 PRs (PR1–PR6) implemented + verified** on `feat/context-engineering-foundation`
(landed on `dev` via the Keiko 0.2.7 backport; this Status section is a historical snapshot written before
the merging commit — see `git log -- docs/context-engineering/decision-log.md` for the shipping commits,
`fb6e9439` "Harden context engineering foundation for 0.2.7" and `8cdf2d69` "Backport Keiko 0.2.7 release
to dev").

- **PR1** (Phases 1–2). Waves: contracts vocab + estimator + validators + `ContextPackDiagnostics.contextBudget?`
  (59 tests); lane allocator + `DEFAULT_CONTEXT_BUDGET` (18 tests, gates 3/4/5 mutation-proven); harness +
  budget + CI gate (26 helper tests). Also fixed a latent PR1 root-typecheck gap (added `@ts-expect-error` to
  an invalid `schemaVersion` fixture).
- **PR2** (compaction + rehydration, ADR-0053). Waves: contracts compaction/provenance/invalidation/rehydration
  schema + validators (60 tests; anti-poisoning `?: never` discriminants + sourceRef-or-inferred, mutation-proven);
  `fileContentHash`/`hashExcerptContent` in keiko-workspace (12 tests, 128 KiB bound double-pinned);
  `buildCompactionRecords` + bounded deny-gated rehydration in keiko-workflows (38 tests, no new package edge —
  `redact` from keiko-security, not memory-capture); harness metrics made load-bearing (40 tests).
- **PR3** (tool-observation shaping, ADR-0054). Waves: contracts shaped-observation schema + validators +
  additive `CommandResult.omittedByteCount?`/`ToolCallResult.shapedObservation?` (64 tests); keiko-tools exec.ts
  omitted-byte capture, `summarizeCommand` byte-identical (51 tests, mutation-probed); keiko-workflows pure
  shapers `shapeCommand/Test/SearchObservation` (25 tests, no new edge); harness shaping-fidelity load-bearing
  (45 gate tests).
- **PR4** (orchestrator + harness wiring, ADR-0055). Waves: grounded diagnostics observer + `contextProfile?`
  on OrchestratorDeps/UiHandlerDeps (AC5 byte-identity proven; keiko-server 2976 + keiko-evidence 332 green,
  0 broken); gated history-compaction splice in `conversation-compaction.ts` (keiko-server 2989 green, 0 broken,
  byte-identical below threshold); harness shaper port + keiko-cli injection (no new edge; model output unchanged;
  keiko-harness 106 + keiko-cli 483 green); harness gate — headline AC required-metric (60 gate tests).
- **PR5** (regulated evidence, ADR-0056). Waves: contracts `EvidenceManifest.contextAssembly?`/`compaction?` +
  index-api shape (21 tests); keiko-evidence `persistCompactionEvidence` + `contextAssembly` redaction
  (342 keiko-evidence tests, redaction/path-free mutation-proven); keiko-server `deriveGroundedContextAssembly`
  wired into evidence at 3 grounded sites (keiko-server 2998 green, 0 broken, AC5 unchanged). Evidence gates
  unit-covered (keiko-contracts/keiko-evidence/keiko-server), not re-asserted in the .mjs gate.
- **PR6** (UI panel + chat-evidence + browser verify, ADR-0057). Waves: contracts path-free
  `GroundedAnswerContextSummary` + builder 4th-arg (43 tests, mutation-proven); keiko-ui `ContextStatusPanel` +
  `.ctx-*` globals.css + a11y + path-leak tests (246 keiko-ui tests; #1300 visual-regression harness re-ran 0
  gated diffs); keiko-server grounded `contextSummary` wiring + chat-compaction evidence (3009 keiko-server tests,
  0 broken, AC5 unchanged); **in-app browser verification** (Playwright over the running app on `127.0.0.1:1983`):
  clean load + 0 console errors + panel absent without grounding (null-guard); panel rendered against the live
  globals.css = collapsed-by-default + aggregate-only + path-free. The full end-to-end grounded-answer render
  needs a configured model gateway (`.env` empty in this env), so the panel was verified against the live
  stylesheet rather than a live model response — noted honestly.
- **Verification (all six PRs):** `build:packages` exit 0, `check:package-graph` PASS, root `tsc --noEmit`
  0 errors, eslint clean on all changed files, context-quality gate exit 0 (all hard invariants + PR2/PR3/PR4
  load-bearing metrics 100%/true), full repo suite **11,981 passed / 1 skipped, exit 0** (713 files). PR4/PR5/PR6
  (the behavior-touching PRs) each changed **zero** pre-existing test outputs.

## Open risks

- Per-test `failingTestNames`/counts are not extractable from the live `VerificationResult` (step-level only on
  `VerificationReport`); the test shaper emits honest-empty arrays and the harness does not assert them. A richer
  test-result producer is a future enhancement (out of this milestone).
- Estimator divisor (3.5) calibration (conservatism direction pinned by a property test; constant tunable;
  not yet validated against a real provider tokenization corpus).
- Default per-lane token splits to be tuned against the 116k effective budget (shape/order fixed; ints tunable).
- `rehydrationReadiness` is vacuous in PR1 (gated at 0); PR2 must add meta-backed evicting repo-evidence
  items + full `readExcerpt` round-trip and tighten the threshold, or the deferred metric never bites.
- Path-free regex in the harness is corpus-specific; new fixture path prefixes must extend it.

## Post-milestone follow-ups

- **KEIKO-0726 (#3323), closed for every reachable production call site (2895 audit).** PR4's harness wiring
  (ADR-0055 D4) was narrower than this milestone's original scope for the agentic harness path:
  `HarnessShaperPort` recompacts individual `role:tool` messages reactively, but `keiko-harness/loop.ts`'s
  `checkModelCallLimits` still hard-failed on `maxContextBytes` alone, with zero compaction wired into the
  gate itself, for growth from assistant/user/system turns, working-memory, history-summary, or
  verification-evidence — an asymmetry this log did not previously disclose. `checkModelCallLimits` now gives
  an optional, injected `HarnessCompactionPort` one attempt to evict/compact history before hard-failing, with
  a production implementation (`packages/keiko-server/src/harness-context-compactor.ts`) that evicts by
  measured bytes alone — no token estimate or `ContextProfile` involved (a 2895 audit correction: an earlier
  revision seeded the eviction search from the `keiko-workflows` context-budget allocator's token-based
  exclusion count, which could over-evict relative to the actual byte budget; see ADR-0052 D9 for the full
  before/after). Segmentation had to be on assistant-message boundaries, not user-message boundaries: the
  harness never produces more than one `role:"user"` message per run, so the first landing of this compactor
  (segmenting on `role:"user"`) was a structural no-op against every real run — caught in post-merge review
  and fixed before landing. The port is injected at `agentProducerRoute.ts` (editor producer route),
  `productionReadOnlyChildRunner.ts` (read-only child runner) — both real `editor-agent-turn` call sites that
  loop through multiple model/tool rounds and can genuinely exceed `maxContextBytes` — and, since the 2895
  audit, `packages/keiko-cli/src/run.ts`'s `generate-unit-tests` / `investigate-bug` dispatch (the CLI already
  depends on `keiko-server`, so no package edge inverts; `explain-plan` stays excluded, see next sentence). It
  is deliberately NOT injected at `run-engine.ts`'s `dispatchExplain`: `explain-plan` is read-only and
  single-model-call by construction, so `checkModelCallLimits` never sees a prior assistant turn there and the
  port could never fire on that path — an earlier revision left it wired anyway as a documented no-op, which
  the 2895 audit removed rather than kept, since a wired-but-dead port invites a future reader to believe the
  path is covered. A compaction success emits a body-free `context:compacted` `HarnessEvent` (counts and byte
  totals only); the two server call sites bridge it into the server activity log as
  `op: "harness.context.compacted"` so a compacted run is reconstructable from `server.log` alone, while the
  CLI (no server activity-log sink in scope) lets it flow through its own existing `teeSink`/`CliEventSink`/
  `MemoryEventSink` pipeline unchanged. See ADR-0052 D9 for the full decision, its wiring-status breakdown, and
  its reconciliation with `HarnessShaperPort`.
