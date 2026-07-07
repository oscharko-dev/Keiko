# HTML Manual Knowledge Pod Refresh Lifecycle Ledger

Status: implementation and verification ledger for Epic
[#1856](https://github.com/oscharko-dev/Keiko/issues/1856) and child issues
[#1890](https://github.com/oscharko-dev/Keiko/issues/1890),
[#1891](https://github.com/oscharko-dev/Keiko/issues/1891),
[#1892](https://github.com/oscharko-dev/Keiko/issues/1892),
[#1893](https://github.com/oscharko-dev/Keiko/issues/1893),
[#1894](https://github.com/oscharko-dev/Keiko/issues/1894), and
[#1895](https://github.com/oscharko-dev/Keiko/issues/1895).

This ledger records evidence only; it is not a substitute for local gate output, PR review, or
human-owned issue closure after merge. It contains only synthetic, redacted, body-free evidence:
counts, contract names, test-file names, and reason codes — never raw manual paths, URLs, page
content, or PII.

Epic #1856 extends the existing Local Knowledge HTML Manual indexing lifecycle to support **explicit
refresh** of an already-indexed manual pod. A refresh re-runs the approved bounded crawl and
re-indexes pages incrementally (unchanged skip, changed re-embed, removed prune), while failing
closed when a crawl limit is reached or the crawl is empty/cancelled. The pod diagnostics surface a
redacted change summary (counts + reason codes + an opaque crawl-run fingerprint only).

## Delivery scope

This epic delivers the refresh **capability, diagnostics, and their surfacing** at the domain,
contract, and UI-render layers. A live server-side refresh **trigger** (BFF route) and a
`gatewayFetch`-backed HTTP fetcher for intranet (`html-manual-http`) manuals are an explicit
follow-up — see [Known limitations and follow-ups](#known-limitations-and-follow-ups). HTML manual
pod _creation_ itself is not yet server-wired, so adding a network-egress refresh route is a separate
governed change that requires its own security review.

## Reuse anchors

| Area                  | Reused surface                                                                                                                              | Extension in this epic                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crawl runner          | `packages/keiko-local-knowledge/src/crawl/crawl-runner.ts` (`crawlManual`) + `scope-guard.ts` (`evaluateManualCrawlLink`)                   | Reused as-is. Refresh calls the same `crawlManual` with a scope reconstructed from persisted metadata; the same fail-closed scope guards apply.                                   |
| Indexing orchestrator | `packages/keiko-local-knowledge/src/indexing/orchestrator.ts` (`runIndexingJob`, `applyIncrementalFastPath`, `pruneDeletedSourceDocuments`) | Reused. Unchanged pages skip, changed pages re-embed, removed pages prune, all through the existing incremental path with a `sourceIds: [sourceId]` restriction.                  |
| Pod summary builder   | `packages/keiko-local-knowledge/src/knowledge-pods.ts` (`buildKnowledgePodSummary`)                                                         | Extended to surface the persisted redacted change summary as the additive optional `KnowledgePodSummary.manualRefresh` field.                                                     |
| Manual pod progress   | `packages/keiko-local-knowledge/src/manual-pod-progress.ts` (`buildHtmlManualIndexingProgress`)                                             | Reused as-is to project the refresh crawl + indexing into the same body-free `HtmlManualIndexingProgress`.                                                                        |
| Source metadata       | `packages/keiko-local-knowledge/src/manual-source-metadata.ts`                                                                              | Extended to persist and read back approved crawl limits + refresh bookkeeping; a new `updateHtmlManualRefreshState` records each refresh outcome.                                 |
| Contracts             | `packages/keiko-contracts/src/html-manual-source.ts`, `local-knowledge-pods.ts`                                                             | Additive: new `html-manual-refresh.ts` (`ManualRefreshChangeSummary` + validator + reason-code guidance) and an additive optional `manualRefresh` field on `KnowledgePodSummary`. |
| On-disk schema        | Migration manifest in `packages/keiko-contracts/src/local-knowledge-schema.ts`                                                              | Additive migration v27 (DB schema 26 → 27): new table `html_manual_page_fingerprints`; new nullable columns on `html_manual_sources`.                                             |

## New interfaces and functions

| Symbol                               | Location                                                     | Purpose                                                                                         |
| ------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `ManualRefreshChangeSummary`         | `keiko-contracts/src/html-manual-refresh.ts`                 | Body-free change projection: counts + reason codes + opaque crawl-run fingerprint + timestamp.  |
| `validateManualRefreshChangeSummary` | `keiko-contracts/src/html-manual-refresh.ts`                 | Hand-written validator (same idiom as the rest of the Local Knowledge contracts; no zod).       |
| `MANUAL_REFRESH_REASON_GUIDANCE`     | `keiko-contracts/src/html-manual-refresh.ts`                 | Browser-safe per-reason-code guidance strings for the UI.                                       |
| `ManualPageFingerprint` + helpers    | `keiko-local-knowledge/src/manual-page-fingerprints.ts`      | Per-page opaque content fingerprint (`sha256:<base64url>`); read/replace/crawl-run fingerprint. |
| `refreshHtmlManualPod`               | `keiko-local-knowledge/src/manual-pod-refresh.ts`            | Orchestrator: reconstruct approved scope, re-crawl, apply indexing incrementally, fail closed.  |
| `computeManualRefreshChangeSummary`  | `keiko-local-knowledge/src/manual-refresh-change-summary.ts` | Pure projection: diff page fingerprints + crawl deny tally + index counters → change summary.   |
| `updateHtmlManualRefreshState`       | `keiko-local-knowledge/src/manual-source-metadata.ts`        | Persist the last refresh outcome (timestamp, crawl-run id, redacted change-summary JSON).       |
| `KnowledgePodSummary.manualRefresh`  | `keiko-contracts/src/local-knowledge-pods.ts`                | Optional field surfacing the redacted change summary in the pod summary for UI diagnostics.     |

## Schema change (migration v27)

Additive and backward-compatible. Existing Local Knowledge stores keep working with no user action.

- New table `html_manual_page_fingerprints` — `(capsule_id, source_id, relative_path)` primary key,
  `content_fingerprint`, `byte_length`, `crawl_run_id`, `updated_at`. Cascade-deletes with the
  capsule/source.
- New nullable columns on `html_manual_sources`: `max_pages`, `max_depth`, `max_bytes`,
  `max_link_sample`, `timeout_ms`, `follow_redirects`, `source_scope_version`, `last_refreshed_at`,
  `last_crawl_run_id`, `last_change_summary_json`. Rows written at v26 remain valid (all new columns
  are nullable); a refresh over a legacy row falls back to the governed default limits.

## Governance invariants held

| Invariant                   | How enforced                                                                                                                                                                                                                                                                       | Evidence                                                                                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope preservation          | `refreshHtmlManualPod` reconstructs scope + limits ONLY from persisted metadata; the API accepts no caller scope. The same `crawlManual` scope guards fail closed on every escape vector.                                                                                          | `manual-pod-refresh.test.ts`: cross-origin denied test; `reconstructHtmlManualSource`.                                                                                                                    |
| Fail closed on limits       | A crawl with `status: "limit-reached"` is NOT applied (truncated crawls are non-authoritative). The prior pod is untouched.                                                                                                                                                        | `manual-pod-refresh.test.ts`: "fails closed on a limit-reached crawl".                                                                                                                                    |
| Fail closed on empty/cancel | An empty crawl (`outcome: "failed"`, reason `crawl-empty`) and a cancelled crawl (`outcome: "cancelled"`) are not applied; the prior pod is preserved.                                                                                                                             | `manual-pod-refresh.test.ts`: empty-crawl and cancelled-crawl tests.                                                                                                                                      |
| No cross-failure pruning    | `finalizeSourceRun` withholds pruning documents no longer discovered this run when the run recorded any per-document failure, so a genuine deletion is never conflated with an unrelated transient failure. Fixed post-merge (see [Known gap](#known-limitations-and-follow-ups)). | `orchestrator.test.ts`: "does not prune a deleted file's document when another file in the same run fails to re-embed"; `manual-pod-refresh.test.ts`: "does not prune a page that disappeared upstream…". |
| Incremental indexing reuse  | Refresh uses the same `runIndexingJob` incremental fast-path and prune; no second crawl or retrieval path.                                                                                                                                                                         | `manual-pod-refresh.ts` reuses `runIndexingJob`, `createManualPageWorkspaceFs`, `buildKnowledgePodSummary`.                                                                                               |
| Body-free diagnostics       | `ManualRefreshChangeSummary` carries only counts, reason codes, a timestamp, and an opaque crawl-run fingerprint. No paths, URLs, or page content.                                                                                                                                 | `manual-refresh-change-summary.test.ts` redaction test; `html-manual-refresh.test.ts` validator.                                                                                                          |
| Removal-detection honesty   | When the crawl reaches its limit, `removalDetection: "not-evaluated-page-limit"` and `removedPages: 0`; a truncated crawl cannot distinguish removed from out-of-budget.                                                                                                           | `manual-refresh-change-summary.test.ts`: limit-reached test; `manual-pod-refresh.test.ts`.                                                                                                                |

## Scenario coverage (regression evidence)

Test file names below are the actual co-located suites in `packages/keiko-local-knowledge/src/` and
`packages/keiko-contracts/src/`.

| Scenario                                                                                                | Regression evidence                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unchanged manual → `unchanged`                                                                          | `manual-pod-refresh.test.ts`: "reports an unchanged manual as unchanged and preserves the ready pod"                                                                                                           |
| Changed page → re-embed, `updated`                                                                      | `manual-pod-refresh.test.ts`: "classifies a changed page and re-indexes it"                                                                                                                                    |
| Newly reachable page → added                                                                            | `manual-pod-refresh.test.ts`: "classifies a newly reachable page as added"                                                                                                                                     |
| Unreachable page → removed + pruned                                                                     | `manual-pod-refresh.test.ts`: "classifies and prunes a page that is no longer reachable"                                                                                                                       |
| Limit-reached → fail closed, `partial`                                                                  | `manual-pod-refresh.test.ts`: "fails closed on a limit-reached crawl, leaving the previous pod untouched"                                                                                                      |
| No scope widening (cross-origin denied)                                                                 | `manual-pod-refresh.test.ts`: "does not widen scope: cross-origin links are denied…"                                                                                                                           |
| Cancelled crawl → prior pod intact                                                                      | `manual-pod-refresh.test.ts`: "leaves the previous pod usable when the crawl is cancelled"                                                                                                                     |
| Empty crawl → prior pod intact                                                                          | `manual-pod-refresh.test.ts`: "leaves the previous pod usable when the refresh crawl is empty"                                                                                                                 |
| Persisted redacted summary + crawl-run id                                                               | `manual-pod-refresh.test.ts`: "persists the redacted change summary and crawl-run id for later diagnostics"                                                                                                    |
| No content/path/origin leak in diagnostics                                                              | `manual-pod-refresh.test.ts`: "does not leak raw content, private paths, or the origin…"                                                                                                                       |
| Non-manual source rejected                                                                              | `manual-pod-refresh.test.ts`: "throws for a source that is not an approved HTML manual"                                                                                                                        |
| Change classification (added/changed/removed/unchanged)                                                 | `manual-refresh-change-summary.test.ts`: "classifies added, changed, removed, and unchanged pages…"                                                                                                            |
| Partial (indexing failures)                                                                             | `manual-refresh-change-summary.test.ts`: "marks the refresh partial when some pages failed to index"                                                                                                           |
| Embedding-incompatible surfaced                                                                         | `manual-refresh-change-summary.test.ts`: "surfaces an embedding-incompatible refresh"                                                                                                                          |
| Denied-link counting                                                                                    | `manual-refresh-change-summary.test.ts`: "counts denied links from the crawl deny tally"                                                                                                                       |
| Migration v27 additive + cascade                                                                        | `local-knowledge-schema.test.ts`: "applies v27 on top of a v26 database…"                                                                                                                                      |
| Fingerprint determinism + isolation                                                                     | `manual-page-fingerprints.test.ts` (compute/read/replace suites); crawl-run fingerprint determinism/order-independence/sensitivity in the same file.                                                           |
| UI panel a11y + no-leak (updated/partial/failed/removal-skipped)                                        | `packages/keiko-ui/src/app/local-knowledge/connector-graph.test.tsx` (manual refresh diagnostics panel)                                                                                                        |
| Fingerprint baseline withheld for a page whose own re-embed fails, masked by an otherwise-succeeded job | `manual-pod-refresh.test.ts`: "does not advance the fingerprint baseline for a page whose re-embed fails…"                                                                                                     |
| A page removed upstream survives a run where a different page fails to re-embed                         | `manual-pod-refresh.test.ts`: "does not prune a page that disappeared upstream…"; `orchestrator.test.ts`: "does not prune a deleted file's document…"                                                          |
| Known gap: a page's own vectors are not rolled back when its own re-embed fails                         | `manual-pod-refresh.test.ts`: "characterizes the known gap: a changed page's vectors are not rolled back…" (pins current behaviour; see [Known limitations and follow-ups](#known-limitations-and-follow-ups)) |
| Refresh progress phase for a finished, limit-reached, indexing-skipped run                              | `manual-pod-progress.test.ts`: "reports a limit-reached refresh with no indexing run as degraded, not crawling…"                                                                                               |

## Per-child mapping

| Issue | Scope                                                                                                  | Primary files                                                                                                        | Status                         |
| ----- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| #1890 | Persisted crawl limits + per-page fingerprints + `ManualRefreshChangeSummary` contract + migration v27 | `local-knowledge-schema.ts`, `html-manual-refresh.ts`, `manual-page-fingerprints.ts`, `manual-source-metadata.ts`    | Implemented + locally verified |
| #1891 | `refreshHtmlManualPod` orchestrator: scope reconstruction, fail-closed logic, incremental indexing     | `manual-pod-refresh.ts`, `manual-pod.ts` (initial fingerprint baseline)                                              | Implemented + locally verified |
| #1892 | `computeManualRefreshChangeSummary`: redacted change projection + diagnostics                          | `manual-refresh-change-summary.ts`                                                                                   | Implemented + locally verified |
| #1893 | `KnowledgePodSummary.manualRefresh` field + read-only UI diagnostics panel                             | `local-knowledge-pods.ts`, `knowledge-pods.ts`, `keiko-ui` connector-graph panel + `manual-refresh-panel.module.css` | Implemented + locally verified |
| #1894 | Refresh regression suite                                                                               | `manual-pod-refresh.test.ts`, `manual-refresh-change-summary.test.ts`                                                | Implemented + locally verified |
| #1895 | Operator runbook + closure-evidence ledger                                                             | `docs/troubleshooting/html-manual-pod-refresh.md`, this ledger, `docs/troubleshooting/README.md`                     | Implemented                    |

Issues remain open pending PR review, required GitHub checks, merge, and human-owned closure. No
issue is marked done in this ledger.

## Security and architecture disposition

- **Scope preservation at the orchestrator:** the refresh API accepts only capsule + source ids; the
  scope + limits are reconstructed from persisted approved metadata and re-validated through
  `validateHtmlManualSource`, then re-checked by the same `crawlManual` scope guards used at pod
  creation. A caller cannot widen the origin/root/path-prefix or the crawl budget.
- **Fail closed on limits/cancellation/empty _before indexing starts_:** a crawl that reaches any
  limit is recognised and not applied; the same holds for a crawl that is cancelled or finds zero
  pages while it is still crawling. In each of these cases the refresh never enters its apply path
  (the source scope is not updated and indexing never runs), so the prior pod state is provably
  unmodified. This guarantee does **not** extend to a `partial`, `failed`, or indexing-phase
  `cancelled` outcome that occurs _after_ a crawl has already completed within budget — see
  [Known limitations and follow-ups](#known-limitations-and-follow-ups) for the gap. The per-page
  fingerprint baseline advances only on a clean indexing success in every case.
- **Body-free diagnostics:** `ManualRefreshChangeSummary` is redacted by construction — counts,
  closed reason codes, a timestamp, and an opaque `sha256:<base64url>` crawl-run fingerprint only.
  No raw manual path, URL, or page body appears in the contract, the persisted record, or the UI.
- **No new network egress or trust boundary:** `keiko-local-knowledge` remains egress-free
  ([ADR-0019](../adr/ADR-0019-modular-package-architecture.md) trust-9 — verified by
  `check-import-policy`). Byte retrieval stays behind the injected `ManualCrawlFetcher` port. All
  indexed content continues through the sealed store writers
  ([ADR-0047](../adr/ADR-0047-local-knowledge-content-encryption.md)).
- **Boundaries unchanged:** additive lifecycle operation; no new package edges (`arch:check` green),
  no boundary move, and the governed documentation-browser trust model
  ([ADR-0113](../adr/ADR-0113-governed-documentation-browser.md)) is unaffected. No new ADR is
  introduced, so `check:adr-index` stays green.

## Known limitations and follow-ups

### Known gap: an indexing-phase failure/partial does not roll back a changed page's vectors

The scope-preservation and fail-closed guarantees above hold in full for any refresh that never
completes its crawl (limit-reached, empty, or crawl-phase cancellation) — in those cases the pod
is provably untouched, because the refresh never enters its apply path.

Once a refresh crawl **does** complete within budget, `refreshHtmlManualPod`
(`packages/keiko-local-knowledge/src/manual-pod-refresh.ts`, `applyRefresh`) narrows the source's
scope to the new crawl's page set and starts incremental indexing (the reused
`runIndexingJob`/`applyIncrementalFastPath`/`pruneDeletedSourceDocuments` orchestrator path) before
the indexing outcome is known. Two consequences of that ordering were audited post-merge:

- **Fixed:** pages no longer in the new crawl's page set were previously pruned even when another
  document in the same run failed to (re-)embed, so a genuinely-deleted page and an unrelated
  transient failure could combine into an over-eager prune. `finalizeSourceRun`
  (`packages/keiko-local-knowledge/src/indexing/orchestrator.ts`) now withholds pruning for a
  source's run whenever that run recorded any per-document failure, mirroring the existing guard
  that already withholds pruning when the discovered-path set hits `maxFiles`. Regression:
  `orchestrator.test.ts` — "does not prune a deleted file's document when another file in the same
  run fails to re-embed".
- **Still open:** a changed page's previous vectors are deleted (via chunk replacement, which
  cascade-deletes the chunk-linked vectors) before its new content is re-embedded; if that specific
  page's re-embed call fails, the page is left with no vectors or chunks rather than its previous
  (good) ones, for the window until a future successful refresh repairs it. The persisted per-page
  fingerprint baseline is withheld from advancing for that page (`manual-pod-refresh.ts`,
  Issue #1891 fix), so a subsequent refresh always re-attempts and can repair it — this closes the
  _permanent, silent data-loss_ risk, but does not close the _temporary unsearchable window_ for
  that one page. Fixing this fully requires either changing the shared indexing orchestrator's
  chunk/embed pipeline to stage new content and only swap it in on a confirmed-successful embed
  ("embed-then-swap"), or a snapshot/restore primitive for a single document's chunks+vectors+
  lexical rows. Both are cross-cutting changes to
  `packages/keiko-local-knowledge/src/indexing/orchestrator.ts`, used by every indexing job in the
  product (not just HTML manual refresh), and interact with the bounded/checkpointed
  large-document resume path, which persists chunks as its resume boundary. That is a properly
  scoped architecture change requiring its own design and review, not a same-change fix — tracked
  as follow-up work; reproduction preserved as
  `manual-pod-refresh.test.ts` — "characterizes the known gap: a changed page's vectors are not
  rolled back when its own re-embed fails".

The operator-facing guidance strings for the `pages-failed`, `index-failed`, and `crawl-cancelled`
reason codes (`MANUAL_REFRESH_REASON_GUIDANCE` in `packages/keiko-contracts/src/html-manual-refresh.ts`)
previously read "the previous pod state is unchanged" / "were left unchanged" unconditionally, which
overstated the guarantee for the still-open case above. They now say a page may be "temporarily
unsearchable" and will be retried on a future refresh, which is accurate for both the fixed and the
still-open sub-case.

### Deferred: server-side refresh trigger route and HTTP fetcher

The refresh capability, diagnostics, and their surfacing are implemented and locally verified.
The following are explicitly out of scope for this epic and are follow-up work:

- **BFF refresh trigger route:** an HTTP endpoint that triggers a refresh from the UI. HTML manual
  pod _creation_ is not yet server-wired, so wiring a refresh route is a separate change. It will
  need same-origin/CSRF handling, the correlation-id error-observability pattern, and progress
  surfacing.
- **`gatewayFetch`-backed HTTP `ManualCrawlFetcher`:** the refresh is agnostic to the fetcher
  (an injected interface). A `WorkspaceFs`-backed fetcher covers local (`html-manual-local`)
  manuals. An HTTP fetcher for intranet (`html-manual-http`) manuals introduces network egress and
  must land in `keiko-server` (never `keiko-local-knowledge`, trust-9) behind its own egress, TLS,
  DNS-rebinding, and credential security review.
- **UI refresh-initiation UX and live progress streaming:** the current UI panel is read-only — it
  renders the last redacted refresh summary from `KnowledgePodSummary.manualRefresh`. A refresh
  button, confirm dialog, and live progress indicator depend on the deferred trigger route.

### Legacy pods (pre-v27)

A refresh over an `html_manual_sources` row written before migration v27 (which has no persisted
limits) falls back to the governed default limits. Because the defaults are the maximum allowed
bound, this never widens beyond policy; a refresh could, however, crawl a wider budget than a
pre-v27 pod originally used. In practice there are no such legacy manual pods yet, because pod
creation is not server-wired.

## Local gate outcomes

Run from a clean checkout at the epic branch. Results recorded by the coordinator on
2026-07-07 (macOS / Node 22.22):

| Gate                                                   | Result                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`                                    | PASS                                                                                                                                                                                                                                                                     |
| `npm run lint`                                         | PASS (root + `@oscharko-dev/keiko-ui`)                                                                                                                                                                                                                                   |
| `npm run format:check`                                 | PASS                                                                                                                                                                                                                                                                     |
| `npm test` (keiko-local-knowledge + keiko-contracts)   | PASS — 3947 tests (1114 `keiko-local-knowledge` + 2833 `keiko-contracts`)                                                                                                                                                                                                |
| `@oscharko-dev/keiko-ui` test suite                    | PASS — 4416 tests                                                                                                                                                                                                                                                        |
| `npm run arch:check`                                   | PASS (dependency-cruiser + import-policy + contract-boundaries)                                                                                                                                                                                                          |
| `npm run arch:check:negative`                          | PASS (exit 0)                                                                                                                                                                                                                                                            |
| `npm run typecheck --workspace @oscharko-dev/keiko-ui` | PASS                                                                                                                                                                                                                                                                     |
| `npm run test:coverage:quality`                        | PASS — all selected packages satisfy their branch floors (keiko-local-knowledge 90.90% lines / 79.88% branches, floor 78.07%).                                                                                                                                           |
| `npm run check:package-surface`                        | Not completable on macOS — blocked by the platform-specific `@napi-rs/canvas-darwin-arm64` native dependency. The additive contract exports do not appear in `scripts/root-package-surface.contract.json`, so the root surface is unaffected. Linux CI is authoritative. |
| `npm run check:editor-release-evidence`                | `keiko-ui` changed (#1893 panel) → the bundle-evidence fingerprint must be regenerated by CI/Linux. It is platform-specific; a macOS value must NOT be committed.                                                                                                        |

Coverage floors (`docs/qa/package-coverage-baseline.json`) for the touched packages: new modules are
fully covered by their co-located tests, and edits to existing files ship with their own tests, so
per-package and per-file floors are maintained or raised.

## Post-merge audit gate outcomes

A post-merge audit re-verified all six child issues and the epic against the current code (this
branch, after af785de1), fixed the confirmed defects in [Known limitations and follow-ups](#known-limitations-and-follow-ups),
and re-ran the full local gate set. Recorded by the coordinator (macOS / Node 22.22):

| Gate                                                   | Result                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                    | PASS                                                                                                                                                                                                                                                                                                                                                                   |
| `npm run lint`                                         | PASS (root + `@oscharko-dev/keiko-ui`)                                                                                                                                                                                                                                                                                                                                 |
| `npm run format:check`                                 | PASS                                                                                                                                                                                                                                                                                                                                                                   |
| `npm test` (full monorepo)                             | PASS — 1000 test files, 16958 tests passed, 2 pre-existing skips                                                                                                                                                                                                                                                                                                       |
| `keiko-local-knowledge` + `keiko-contracts` suites     | PASS — 3968 tests (184 files)                                                                                                                                                                                                                                                                                                                                          |
| `@oscharko-dev/keiko-ui` test suite                    | PASS — 4418 tests (269 files)                                                                                                                                                                                                                                                                                                                                          |
| `npm run arch:check`                                   | PASS (2643 modules, 7296 dependencies cruised; no violations)                                                                                                                                                                                                                                                                                                          |
| `npm run arch:check:negative`                          | PASS (exit 0; 40 expected fixture violations correctly detected)                                                                                                                                                                                                                                                                                                       |
| `npm run typecheck --workspace @oscharko-dev/keiko-ui` | PASS                                                                                                                                                                                                                                                                                                                                                                   |
| `npm run test:coverage:ui`                             | PASS                                                                                                                                                                                                                                                                                                                                                                   |
| `npm run test:coverage:quality`                        | PASS — `keiko-local-knowledge` 90.98% lines / 79.99% branches (floor 78.07%, ratcheted); no package below its floor                                                                                                                                                                                                                                                    |
| `npm run check:adr-index`                              | PASS — 86 unique ADR numbers, all indexed, no orphan links                                                                                                                                                                                                                                                                                                             |
| `npm run check:retrieval-quality`                      | PASS — all fixtures at threshold, regressions correctly fail closed                                                                                                                                                                                                                                                                                                    |
| `npm run check:grounded-retrieval-quality`             | PASS — top1/recall/nDCG/citation-support at 100%, reranker/embedding regressions correctly fail closed                                                                                                                                                                                                                                                                 |
| `npm run check:grounded-faithfulness`                  | PASS — unsupported-detection/citation-precision/abstention at 100%                                                                                                                                                                                                                                                                                                     |
| `npm run check:package-surface`                        | Not completable on macOS — blocked by the platform-specific `@napi-rs/canvas-darwin-arm64` native dependency (pre-existing, unrelated to this change). No new package exports were added. Linux CI is authoritative.                                                                                                                                                   |
| `npm run check:editor-release-evidence`                | Not completable on macOS — `keiko-ui` changed (test file + a one-line CSS selector fix), so the committed evidence is reported stale; a local macOS regen showed byte-level `b2`/`b3`/`workers`/`editorRuntimeChunks` drift from gzip/compression differences alone (the known macOS-vs-Linux measurement divergence), not committed. Must be regenerated by CI/Linux. |

Defects found and fixed in this audit (see [Known limitations and follow-ups](#known-limitations-and-follow-ups)
and the epic's post-merge audit record for full detail): a redacted-validator field-leak and an
obfuscated-fingerprint bypass (#1890); a masked per-document indexing failure silently advancing the
fingerprint baseline, plus a cross-failure over-eager prune (#1891); an empty/cancelled crawl
falsely reporting removed pages, an unapplied refresh falsely claiming pages were indexed, and a
budget-exhaustion sentinel inflating the denied-link count (#1892); a CSS selector that never
matched its target element, an untested cancelled-outcome UI branch, and a missing `onlyKeys`
defense-in-depth on the summary validator (#1893); two under-tested fail-closed guard branches and
missing end-to-end coverage for an indexing-phase failure (#1894); stale test-count claims and a
doc section that described a live UI flow which does not exist yet (#1895); and, at the epic
integration level, the still-open vector-rollback gap described above, a progress-phase
misclassification for a finished limit-reached refresh with no indexing run, and a committed raw
NUL byte used as an invisible field separator in the crawl-run fingerprint helper.
