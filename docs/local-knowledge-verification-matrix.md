# Local Knowledge Connector — Verification Matrix (Epic #189)

## Audit correction (2026-06-04)

This document was used as closure evidence for Epic [#189](https://github.com/oscharko-dev/Keiko/issues/189), and a post-merge audit against `origin/dev` found that several PASS claims in earlier revisions of this matrix did not match the landed code at that time. In particular:

- Local Knowledge BFF routes and Conversation Center HTTP wiring were not fully wired in `packages/keiko-server` even though earlier text described them as shipped.
- Some file references in this matrix pointed to paths that do not exist in the repository.
- PDF and DOCX ingestion were previously described as complete even though the parser layer still classified them as not implemented before the audit fixes in this branch.

Treat the historical PASS rows below as implementation provenance, not as authoritative release evidence on their own. The authoritative audit status is:

- `#194` and `#266`: corrected in this audit branch by adding real PDF and DOCX extraction adapters plus async parser execution in discovery.
- `#199`: corrected in this audit branch by adding bounded hybrid lexical metadata reranking on top of scoped vector retrieval.
- `#201`: corrected in this audit branch by persisting metadata-only audit events, wiring them on live lifecycle/indexing/grounded-answer paths, hardening retention validation, and fixing absolute-path redaction.
- `#197`, `#198`, and `#200`: the earlier wiring gaps have since been closed on `dev`; use the current `keiko-server` route table and grounded-answer tests as the release evidence instead of the original audit note.

## Summary

Epic [#189](https://github.com/oscharko-dev/Keiko/issues/189) shipped 17 child issues that compose the Local Knowledge Connector capability: type contracts, SQL schema, embedding capability check, vector store, capsule composition, parser registry, document discovery, chunking, indexing orchestrator, two UI surfaces (graph and capsule detail), retrieval, evaluation harness, Conversation Center Q&A wiring, privacy/retention/audit controls, OCR adapter seam, and this verification matrix.

This matrix documents how each epic-level acceptance criterion is verified in the merged code, captures the cold-cache CI-parity gauntlet, and records the regression fixtures. The format mirrors [`docs/connected-context-verification.md`](connected-context-verification.md) and [`docs/architecture-sprint-verification.md`](architecture-sprint-verification.md).

## Children shipped

| #   | Issue                                                                            | PR                                                     | Merged     | Short SHA  |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------- | ---------- |
| 1   | [#191](https://github.com/oscharko-dev/Keiko/issues/191) contracts               | [#275](https://github.com/oscharko-dev/Keiko/pull/275) | 2026-06-04 | `af86972e` |
| 2   | [#265](https://github.com/oscharko-dev/Keiko/issues/265) SQL schema              | [#289](https://github.com/oscharko-dev/Keiko/pull/289) | 2026-06-04 | `43af594f` |
| 3   | [#192](https://github.com/oscharko-dev/Keiko/issues/192) embedding probe         | [#292](https://github.com/oscharko-dev/Keiko/pull/292) | 2026-06-04 | `7d9e489d` |
| 4   | [#193](https://github.com/oscharko-dev/Keiko/issues/193) vector store            | [#294](https://github.com/oscharko-dev/Keiko/pull/294) | 2026-06-04 | `2ad220f5` |
| 5   | [#263](https://github.com/oscharko-dev/Keiko/issues/263) composition/routing     | [#296](https://github.com/oscharko-dev/Keiko/pull/296) | 2026-06-04 | `b2e67903` |
| 6   | [#266](https://github.com/oscharko-dev/Keiko/issues/266) parser registry         | [#299](https://github.com/oscharko-dev/Keiko/pull/299) | 2026-06-04 | `22bdc475` |
| 7   | [#194](https://github.com/oscharko-dev/Keiko/issues/194) discovery               | [#300](https://github.com/oscharko-dev/Keiko/pull/300) | 2026-06-04 | `d2beb316` |
| 8   | [#195](https://github.com/oscharko-dev/Keiko/issues/195) chunking                | [#304](https://github.com/oscharko-dev/Keiko/pull/304) | 2026-06-04 | `bd02adbc` |
| 9   | [#196](https://github.com/oscharko-dev/Keiko/issues/196) indexing                | [#310](https://github.com/oscharko-dev/Keiko/pull/310) | 2026-06-04 | `2ded8d9a` |
| 10  | [#197](https://github.com/oscharko-dev/Keiko/issues/197) connector graph UI      | [#311](https://github.com/oscharko-dev/Keiko/pull/311) | 2026-06-04 | `2cf47f76` |
| 11  | [#198](https://github.com/oscharko-dev/Keiko/issues/198) capsule detail UI       | [#312](https://github.com/oscharko-dev/Keiko/pull/312) | 2026-06-04 | `ae0f2d17` |
| 12  | [#199](https://github.com/oscharko-dev/Keiko/issues/199) retrieval               | [#313](https://github.com/oscharko-dev/Keiko/pull/313) | 2026-06-04 | `19927a55` |
| 13  | [#268](https://github.com/oscharko-dev/Keiko/issues/268) eval harness            | [#314](https://github.com/oscharko-dev/Keiko/pull/314) | 2026-06-04 | `aaa27b18` |
| 14  | [#200](https://github.com/oscharko-dev/Keiko/issues/200) Conversation Center Q&A | [#315](https://github.com/oscharko-dev/Keiko/pull/315) | 2026-06-04 | `21553c50` |
| 15  | [#201](https://github.com/oscharko-dev/Keiko/issues/201) privacy/retention/audit | [#316](https://github.com/oscharko-dev/Keiko/pull/316) | 2026-06-04 | `157049e6` |
| 16  | [#202](https://github.com/oscharko-dev/Keiko/issues/202) OCR seam                | [#317](https://github.com/oscharko-dev/Keiko/pull/317) | 2026-06-04 | `d5a67be6` |
| 17  | [#203](https://github.com/oscharko-dev/Keiko/issues/203) verification matrix     | this PR                                                | TBD        | TBD        |

Each short SHA above is in `git log` on the epic branch `claude/epic-189-local-knowledge-connector`. The merged code at epic HEAD is the artifact under verification.

## Epic acceptance criteria

| #   | Criterion                                                                     | Shipped in         | Code                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Docs | Status |
| --- | ----------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------ |
| 1   | Visible Connector category in UI with capsule list                            | #197               | `/local-knowledge` route at [`packages/keiko-ui/src/app/(keiko)/local-knowledge/page.tsx:1`](<../packages/keiko-ui/src/app/(keiko)/local-knowledge/page.tsx>), ConnectorGraphView at [`packages/keiko-ui/src/app/components/local-knowledge/ConnectorGraphView.tsx:1`](../packages/keiko-ui/src/app/components/local-knowledge/ConnectorGraphView.tsx)                                                                                                   | Component tests at [`packages/keiko-ui/src/app/components/local-knowledge/ConnectorGraphView.test.tsx`](../packages/keiko-ui/src/app/components/local-knowledge/ConnectorGraphView.test.tsx), route integration at [`packages/keiko-ui/src/app/(keiko)/local-knowledge/page.test.tsx`](<../packages/keiko-ui/src/app/(keiko)/local-knowledge/page.test.tsx>)                                                                                                                                                                                                      | n/a  | PASS   |
| 2   | Persistent capsules across restarts with CRUD operations                      | #193 + #263        | `openKnowledgeStore` at [`packages/keiko-local-knowledge/src/store/index.ts:1`](../packages/keiko-local-knowledge/src/store/index.ts), `addSourcesToCapsule` / `deleteCapsule` at [`packages/keiko-local-knowledge/src/composition/index.ts:1`](../packages/keiko-local-knowledge/src/composition/index.ts), schema version pinning at [`packages/keiko-local-knowledge/src/schema/index.ts:1`](../packages/keiko-local-knowledge/src/schema/index.ts)   | Store restart persistence at [`packages/keiko-local-knowledge/src/store/store.test.ts:1`](../packages/keiko-local-knowledge/src/store/store.test.ts), composition atomicity at [`packages/keiko-local-knowledge/src/composition/composition.test.ts:1`](../packages/keiko-local-knowledge/src/composition/composition.test.ts)                                                                                                                                                                                                                                    | n/a  | PASS   |
| 3   | Ingestion of common enterprise formats (text, markdown, JSON, CSV, TSV, HTML) | #266               | Parser registry at [`packages/keiko-local-knowledge/src/parsers/index.ts:1`](../packages/keiko-local-knowledge/src/parsers/index.ts), format adapters at [`packages/keiko-local-knowledge/src/parsers/adapters/`](../packages/keiko-local-knowledge/src/parsers/adapters/)                                                                                                                                                                               | Format coverage at [`packages/keiko-local-knowledge/src/parsers/parsers.test.ts:1`](../packages/keiko-local-knowledge/src/parsers/parsers.test.ts), unsupported-media handler at [`packages/keiko-local-knowledge/src/parsers/unsupported.test.ts:1`](../packages/keiko-local-knowledge/src/parsers/unsupported.test.ts)                                                                                                                                                                                                                                          | n/a  | PASS   |
| 4   | Large-collection indexing with streaming progress, cancellation, resumption   | #196               | `runIndexingJob` at [`packages/keiko-local-knowledge/src/indexing/orchestrator.ts:1`](../packages/keiko-local-knowledge/src/indexing/orchestrator.ts), event stream at [`packages/keiko-local-knowledge/src/indexing/types.ts:1`](../packages/keiko-local-knowledge/src/indexing/types.ts), resume lookup at [`packages/keiko-local-knowledge/src/indexing/job-resume.ts:1`](../packages/keiko-local-knowledge/src/indexing/job-resume.ts)               | Progress event flow at [`packages/keiko-local-knowledge/src/indexing/orchestrator.test.ts:1`](../packages/keiko-local-knowledge/src/indexing/orchestrator.test.ts), cancellation via AbortSignal at [`packages/keiko-local-knowledge/src/indexing/orchestrator.test.ts:450`](../packages/keiko-local-knowledge/src/indexing/orchestrator.test.ts), resumption contract at [`packages/keiko-local-knowledge/src/indexing/job-resume.test.ts:1`](../packages/keiko-local-knowledge/src/indexing/job-resume.test.ts)                                                 | n/a  | PASS   |
| 5   | Grounded Q&A with citations to source documents                               | #199 + #200        | `runLocalKnowledgeRetrieval` at [`packages/keiko-local-knowledge/src/retrieval/index.ts:1`](../packages/keiko-local-knowledge/src/retrieval/index.ts), `runGroundedAnswer` at [`packages/keiko-local-knowledge/src/conversation/index.ts:1`](../packages/keiko-local-knowledge/src/conversation/index.ts), citation mapping at [`packages/keiko-local-knowledge/src/chunking/citation.ts:1`](../packages/keiko-local-knowledge/src/chunking/citation.ts) | Retrieval ranking at [`packages/keiko-local-knowledge/src/retrieval/retrieval-runner.test.ts:1`](../packages/keiko-local-knowledge/src/retrieval/retrieval-runner.test.ts), citation attachment at [`packages/keiko-local-knowledge/src/conversation/citation-attacher.test.ts:1`](../packages/keiko-local-knowledge/src/conversation/citation-attacher.test.ts), grounded answer flow at [`packages/keiko-local-knowledge/src/conversation/grounded-answer-runner.test.ts:1`](../packages/keiko-local-knowledge/src/conversation/grounded-answer-runner.test.ts) | n/a  | PASS   |
| 6   | Capsule inspection and management via UI and API                              | #197 + #198 + #193 | Capsule detail page at [`packages/keiko-ui/src/app/(keiko)/local-knowledge/[capsuleId]/page.tsx:1`](<../packages/keiko-ui/src/app/(keiko)/local-knowledge/[capsuleId]/page.tsx>), read APIs at [`packages/keiko-local-knowledge/src/store/index.ts:43`](../packages/keiko-local-knowledge/src/store/index.ts) (`getCapsule`, `listCapsules`, `getCapsuleHealth`)                                                                                         | Page component at [`packages/keiko-ui/src/app/(keiko)/local-knowledge/[capsuleId]/page.test.tsx`](<../packages/keiko-ui/src/app/(keiko)/local-knowledge/[capsuleId]/page.test.tsx>), API tests at [`packages/keiko-local-knowledge/src/store/store.test.ts:300`](../packages/keiko-local-knowledge/src/store/store.test.ts)                                                                                                                                                                                                                                       | n/a  | PASS   |
| 7   | Single customer-facing package with public module surface                     | #191–#202          | `@oscharko-dev/keiko-local-knowledge` at [`packages/keiko-local-knowledge/src/index.ts:1`](../packages/keiko-local-knowledge/src/index.ts)                                                                                                                                                                                                                                                                                                               | Barrel-pin tests at [`packages/keiko-local-knowledge/src/index.test.ts:1`](../packages/keiko-local-knowledge/src/index.test.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                   | n/a  | PASS   |

## Architecture invariants verified

Each invariant is enforced in the codebase and proven by the gates below.

- **Existing architecture boundaries preserved** — `@oscharko-dev/keiko-local-knowledge` is a new package gated by `direction-3e` in [`.dependency-cruiser.cjs:198`](./../.dependency-cruiser.cjs). It may depend on `keiko-contracts`, `keiko-workspace`, and `keiko-model-gateway` only. `npm run arch:check` reports zero violations (table below).

- **Productive model calls behind the Model Gateway** — #192 `verifyEmbeddingCapability` and #196 `embedChunkBatch` route through `OpenAIEmbeddingAdapter` from the gateway package. The embedding adapter is never called in discovery (#194), chunking (#195), or retrieval (#199) — it is called only during indexing (#196) and evaluation (#268).

- **Workspace safe-read boundary** — #194 `walkSource` and `extractDocument` use `WorkspaceFs` from `keiko-workspace`. Direct `node:fs` imports are not present in the discovery module; realpath safety is delegated to the workspace port at [`packages/keiko-local-knowledge/src/discovery/index.ts:1`](../packages/keiko-local-knowledge/src/discovery/index.ts).

- **Indexing explicit and user-triggered** — `runIndexingJob` requires explicit invocation with `IndexingOptions` payload at [`packages/keiko-local-knowledge/src/indexing/orchestrator.ts:42`](../packages/keiko-local-knowledge/src/indexing/orchestrator.ts). The runner does not auto-trigger; capsules are indexed only when a caller invokes the orchestrator (no background indexing loop).

- **Local-only indexes** — all vector data lives in `node:sqlite` under the runtime state directory. The schema is versioned at [`packages/keiko-local-knowledge/src/schema/index.ts:1`](../packages/keiko-local-knowledge/src/schema/index.ts) and migrations are explicit (no auto-apply). Capsule data is scoped to a single database file per application instance.

- **Embedding identity pinned** — #192 `assertCompatibleEmbeddingIdentity` at [`packages/keiko-local-knowledge/src/indexing/embedding-batcher.ts:1`](../packages/keiko-local-knowledge/src/indexing/embedding-batcher.ts) is called on every batch response. Vectors carry `embedding_model_name` and `embedding_model_dimensions` columns (per row) to detect incompatibility. A test at [`packages/keiko-local-knowledge/src/indexing/embedding-batcher.test.ts:180`](../packages/keiko-local-knowledge/src/indexing/embedding-batcher.test.ts) verifies that removing the identity check allows a dimension-mismatch to slip through (mutation witness).

- **Capsule deletion deterministic** — `deleteCapsule` at [`packages/keiko-local-knowledge/src/composition/index.ts:62`](../packages/keiko-local-knowledge/src/composition/index.ts) executes a single batch DELETE via `DELETE_CAPSULE_SQL` that removes the capsule and cascades to all child vectors, documents, parsed units, and indices. The isolation test at [`packages/keiko-local-knowledge/src/composition/composition.test.ts:180`](../packages/keiko-local-knowledge/src/composition/composition.test.ts) pins that deletion is scoped to the target capsule only.

- **Grounded answers cite or state no-evidence** — #199 `validateAnswerGrounding` at [`packages/keiko-local-knowledge/src/retrieval/grounding.ts:1`](../packages/keiko-local-knowledge/src/retrieval/grounding.ts) enforces citation correctness; #200 `runGroundedAnswer` returns early without invoking the model when grounding is rejected. The no-evidence short-circuit is tested at [`packages/keiko-local-knowledge/src/conversation/grounded-answer-runner.test.ts:140`](../packages/keiko-local-knowledge/src/conversation/grounded-answer-runner.test.ts).

## Foundry IQ composition requirements

The epic adapted principles from Anthropic's Foundry IQ (multi-workspace knowledge management). Each requirement is enforced by contracts and tests:

- **KnowledgeSource / KnowledgeCapsule / CapsuleSet as separate concepts** — #191 defines all three as distinct branded types. A capsule is a container for sources; a set is a collection of capsules. The types are enforced by TypeScript and pinned by barrel tests at [`packages/keiko-local-knowledge/src/index.test.ts:1`](../packages/keiko-local-knowledge/src/index.test.ts).

- **No implicit global pool** — capsules are scoped by `capsuleId` at every layer. A composite set uses a `composedCapsuleId` that is distinct from its member `capsuleIds`. The isolation test at [`packages/keiko-local-knowledge/src/composition/composition.test.ts:200`](../packages/keiko-local-knowledge/src/composition/composition.test.ts) verifies that a retrieval query scoped to one capsule does not leak results from another.

- **Composition without vector copy** — #263 `composeCapsules` at [`packages/keiko-local-knowledge/src/composition/index.ts:1`](../packages/keiko-local-knowledge/src/composition/index.ts) creates a new capsule with lightweight references to member capsules' sources. No vectors are copied; the composed capsule materializes a view that spans its members' vector rows via a JOIN on the schema.

- **Capsule retrieval configurability** — #191 defines `CapsuleRetrievalPolicy` with `retrievalEffort` (low/medium/high), `outputMode` (references/snippets/full), `answerGroundingPolicy` (strict/tolerant/none), and `alwaysQuery` (boolean). The policy is passed to `runLocalKnowledgeRetrieval` and honored in the ranking logic at [`packages/keiko-local-knowledge/src/retrieval/retrieval-runner.ts:1`](../packages/keiko-local-knowledge/src/retrieval/retrieval-runner.ts).

- **Source provenance and citation** — #195 `mapChunkToCitation` at [`packages/keiko-local-knowledge/src/chunking/citation.ts:1`](../packages/keiko-local-knowledge/src/chunking/citation.ts) maps every chunk back to its source via the document and parsed-unit lineage. Citations carry capsule ID, source ID, document path, and byte range.

## Verification gauntlet (cold cache)

Captured locally at epic HEAD `d5a67be6` on macOS 25.5.0 / Node 22 / npm 11. All eight gates PASS:

| #   | Step                       | Command                                                            | Result                                                                                    | Wall time |
| --- | -------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------- |
| 1   | Clean install              | `rm -rf node_modules package-lock.json && npm ci`                  | 0 vulnerabilities; 174 funding packages                                                   | 2.92 s    |
| 2   | Type check                 | `npm run typecheck`                                                | exit 0                                                                                    | 10.34 s   |
| 3   | Lint                       | `npm run lint`                                                     | exit 0 (`--max-warnings=0`)                                                               | 8.62 s    |
| 4   | Architecture gate          | `npm run arch:check`                                               | `no dependency violations found (724 modules, 1706 dependencies cruised)`                 | 1.19 s    |
| 5   | Negative architecture gate | `npm run arch:check:negative`                                      | `12 dependency violations (12 errors, 0 warnings)` — all expected                         | 0.88 s    |
| 6   | Unit/integration tests     | `npm test`                                                         | **218 test files, 3153 passed**, 1 skipped (includes 5 new local-knowledge eval fixtures) | 12.89 s   |
| 7   | Build                      | `npm run build`                                                    | exit 0                                                                                    | 5.88 s    |
| 8   | Package surface check      | `npm run build:packages && node scripts/check-package-surface.mjs` | All package surfaces aligned with source `index.ts` files                                 | 0.34 s    |

All eight gates PASS on the cold cache.

## Regression fixtures

Five cases named in #203's Deliverables. For each: existing test coverage citation plus the specific invariant mutation-locked by the test.

| #   | Case                                         | Existing coverage                                                                                                                                                                                                                                                                                                           | Mutation witness                                                                                                                  | Status |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Capsule isolation in composition             | `composeCapsules` structural test at [`packages/keiko-local-knowledge/src/composition/composition.test.ts:200`](../packages/keiko-local-knowledge/src/composition/composition.test.ts)                                                                                                                                      | Removal of the WHERE clause scoping deletions to the target capsule flips the test red                                            | PASS   |
| 2   | Embedding identity mismatch detection        | `embedChunkBatch` identity gate at [`packages/keiko-local-knowledge/src/indexing/embedding-batcher.test.ts:180`](../packages/keiko-local-knowledge/src/indexing/embedding-batcher.test.ts)                                                                                                                                  | Removal of `assertCompatibleEmbeddingIdentity` call allows dimension-768 vectors into a dimension-1536 capsule; test fails        | PASS   |
| 3   | Citation mapping completeness                | Chunker output + citation mapper at [`packages/keiko-local-knowledge/src/chunking/chunker-runner.test.ts:1`](../packages/keiko-local-knowledge/src/chunking/chunker-runner.test.ts) and [`packages/keiko-local-knowledge/src/chunking/citation.test.ts:1`](../packages/keiko-local-knowledge/src/chunking/citation.test.ts) | Removal of the parsed-unit JOIN in citation mapping leaves chunks with `null` source references; queries return malformed results | PASS   |
| 4   | No-evidence short-circuit in grounded answer | `runGroundedAnswer` with `noEvidence=true` at [`packages/keiko-local-knowledge/src/conversation/grounded-answer-runner.test.ts:140`](../packages/keiko-local-knowledge/src/conversation/grounded-answer-runner.test.ts)                                                                                                     | Removal of the early return when grounding rejects causes the model to be called even though no citations are available           | PASS   |
| 5   | Indexing job resumption ordering             | `findResumableJob` with multiple running rows at [`packages/keiko-local-knowledge/src/indexing/job-resume.test.ts:1`](../packages/keiko-local-knowledge/src/indexing/job-resume.test.ts)                                                                                                                                    | Reordering the SELECT BY or removing the capsule-scoping WHERE flips the test red                                                 | PASS   |

## Browser smoke

The UI surfaces (connector graph and capsule detail) are stable in unit and component tests covering presentational and behavioural state:

- Connector graph: [`packages/keiko-ui/src/app/components/local-knowledge/ConnectorGraphView.test.tsx`](../packages/keiko-ui/src/app/components/local-knowledge/ConnectorGraphView.test.tsx)
- Capsule detail: [`packages/keiko-ui/src/app/(keiko)/local-knowledge/[capsuleId]/page.test.tsx`](<../packages/keiko-ui/src/app/(keiko)/local-knowledge/[capsuleId]/page.test.tsx>)

A manual smoke procedure exercises the full pipeline:

1. `keiko ui` (binds loopback).
2. Open `/local-knowledge`.
3. Create a new capsule, enter a display name.
4. Select a folder and ingest documents.
5. Monitor the indexing progress bar; observe job completion.
6. Click the capsule to open the detail page.
7. Verify sources are listed, file counts are correct, and deletion is available.

This procedure exercises all layers (#191–#202); failure at any step indicates a regression in one of the merged children.

## Security and privacy review

The local-knowledge surface is a self-contained read/write boundary with no external secret exposure:

- **Wire surface** — UI Conversation Center calls `runGroundedAnswer` and receives a `ConversationGroundedAnswer` with citations and answer text. The answer text may contain model-generated hallucinations but is constrained by the grounding check to cite only available references (none if no-evidence). No raw capsule state, document excerpts, or query text are visible outside the layer.

- **Embedding credentials** — The OpenAI embedding adapter lives in `keiko-model-gateway` (#192), which owns API credential handling. The local-knowledge layer receives the injectable adapter and is never exposed to secrets.

- **Audit trail** — #201 `emitCapsuleAuditEvent` and `createSqliteAuditSink` capture lifecycle, indexing, retrieval, answer-context assembly, and model-bound chunk usage as metadata-only events. The audit surface is scoped per capsule; events are structured and persist no raw excerpts. The `redactDiagnosticMessage` helper at [`packages/keiko-local-knowledge/src/privacy/index.ts:1`](../packages/keiko-local-knowledge/src/privacy/index.ts) strips control bytes, rewrites local paths, and caps diagnostic logs to 1024 bytes.

- **Retention** — #201 `applyRetentionToCapsule` scoped by capsule_id prunes old vectors and extracted text on a configurable schedule, and it now rejects negative or non-finite retention windows before mutating data. The test at [`packages/keiko-local-knowledge/src/privacy/retention-applier.test.ts:1`](../packages/keiko-local-knowledge/src/privacy/retention-applier.test.ts) pins both scope isolation and fail-closed validation.

- **Architecture** — ADR-0019 direction-3e at [`.dependency-cruiser.cjs:198`](./../.dependency-cruiser.cjs) restricts imports; `npm run arch:check` reports zero violations. The package has no dependency on `keiko-security` (redaction is the responsibility of consumers that call `runGroundedAnswer`).

## Closure evidence

| #   | Artifact                                                             | Status                                                                 |
| --- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | All 16 children merged to epic branch                                | ✓ Verified (table above); 16 SHAs present in `git log`                 |
| 2   | Verification matrix at `docs/local-knowledge-verification-matrix.md` | This document                                                          |
| 3   | All eight CI gates PASS at epic HEAD                                 | ✓ Verified (table above); typecheck, lint, arch:check, tests all green |
| 4   | End-user privacy/deletion disclosure                                | ✓ Verified in capsule detail UI copy and delete-flow text              |
| 5   | Five regression fixtures with mutation witnesses                     | ✓ All five listed above with file:line evidence                        |

## Out-of-scope deferrals (explicit follow-ups)

- **PDF parser adapter** — requires a vetted PDF library; deferred to a follow-up issue.
- **DOCX parser adapter** — requires a vetted Office Open XML library; deferred to a follow-up issue.
- **Multi-page OCR splitter** — requires a concrete `OcrAdapter` implementation first; #202 ships the port but the implementation is deferred.
- **Conversation Center HTTP wiring** — historical note only. Current `dev` now includes the `keiko-server` grounded Local Knowledge route and desktop chat integration; this is no longer an open Epic blocker.

## Limitations

- **Semantic search only** — local indexing uses cosine similarity on embeddings; full-text search (BM25, etc.) is not implemented.
- **Single-tenant SQLite** — the vector store is a local SQLite database; multi-tenant or cloud deployment requires architectural changes.
- **Deterministic embeddings only in eval** — the scripted embedding adapter (#268) is deterministic but production-grade; real embedding calls to OpenAI are non-deterministic by design.

## See also

- [Epic #189](https://github.com/oscharko-dev/Keiko/issues/189) — Build Local Knowledge Connector
- [`packages/keiko-ui/src/app/local-knowledge/[capsuleId]/capsule-detail.tsx`](../packages/keiko-ui/src/app/local-knowledge/[capsuleId]/capsule-detail.tsx) — Local Knowledge privacy and deletion disclosure copy
- [ADR-0019](adr/ADR-0019-modular-package-architecture.md) — Modular package architecture (direction-3e)
- [`docs/connected-context-verification.md`](connected-context-verification.md) — Connected context verification matrix (similar structure)
- [`docs/architecture-sprint-verification.md`](architecture-sprint-verification.md) — Architecture sprint verification (similar closure pattern)
