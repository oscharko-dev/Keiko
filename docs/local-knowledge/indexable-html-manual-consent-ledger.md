# Indexable HTML Manual Consent Ledger

Status: implementation and verification ledger for Epic #1852 and child issues #1865–#1870.

This ledger records evidence only. It is not a substitute for local gate output, PR review, or
human-owned issue closure after merge. Epic #1852 is the consent boundary that turns the governed
documentation browser (Epic #1851, ADR-0113) into a proposed Knowledge Pod source candidate. It adds
detection, a bounded scope preview, explicit consent, and a redacted handoff — and no crawler,
indexer, model call, or new egress. Actual crawling/indexing is the future Epic #1853 (out of scope).

## Reuse anchors

| Area           | Reused surface                                                                                        | Extension                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Contracts      | `classifyDocumentationTarget`, `DocumentationBrowserCapability`, text-safety redaction primitives     | `documentation-manual-proposal.ts`: proposal states, pure `detectIndexableManual`, scope preview, matcher, approval |
| Contracts      | `KnowledgePodSummary` + `validateKnowledgePodSummary`                                                 | Optional, content-free `manualSourceFingerprint` for already-indexed detection                                      |
| Server / BFF   | `POST /api/docs-browser/navigate`, `readDocsBrowserJsonBody`, correlation-id error bodies             | `POST /api/docs-browser/propose` + `/approve` (no target egress; read-only pod lookup only)                         |
| Server         | `keiko-security` `sha256Hex`/`canonicalise`, `listKnowledgePodSummaries`, `openKnowledgeStoreForDeps` | Normalized-root fingerprint + best-effort already-indexed lookup, computed in server (contracts is a leaf)          |
| UI             | `DocumentationBrowserWidget`, `bffFetchJson`, component-scoped `.db-*` CSS, `lib/types.ts` seam       | Inline consent flow (propose → scope preview → approve), no new lazy chunk, no `globals.css` edit                   |
| Retrieval / LK | Local Knowledge indexing/retrieval pipeline                                                           | Untouched — this epic starts none of it; the approval only hands off to #1853                                       |

## Scenario coverage

| Scenario                              | Expected behavior                                                                      | Regression evidence                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| index.html / doc-path manual          | `likely-manual`, high confidence, scope preview attached                               | `documentation-manual-proposal.test.ts`, `docs-browser-proposal.test.ts`       |
| documentation directory / weak signal | `probable-manual`, medium/low confidence; consent still required                       | `documentation-manual-proposal.test.ts`                                        |
| local index.html                      | `requires-local-file-approval`, local source kind                                      | `documentation-manual-proposal.test.ts`                                        |
| action / login / dynamic page         | `degraded`, not offered for approval                                                   | `documentation-manual-proposal.test.ts`, `docs-browser-consent-safety.test.ts` |
| external / unsupported scheme         | `unsupported`, no scope preview, approval refused (409)                                | `documentation-manual-proposal.test.ts`, `docs-browser-proposal.test.ts`       |
| credentials in target                 | `denied`; credential never echoed                                                      | `documentation-manual-proposal.test.ts`, `docs-browser-consent-safety.test.ts` |
| already-indexed root                  | proposal overridden to `already-indexed` with pod id; approval refused (409)           | `documentation-manual-proposal.test.ts`, `docs-browser-proposal.test.ts`       |
| bounded scope preview                 | explicit limits, `followRedirects:false`, `estimatedPageCount:null`, denied classes    | `documentation-manual-proposal.test.ts`, `docs-browser-proposal.test.ts`       |
| explicit consent → handoff            | approval requires an explicit action; returns redacted `DocumentationIndexingApproval` | `DocumentationBrowserWidget.test.tsx`, `docs-browser-proposal.test.ts`         |
| cancel / denied / degraded UI         | no "Create Knowledge Pod" action offered; safe copy + remediation                      | `DocumentationBrowserWidget.test.tsx`                                          |
| pre-consent no side effect            | 0 capsules, 0 indexing jobs, no model-port request across a hostile battery            | `docs-browser-consent-safety.test.ts`                                          |
| redaction / leakage                   | no raw token/credential/private path/query in any response                             | `docs-browser-consent-safety.test.ts`, `docs-browser-api.test.ts`              |

## Gate matrix

| Gate                       | Status              | Evidence                                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript (strict, tests) | passed              | `npm run typecheck`                                                                                                                                                                                                                                                                                     |
| Lint                       | passed              | `npm run lint` (`eslint . --max-warnings=0` + keiko-ui lint)                                                                                                                                                                                                                                            |
| Formatting                 | passed              | `npm run format:check`                                                                                                                                                                                                                                                                                  |
| Full test suite            | passed              | `npm test` — 16626 passed, 2 skipped, 982 files                                                                                                                                                                                                                                                         |
| Architecture               | passed              | `npm run arch:check` (dependency-cruiser + import-policy + contract-boundaries)                                                                                                                                                                                                                         |
| Architecture (negative)    | passed              | `npm run arch:check:negative` (exit 0; expected fixture violations detected)                                                                                                                                                                                                                            |
| Error observability        | passed              | `npm run check:error-observability`                                                                                                                                                                                                                                                                     |
| UI coverage                | passed              | `npm run test:coverage:ui` (exit 0)                                                                                                                                                                                                                                                                     |
| Coverage quality (ratchet) | passed              | `npm run test:coverage:quality` (all package branch floors met; keiko-contracts 90.65%, keiko-server 76.13%, keiko-ui 76.69%)                                                                                                                                                                           |
| Package surface            | Linux-authoritative | Not finalizable on macOS: the tarball picks up a macOS-only native dep (`@napi-rs/canvas-darwin-arm64`). No new package export subpath was added, so no root-package-surface drift; CI/Linux is authoritative.                                                                                          |
| Editor release evidence    | Linux-authoritative | `check:editor-release-evidence` reports a stale fingerprint (the widget content changed; `staticExport.fileCount` is unchanged at 255, i.e. no new chunk). The value is platform-specific — regenerate on CI/Linux and commit; do NOT commit a macOS regen of `docs/release/1209-bundle-evidence.json`. |

## Security / governance evidence (#1870)

- **No target egress.** Neither `/propose` nor `/approve` fetches, crawls, or reads the documentation
  target. Detection (`detectIndexableManual`) and preview (`buildManualScopePreview`) are pure over the
  user-entered URL shape. The only local touch is a read-only `listKnowledgePodSummaries` lookup for
  duplicate detection (`openKnowledgeStoreForDeps` with `recover:false`).
- **No write, no model.** `docs-browser-consent-safety.test.ts` runs the routes against a hostile
  target battery on a REAL SQLite store and asserts 0 capsules and 0 `indexing_jobs` rows afterward and
  that `modelPortFactory` is never invoked — so no capsule/document/chunk/vector/job is created and no
  embedding/reranker/chat model can be called pre-consent.
- **Redaction.** Origin/path-prefix summaries are `scheme://host[:port]` + `/` or `/…` only; the pod
  name is host-derived; the source fingerprint is a SHA-256 hash (never a raw root). Credentials
  collapse to `denied` without hinting. Leakage assertions cover propose/approve responses and error
  bodies.
- **Fail closed.** Consent is a compile-time literal (`approvalRequired: true` / `approved: false`).
  `/approve` re-derives the proposal server-side and refuses any non-approvable or already-indexed
  target with a 409.

## Known limitations and follow-ups

- **Already-indexed activation.** No HTML-manual Knowledge Pod exists until the future crawler epic
  (#1853) populates `manualSourceFingerprint` on created pods. The matcher, server override, and
  fingerprint are implemented and unit-tested (contract matcher + server resolver with an injected pod
  lister); end-to-end duplicate detection activates when #1853 sets the field.
- **Estimated page count** is `null` pre-consent by design: sampling is deferred to post-consent
  indexing, which does not exist yet. The scope preview surfaces the bounded limits instead.
- **Rendered capture and crawling** remain out of scope and still require the separately
  security-reviewed, CSP-scoped path noted in ADR-0113.
