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

| Invariant                   | How enforced                                                                                                                                                                              | Evidence                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Scope preservation          | `refreshHtmlManualPod` reconstructs scope + limits ONLY from persisted metadata; the API accepts no caller scope. The same `crawlManual` scope guards fail closed on every escape vector. | `manual-pod-refresh.test.ts`: cross-origin denied test; `reconstructHtmlManualSource`.                      |
| Fail closed on limits       | A crawl with `status: "limit-reached"` is NOT applied (truncated crawls are non-authoritative). The prior pod is untouched.                                                               | `manual-pod-refresh.test.ts`: "fails closed on a limit-reached crawl".                                      |
| Fail closed on empty/cancel | An empty crawl (`outcome: "failed"`, reason `crawl-empty`) and a cancelled crawl (`outcome: "cancelled"`) are not applied; the prior pod is preserved.                                    | `manual-pod-refresh.test.ts`: empty-crawl and cancelled-crawl tests.                                        |
| Incremental indexing reuse  | Refresh uses the same `runIndexingJob` incremental fast-path and prune; no second crawl or retrieval path.                                                                                | `manual-pod-refresh.ts` reuses `runIndexingJob`, `createManualPageWorkspaceFs`, `buildKnowledgePodSummary`. |
| Body-free diagnostics       | `ManualRefreshChangeSummary` carries only counts, reason codes, a timestamp, and an opaque crawl-run fingerprint. No paths, URLs, or page content.                                        | `manual-refresh-change-summary.test.ts` redaction test; `html-manual-refresh.test.ts` validator.            |
| Removal-detection honesty   | When the crawl reaches its limit, `removalDetection: "not-evaluated-page-limit"` and `removedPages: 0`; a truncated crawl cannot distinguish removed from out-of-budget.                  | `manual-refresh-change-summary.test.ts`: limit-reached test; `manual-pod-refresh.test.ts`.                  |

## Scenario coverage (regression evidence)

Test file names below are the actual co-located suites in `packages/keiko-local-knowledge/src/` and
`packages/keiko-contracts/src/`.

| Scenario                                                         | Regression evidence                                                                                         |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Unchanged manual → `unchanged`                                   | `manual-pod-refresh.test.ts`: "reports an unchanged manual as unchanged and preserves the ready pod"        |
| Changed page → re-embed, `updated`                               | `manual-pod-refresh.test.ts`: "classifies a changed page and re-indexes it"                                 |
| Newly reachable page → added                                     | `manual-pod-refresh.test.ts`: "classifies a newly reachable page as added"                                  |
| Unreachable page → removed + pruned                              | `manual-pod-refresh.test.ts`: "classifies and prunes a page that is no longer reachable"                    |
| Limit-reached → fail closed, `partial`                           | `manual-pod-refresh.test.ts`: "fails closed on a limit-reached crawl, leaving the previous pod untouched"   |
| No scope widening (cross-origin denied)                          | `manual-pod-refresh.test.ts`: "does not widen scope: cross-origin links are denied…"                        |
| Cancelled crawl → prior pod intact                               | `manual-pod-refresh.test.ts`: "leaves the previous pod usable when the crawl is cancelled"                  |
| Empty crawl → prior pod intact                                   | `manual-pod-refresh.test.ts`: "leaves the previous pod usable when the refresh crawl is empty"              |
| Persisted redacted summary + crawl-run id                        | `manual-pod-refresh.test.ts`: "persists the redacted change summary and crawl-run id for later diagnostics" |
| No content/path/origin leak in diagnostics                       | `manual-pod-refresh.test.ts`: "does not leak raw content, private paths, or the origin…"                    |
| Non-manual source rejected                                       | `manual-pod-refresh.test.ts`: "throws for a source that is not an approved HTML manual"                     |
| Change classification (added/changed/removed/unchanged)          | `manual-refresh-change-summary.test.ts`: "classifies added, changed, removed, and unchanged pages…"         |
| Partial (indexing failures)                                      | `manual-refresh-change-summary.test.ts`: "marks the refresh partial when some pages failed to index"        |
| Embedding-incompatible surfaced                                  | `manual-refresh-change-summary.test.ts`: "surfaces an embedding-incompatible refresh"                       |
| Denied-link counting                                             | `manual-refresh-change-summary.test.ts`: "counts denied links from the crawl deny tally"                    |
| Migration v27 additive + cascade                                 | `local-knowledge-schema.test.ts`: "applies v27 on top of a v26 database…"                                   |
| Fingerprint determinism + isolation                              | `manual-page-fingerprints.test.ts` (compute/read/replace suites)                                            |
| UI panel a11y + no-leak (updated/partial/failed/removal-skipped) | `packages/keiko-ui/src/app/local-knowledge/connector-graph.test.tsx` (manual refresh diagnostics panel)     |

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
- **Fail closed on limits/cancellation/empty:** a crawl that reaches any limit is recognised and not
  applied; the same holds for cancellation and empty crawls. The prior pod state is never overwritten
  on a partial or failed refresh, and the per-page fingerprint baseline advances only on a clean
  indexing success.
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
| `npm test` (keiko-local-knowledge + keiko-contracts)   | PASS — 3942 tests                                                                                                                                                                                                                                                        |
| `@oscharko-dev/keiko-ui` test suite                    | PASS — 4415 tests                                                                                                                                                                                                                                                        |
| `npm run arch:check`                                   | PASS (dependency-cruiser + import-policy + contract-boundaries)                                                                                                                                                                                                          |
| `npm run arch:check:negative`                          | PASS (exit 0)                                                                                                                                                                                                                                                            |
| `npm run typecheck --workspace @oscharko-dev/keiko-ui` | PASS                                                                                                                                                                                                                                                                     |
| `npm run test:coverage:quality`                        | PASS — all selected packages satisfy their branch floors (keiko-local-knowledge 90.90% lines / 79.88% branches, floor 78.07%).                                                                                                                                           |
| `npm run check:package-surface`                        | Not completable on macOS — blocked by the platform-specific `@napi-rs/canvas-darwin-arm64` native dependency. The additive contract exports do not appear in `scripts/root-package-surface.contract.json`, so the root surface is unaffected. Linux CI is authoritative. |
| `npm run check:editor-release-evidence`                | `keiko-ui` changed (#1893 panel) → the bundle-evidence fingerprint must be regenerated by CI/Linux. It is platform-specific; a macOS value must NOT be committed.                                                                                                        |

Coverage floors (`docs/qa/package-coverage-baseline.json`) for the touched packages: new modules are
fully covered by their co-located tests, and edits to existing files ship with their own tests, so
per-package and per-file floors are maintained or raised.
