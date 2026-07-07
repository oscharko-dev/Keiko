# HTML Manual Chat Citations - closure evidence (Epic #1854)

Local closure evidence for Epic #1854 and child issues #1878, #1879, #1880, #1881, #1882,
and #1883. This record is body-free: it names implementation surfaces, behavioral guarantees,
and gate outcomes, but does not include manual bodies, raw crawled pages, private filesystem
paths, connector payloads, secrets, prompts, or model output.

## Post-Merge Audit (2026-07-07)

The original implementation merged as PR #2047 (commit `a70e9c82`). A subsequent post-merge audit
(7 parallel agents auditing the epic and all 6 child issues against acceptance criteria, followed
by adversarial verification of every serious finding) found and fixed the defects below before this
record was updated. All local gates listed in the Verification Record were re-run after every fix.

Confirmed and fixed:

- **Blocker** - the citation "open" action (`ManualCitationChip` in `GroundedAnswer.tsx`) called
  `navigateDocumentation` directly and unconditionally reported "Opened" on any resolved promise,
  discarding the returned `DocumentationNavigationResult` entirely. Clicking a citation never
  actually opened the existing governed documentation-browser widget, so the mainline outcome for
  `html-manual-http`/`html-manual-local` citations (`reason: "rendering-deferred"`) was misreported
  as success. Fixed by routing the click through a new `openDocumentationTarget` callback
  (`ChatWindow.tsx` -> `previewWindows.add("docbrowser", { target })`, mirroring the existing PDF
  citation-preview window-opening pattern) so the existing `DocumentationBrowserWidget` performs the
  real navigation call and renders the authoritative reason/severity.
- **Major** - `manual-source-metadata.ts`'s `httpTarget()` scope check compared only the resolved
  URL's pathname against the approved path prefix, never its origin/host against the source's
  approved origin. Unreachable in production today (an upstream gate already prevents an
  attacker-shaped `relativePath` from reaching this function), but hardened with an explicit
  origin-equality check so the boundary fails closed on its own rather than relying solely on an
  upstream caller.
- **Major** - the hybrid (multi-connector) grounded-QA path had zero test coverage for HTML-manual
  citation projection despite production code threading `store` through it for exactly that purpose;
  added a seeded-capsule regression test.
- **Major** - no test proved honest "no evidence" behavior for a genuinely non-matching manual
  query (the only manual e2e test used a constant-vector embedding adapter that matches every
  query); added a keyword-hashed adapter and a no-match regression test.
- **Major** - `manual-source-metadata.ts` (the citation-reopen scope boundary) had no dedicated unit
  test file; added one covering absolute/protocol-relative path rejection, path-prefix edge cases,
  and non-default-port origins.
- **Major** - this evidence record's Known Limits section did not name feature-level limitations or
  cross-reference the tracked follow-up epics; corrected below.
- 11 minor defects across citation redaction (`anchorId` now passes through the same
  `stripUnsafeFormatChars` pass as every other citation label field), citation-navigation
  diagnostics (`docs-browser.ts` now reports a distinct, curated label per failure reason instead of
  a hardcoded string; `html-manual-citation-navigation.ts` now verifies `chunkId` actually belongs to
  the resolved document instead of validating-but-ignoring it), pod-selection guidance (in-progress
  readiness states are no longer mislabeled as hard failures; a mixed manual/non-manual pod set is no
  longer mislabeled as a manual pod), citation UI (curated unavailable-reason copy, an `aria-live`
  region for open-action state transitions, the existing `--blocked` action-state modifier class is
  now applied), and `parsedUnitId` now flows through `citation-mapper.ts`'s preview-snapshot builder
  consistently with the production retrieval path.

Adversarially reviewed and confirmed NOT a defect: an epic-level audit pass flagged that
`HtmlManualCitationMetadata.open` reports `available`/`page-level-only` for manual sources even
though those target classes always resolve to `reason: "rendering-deferred"` at the real docs-browser
navigate route. On investigation this is intentional system design (`rendering-deferred` is a
`severity: "limitation"` outcome, not an error - the widget still opens and shows an honest "Opened
for inspection" card); the actual defect was the missing widget-open wiring above, which is now fixed.

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

## Post-Merge Audit Re-Verification (2026-07-07)

Commands re-run locally in this worktree after the fixes listed above, against `dev` at commit
`8cad3765` (Epic #1855 post-merge audit, unrelated file scope, merged after `a70e9c82`).

| Command                                                | Outcome                                          |
| ------------------------------------------------------ | ------------------------------------------------ |
| `npm run typecheck`                                    | PASS                                             |
| `npm run lint`                                         | PASS (root + `@oscharko-dev/keiko-ui`)           |
| `npm run format:check`                                 | PASS                                             |
| `npm run arch:check`                                   | PASS - 2,630 modules, 7,236 dependencies cruised |
| `npm run arch:check:negative`                          | PASS - 40 negative fixtures correctly rejected   |
| `npm test`                                             | PASS - 994 files, 16,873 tests, 1 skipped        |
| `npm run typecheck --workspace @oscharko-dev/keiko-ui` | PASS                                             |
| `npm run lint --workspace @oscharko-dev/keiko-ui`      | PASS                                             |
| `npm run test:coverage:ui`                             | PASS - 269 files, 4,408 tests                    |
| `npm run check:retrieval-quality`                      | PASS                                             |
| `npm run check:grounded-retrieval-quality`             | PASS                                             |
| `npm run check:grounded-faithfulness`                  | PASS                                             |
| `npm run check:error-observability`                    | PASS                                             |
| `npm run check:adr-index`                              | PASS                                             |

## Known Limits

- This is local implementation and verification evidence only. The human-control invariant keeps
  GitHub issue/project updates, commits, pushes, PR creation, and merge actions outside agent
  authority unless the maintainer explicitly requests them. Issue #1883's own Acceptance Criteria
  and Deliverables checkboxes remain unchecked pending maintainer review of this record.
- The editor release evidence fingerprint is platform-sensitive; the original PR's authoritative
  check ran in a path-preserving Linux Node container. The post-merge audit fix set does not touch
  `packages/keiko-editor` or any Monaco-related code, so it carries negligible risk to that
  fingerprint, but re-running `check:editor-release-evidence` locally on this macOS worktree was not
  attempted a second time after an earlier bind-mounted Docker attempt corrupted local native
  dependencies (recovered via a clean host `npm install`, confirmed by the green re-verification
  table above). This gate will run on Linux in CI before merge; it is a residual risk, not a known
  failure.
- Parser quality beyond the additive `anchorId` reuse from Epic #1855 is tracked in Epic #1855
  itself (technical HTML structure), not this epic.
- Refresh/diff/diagnostics for HTML Manual Knowledge Pods are tracked in Epic #1856, not this epic.
- Browser-rendered documentation capture (as opposed to the current classify-and-link governed
  navigation) is tracked in Epic #1857, not this epic.
- Retrieval evaluation and pilot release gates beyond the fixture-based regression coverage added
  here are tracked in Epic #1858, not this epic.
