# HTML Manual Chat Citations - closure evidence (Epic #1854)

Local closure evidence for Epic #1854 and child issues #1878, #1879, #1880, #1881, #1882,
and #1883. This record is body-free: it names implementation surfaces, behavioral guarantees,
and gate outcomes, but does not include manual bodies, raw crawled pages, private filesystem
paths, connector payloads, secrets, prompts, or model output.

## Scope

| Issue | Local completion evidence                                                                                                                                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1878 | HTML manual Knowledge Pods now surface in the existing chat grounding picker through the existing local-knowledge readiness projection. Ready, degraded, and unavailable states use source-kind and fingerprint metadata without exposing raw crawl roots.                  |
| #1879 | Grounded chat citations carry HTML manual lineage: safe page id, page title, section path, anchor id, parsed unit id, source kind, and governed open eligibility. Citation metadata is derived from persisted source lineage and existing parsed-unit anchors.              |
| #1880 | Chat answers route HTML manual grounding through the existing Local Knowledge retrieval and grounded QA flow. Retrieval remains the local-knowledge hybrid/RRF path; no browser-side model calls or manual-specific answer synthesizer were added.                          |
| #1881 | Citation open actions route through docs-browser navigation. The chat UI passes only an opaque citation target to `navigateDocumentation`, and the server resolves it through local-knowledge lineage before the docs-browser classifier applies existing file/HTTP policy. |
| #1882 | Regression coverage exercises selection, retrieval, citation projection, docs-browser reopening, fail-closed unsupported targets, and redaction boundaries. Tests assert body-free evidence and reject raw source-root leakage.                                             |
| #1883 | This evidence record anchors the local pilot closeout and lists local verification commands. GitHub issue state, project state, commits, pushes, and PR creation were intentionally not mutated by the agent.                                                               |

## Implementation Notes

- Source metadata is persisted in the local-knowledge store as manual source lineage keyed by
  capsule/source and source fingerprint.
- Local and HTTP reopen targets are reconstructed server-side from persisted lineage and citation
  document paths, then classified by the existing docs-browser boundary.
- The browser receives an opaque manual-citation handle, not a filesystem root, crawl origin, query,
  or raw source body.
- ADR-0113 is amended in place to cover citation-driven documentation browser navigation for
  HTML manual chat answers.

## Test Coverage

| Surface         | Coverage                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts       | HTML manual source tags, Knowledge Pod source-kind projection, DB schema version, citation wire metadata, and barrel exports.                                               |
| Local Knowledge | Manual pod metadata persistence, readiness projection, retrieval through `runLocalKnowledgeRetrieval`, parsed-unit citation metadata, and approved-scope target resolution. |
| Server          | Grounded QA citation projection, docs-browser opaque-target resolution, fail-closed malformed handles, and redacted navigation failures.                                    |
| UI              | Chat grounding selection, manual-specific Knowledge Pod labels, citation chip rendering, docs-browser open action, unavailable citation states, and no raw source leakage.  |

## Verification Record

All commands below were run locally in this worktree unless explicitly marked as Linux container
execution for platform-sensitive editor release evidence.

| Command                                                                                                                                                                                                                                                                                                        | Outcome                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm install`                                                                                                                                                                                                                                                                                                  | PASS                                                                          |
| `npx vitest run packages/keiko-local-knowledge/src/manual-pod.test.ts packages/keiko-local-knowledge/src/manual-pod.e2e.test.ts packages/keiko-local-knowledge/src/knowledge-pods.test.ts packages/keiko-server/src/docs-browser.test.ts packages/keiko-server/src/local-knowledge-grounded-qa.rescue.test.ts` | PASS - 83 tests                                                               |
| `npm --workspace @oscharko-dev/keiko-ui run test -- src/lib/local-knowledge-api.test.ts src/app/components/desktop/ChatWindow.test.tsx src/app/components/desktop/GroundedAnswer.test.tsx`                                                                                                                     | PASS - 138 tests                                                              |
| `npm run typecheck`                                                                                                                                                                                                                                                                                            | PASS                                                                          |
| `npm run lint`                                                                                                                                                                                                                                                                                                 | PASS                                                                          |
| `npm run format:check`                                                                                                                                                                                                                                                                                         | PASS                                                                          |
| `npm test`                                                                                                                                                                                                                                                                                                     | PASS - 16,788 passed, 1 skipped                                               |
| `npm run arch:check`                                                                                                                                                                                                                                                                                           | PASS                                                                          |
| `npm run arch:check:negative`                                                                                                                                                                                                                                                                                  | PASS - negative fixtures rejected as expected                                 |
| `npm run typecheck --workspace @oscharko-dev/keiko-ui`                                                                                                                                                                                                                                                         | PASS                                                                          |
| `npm run lint --workspace @oscharko-dev/keiko-ui`                                                                                                                                                                                                                                                              | PASS                                                                          |
| `npm run test:coverage:ui`                                                                                                                                                                                                                                                                                     | PASS - 4,400 tests                                                            |
| `docker run ... node:22-bookworm npm run build:ui`                                                                                                                                                                                                                                                             | PASS - Linux static UI export rebuilt                                         |
| `docker run ... node:22-bookworm npm run check:editor-release-evidence`                                                                                                                                                                                                                                        | PASS - B1/B2/B3 editor release evidence matches committed Linux fingerprint   |
| `npm run check:retrieval-quality`                                                                                                                                                                                                                                                                              | PASS - retrieval, local-knowledge, comparison, and regression fixtures passed |
| `npm run check:grounded-retrieval-quality`                                                                                                                                                                                                                                                                     | PASS                                                                          |
| `npm run check:grounded-faithfulness`                                                                                                                                                                                                                                                                          | PASS                                                                          |
| `npm run check:error-observability`                                                                                                                                                                                                                                                                            | PASS                                                                          |
| `npm run build`                                                                                                                                                                                                                                                                                                | PASS                                                                          |
| `npm run prepare:bin`                                                                                                                                                                                                                                                                                          | PASS                                                                          |
| `npm run prune:package-build-artifacts`                                                                                                                                                                                                                                                                        | PASS                                                                          |
| `npm run prune:package-native-optionals`                                                                                                                                                                                                                                                                       | PASS                                                                          |
| `npm run check:package-surface`                                                                                                                                                                                                                                                                                | PASS - 4,232 tarball files; UI static export present                          |
| `npm run check:adr-index`                                                                                                                                                                                                                                                                                      | PASS                                                                          |
| `npm run test:e2e:smoke`                                                                                                                                                                                                                                                                                       | PASS - 37 Chromium smoke tests                                                |

## Known Limits

- This is local implementation and verification evidence only. The human-control invariant keeps
  GitHub issue/project updates, commits, pushes, PR creation, and merge actions outside agent
  authority unless the maintainer explicitly requests them.
- The editor release evidence fingerprint is platform-sensitive. The authoritative check in this
  record was run in a path-preserving Linux Node container with isolated Linux dependencies.
