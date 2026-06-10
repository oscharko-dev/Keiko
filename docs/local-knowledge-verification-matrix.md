# Local Knowledge Connector Verification Matrix (#203)

## Summary

This document is the current audit artifact for Issue [#203](https://github.com/oscharko-dev/Keiko/issues/203) on top of `origin/dev`.

It replaces earlier, stale closure text with evidence that matches the repository as checked on 2026-06-05. Every local repository link in this document is covered by a docs-drift test so the matrix cannot silently regress back to nonexistent paths.

## Acceptance Criteria

| # | Criterion | Current evidence | Status |
| --- | --- | --- | --- |
| 1 | The packed artifact can create and use a local knowledge capsule from a clean sandbox. | Install smoke: [`scripts/installable-package-smoke.mjs`](../scripts/installable-package-smoke.mjs). Current audit run: `npm run smoke:install` → `installable-smoke ok: tarball installed, 15 bundled packages present, CLI + SDK reachable.` Store bootstrap and schema application: [`packages/keiko-local-knowledge/src/store.ts`](../packages/keiko-local-knowledge/src/store.ts), [`packages/keiko-local-knowledge/src/store.test.ts`](../packages/keiko-local-knowledge/src/store.test.ts). | PASS |
| 2 | Indexed knowledge remains available after Keiko restart. | Restart persistence is pinned in [`packages/keiko-local-knowledge/src/store.test.ts`](../packages/keiko-local-knowledge/src/store.test.ts). Capsule detail reads persisted health, sources, diagnostics, and job history through [`packages/keiko-server/src/local-knowledge-handlers.ts`](../packages/keiko-server/src/local-knowledge-handlers.ts) and [`packages/keiko-server/src/local-knowledge-handlers.test.ts`](../packages/keiko-server/src/local-knowledge-handlers.test.ts). | PASS |
| 3 | Answers include grounded citations or explicit insufficient-evidence states. | Grounding policy: [`packages/keiko-local-knowledge/src/retrieval/answer-grounding.ts`](../packages/keiko-local-knowledge/src/retrieval/answer-grounding.ts), citation mapping: [`packages/keiko-local-knowledge/src/chunking/citation-mapper.ts`](../packages/keiko-local-knowledge/src/chunking/citation-mapper.ts), grounded-answer runner: [`packages/keiko-local-knowledge/src/conversation/grounded-answer-runner.ts`](../packages/keiko-local-knowledge/src/conversation/grounded-answer-runner.ts), loopback BFF wiring: [`packages/keiko-server/src/local-knowledge-grounded-qa.ts`](../packages/keiko-server/src/local-knowledge-grounded-qa.ts). Coverage: [`packages/keiko-local-knowledge/src/retrieval/answer-grounding.test.ts`](../packages/keiko-local-knowledge/src/retrieval/answer-grounding.test.ts), [`packages/keiko-local-knowledge/src/conversation/grounded-answer-runner.test.ts`](../packages/keiko-local-knowledge/src/conversation/grounded-answer-runner.test.ts). | PASS |
| 4 | Incremental reindexing updates changed or deleted files and skips unchanged files. | Orchestrator: [`packages/keiko-local-knowledge/src/indexing/orchestrator.ts`](../packages/keiko-local-knowledge/src/indexing/orchestrator.ts), route handler: [`packages/keiko-server/src/local-knowledge-handlers.ts`](../packages/keiko-server/src/local-knowledge-handlers.ts). Coverage: [`packages/keiko-local-knowledge/src/indexing/orchestrator.test.ts`](../packages/keiko-local-knowledge/src/indexing/orchestrator.test.ts), [`packages/keiko-server/src/local-knowledge-handlers.test.ts`](../packages/keiko-server/src/local-knowledge-handlers.test.ts). | PASS |
| 5 | Delete removes local capsule state and reports cleanup success or failure. | Delete lifecycle: [`packages/keiko-local-knowledge/src/capsule-lifecycle.ts`](../packages/keiko-local-knowledge/src/capsule-lifecycle.ts), BFF delete route: [`packages/keiko-server/src/local-knowledge-handlers.ts`](../packages/keiko-server/src/local-knowledge-handlers.ts). Coverage: [`packages/keiko-local-knowledge/src/capsule-lifecycle.test.ts`](../packages/keiko-local-knowledge/src/capsule-lifecycle.test.ts), [`packages/keiko-server/src/local-knowledge-handlers.test.ts`](../packages/keiko-server/src/local-knowledge-handlers.test.ts). | PASS |
| 6 | No customer-specific data, private logs, secrets, vectors, or real credentials are included in fixtures or closure evidence. | Synthetic parser fixtures: [`packages/keiko-local-knowledge/src/parsers/parser-test-fixtures.ts`](../packages/keiko-local-knowledge/src/parsers/parser-test-fixtures.ts), retrieval fixtures: [`packages/keiko-local-knowledge/src/evaluations/fixtures.ts`](../packages/keiko-local-knowledge/src/evaluations/fixtures.ts). Audit and redaction layer: [`packages/keiko-local-knowledge/src/privacy/audit-emitter.ts`](../packages/keiko-local-knowledge/src/privacy/audit-emitter.ts), [`packages/keiko-local-knowledge/src/privacy/diagnostic-redactor.ts`](../packages/keiko-local-knowledge/src/privacy/diagnostic-redactor.ts), [`packages/keiko-local-knowledge/src/privacy/retention-applier.ts`](../packages/keiko-local-knowledge/src/privacy/retention-applier.ts). | PASS |

## UI And Browser Evidence

The browser-facing Local Knowledge surfaces now live under `packages/keiko-ui/src/app/local-knowledge/`, not the older paths cited by the original PR #318.

- Connector graph route: [`packages/keiko-ui/src/app/local-knowledge/page.tsx`](../packages/keiko-ui/src/app/local-knowledge/page.tsx)
- Connector graph component: [`packages/keiko-ui/src/app/local-knowledge/connector-graph.tsx`](../packages/keiko-ui/src/app/local-knowledge/connector-graph.tsx)
- Connector graph tests: [`packages/keiko-ui/src/app/local-knowledge/connector-graph.test.tsx`](../packages/keiko-ui/src/app/local-knowledge/connector-graph.test.tsx)
- Capsule detail component: [`packages/keiko-ui/src/app/local-knowledge/[capsuleId]/capsule-detail.tsx`](<../packages/keiko-ui/src/app/local-knowledge/[capsuleId]/capsule-detail.tsx>)
- Capsule actions: [`packages/keiko-ui/src/app/local-knowledge/[capsuleId]/capsule-actions.tsx`](<../packages/keiko-ui/src/app/local-knowledge/[capsuleId]/capsule-actions.tsx>)
- Capsule detail tests: [`packages/keiko-ui/src/app/local-knowledge/[capsuleId]/capsule-detail.test.tsx`](<../packages/keiko-ui/src/app/local-knowledge/[capsuleId]/capsule-detail.test.tsx>)
- Capsule action tests: [`packages/keiko-ui/src/app/local-knowledge/[capsuleId]/capsule-actions.test.tsx`](<../packages/keiko-ui/src/app/local-knowledge/[capsuleId]/capsule-actions.test.tsx>)

## Parser Coverage

The current parser registry includes the previously deferred PDF and DOCX adapters.

- Registry export surface: [`packages/keiko-local-knowledge/src/parsers/index.ts`](../packages/keiko-local-knowledge/src/parsers/index.ts)
- PDF adapter coverage: [`packages/keiko-local-knowledge/src/parsers/pdf-parser.ts`](../packages/keiko-local-knowledge/src/parsers/pdf-parser.ts), [`packages/keiko-local-knowledge/src/parsers/pdf-parser.test.ts`](../packages/keiko-local-knowledge/src/parsers/pdf-parser.test.ts)
- DOCX adapter coverage: [`packages/keiko-local-knowledge/src/parsers/docx-parser.ts`](../packages/keiko-local-knowledge/src/parsers/docx-parser.ts), [`packages/keiko-local-knowledge/src/parsers/docx-parser.test.ts`](../packages/keiko-local-knowledge/src/parsers/docx-parser.test.ts)
- Registry resolution coverage: [`packages/keiko-local-knowledge/src/parsers/index.test.ts`](../packages/keiko-local-knowledge/src/parsers/index.test.ts)

## Composition, Provenance, And Isolation

- Capsule-set composition: [`packages/keiko-local-knowledge/src/composition.ts`](../packages/keiko-local-knowledge/src/composition.ts)
- Capsule-set lifecycle: [`packages/keiko-local-knowledge/src/capsule-set-lifecycle.ts`](../packages/keiko-local-knowledge/src/capsule-set-lifecycle.ts)
- Composition coverage: [`packages/keiko-local-knowledge/src/composition.test.ts`](../packages/keiko-local-knowledge/src/composition.test.ts), [`packages/keiko-local-knowledge/src/capsule-set-lifecycle.test.ts`](../packages/keiko-local-knowledge/src/capsule-set-lifecycle.test.ts)
- Retrieval scope assembly: [`packages/keiko-local-knowledge/src/retrieval/retrieval-runner.ts`](../packages/keiko-local-knowledge/src/retrieval/retrieval-runner.ts), [`packages/keiko-local-knowledge/src/retrieval/scoped-vector-search.ts`](../packages/keiko-local-knowledge/src/retrieval/scoped-vector-search.ts)

## Security, Privacy, And Retention

- Metadata-only audit sink: [`packages/keiko-local-knowledge/src/privacy/audit-emitter.ts`](../packages/keiko-local-knowledge/src/privacy/audit-emitter.ts)
- Diagnostic path redaction: [`packages/keiko-local-knowledge/src/privacy/diagnostic-redactor.ts`](../packages/keiko-local-knowledge/src/privacy/diagnostic-redactor.ts)
- Retention enforcement: [`packages/keiko-local-knowledge/src/privacy/retention-applier.ts`](../packages/keiko-local-knowledge/src/privacy/retention-applier.ts)
- Loopback route integration: [`packages/keiko-server/src/local-knowledge-grounded-qa.ts`](../packages/keiko-server/src/local-knowledge-grounded-qa.ts), [`packages/keiko-server/src/local-knowledge-handlers.ts`](../packages/keiko-server/src/local-knowledge-handlers.ts)

## Verification Commands

The current audit used these repository commands:

| Step | Command | Result |
| --- | --- | --- |
| Tarball install smoke | `npm run smoke:install` | PASS |
| Targeted docs drift | `npx vitest run tests/pilot/issue-12-docs.test.ts tests/pilot/issue-203-verification-matrix.test.ts` | PASS |
| Targeted Local Knowledge server regression | `npm run -w @oscharko-dev/keiko-server test -- src/local-knowledge-handlers.test.ts` | PASS |
| Targeted Local Knowledge UI regression | `npm run -w @oscharko-dev/keiko-ui test -- src/app/local-knowledge/connector-graph.test.tsx src/app/local-knowledge/[capsuleId]/capsule-detail.test.tsx` | PASS |

## Known Limits

- The repository stores component and route-level browser evidence, not a checked-in Playwright transcript for the Local Knowledge flow.
- OCR remains a seam plus null adapter until a concrete OCR implementation is selected.
- Retrieval remains scoped and citation-first; this matrix is intentionally evidence-oriented and does not replace the evaluation report under Issue [#268](https://github.com/oscharko-dev/Keiko/issues/268).

## See Also

- [Issue #203](https://github.com/oscharko-dev/Keiko/issues/203)
- [Epic #189](https://github.com/oscharko-dev/Keiko/issues/189)
- [`docs/connected-context-verification.md`](connected-context-verification.md)
- [`docs/security-and-audit-boundaries.md`](security-and-audit-boundaries.md)
- [`docs/adr/ADR-0019-modular-package-architecture.md`](adr/ADR-0019-modular-package-architecture.md)
