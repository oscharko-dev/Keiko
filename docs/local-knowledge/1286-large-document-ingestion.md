# Local Knowledge: bounded large-document ingestion (Issue #1286)

Parent epic: #1160. This document records the existing-capability review, the
reuse/extension decision, the resource-policy defaults, the supported
progressive-extraction strategy, the capability-aware fallback behavior, and the
known limitations for bounded large-document ingestion in Local Knowledge.

It is the architecture-decision deliverable required by Issue #1286
("Existing-capability review and architecture decision recorded in the issue or
linked PR").

## 1. Problem

Local Knowledge previously ingested every supported file by reading the full
file into a single in-process `Uint8Array`, hashing the whole buffer, handing
the complete buffer to a format parser, and only then chunking and embedding the
extracted text. A tactical mitigation on `release/0.2.0` raised the parser
defaults to a 1 GiB max file size, 25,000,000 parser objects, and a 60-minute
parser deadline. That mitigation removed the hard ceiling but did not change the
execution model: peak working set still scaled with the extracted document, an
interrupted job could only restart from scratch, and a missing optional
capability (OCR, multimodal) was indistinguishable from a pipeline failure.

## 2. Existing-capability review (reuse-first)

The implementation **extends** the existing Local Knowledge surfaces. It does
**not** introduce a parallel ingestion subsystem, job store, source graph, or
vector path. The review below records what already exists and where the
large-document path hooks in.

| Surface                   | File(s)                                                         | Reused as-is                                                                                                       | Extended                                                                                                              |
| ------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Parser contract           | `parsers/types.ts`                                              | `ParserAdapter`, `AsyncParserAdapter`, `ParserOptions`, `InternalParserResult`, `shouldStop()`                     | New `ProgressiveExtractor` contract coexists with the full-buffer adapters                                            |
| PDF text-layer extraction | `parsers/pdf-parser.ts`                                         | `loadPdfDocument`, per-page `streamTextContent`, `shouldStop` boundaries, DOM polyfills, page records              | New page-windowed `progressive-pdf` strategy reuses the same pdfjs loader and per-page reader                         |
| OCR / multimodal          | `parsers/ocr/*`                                                 | `OcrAdapter` port, `OcrPipelineParser` factory, null adapter                                                       | Capability discovery + degraded/failing isolation; missing capability becomes a quality warning                       |
| Legacy `.doc`             | `parsers/unsupported-parser.ts`                                 | `unsupported-media` fallback path                                                                                  | Stable `CONVERTER_UNAVAILABLE` diagnostic with actionable guidance                                                    |
| Discovery / extraction    | `discovery/extract.ts`                                          | realpath containment, deny rules, hash fast-path, redaction, persistence                                           | Preflight classification + progressive extraction routing for large supported files                                   |
| Indexing orchestrator     | `indexing/orchestrator.ts`                                      | job/document events, cancellation via `AbortSignal`, incremental skip, embedding batching, partial-vector recovery | Per-phase checkpoint writes + resume from durable progress                                                            |
| Job persistence / resume  | `indexing/job-persist.ts`, `indexing/job-resume.ts`             | `indexing_jobs` row lifecycle, `findResumableJob`                                                                  | Phase/coverage columns; true resume backed by the checkpoint table                                                    |
| Store / schema            | `store.ts`, `contracts/local-knowledge-schema.ts`               | forward-only migration runner, `PRAGMA user_version`, STRICT tables, FK cascade                                    | New `extraction_checkpoints` table + `indexing_jobs` columns (DB schema v11)                                          |
| BFF                       | `keiko-server/local-knowledge-handlers.ts`                      | health summary, conflict responses, abandoned-job recovery, diagnostics pagination, error redaction                | Large-document progress / partial-coverage / quality-warning / policy-decision / resume fields, `resume` reindex mode |
| UI                        | `keiko-ui/.../capsule-detail.tsx`, `lib/local-knowledge-api.ts` | index status, source coverage, diagnostics, job-history polling                                                    | Granular phase progress, partial-coverage badges, quality warnings, retry/resume controls, accessible live regions    |

## 3. Resource policy

`LargeDocumentResourcePolicy` (`keiko-contracts`) separates every bounded
dimension instead of collapsing them into the single parser `maxBytes` constant:

| Dimension                      | Field                            | Default    |
| ------------------------------ | -------------------------------- | ---------- |
| Raw file bytes                 | `maxRawFileBytes`                | 1 GiB      |
| Extracted text bytes           | `maxExtractedTextBytes`          | 256 MiB    |
| Parser pages / units           | `maxParserUnits`                 | 200,000    |
| Parser objects                 | `maxParserObjects`               | 25,000,000 |
| Chunk count                    | `maxChunkCount`                  | 2,000,000  |
| Embedding batch count          | `maxEmbeddingBatchCount`         | 100,000    |
| Wall-clock runtime             | `maxWallClockMs`                 | 60 min     |
| Cancellation deadline          | `cancellationDeadlineMs`         | 15 s       |
| Retry count                    | `maxRetryCount`                  | 3          |
| Persisted storage growth       | `maxPersistedStorageGrowthBytes` | 512 MiB    |
| Large-file preflight threshold | `largeFileThresholdBytes`        | 64 MiB     |
| Page window size               | `extractionWindowPages`          | 16         |

The defaults live in `DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY` and are validated
by `validateLargeDocumentResourcePolicy`, so they are configurable through Local
Knowledge configuration / BFF defaults rather than hidden inside parser
constants. `largeDocumentPolicyFingerprint()` produces a stable string that is
persisted with each checkpoint so a resumed job can detect a policy change.

`maxRawFileBytes` is also enforced synchronously at connect time for `"files"`
scopes (`guardConnectorSourcePath` in `keiko-server/local-knowledge-handlers.ts`):
a native multi-file pick is a bounded, explicit relative-file list, so each file
is `stat`-ed and rejected up front instead of only being discovered during
indexing. `"folder"`/`"repository"` scopes are unbounded recursive walks and stay
size-checked only at indexing time, as before.

## 4. Progressive extraction

A `ProgressiveExtractor` yields the document as an ordered sequence of bounded
`ProgressiveExtractionWindow` values (a page window for PDF). The driver
`runProgressiveExtraction` persists each window's text and provenance before the
next window is requested, so the extraction working set never grows past one
window plus the policy-bounded accumulators.

- `progressive-pdf` reuses the existing pdfjs loader and per-page text reader.
  pdfjs-dist requires the raw byte buffer in memory to open a document — that is
  an upstream limitation, documented in §8 — but **useful work begins after the
  first window** and neither the extracted text, the chunk set, nor the
  embedding batch is held in full at any point. Peak RSS therefore does not scale
  with extracted-text size.
- A deterministic synthetic streaming source (`syntheticStreamingSource`) backs
  the bounded-RSS regression. It never materializes the whole document, proving
  the contract supports byte-windowed sources for future native-streaming
  parsers and giving a 1 GiB-class fixture without committing a binary blob.

## 5. Checkpoints and resume

`extraction_checkpoints` persists one row per `(capsule_id, document_id)` with
the parser phase, page/section/object cursors, extracted-text-bytes window,
chunk cursor, embedded-chunk cursor, retry count, terminal diagnostics, and a
compatibility fingerprint (source content hash, parser version, policy
fingerprint, chunking strategy version, embedding identity).

Resume reads the checkpoint and continues from the recorded phase only when the
fingerprint still matches. `checkpointCompatibility()` refuses a stale checkpoint
with a precise reason (`source-hash`, `parser-version`, `resource-policy`,
`chunking-strategy`, or `embedding-identity`) and the job restarts cleanly with a
`CHECKPOINT_INCOMPATIBLE` diagnostic. Cancellation writes the checkpoint before
unwinding so the cancelled state is durable and resumable.

## 6. Capability-aware fallbacks

`discoverExtractionCapabilities` reports OCR and multimodal availability as
`available | unavailable | degraded | failing`. When a capability is missing or
fails:

- text-layer and metadata indexing still complete deterministically;
- a partial-coverage quality warning is recorded
  (`OCR_CAPABILITY_UNAVAILABLE`, `MULTIMODAL_CAPABILITY_UNAVAILABLE`,
  `PARTIAL_COVERAGE`) instead of failing the job or invalidating the capsule;
- when an approved OCR/multimodal adapter is injected, its text is indexed with
  page/region provenance through the existing `PageRecord` / `ParsedUnit`
  contracts.

Capsule health distinguishes **pipeline stability** (the job succeeded) from
**retrieval quality** (coverage was partial with explicit warnings).

## 6a. Bounded text storage and the unified span reader

Storing a multi-hundred-MiB extracted text as one `document_texts.normalized_text`
column would force either an O(n) JS string at write time or an O(n²) `||` append.
DB schema **v12** adds `document_text_windows(capsule_id, document_id, window_index,
character_start, character_end, normalized_text)`: a progressively-extracted
document persists its text as one bounded row per extraction window. The on-disk
text is stored exactly once with linear growth, and the JS working set never holds
more than one window.

`readDocumentTextSpan(db, capsuleId, documentId, charStart, charEnd)` is the single
text-read primitive: it reads a bounded span via SQLite `SUBSTR` from
`document_texts` for small files, or from the one `document_text_windows` row that
contains the span (every chunk lies inside one page → one window) for large files.
All three text-read sites route through it — bounded chunking, bounded embedding,
and retrieval citation excerpts.

## 6b. End-to-end pipeline

1. **Discovery** (`extract.ts`): preflight routes a file `≥ largeFileThresholdBytes`
   with a matching progressive extractor to `extractDocumentProgressive`, which
   flushes each window (pages, parsed units, one `document_text_windows` row,
   checkpoint) in its own transaction. Small files keep the exact existing path.
2. **Orchestrator** (`bounded-indexing.ts`): a document carrying an
   `extraction_checkpoints` row is chunked by reading each parsed unit's text via
   `readDocumentTextSpan` (byte-identical chunk ids/offsets/hashes to the full-text
   chunker), then embedded one batch at a time over chunks that have no vector yet —
   the missing-vector gate is the self-healing resume. The checkpoint advances
   between batches; an incompatible checkpoint restarts with a
   `CHECKPOINT_INCOMPATIBLE` diagnostic.
3. **BFF** (`local-knowledge-handlers.ts`): exposes the resource policy
   (operator-overridable `KEIKO_LK_LARGE_DOC_THRESHOLD_BYTES`), per-document
   progress, partial-coverage / quality-warning / resumable counts, and routes the
   `resume` reindex mode to a checkpoint-resuming job.
4. **UI** (`capsule-detail.tsx`): renders per-document phase progress, a
   partial-coverage badge, retrieval-quality warnings, and a Resume control, with an
   accessible live region announcing active phases.

## 6c. Verified bounded resource use

The bounded-memory profile drives a fully-streamed synthetic fixture (the source
generates bytes per window and is never held whole). Across an 8× document-size
difference the peak single byte-window read and peak text row are **identical**
(O(window), not O(document)), persisted text grows linearly as per-window rows, and
no `document_texts` column is written for a large document. pdfjs-dist still holds
the raw PDF buffer for real PDFs (see §8); the synthetic streaming fixture
demonstrates the contract supports a fully byte-windowed source.

## 7. Backward compatibility

Files below `largeFileThresholdBytes` follow the exact existing buffer path with
no behavior change. The new columns and table are additive; existing small-file
indexing, incremental refresh, repair-failed mode, force reindex, embedding
batching, vector compatibility, and capsule deletion are unchanged and covered by
regression tests.

## 8. Known limitations

- pdfjs-dist requires the full raw PDF byte buffer to open a document; the
  progressive path bounds the _extraction/chunking/embedding_ working set and
  persists incrementally, but the raw buffer itself is held by pdfjs for the
  lifetime of the document handle. A future native byte-windowed PDF source can
  drop in behind the same `ProgressiveExtractor` contract.
- OCR and multimodal extraction are optional and disabled by default. No
  third-party OCR/vision/conversion service is required, and none is added that
  needs secrets or external customer-data egress.
- Legacy `.doc` and older binary office formats are reported with a stable
  `CONVERTER_UNAVAILABLE` diagnostic; no converter is bundled.
