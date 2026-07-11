# Atlassian Connector Lifecycle Ledger

Status: implementation and closure-evidence ledger for Epic
[#2238](https://github.com/oscharko-dev/Keiko/issues/2238) and child issues
[#2239](https://github.com/oscharko-dev/Keiko/issues/2239),
[#2240](https://github.com/oscharko-dev/Keiko/issues/2240),
[#2241](https://github.com/oscharko-dev/Keiko/issues/2241),
[#2242](https://github.com/oscharko-dev/Keiko/issues/2242),
[#2243](https://github.com/oscharko-dev/Keiko/issues/2243),
[#2244](https://github.com/oscharko-dev/Keiko/issues/2244),
[#2245](https://github.com/oscharko-dev/Keiko/issues/2245),
[#2246](https://github.com/oscharko-dev/Keiko/issues/2246),
[#2247](https://github.com/oscharko-dev/Keiko/issues/2247), and
[#2248](https://github.com/oscharko-dev/Keiko/issues/2248).

This ledger records evidence only; it is not a substitute for local gate output, PR review, or
human-owned issue closure after merge. It contains only synthetic, redacted, body-free evidence:
counts, contract names, route paths, and reason codes — never raw tokens, tenant names, endpoints,
issue/page content, or PII.

> **Coordinator note.** This document is finalized by the epic coordinator after child
> [#2246](https://github.com/oscharko-dev/Keiko/issues/2246) records its verification evidence and
> the implementation pull request(s) are opened. The [Local gate outcomes](#local-gate-outcomes) and
> [Merged pull requests](#merged-pull-requests) sections carry explicit placeholders for that
> consolidation. Sections above them reflect the implemented behavior on the epic branch and are
> restatements of [ADR-0128](../adr/ADR-0128-atlassian-connector-authority-and-security-design.md);
> where the two differ, the ADR is authoritative.

Epic #2238 adds a governed Atlassian connector lane: explicit, user-triggered synchronization of
Confluence spaces and Jira projects into Local Knowledge connector pods, an ad-hoc live Jira JQL read
action, and governed Confluence/Jira write actions. The authority, credential custody, egress,
sync-bounds, evidence, and permissions decisions are fixed by ADR-0128 (D1–D8); every child
implements against that record.

## Delivery scope

This epic delivers the connector's authority ADR, contracts, credential custody, Confluence and Jira
ingestion into connector pods, governed write actions, a live Jira read, the operating UI, end-to-end
verification, and this documentation. The connector produces Local Knowledge connector pods and reuses
the existing retrieval, grounding, readiness, and redacted-summary machinery rather than adding a
second knowledge subsystem.

Out of scope for v1 (ADR-0128 D7): Data Center, OAuth 2.0, webhooks, scheduled/background sync,
attachment/worklog content, deletion actions, and page ancestor/breadcrumb capture. See
[Limitations and follow-ups](#limitations-and-follow-ups).

## Reuse anchors

The connector adds one new leaf package and otherwise composes existing subsystems by shape, not by
duplication (ADR-0128 D1–D5; AGENTS.md §5).

| Area                     | Reused surface                                                                          | Use in this epic                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Authority and modes      | ADR-0129 three-mode model (`governed-assist`/`supervised-coding`/`autonomous-delivery`) | Connector actions map onto the shared modes; no connector-local autonomy vocabulary is invented (ADR-0128 D4).               |
| Credential vault         | `packages/keiko-security/src/secret-vault.ts` (ADR-0046)                                | A new, dedicated vault domain with its own key; no new crypto or package (ADR-0128 D2).                                      |
| Outbound egress          | `gatewayFetch` from `@oscharko-dev/keiko-model-gateway/internal/http` (ADR-0038)        | The concrete HTTP port is composed in `keiko-server` from the shared transport; the connector leaf holds no egress (D1, D3). |
| Disposition pattern      | `packages/keiko-contracts/src/editor-agent-governance.ts`                               | The action-class/scope/risk mapping table and tri-state disposition with exactly one reason (ADR-0128 D4).                   |
| Fingerprint change model | `packages/keiko-local-knowledge/src/manual-*-fingerprints.ts` (Epic #1856)              | Generalized to `diffFingerprintSets` for per-item change summaries keyed by stable provider ids (ADR-0128 D5).               |
| Pod readiness            | `packages/keiko-contracts/src/local-knowledge-pods.ts` (`KnowledgePodReadiness`)        | Sync job states map onto the existing readiness vocabulary; no connector-local status set (ADR-0128 D5).                     |
| Content encryption       | Local Knowledge content cipher (ADR-0047)                                               | Synced content is encrypted at rest by the existing boundary; the connector adds no new at-rest store (ADR-0128 D6, D8).     |

## Per-child mapping

One-line outcome and reuse decision per child. Final merged-PR status is consolidated in
[Merged pull requests](#merged-pull-requests).

| Child                                                      | Outcome (implemented behavior)                                                                                                      | Reuse decision                                                                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [#2239](https://github.com/oscharko-dev/Keiko/issues/2239) | ADR-0128 (D1–D8) accepted as the normative authority/credential/egress/bounds/evidence/permissions record; ADR-0129 adopted.        | First forward-citation consumer of ADR-0129; extends ADR-0046 and ADR-0038 by composition.                      |
| [#2240](https://github.com/oscharko-dev/Keiko/issues/2240) | `keiko-contracts` connector contracts: descriptors, sync scopes/bounds, job states, failure-reason unions, the D4 decision helper.  | Extended `CodingWorkbenchConnectorScope` with `knowledge-base.read`/`.write`; reused the disposition idiom.     |
| [#2241](https://github.com/oscharko-dev/Keiko/issues/2241) | New leaf package `@oscharko-dev/keiko-connectors`; credential custody and opaque `authRef`; server vault, HTTP port, verify route.  | Reused the `secret-vault` primitives and `gatewayFetch` transport; no new crypto, no direct egress in the leaf. |
| [#2242](https://github.com/oscharko-dev/Keiko/issues/2242) | Confluence ingestion: provider-agnostic sync lane, Confluence adapter, connector-pod sink, sync job registry and routes.            | Generalized the #1856 fingerprint/change-summary model; mapped job states to `KnowledgePodReadiness`.           |
| [#2243](https://github.com/oscharko-dev/Keiko/issues/2243) | Jira ingestion: Jira sync adapter and document/metadata mapping wired into the same provider-fetch seam and sync routes.            | Reused the provider-agnostic sync lane from #2242; no second sync engine.                                       |
| [#2244](https://github.com/oscharko-dev/Keiko/issues/2244) | Governed write actions and the policy seam: actions/approvals routes, write failure-reason union, plain-text→ADF/storage composers. | Composed the D4 decision helper with the central matrix, mirroring the editor-agent route composition.          |
| [#2245](https://github.com/oscharko-dev/Keiko/issues/2245) | Operating UI for registration, verify, scope selection, sync, approvals, and the live read (delivered under its own child).         | Consumes the `keiko-contracts` wire types; adds no re-declared connector types in the UI.                       |
| [#2246](https://github.com/oscharko-dev/Keiko/issues/2246) | End-to-end verification across the connector routes; its recorded gate evidence is consolidated below.                              | Exercises the shipped routes and contracts; records evidence rather than re-deciding behavior.                  |
| [#2247](https://github.com/oscharko-dev/Keiko/issues/2247) | This documentation: setup/operations guide, permissions/privacy and limitations, troubleshooting runbook, and this ledger.          | Followed the #1856 documentation structure and the troubleshooting house template; no product code.             |
| [#2248](https://github.com/oscharko-dev/Keiko/issues/2248) | Live Jira JQL read (`search-issues-live`) with the built-in "issues assigned to me" template; ephemeral, no pod persisted.          | Extended the #2244 actions route union rather than adding a parallel route.                                     |

## Governance invariants held

Restated from ADR-0128; each is enforced in the implementation, not by documentation.

- **Single-host egress, fail-closed redirects.** A connector may reach only the one host derived from
  its validated HTTPS base URL; 3xx responses, cross-host or non-HTTPS redirects, and URL-embedded
  credentials are refused (D3).
- **Write-only-after-creation credential surface.** The token is accepted once at registration,
  sealed in a dedicated vault under an opaque `authRef`, and read back only inside the outbound HTTP
  adapter immediately before a request is signed. No screen, log, evidence record, error message, or
  model prompt re-emits it, in any mode including Full access (D2).
- **Scope required in every mode.** A write action without its `*.write` scope, or a read without its
  `*.read` scope, is denied (`connector-write-denied` / `connector-access-denied`) in every mode,
  Full access included (D4).
- **Bounded, non-wideneable sync.** 2 000 items, 50 MB, 15 minutes, concurrency 4, and a 100-result
  live-read cap; bounded backoff for 429/5xx with a capped `Retry-After` (D3, D5).
- **Atomic, fail-closed apply.** A run's fingerprint set and index update commit once, atomically, at
  the end; a cancelled or failed-before-commit run applies nothing and leaves the prior pod intact
  (D5).
- **Content-free governance trail.** Audit and evidence records carry action type, ids, disposition,
  reason code, correlation id, duration, counts, and a fingerprint digest — never bodies, field
  values, tokens, or token-bearing URLs; JQL is hashed or omitted (D6).

## Limitations and follow-ups

Each is a deliberate v1 scope decision from ADR-0128 D7, restated in the
[setup and operations guide](atlassian-connector-guide.md#limitations-and-follow-ups):

- Cloud-verified v1; Data Center is a follow-up (base-path conventions, private CAs, `bearer-pat`).
- No OAuth 2.0 (3LO); API-token Basic auth is sufficient for a single local user.
- No webhooks; sync is pull-based and explicitly user-triggered.
- No attachment or worklog content; attachment metadata only.
- No scheduled or background sync.
- No deletion actions (issue/page/comment deletion excluded from the action union).
- Confluence page ancestors and breadcrumbs are not captured.

**Future direction:** the ticket-to-workbench handoff (taking a Jira ticket into a Coding Workbench
task) is tracked separately as Epic
[#2249](https://github.com/oscharko-dev/Keiko/issues/2249) and is not part of this epic.

## Local gate outcomes

The full CI-equivalent gate set was run locally and green before delivery (macOS; CI/Linux is
authoritative for the two platform-artifact gates noted below).

| Gate                                                                                       | Outcome                                                                                                                             |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                                                        | PASS (package graph aligned; `tsc --noEmit` clean)                                                                                  |
| `npm run lint` (root + keiko-ui workspace, `--max-warnings=0`)                             | PASS                                                                                                                                |
| `npm run format:check`                                                                     | PASS                                                                                                                                |
| `npm test` (full root suite)                                                               | PASS — 1110 files, 19080 passed, 2 pre-existing skipped                                                                             |
| `npm run arch:check` / `arch:check:negative`                                               | PASS (import-policy + contract boundaries green; negative fixtures fire)                                                            |
| `npm run check:adr-index`                                                                  | PASS (101 ADRs indexed)                                                                                                             |
| `npm run check:error-observability`                                                        | PASS                                                                                                                                |
| `npm run check:version-consistency` / `check:dependency-hygiene`                           | PASS                                                                                                                                |
| `npm run test:coverage:quality` (fresh)                                                    | PASS — all packages hold their branch floors (keiko-connectors, keiko-server, keiko-ui, keiko-local-knowledge included)             |
| `npm run check:ui-i18n`                                                                    | PASS (central en + de catalogs at parity)                                                                                           |
| `npm run check:retrieval-quality` / `grounded-retrieval-quality` / `grounded-faithfulness` | PASS (confluence-connector-pod + jira-connector-pod scorecards and connector grounded fixtures)                                     |
| Connector integration suites (`tests/atlassian-connectors/*`)                              | PASS — 137 tests (redaction sweep, egress fail-closed, hostile-provider, degradation matrix, scope preservation, policy regression) |
| Playwright e2e (chromium, `tests/e2e/atlassian-connectors-*.smoke.spec.ts`)                | PASS — setup → verify → scope → sync → grounded ask (connector citation) → governed write → approve → typed result                  |

Two gates fail locally on macOS purely as documented platform artifacts; both pass on CI/Linux,
which is authoritative:

- `check:package-surface` — the local tarball contains the macOS-only native dependency
  `@napi-rs/canvas-darwin-arm64`. The root package export surface is provably unchanged (root
  `src/index.ts` and the `package.json` `exports` field are untouched), so there is no real surface
  drift.
- `check:editor-release-evidence` — the measurement fingerprint embeds gzip byte sizes that differ
  between macOS and Linux. The platform-agnostic `staticExport.fileCount` was updated to `289` (the
  connector UI route adds files); the editor-runtime chunk raw byte sizes are unchanged, so the
  committed Linux fingerprint is preserved.

## Delivery pull request

All ten children (#2239–#2248) were implemented in required order on a single integration branch
(`claude/epic-2238-implementation-55fd37`) from `origin/dev` and are delivered as one consolidated
epic pull request rather than ten separate ones, so the reviewer sees the connector lane as a single
coherent change with all gates green together. Merge remains a human-approved delivery action per
the human-control invariant; this ledger is finalized when the maintainer merges.

- Delivery pull request: [#2301](https://github.com/oscharko-dev/Keiko/pull/2301) (targets `dev`;
  open for maintainer review).

Open follow-ups (documented in the ADR and this ledger, not blockers for the epic):

- Data Center verification, OAuth 2.0 (3LO), webhooks, attachments/worklogs indexing, scheduled
  sync, and deletion write actions — all recorded as follow-ups in
  [ADR-0128](../adr/ADR-0128-atlassian-connector-authority-and-security-design.md).
- Wiring the connector management surface into the desktop shell navigation (it currently ships as a
  dedicated `/atlassian-connectors` route); the ticket-to-workbench handoff Epic
  [#2249](https://github.com/oscharko-dev/Keiko/issues/2249).

## Related documentation

- [Atlassian connector setup and operations guide](atlassian-connector-guide.md) — token creation,
  registration, scope selection, sync, live read, write-action modes, permissions, and limitations.
- [Atlassian connector troubleshooting runbook](../troubleshooting/atlassian-connector.md) — one
  entry per known failure mode.
- [ADR-0128](../adr/ADR-0128-atlassian-connector-authority-and-security-design.md) — the normative
  decisions this ledger restates.
- [HTML Manual refresh lifecycle ledger](html-manual-refresh-lifecycle-ledger.md) — the Epic #1856
  ledger this document's structure follows.
