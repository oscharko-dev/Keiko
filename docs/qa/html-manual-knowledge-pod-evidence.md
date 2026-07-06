# Static HTML Manual Knowledge Pod — closure evidence (Epic #1853)

End-to-end closure evidence for the static HTML manual crawler epic. All evidence is body-free:
counts, statuses, and reason codes only — no raw page body, URL, local path, query token, or
credential appears here or in any test fixture. The corpus is synthetic (`manual.test` /
`Product Handbook`); no customer content is committed.

## What is proven

An approved static HTML manual becomes a searchable local Knowledge Pod through the existing Local
Knowledge pipeline, with no second store and no parallel retrieval path:

1. **Contract handoff (#1871).** A redacted `DocumentationIndexingApproval` (Epic #1852) is bridged
   into an internal `HtmlManualSource` via `deriveHtmlManualSource`, which fails closed when the
   recomputed fingerprint or the source kind do not match the approval.
2. **Bounded discovery (#1872).** A breadth-first link-graph crawl resolves `<a>` / frame / iframe /
   canonical links, canonicalises and deduplicates them, follows framesets, and stays inside the
   governed page/depth/byte/time/link limits, emitting body-free denied-link reason codes.
3. **Scope enforcement (#1873).** One pure guard precedes every read/fetch and refuses cross-origin,
   outside-path-prefix, unsupported-scheme, credentialed, action, non-HTML, and hidden/credential-file
   links. Every accepted http link is proven same-origin as the approved, non-metadata origin, so a
   cloud-metadata or link-local link is always refused as `cross-origin` before any address is
   contacted. ADR-0113 carries the recorded trust boundary, including how the follow-up intranet
   fetcher keeps the cloud-metadata address unreachable while reaching an approved private origin.
4. **Indexing integration (#1874).** The captured page set is mounted through an in-memory
   `WorkspaceFs` and indexed by the existing `runIndexingJob` — same HTML parser, chunker, lexical +
   vector indexing, and lifecycle a folder source uses.
5. **Lifecycle + progress (#1875).** A body-free progress projection reports crawl and indexing
   counts, phase, denied reasons, and remediation guidance. A cancelled crawl never publishes a
   ready pod; partial failures read as `degraded`.
6. **Fixtures + regression (#1876).** A synthetic legacy corpus (index, nested chapters, framesets,
   tables, code, duplicate/anchor links, malformed HTML) plus a hostile-link battery exercises the
   full pipeline with leakage assertions.
7. **End-to-end retrieval (#1877).** The pod is searched through the existing
   `runLocalKnowledgeRetrieval` path and returns grounded, body-free references.

## Representative end-to-end run (synthetic `Product Handbook`)

Measured by `packages/keiko-local-knowledge/src/manual-pod.e2e.test.ts` (hermetic, deterministic,
network-free):

| Metric                   | Value                                                                  |
| ------------------------ | ---------------------------------------------------------------------- |
| Crawled / accepted pages | 4 (index + 2 chapters + 1 reference)                                   |
| Pod readiness            | `ready`                                                                |
| Documents indexed        | 4                                                                      |
| Chunks                   | > 0 (6 in the reference run)                                           |
| Vectors persisted        | > 0 (6 in the reference run)                                           |
| Progress phase           | `ready`                                                                |
| Retrieval references     | > 0 grounded references, `noEvidence = false`                          |
| Reference payload        | chunk/document/capsule lineage + citation metadata; no raw body or URL |

Retrieval uses a constant test embedding solely so a query reliably matches an indexed chunk; this
proves index presence and the retrieval path, and makes no claim about final answer quality
(deferred to #1855).

## Gate command summary

Run from the repository root against this branch. See the PR body for the exact captured output.

- `npm run typecheck` — TypeScript strict, full package graph.
- `npm run lint` — ESLint `--max-warnings=0`.
- `npm run format:check` — Prettier.
- `npm test` — Vitest (includes the crawler unit, regression, and end-to-end suites).
- `npm run arch:check` / `npm run arch:check:negative` — ADR-0019 boundaries; confirms
  `keiko-local-knowledge` performs no network egress (trust-9) — the crawl fetch is an injected port.
- `npm run check:adr-index` — ADR registry integrity after the ADR-0113 amendment.

## Known limitations and follow-ups

- **Duplicate-pod marker not persisted.** `KnowledgePodSummary.manualSourceFingerprint` (the Epic
  #1852 dedup key) is carried through `HtmlManualSource` and the create result, but persisting it onto
  the pod summary for cross-session already-indexed detection needs a new nullable capsule column and
  a schema migration; that is a small, isolated follow-up and is intentionally out of scope here.
- **Production intranet egress fetcher.** `keiko-local-knowledge` stays egress-free (trust-9). The
  local manual path is fully real (WorkspaceFs), and the http path is exercised end-to-end through an
  injected fetcher. A `gatewayFetch`-backed `ManualCrawlFetcher` for real intranet crawling, and the
  BFF route and UI that drive it, belong to the follow-up chat-attach work (#1854) and are out of
  scope for these children.
- **Resumable-checkpoint surfacing.** Large-document checkpoint/resume is reused from
  `runIndexingJob`; a user-facing resume surface (`listResumableDocuments`) is a UI concern deferred
  with the rest of the manual UI.
- **Deeper parser/citation quality.** Page-title and anchor-precise citations are deferred to
  structure-preservation work (#1855); refresh/diagnostics to #1856.
