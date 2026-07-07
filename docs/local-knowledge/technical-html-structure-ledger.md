# Technical HTML Structure Retrieval Ledger

Status: implementation and verification ledger for Epic
[#1855](https://github.com/oscharko-dev/Keiko/issues/1855) and child issues
[#1884](https://github.com/oscharko-dev/Keiko/issues/1884),
[#1885](https://github.com/oscharko-dev/Keiko/issues/1885),
[#1886](https://github.com/oscharko-dev/Keiko/issues/1886),
[#1887](https://github.com/oscharko-dev/Keiko/issues/1887),
[#1888](https://github.com/oscharko-dev/Keiko/issues/1888), and
[#1889](https://github.com/oscharko-dev/Keiko/issues/1889).

This ledger records evidence only; it is not a substitute for local gate output, PR review, or
human-owned issue closure after merge. It contains only synthetic, redacted, body-free evidence:
counts, fixture ids, gate names, test-file names, and enums — never raw HTML bodies, real manual
URLs, private paths, tokens, or PII.

Epic #1855 **extends** the existing Local Knowledge HTML parser, chunker, citation mapper, and
retrieval-evaluation harness. It introduces no new parser registry, no browser-rendered extraction
path, no manual-only chunk store or retrieval index, and no new network egress. Static HTML
ingestion continues to execute no JavaScript and trusts no DOM.

## Reuse anchors

| Area                     | Reused surface                                                                               | Extension in this epic                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| HTML parser              | `packages/keiko-local-knowledge/src/parsers/html-parser.ts` single-pass scanner              | Title capture, `<dl>`/`<dt>`/`<dd>`, verbatim `<pre>`/`<code>`, `<frame>` navigation, heading anchor id                                     |
| Shared parser internals  | `packages/keiko-local-knowledge/src/parsers/_internal.ts` byte decoder                       | `decodeBytes` reports the codec + honors a declared charset fallback; `readAttribute` promoted and shared                                   |
| Attribute reader (reuse) | `packages/keiko-local-knowledge/src/parsers/xlsx-parser.ts` `attribute()`                    | Consolidated into the shared `readAttribute`; the XLSX parser now delegates instead of keeping a second regex                               |
| Parsed-unit contract     | `packages/keiko-contracts/src/local-knowledge-records.ts` `ParsedUnit` / `CitationReference` | Additive optional `anchorId` on the `html-block` kind and on `CitationReference`                                                            |
| On-disk schema           | `packages/keiko-contracts/src/local-knowledge-schema.ts` migration manifest                  | Additive `parsed_units.anchor_id` column via forward-only migration v25 (DB schema version 24 → 25)                                         |
| Chunker                  | `packages/keiko-local-knowledge/src/chunking/chunker.ts` boundary ladder                     | Line/row boundary probe before the hard cut, checked ahead of mid-line sentence punctuation; strategy version `boundary-v3` → `boundary-v5` |
| Citation mapper          | `packages/keiko-local-knowledge/src/chunking/citation-mapper.ts` `mapChunkToCitation`        | Projects the sealed `anchor_id` onto the citation, alongside the existing heading `sectionPath` hop                                         |
| Retrieval evaluation     | `packages/keiko-local-knowledge/src/evaluations/fixtures.ts` `ALL_FIXTURES` + scoring        | New `html-manual-structure` fixture scored by the existing Recall@K / MRR / nDCG / citation dimensions                                      |

## Supported HTML structures

| Structure           | Extraction behavior                                                                                                                                                                                               | Retrieval signal preserved                                                                         | Regression evidence (`html-parser.test.ts`)                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page title          | `<title>` captured before `<main>` narrowing and emitted as a searchable block                                                                                                                                    | Manual name available for grounding even when the title lives in head                              | "captures the document `<title>` …", "does not double-emit the `<title>`"                                                                                |
| Heading hierarchy   | Existing `<h1>`–`<h6>` stack → `headingPath`                                                                                                                                                                      | Section breadcrumb on the citation                                                                 | "emits one html-block per heading section"                                                                                                               |
| Section anchor      | Nearest heading `id`/`name` stamped as `anchorId`                                                                                                                                                                 | Deep-link fragment on the citation                                                                 | "stamps the nearest heading anchor id onto blocks in that section"                                                                                       |
| Tables              | Header-attached rows (`Header=value \| …`) as one block per row, `<caption>` surfaced as its own `Table caption: …` block, nested sub-tables no longer truncate the outer row                                     | Column header stays attached to the row value; the table's own label is no longer silently dropped | "surfaces `<table><caption>` text instead of silently dropping it", "does not truncate an outer table row at a nested sub-table's closing tag"           |
| Definition lists    | `<dt>`/`<dd>` paired as `Term: definition`; a nested `<dl>` inside a `<dd>` no longer truncates later sibling terms                                                                                               | Term stays attached to its definition                                                              | "keeps definition-list terms attached to their definitions", "does not truncate a nested `<dl>` inside a `<dd>`"                                         |
| Code / preformatted | `<pre>`/`<code>` emitted verbatim (no whitespace collapse) with a `Code (<lang>):` hint                                                                                                                           | Indentation, line breaks, and exact identifiers survive                                            | "preserves `<pre>`/`<code>` whitespace, identifiers, and language hint"                                                                                  |
| Frameset navigation | `<frame>`/`<iframe>` `src` surfaced as `Frame: <path>`, host/query/fragment redacted for absolute and protocol-relative (`//host/...`) targets; non-http(s) schemes (`javascript:`, `data:`, …) rejected outright | Table-of-contents targets discoverable without executing scripts, no host/token/payload leak       | "surfaces frameset navigation targets redacted of host and query tokens", "rejects a javascript: frame src …", "redacts a protocol-relative frame src …" |
| Legacy encodings    | Declared `<meta charset>` cross-checked against the byte-shape decode                                                                                                                                             | Predictable degradation with a diagnostic, no silent corruption                                    | "warns when the declared `<meta charset>` disagrees", "uses the declared charset"                                                                        |

## Scenario coverage

| Scenario                        | Expected behavior                                                                                                                        | Regression evidence                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `<script>`/`<style>` stripped   | No JavaScript executed; no markup in any unit span or `normalizedText`                                                                   | `html-parser.test.ts` GRD-003 tests (unchanged, still green)                                      |
| Boilerplate dropping            | `nav`/`footer`/`aside`/cookie banners excluded; `<main>` preferred                                                                       | "prefers main content and skips nav/footer/cookie boilerplate"                                    |
| Malformed / unterminated markup | Consumed to EOF without leaking raw bytes                                                                                                | "treats an unterminated `<script>` as raw text consumed to EOF"                                   |
| Oversized document              | Bounded by `maxBytes` / unit + chunk limits                                                                                              | Parser oversize + perf tests; `chunker.test.ts` chunk caps                                        |
| Large table / code block        | Split at line/row boundaries, never mid-line                                                                                             | `chunker.test.ts` "splits an oversized code/table unit at line boundaries"                        |
| Anchor round-trip to citation   | Sealed `anchor_id` re-hydrates onto the citation                                                                                         | `citation-mapper.test.ts` "surfaces the html-block anchorId …"                                    |
| Structure retrieval             | Table-identifier, anchored-section, definition, and retry-limit questions recalled                                                       | `html-manual-structure` fixture (`check:retrieval-quality`)                                       |
| Malformed tag boundary          | An unterminated attribute quote degrades within the scope of the one malformed tag, never leaking the rest of the document as raw markup | "does not leak the rest of the document as raw markup after an unclosed attribute quote"          |
| Nested raw-text in table/dl     | A `<script>`/`<style>` nested inside `<table>`/`<dl>` is dropped even if its body contains a `</table>`/`</dl>`-shaped literal           | "drops a `<script>` nested in `<table>`/`<dl>` even when its body contains a literal closing tag" |

## Gate matrix

| Gate                              | Status | Evidence (command)                                       |
| --------------------------------- | ------ | -------------------------------------------------------- |
| Type check                        | PASS   | `npm run typecheck`                                      |
| Lint                              | PASS   | `npm run lint`                                           |
| Format                            | PASS   | `npm run format:check`                                   |
| Unit + integration tests          | PASS   | `npm test`                                               |
| Architecture (direction + policy) | PASS   | `npm run arch:check`                                     |
| Architecture (negative)           | PASS   | `npm run arch:check:negative`                            |
| Local Knowledge retrieval quality | PASS   | `npm run check:retrieval-quality` (18/18 fixtures)       |
| Grounded retrieval quality        | PASS   | `npm run check:grounded-retrieval-quality`               |
| Grounded faithfulness             | PASS   | `npm run check:grounded-faithfulness`                    |
| Release-impact metadata           | PASS   | `npm run check:release-impact` (unchanged; no new entry) |

`packages/keiko-ui/` is untouched, so the editor release-evidence fingerprint
(`check:editor-release-evidence`) is unaffected. Platform-specific fingerprints remain
Linux-authoritative.

## Release evidence summary

- **Improved:** exact identifier lookup inside tables (e.g. an error code and its severity),
  section-anchored questions, definition-list term/definition questions, and retry-limit
  natural-language questions over technical HTML manuals — proven by the deterministic
  `html-manual-structure` scorecard (Recall / MRR / nDCG / citation quality = 1.000) and the
  parser/chunker/citation regression tests above. Cross-language retrieval over technical HTML
  manuals is not a claim of this fixture; multilingual coverage is owned by the pre-existing
  `multilingual-retrieval` fixture.
- **Compatibility:** additive. Existing Local Knowledge stores keep working. The new
  `parsed_units.anchor_id` column is applied by forward-only migration v25; the chunking strategy
  version bump (`boundary-v5`) marks previously chunked documents stale so a refresh/reindex adopts
  the improved boundaries. No content migration is required.
- **Regression detection:** the parser tests fail if a technical structure stops being extracted;
  the chunker test fails if a large unit splits mid-line; the citation test fails if the anchor
  stops round-tripping; and the retrieval fixture (registered in `REGRESSION_PROBE_FIXTURE_IDS`)
  fails, and is proven non-tautological, via `check:retrieval-quality`.

## Security and architecture disposition

- No JavaScript execution and no DOM trust; the parser remains a pure single-pass string scanner.
  Preserved structure is emitted as decoded plaintext — `normalizedText` and every unit span stay
  markup-free (GRD-003 tests unchanged).
- Body-free evidence: diagnostics carry only codes, normalized charset labels (capped at 64
  characters), and a normalized declared-charset value; the new `anchor_id` is a fragment
  identifier (never a raw href), sealed at rest exactly like `heading_path_json` and registered in
  the local-state audit target list. `anchorId` is restricted to a conservative slug character
  class (letters, digits, `-`, `_`, `.`, `:`) — path separators, quote characters, and bare
  colon-scheme prefixes (`javascript:…`) are rejected, since a future citation-rendering consumer
  (e.g. [#1879](https://github.com/oscharko-dev/Keiko/issues/1879)) may build a deep link from it.
- Frame `src` targets are surfaced only as redacted navigation references (host, query, and
  fragment removed for absolute and protocol-relative targets alike; any non-http(s) scheme is
  rejected outright); the parser never fetches or follows a link. Any following of manual links
  remains the crawler's injected-fetch responsibility, preserving the local-first, no-implicit-egress
  posture.
- Boundaries unchanged: this epic aligns to
  [ADR-0019](../adr/ADR-0019-modular-package-architecture.md) (one-directional
  dependencies; provider-SDK isolation),
  [ADR-0036](../adr/ADR-0036-hybrid-grounding-reciprocal-rank-fusion.md) (RRF fusion is unchanged —
  `RRF_K=60`, no raw cross-space score mixing), and
  [ADR-0113](../adr/ADR-0113-governed-documentation-browser.md) (the governed source of HTML
  manuals). **No new ADR is introduced** — this is an additive parser/chunker/contract/evaluation
  change with no boundary move — so `check:adr-index` stays green. If a future change does add an
  ADR it must take the next free number and be indexed in the same commit.

## Post-merge audit hardening

A post-merge audit of this epic (after the merge recorded above) found and closed several
confirmed defects in the shipped parser, none of which change the supported-structures or
scenario-coverage claims above beyond what those tables already reflect:

- The tag-boundary scanner (`readTagAt`/`findTagEnd`) now falls back to a plain `>` search, scoped
  to the one malformed tag, when an attribute value's quote never closes — an unterminated quote
  previously left the scanner unable to find any tag end for the rest of the document, causing raw
  markup to leak into `normalizedText` as literal text.
- The depth-aware nested-element walk backing `<table>`/`<dl>` extraction
  (`findNestableElementEnd`) now skips `<script>`/`<style>`/`<noscript>` subtrees the same way the
  top-level body scanner and `<title>`/`<pre>` text extraction do — a raw-text body containing a
  literal `</table>`/`</dl>`-shaped substring could otherwise be mis-read as the real close tag,
  ending the scan early and leaking the remainder of the script/style body (GRD-003).
- `redactFrameTarget` now also strips the host from protocol-relative frame targets
  (`//host/path`), which previously bypassed both the unsafe-scheme check and the `://` check and
  were forwarded verbatim.
- `anchorFromTag` now allowlists a conservative slug character class instead of only blocklisting
  `://`, closing a gap where a path-like or scheme-like value (e.g. `javascript:alert(1)`) could be
  accepted as an `anchorId`.
- `readDocumentTitle` and `readMetaCharset` were narrowed to walk real tags (skipping raw-text
  subtrees) instead of doing an un-scoped substring search, so a `<title>`-shaped literal inside an
  earlier `<script>`, or the word "charset" in ordinary prose, no longer produces an incorrect
  title capture or a spurious `HTML_CHARSET_MISMATCH` diagnostic.
- The chunker's boundary ladder now checks a line/row boundary ahead of mid-line sentence
  punctuation (`chooseChunkEnd`), so a decimal literal or a trailing-period comment inside a
  preserved code line or table row no longer starves the line-boundary probe — see the strategy
  version bump above.
- The `html-manual-structure` fixture's mounting-torque and retry-limit queries were rewritten as
  literal-phrase, exact-strategy queries so they are lexically grounded rather than resolved purely
  by the fixture harness's topic-boost mechanism; the retry-limit query no longer exercises a
  cross-language axis (see the "Improved" note above).

Every item above has a regression test in `html-parser.test.ts` / `chunker.test.ts` (or, for the
fixture rewrite, an empirical topic-salt-ablation check) that fails against the pre-hardening code
and passes against the current code.

## Operating guidance

- To claim a movement in technical-manual retrieval quality, run `npm run check:retrieval-quality`
  and read the `html-manual-structure` scorecard row; investigate a failure at the owning layer
  (parser → `html-parser.test.ts`, chunk boundaries → `chunker.test.ts`, citation shape →
  `citation-mapper.test.ts`).
- After upgrading, operators may refresh/reindex a manual pod to adopt the improved extraction and
  chunk boundaries. No manual content migration is required.

## Known limitations and follow-ups

- No rendered/JavaScript-executed capture. Content that only exists after client-side rendering is
  out of scope and is not extracted; introducing a rendered path would be a separate governed
  capability with its own scope, policy, and security review.
- Anchor precision is heading-scoped: blocks inherit the nearest heading's `id`/`name`. Non-heading
  in-body anchors are not individually addressed.
- Table serialization keeps the pre-existing `Header=value` projection (header-attached); a
  structured per-row citation kind was intentionally not introduced to keep the change additive and
  avoid a parallel table-unit subsystem. Cell values remain in the chunk text behind
  `safeExcerptHash`, preserving the body-free contract surface.
- The retrieval fixture seeds pre-chunked rows (like every `ALL_FIXTURES` entry) and does not run
  the real parser; end-to-end parser/chunker regressions are owned by the co-located parser and
  chunker unit tests. This split is deliberate and recorded on
  [#1888](https://github.com/oscharko-dev/Keiko/issues/1888).
