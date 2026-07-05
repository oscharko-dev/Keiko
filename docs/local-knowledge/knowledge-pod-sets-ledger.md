# Knowledge Pod Sets Task-Ready Ledger

Status: implementation and verification ledger for Epic #1821 and issues #1927-#1932.

This ledger records the task-ready Knowledge Pod Set surface. It does not close the
GitHub issues; issue closure remains a human-owned review action after PR review.

## Reuse Contract

Knowledge Pod Sets remain the existing `CapsuleSet` composition primitive. The persisted
set stores safe display metadata plus ordered member capsule ids only. It does not store
documents, chunks, vectors, provider diagnostics, or raw source paths.

The task-ready contract is additive:

- `CapsuleSet` remains the durable logical grouping model.
- `KnowledgePodSummary.kind: "pod-set"` is the browser and evidence projection.
- `KnowledgePodSummary.setReadiness` exposes closed member counts and reason codes.
- retrieval expands a set into member pods and keeps per-member activity rows.
- UI graph, chat, Quality Intelligence, and editor connector flows keep using existing
  `capsule-set` wire discriminants.

## Issue Matrix

| Issue                                              | Status      | Evidence                                                                                                                                                                                                 |
| -------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1927 CapsuleSet foundation and readiness contract | implemented | `CapsuleSet` remains id-only composition; `KnowledgePodSummary` carries pod-set readiness without a new grouping subsystem.                                                                              |
| #1928 metadata/readiness summaries                 | implemented | `setReadiness` contains ready/degraded/unavailable/denied/indexing/stale/error/missing counts plus closed reason codes.                                                                                  |
| #1929 UI composition and attachment                | implemented | Local Knowledge graph lists Knowledge Pod Sets, exposes readiness/counts/guidance, and can add set nodes to the workspace; chat/QI/editor attachment paths continue to use existing connector selection. |
| #1930 retrieval activity member participation      | implemented | set-backed activity emits member pod rows; skipped set failures now assign the concrete reason to the affected member and `source-skipped` to unaffected members.                                        |
| #1931 compatibility warnings                       | implemented | compose dialog, graph rows, chat selector, and connector picker use redacted guidance from Knowledge Pod summaries.                                                                                      |
| #1932 docs and release evidence                    | implemented | this ledger, `knowledge-pods.md`, and the refreshed editor bundle evidence file record the final local verification before PR handoff.                                                                   |

## Evidence Boundaries

Allowed evidence is limited to ids, safe labels, lifecycle/readiness enums, closed reason
codes, source kind labels, and counts. The task-ready surface must not expose document
bodies, chunk text, prompts, raw query text, raw vector scores, source roots, provider
endpoints, credentials, tokens, or private paths.

Remote, federated, managed-service, and policy-pack pods remain future governed designs.
The current implementation only reserves compatible enum/posture vocabulary and does not
add network behavior.

## Verification Anchors

- `packages/keiko-contracts/src/local-knowledge-pods.test.ts`
- `packages/keiko-local-knowledge/src/knowledge-pods.test.ts`
- `packages/keiko-server/src/local-knowledge-grounded-qa.rescue.test.ts`
- `packages/keiko-ui/src/app/local-knowledge/connector-graph.test.tsx`
- `packages/keiko-ui/src/app/local-knowledge/capsule-set-compose.test.tsx`
- `packages/keiko-ui/src/lib/local-knowledge-api.test.ts`

## Gate Matrix

| Gate                             | Result                                                                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused package tests            | passed: `npm test -- --run packages/keiko-contracts/src/local-knowledge-pods.test.ts packages/keiko-local-knowledge/src/knowledge-pods.test.ts packages/keiko-server/src/local-knowledge-grounded-qa.rescue.test.ts` |
| Focused UI tests                 | passed: `npm run test --workspace @oscharko-dev/keiko-ui -- --run src/app/local-knowledge/capsule-set-compose.test.tsx src/app/local-knowledge/connector-graph.test.tsx src/lib/local-knowledge-api.test.ts`         |
| TypeScript                       | passed: `npm run typecheck`; `npm run typecheck --workspace @oscharko-dev/keiko-ui`                                                                                                                                  |
| Lint                             | passed: `npm run lint`; `npm run lint --workspace @oscharko-dev/keiko-ui`                                                                                                                                            |
| Format                           | passed: `npm run format:check`                                                                                                                                                                                       |
| Full test suite                  | passed: `npm test`                                                                                                                                                                                                   |
| Architecture                     | passed: `npm run arch:check`; `npm run arch:check:negative`                                                                                                                                                          |
| Retrieval quality                | passed: `npm run check:retrieval-quality`; `npm run check:grounded-retrieval-quality`; `npm run check:grounded-faithfulness`                                                                                         |
| UI coverage and release evidence | passed: `npm run test:coverage:ui`; `npm run build:ui`; Linux container `npm run check:editor-release-evidence` after regenerating `docs/release/1209-bundle-evidence.json` from the Linux static export.            |
| Package surface                  | passed: `npm run clean`; `npm run build`; `npm run build:ui`; `npm run prepare:bin`; `npm run prune:package-build-artifacts`; `npm run prune:package-native-optionals`; `npm run check:package-surface`              |
| Docs/release metadata checks     | passed: `npm run check:editor-doc-links`; `npm run check:release-impact`                                                                                                                                             |

## Known Limits

- There is no separate Knowledge Pod Set detail route. The Local Knowledge graph exposes
  safe set-level inspection from the list projection; member labels require existing pod
  rows or a future reviewed detail route.
- Direct cross-space vector-score comparison remains forbidden. Set-backed retrieval uses
  existing lane-local ranking and reciprocal-rank fusion.
- Linux CI remains authoritative for platform-specific editor release evidence. The macOS
  `npm run check:editor-release-evidence` still reports the known local fingerprint difference;
  Linux `node:22-bookworm` verification passes with the committed evidence JSON.
