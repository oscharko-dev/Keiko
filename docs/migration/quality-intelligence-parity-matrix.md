# Quality Intelligence Migration Parity Matrix

_Point-in-time record: reflects the Epic #270 closure gate as of PR #490 (merged 2026-06-06), with delivery notes for rows 12–13 added after the closure gate. Capability citations (Keiko locations, public entry points, and the export-adapter inventory) were re-anchored against `release/0.2.0` in a later #285 verification pass; the live-proof counts below remain the closure-gate snapshot. For the full release-gate record with per-child commit SHAs, see [the historical parity matrix](../historical/quality-intelligence-parity-matrix.md)._

> Release-gate artifact for **Epic #270 — Integrate Test Intelligence as native Keiko Quality
> Intelligence** (Issue #285). It records, for every migrated Test Intelligence capability, an
> explicit **reuse decision** and the Keiko-owned location that delivers it — proving the behavior
> migrated into Keiko boundaries **without duplicating Keiko services**.

## References

- **Architecture decision**: [ADR-0023 — Quality Intelligence migration architecture](../adr/ADR-0023-quality-intelligence-migration-architecture.md).
- **Test Intelligence reference** (behavioral parity target, not an implementation path): the
  standalone `oscharko-dev/test-intelligence` product, reviewed at branch `dev`, commit
  `0ffeab80c045ac06b5ac6cb4c1f6bec03226b392` (per the Epic #270 baseline). Its valuable areas are
  **behavioral and domain-oriented**; its standalone runtime layers (`apps/workbench`,
  `packages/server`, `packages/cli`, `packages/model-gateway`, `packages/agentic-harness`,
  `packages/production-runner`, standalone stores) are explicitly **out of scope**.

## Reuse-decision legend

Each capability is classified as exactly one of:

| Decision       | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| **reused**     | Delivered by an existing Keiko service, used as-is.                     |
| **extended**   | An existing Keiko service was extended through a generic seam.          |
| **new-domain** | Narrowly scoped Keiko Quality Intelligence domain logic (pure package). |
| **rejected**   | Test Intelligence layer deliberately NOT carried forward.               |
| **deferred**   | Valuable, but out of this slice — needs a separate product decision.    |

## Capability matrix

| #   | Capability (TI behavioral reference)                                                                 | Decision                                                              | Keiko location                                                                                                                                                                                                          | Notes                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Requirements / human-context ingestion                                                               | new-domain                                                            | `keiko-quality-intelligence/src/generation/requirementsIngestion.ts`; `keiko-server/src/qualityIntelligence/runIngestion.ts` (exported `ingestInlineSources` → internal `ingestRequirements` branch)                    | Pasted requirement text is split into provenance-tracked atoms; bounded by `MAX_TOTAL_ATOMS`.                                                                                                                                                                                                                                                                              |
| 2   | Repository / local-source ingestion                                                                  | **reused**                                                            | `keiko-server/src/qualityIntelligence/runIngestion.ts` (exported `ingestInlineSources` → internal `ingestWorkspace` branch) → `keiko-workspace` `detectWorkspaceAt` / `discoverWithStats` / `buildContextPackFromFiles` | No independent source traversal; path containment + redaction inherited from `keiko-workspace`. Live-verified: a real folder → grounded test cases.                                                                                                                                                                                                                        |
| 3   | Model-assisted test-design generation                                                                | new-domain (prompt/parse) + **reused** (gateway)                      | `keiko-quality-intelligence/src/generation/{prompt.ts,parseGeneratedCandidates.ts}`; `keiko-workflows/src/qualityIntelligence/modelRoutedTestDesign.ts`; `keiko-server/src/qualityIntelligence/generationPort.ts`       | All productive model calls route through `keiko-model-gateway` `ModelPort`. Capability gate (`assertProfileCompatibleWithModel`); evidence-delimiter injection neutralized (`scrubEvidenceText`). Live-verified vs `gpt-oss-120b`.                                                                                                                                         |
| 4   | Workflow execution: plan → candidates → coverage → validate → finalize, with progress + cancellation | **reused** (`keiko-harness` / `keiko-workflows`) + new-domain runtime | `keiko-workflows/src/qualityIntelligence/{runtimeCommon.ts,modelRoutedTestDesign.ts,cancellation.ts}`                                                                                                                   | Composes the existing Harness world; emits the versioned QI run-event envelope. Cooperative cancellation settles status `cancelled` (not `failed`) — live-verified mid-flight abort.                                                                                                                                                                                       |
| 5   | Coverage relevance mapping                                                                           | new-domain                                                            | `keiko-workflows/src/qualityIntelligence/**` (`buildCoverageMap`)                                                                                                                                                       | Coverage stage maps candidates back to ingested atoms.                                                                                                                                                                                                                                                                                                                     |
| 6   | Validation findings                                                                                  | new-domain                                                            | `keiko-workflows/src/qualityIntelligence/**` (`validateCandidates`) + `keiko-contracts` `QualityIntelligenceValidationFinding`                                                                                          | Findings persisted on the manifest; surfaced in the run card.                                                                                                                                                                                                                                                                                                              |
| 7   | Review governance + artifact lifecycle (approve / reject / request-changes, four-eyes)               | new-domain + **reused** (evidence)                                    | `keiko-server/src/qualityIntelligence/{reviewStore.ts,reviewRoutes.ts}`; `keiko-quality-intelligence/src/review/**` (four-eyes)                                                                                         | Per-candidate + run-level review state in a mutable `<runId>.review.json` companion; audit count increments. Live-verified approve/reject persist.                                                                                                                                                                                                                         |
| 8   | Enterprise export / TMS mapping                                                                      | new-domain (adapters) + connector-gated                               | `keiko-server/src/qualityIntelligence/exportRoutes.ts`; `keiko-quality-intelligence` `QualityIntelligenceExport`                                                                                                        | Local file adapters (csv / spreadsheet-safe-csv / json / markdown / plain-text, plus binary pdf / zip-bundle) download a same-origin blob. **TMS adapters (jira-issues / qtest / xray / polarion / alm / quality-center) are dry-run preview only, force approved-only, and 403 on real write until a connector is configured** — live-verified. Bundle attests redaction. |
| 9   | Evidence / audit concepts                                                                            | **reused** (`keiko-evidence`) + new-domain companion artifacts        | `keiko-evidence/src/qualityIntelligence/{companionStore.ts,candidatesArtifact.ts,store.ts,manifestSchema.ts}`                                                                                                           | Immutable `<runId>.qi.json` manifest + mutable `<runId>.candidates.json`; realpath-contained atomic writes; **redaction-before-persist** (live-verified: zero Azure secret leakage).                                                                                                                                                                                       |
| 10  | Conversation Center → test design handoff                                                            | new-domain                                                            | `keiko-server/src/qualityIntelligence/handoffRoutes.ts`                                                                                                                                                                 | A "design-tests" handoff over a chat with a connected folder starts a background QI workspace run; consumes Keiko connector/handoff surfaces (no separate chat/agent/model channel).                                                                                                                                                                                       |
| 11  | Native UI surfaces                                                                                   | **rejected** (no Workbench embed) + new-domain (Workspace windows)    | `keiko-ui/src/app/components/desktop/widgets/quality-intelligence/**` (`QiHubPanel`, `QiRunCard`, `RunLauncher`, `CandidatesPane`, `ExportBar`)                                                                         | The Test Intelligence Workbench is NOT embedded. QI is a singleton Workspace **hub window** + per-run **result cards** on the canvas (no full-page route). Live-verified.                                                                                                                                                                                                  |
| 12  | Judge calibration                                                                                    | **new-domain**                                                        | `packages/keiko-server/src/qualityIntelligence/judgePort.ts` + workflow judge stage                                                                                                                                     | Initially deferred from this slice; since delivered as the adversarial test-quality judge (Epic #736, PR #843): capability-routed model-judge tier, fail-soft, call-budgeted, fully audited.                                                                                                                                                                               |
| 13  | Figma / Jira live context normalization                                                              | **new-domain**                                                        | `packages/keiko-quality-intelligence/src/domain/figma/` (clean→IR pipeline) + `keiko-server/src/qualityIntelligence/figmaSnapshotAdapter.ts`/`figmaSnapshotRoutes.ts`                                                   | Initially deferred; the Figma side has since shipped (Epic #750): PAT-only read-only connector, deterministic clean Snapshot ingestion as a QI source. Jira/TMS export remains dry-run-only by design (403 live-write guard).                                                                                                                                              |

## Rejected standalone-runtime layers

These Test Intelligence layers are deliberately **not** carried forward — Keiko already provides the
capability, and the Epic forbids parallel runtimes:

| Test Intelligence layer             | Keiko replacement                      |
| ----------------------------------- | -------------------------------------- |
| `apps/workbench` (second UI)        | `keiko-ui` Workspace windows           |
| `packages/server` (standalone HTTP) | `keiko-server` local BFF routes        |
| `packages/cli`                      | `keiko-cli`                            |
| `packages/model-gateway`            | `keiko-model-gateway` (`ModelPort`)    |
| `packages/agentic-harness`          | `keiko-harness` / `keiko-workflows`    |
| `packages/production-runner`        | `keiko-workflows` QI run entries       |
| Standalone stores / state root      | `keiko-evidence` + local runtime state |

The native implementation has **no dependency** on `@oscharko-dev/test-intelligence`, `@oscharko-dev/ti-*`,
Workbench build output, or the standalone dependency graph (enforced by `check:qi-supply-chain`).

## Architecture-invariant conformance

- New package `keiko-quality-intelligence` is a **pure domain package** — no HTTP server, secret
  store, model gateway, harness loop, scheduler, event bus, state DB, or UI runtime (enforced by
  `arch:check` / `arch:check:negative` / `check:package-surface`).
- Productive model calls only via `keiko-model-gateway`.
- Workflow execution only via `keiko-harness` / `keiko-workflows`.
- Runtime state local + governed; evidence redacted, retained, and audited via `keiko-evidence`.
- External connectors explicit, least-privilege, dry-run capable, disabled until configured.

## Release gate

**Static gates (all green):** `typecheck`, `lint`, `arch:check`, `arch:check:negative`,
`check:qi-supply-chain`, `check:package-surface`, `check:version-consistency`; at the closure gate:
root test suite (5905 passing) + `keiko-ui` suite (1067 passing).

**Live proof (real Azure `gpt-oss-120b`, no mocks):**

- Requirements ingestion → **31** authored test cases with correct atom provenance.
- Workspace-folder ingestion → **15** grounded test cases.
- Review approve/reject persisted with an incrementing audit trail.
- Export: local CSV (all + approved-only) + Jira dry-run preview (approved-only) + **403** on real
  TMS write.
- Cancellation mid-generation settles status `cancelled`.
- Evidence persisted as `<runId>.qi.json` / `.candidates.json` / `.review.json` with **zero** Azure
  secret leakage across all artifacts.
- UI: rail icon → QI hub window → run → result card (responsive test-case grid) → review → export,
  all as windows on the Workspace canvas; reopening a run dedupes to one card.
