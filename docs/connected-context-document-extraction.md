# Repository Search — bounded small-document extraction (Issue #1285)

Repository Search remains a fast, code-first grounded search capability. Issue #1285 adds a
bounded, request-local fallback so that small everyday business documents that are **explicitly
connected** to a chat are no longer silently ignored. The fallback extracts safe text from small
`.docx`, `.xlsx`, and text-layer `.pdf` files, includes that content as distinguishable repository
evidence, and reports stable diagnostics for files that cannot be used.

This document records the reuse/generalization decision (an Expected Verification deliverable), the
enforced bounds, the diagnostic taxonomy, and the trust-boundary guarantees.

## Reuse / generalization decision

**Decision: reuse the existing Local Knowledge parser adapters through a new, pure public API in
`keiko-local-knowledge`; integrate in `keiko-server`. Do not duplicate parser logic, and do not add
a parser dependency to `keiko-workspace`.**

The DOCX/XLSX/PDF parsers already exist in `keiko-local-knowledge` (`src/parsers/{docx,xlsx,pdf}-parser.ts`,
Epic #189) and already pull their runtime dependencies (`yauzl`, `pdfjs-dist`). Reusing them adds **no
new supply-chain dependency**.

The architecture gates (`.dependency-cruiser.cjs`, severity `error`) constrain where the bounded
extractor can live:

- `keiko-workspace` is a leaf package: it may depend only on `keiko-contracts` and `keiko-security`
  (ADR-0019 direction 3b). It therefore **cannot** import the Local Knowledge parsers, so the
  pre-existing text-only `keiko-workspace/src/document-extraction.ts` (the Issue #148 conversation
  attachment path) is intentionally **not** the host for this feature.
- `keiko-local-knowledge` may depend on `keiko-contracts` + `keiko-workspace` + `keiko-model-gateway`
  (direction 3e); it is the only package that may compose the parsers.
- `keiko-server` may depend on both `keiko-local-knowledge` and `keiko-workspace` (direction 6a); it
  bridges them.

Accordingly:

- **`keiko-local-knowledge`** gains a pure public function `extractBoundedDocumentText(input, options)`
  (`src/bounded-document-extraction.ts`). It wraps the existing parser singletons, surfaces their
  internal `normalizedText` as a bounded, UTF-8-capped projection, and returns a discriminated
  outcome. It performs **no** filesystem access and **no** redaction — bytes in, text out — mirroring
  the parser adapters themselves.
- **`keiko-server`** gains `grounded-document-evidence.ts`, which reads bytes through the workspace
  path-safety primitives, enforces the input cap, calls the bounded extractor, redacts the text, and
  produces request-local `document-extract` evidence atoms + excerpt windows (or a stable
  diagnostic). It is wired into the existing grounded orchestrator pack assembly.
- **`keiko-contracts`** is extended additively (no schema-version bump): a `document-extract`
  evidence provenance kind, four document diagnostic omission reasons, and an optional
  `documentFormat` discriminator on the browser citation.

A shared bounded-parser contract in `keiko-contracts` was rejected: `keiko-contracts` is a pure-data
leaf and must not carry parser logic or the internal `normalizedText` representation.

## Supported formats and enforced bounds

Supported (extracted): `.docx` (OOXML text), `.xlsx` (sheet/cell text within budget), text-layer
`.pdf`. All bounds are enforced in `keiko-server/src/grounded-document-evidence.ts`:

| Bound                                         | Value  | Enforcement point                                           |
| --------------------------------------------- | ------ | ----------------------------------------------------------- |
| Max input file size                           | 2 MiB  | `fs.stat` **before** any byte read or parser execution      |
| Max extracted text per document               | 32 KiB | bounded extractor output clamp                              |
| Max total extracted text per grounded request | 64 KiB | per-request aggregate budget                                |
| Max excerpt window size                       | 8 KiB  | matches the context-pack assembler per-excerpt cap          |
| Max excerpt windows per document              | 8      | windowing of the extracted text                             |
| Per-document parser timeout                   | 5 s    | `AbortSignal` + parser deadline                             |
| Max parser units per document                 | 5 000  | parser `maxUnitsPerDocument` (bounds paragraphs/rows/pages) |

Only `files` scopes with `explicitConnection === true` are eligible. Whole-workspace and directory
scopes stay on the unchanged code-first path. Extraction runs only after a connected document is
selected; nothing is parsed speculatively.

## Diagnostic taxonomy

Every non-usable connected document produces a stable diagnostic. The bounded extractor returns an
outcome which the server maps to a `CandidateOmissionReason`:

| Condition                                                | Extractor outcome         | Omission reason      |
| -------------------------------------------------------- | ------------------------- | -------------------- |
| File over 2 MiB                                          | `oversized`               | `size-exceeded`      |
| Legacy/other document format (`.doc`, `.ppt`, `.odt`, …) | (not parsed)              | `unsupported-format` |
| Scanned / image-only PDF, or empty-but-valid container   | `no-text-layer` / `empty` | `no-text-layer`      |
| Corrupt / truncated container                            | `malformed`               | `malformed-document` |
| Password-protected / encrypted (CFB-wrapped OOXML)       | `encrypted`               | `encrypted-document` |
| Per-document timeout                                     | `timed-out`               | `budget-exhausted`   |
| Per-request aggregate budget exhausted                   | —                         | `budget-exhausted`   |
| Denied / escaping path                                   | —                         | `outside-scope`      |
| Unreadable (I/O error)                                   | —                         | `tool-unavailable`   |

Whenever at least one connected document is skipped, a `scope-incomplete` uncertainty marker is added
so the grounded answer discloses that Repository Search reads text, code, and small documents only.

Encryption detection is limited to OOXML documents wrapped in a Compound File Binary (OLE2) container
(the common password-protected Word/Excel case, signature `D0 CF 11 E0 A1 B1 1A E1`). An encrypted PDF
that the parser cannot open degrades gracefully to `malformed-document`; OCR and PDF `/Encrypt`
sniffing are out of scope.

## Evidence semantics

- Document excerpts carry a distinct `document-extract` provenance kind. Line ranges index the
  extracted-text projection (DOCX paragraph / XLSX row / PDF page lines), not original on-screen
  lines; the model prompt labels them `Document evidence (<FORMAT>, extracted text)` and the browser
  citation carries a `documentFormat` discriminator + format badge.
- Extracted document content is **not** persisted as a Local Knowledge capsule, vector, index, or
  cache. It exists only for the duration of the grounded request. Because document evidence is
  request-local and not part of the micro-index file-state key, a scope carrying documents is not
  served from or written to that cache.

## Trust boundary

- Bytes are read through `resolveWithinWorkspace` + `containedRealPathInfo` + the always-on deny
  list, identical to every other workspace read. Denied or escaping paths never reach a parser.
- The Local Knowledge extractor is pure and does not redact. The server module calls
  `redact()` on the extracted text **before** it enters any excerpt window, prompt, or citation, so
  credential-shaped strings inside a document cannot reach the model, the citation surface, or the
  evidence manifest.
- No path safety, deny rules, redaction, evidence semantics, Model Gateway boundaries, or
  deterministic verification are weakened. Model calls stay behind the Model Gateway; the
  orchestrator remains the workflow authority.

## Out of scope (unchanged)

OCR; vision / multimodal image analysis; embedded image parsing; legacy `.doc` parsing; persistent
indexing, vector storage, Local Knowledge capsules, or hidden caches; raising the 2 MiB input cap.
Local Knowledge remains the recommended product path for large, old, complex, OCR-heavy, image-heavy,
or durable retrieval use cases.
