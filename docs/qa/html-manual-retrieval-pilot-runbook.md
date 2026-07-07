# HTML Manual Knowledge Pod — private pilot runbook (Epic #1858)

Operational runbook for testing a real, private customer HTML manual locally without committing any
private content. This record is body-free: it describes a procedure and an evidence format, but no
manual body, raw crawled page, private filesystem path, private URL, query token, credential,
cookie, prompt, or provider endpoint appears here, and none may appear in the evidence a pilot
produces. A pilot operator runs this against their own local documentation; nothing they open,
index, or refresh is committed to this repository.

## What is proven

A completed pilot demonstrates, for one real manual and without leaking its content, that:

1. **Scoped opening is under human control.** Opening a page in the governed browser is not consent
   to crawl or index it; indexing begins only after an explicit, local approval of an origin and
   path-prefix scope with page, depth, byte, time, and concurrency limits.
2. **Retrieval answers real handbook questions.** Exact identifier, error-code, table-row,
   section/anchor, code-block, index-page, and multilingual questions retrieve the right evidence,
   matching the query classes the synthetic goldset
   (`docs/local-knowledge/knowledge-pod-retrieval-goldset-ledger.md`) scores deterministically.
3. **Citations are openable and correct.** Each grounded answer cites a chunk that resolves to a
   real manual section (heading path plus, where present, an in-document anchor), and a denied or
   out-of-scope link returns no evidence rather than a confident wrong answer.
4. **Evidence stays body-free.** Every number an operator reports — page counts, chunk counts,
   retrieval hit/miss, citation resolution, denied-link counts — is a count, status, or reason code,
   never a raw body, path, or URL.

## Representative end-to-end run

Run Keiko locally (`npm run dev:start`, single loopback URL). Progress through the states below in
order; a pilot may stop at any state and still report useful evidence. Record only the body-free
fields in the [evidence template](#evidence-template).

- **Browser-only.** Open the manual's entry page in the governed browser. Confirm no pod, indexing
  job, or crawl has started (opening is not consent). Record: reachable yes/no, whether the target
  is same-origin static HTML, and whether an OS/enterprise proxy or firewall governs the route.
  Never record the URL itself — record its shape (for example, "intranet host, path-prefixed").
- **Indexing (consent + crawl + parse).** Approve an explicit origin and path-prefix scope with
  bounded page, depth, byte, time, and concurrency limits. Let the bounded crawl and static parse
  run. Record: pages crawled/accepted/denied, documents indexed, chunks and vectors persisted, and
  the terminal readiness state. Static HTML ingestion must not execute JavaScript.
- **Chat (grounded retrieval + citation).** Ask the pilot's safe test questions (below). For each,
  record: whether the answer was grounded, whether the top citation resolved to the correct section
  or anchor, and whether an intentionally out-of-scope question correctly returned no evidence.
- **Refresh (diff + diagnose).** Re-run the bounded refresh against the same approved scope. Record:
  added/changed/removed document counts and the change-summary reason codes only — never the diffed
  text.
- **Rendered capture (not a pilot state).** Rendered/JavaScript-executed capture is out of scope for
  this roadmap and this runbook. If a manual only renders client-side, record that it is unsupported
  and stop; do not attempt to route around the static-only ingestion boundary.

### Prerequisites

- A local Keiko build that passes the core gates (see below), Node ≥ 22, and local disk for the pod
  store. No hosted crawler, managed retrieval service, or cloud installation is used or required.
- A manual the operator is authorized to read locally, reachable as static HTML from the pilot host.
- If an enterprise intranet, proxy, or firewall governs the route, the pilot respects it as
  configured. The pilot never adds a bypass route or tunnel and never treats a reachable network as
  implicitly in scope.

### Supported manual target types

- Static HTML manuals: single-page, multi-page/chapter, framesets, index/table-of-contents pages,
  pages with tables, `<pre><code>` blocks, definition lists, anchors, and parallel-translated
  (multilingual) manuals.
- Not supported: manuals that exist only after client-side rendering, authenticated document portals
  that require credential replay, and non-HTML documents (covered by other source types).

### Safe test questions

Choose questions whose answers are structural, not confidential — the goal is to measure retrieval,
not to extract sensitive content. Good classes: an exact interface or error identifier, a specific
table-row value, a section or anchored heading, a code-block example name, an index "where is X
documented" lookup, and one question per additional manual language. Include at least one question
whose answer is deliberately outside the approved scope, and confirm it returns no evidence.

### Evidence template

Fill in counts, statuses, and reason codes only. Do not add columns that would carry a body, path,
URL, or token. Example row values are illustrative shapes, not real data.

| Field                             | Value (body-free)                                      |
| --------------------------------- | ------------------------------------------------------ |
| Manual shape                      | e.g. multi-page frameset, intranet host, path-prefixed |
| Route governance                  | direct / OS proxy / enterprise proxy / firewall        |
| Approved scope                    | origin + path-prefix; page/depth/byte/time/concurrency |
| Pages crawled / accepted          | integer / integer                                      |
| Pages denied / skipped            | integer / integer                                      |
| Documents indexed                 | integer                                                |
| Chunks / vectors persisted        | integer / integer                                      |
| Pod readiness                     | `ready` / `blocked` / reason code                      |
| Questions asked                   | integer (by class)                                     |
| Grounded answers                  | integer with correct top citation                      |
| Citation resolution               | integer resolved to section/anchor                     |
| Out-of-scope questions            | integer returning `noEvidence = true`                  |
| Refresh added / changed / removed | integer / integer / integer + reason codes             |
| Rendered-capture manuals          | integer recorded unsupported (not attempted)           |

### Screenshots and logs policy

- Do not attach screenshots that contain readable private manual text. If a screenshot is needed,
  capture only redacted chrome (counts, states, reason codes) with manual bodies obscured.
- Do not paste raw logs, private local paths, token-bearing URLs, cookies, prompts, or provider
  endpoints. Report the redacted diagnostic summary (counts, statuses, reason codes) instead.

## Gate command summary

Run from the repository root. These are the same deterministic gates the synthetic goldset uses; a
pilot adds a real manual on top of them but reports only body-free numbers.

- `npm run typecheck` — TypeScript strict, full package graph.
- `npm run lint` — ESLint `--max-warnings=0`.
- `npm run format:check` — Prettier.
- `npm test` — Vitest (includes the retrieval eval, leakage, and manual pipeline suites).
- `npm run check:retrieval-quality` — Local Knowledge retrieval scorecards over the synthetic
  goldset, including the HTML-manual fixtures (Epic #1858).
- `npm run check:grounded-retrieval-quality` / `npm run check:grounded-faithfulness` — grounded
  answer ranking and citation faithfulness.
- `npm run arch:check` / `npm run arch:check:negative` — ADR-0019 boundaries.

## Known limitations and follow-ups

- A pilot measures one real manual and is not a substitute for the synthetic goldset gates; the
  scorecards remain the deterministic, machine-checked signal. The pilot's value is confirming the
  synthetic classes hold on real content without committing that content.
- Retrieval quality on a specific manual depends on the manual's own structure; a pilot that finds a
  gap should be recorded as a new synthetic fixture class in the goldset ledger, not as committed
  customer evidence.
- Rendered/JavaScript-executed capture is out of scope and tracked in Epic #1857, not this runbook.
- Release closure that consumes pilot evidence is defined in
  `docs/qa/html-manual-retrieval-evaluation-evidence.md` (Epic #1858, Issue #1906).
