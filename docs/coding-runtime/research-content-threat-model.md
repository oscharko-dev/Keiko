# Research-egress content: threat model

Issue #2637. Scope: what happens to a public web page **after** a Code task's governed research
fetch has been authorised and performed, and before its text reaches the model.

Owning code:

- `packages/keiko-server/src/coding-runtime/researchContentQuarantine.ts` — the extraction and
  labelling step.
- `packages/keiko-server/src/coding-runtime/researchEgressPort.ts` — the governed fetch that calls
  it.
- `packages/keiko-local-knowledge/src/parsers/html-parser.ts` — the reused visible-text scanner,
  reached through `extractBoundedDocumentText` (format `html`).

Read this before changing any of them. **An extractor that claims more than it delivers is worse
than none**, because the authority model would then be sized against a defence that does not exist.

## The threat

A research fetch returns attacker-authored text into the same agent turn that can subsequently call
mutation-capable tools (`keiko_changeset_edit`, `keiko_command`, delivery). A page can therefore try
to steer a privileged turn: **prompt injection, CWE-1427**. The operator approved a _destination_ —
a host and an exact request line — never the _content_ that destination would return. Nothing in the
approval loop constrains what comes back.

This was raised by CodeRabbit on PR #2602 and deliberately deferred there rather than patched at the
tail of a large integration.

## What was already bounded before this change

The residual risk is narrow because reaching the internet at all is hard:

| Control                       | Effect                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator approval             | Binds the exact host **and** the exact request line (`queryTextDigest` over `researchRequestLineText`); since PR #2602 the operator sees that request line before approving. |
| GET only                      | No request body can leave. Uploads are structurally impossible.                                                                                                              |
| Closed named-domain allowlist | Re-checked on the initial host and on every redirect hop. No wildcard or subdomain widening.                                                                                 |
| Read-only child agent         | No mutation, command, delivery, or connector authority.                                                                                                                      |
| Fetch and byte budgets        | Reserved before each hop; an exhausted grant performs zero network calls.                                                                                                    |
| Content-free events           | The audit trail carries counts and outcomes, never the page, URL, path, or query.                                                                                            |

None of that constrains the **content** that comes back. That is the gap this document covers.

## What the quarantine step does

### 1. It narrows the channel

The fetched bytes are projected through the already-shipped, hardened Local Knowledge HTML scanner
rather than a second, purpose-built tag stripper. That scanner drops:

- `<script>`, `<style>`, and `<noscript>` bodies,
- HTML comments, DOCTYPE, and processing instructions,
- every tag and **every attribute** — only inter-tag text runs survive,
- boilerplate containers (`<nav>`, `<footer>`, `<aside>`) and, when a `<main>` element exists,
  everything outside it.

The rationale is a single sentence: **these channels carry text a human previewing the page could
not have seen**, so the operator's approval of the destination cannot conceivably have covered them.
An `<!-- ignore previous instructions -->` comment is invisible in a browser and fully visible to a
model; after extraction it is visible to neither.

The site-declared `content-type` is **not** consulted. It is attacker-controlled, so a hostile page
could otherwise declare `text/plain` and route its own markup around the scanner. Every research
payload goes through the HTML projection unconditionally; a genuinely plain-text page has no tags to
drop and survives intact.

### 2. It removes invisible characters

Unicode format characters (zero-width spaces and joiners, bidirectional overrides and isolates) are
dropped; every other control character collapses to a space. These are the other way to hide text
from a reviewer but not from a model, and to fabricate structure inside a text block.

### 3. It labels what survives

The extracted text is wrapped in an explicit untrusted-data envelope that tells the model, in the
imperative it actually reads, that the enclosed text is third-party data carrying no authority.

The fence delimiter carries a nonce derived from the SHA-256 of the fetched bytes. A page cannot
close its own quarantine block, and it is worth stating the argument precisely because it was
misread in review: the digest is taken over the bytes **as served**, so an attacker computing it
offline and then _writing it into the page_ changes the page and therefore changes the digest. A
page containing its own correct fence is a SHA-256 fixed point. The test suite demonstrates the
failed forgery rather than asserting the property abstractly.

Independently of that, `neutralizeMarker` redacts **every** literal occurrence of the marker token
out of the extracted text, whether or not its nonce matches. Keep both: the nonce argument is about
self-consistency, the redaction is about the transcript never containing a second thing that reads
like a fence.

### 4. It bounds the work it does

The scanner runs synchronously on the runtime thread, so the parse is bounded twice. The bytes fed
to it are capped at 1 MiB (the egress read budget alone allows 2 MB, and the tool result is capped
at 64 KiB regardless, so no realistic page loses content). And the scanner re-checks its deadline
every few thousand scan steps, not only when it emits a block — an input engineered to produce many
scan events and almost no blocks would otherwise run past `timeoutMs` before any limit was
consulted.

Measured on maximum-size payloads: ~61 ms for a 2 MB single text run, ~22 ms for a 1.5 MB tag-dense
page. The parse is single-pass and O(n) in input size. This is a bounded pause on the runtime
thread, not an unbounded one — but it is a synchronous pause, and that is the honest description.
Moving the parse off-thread was considered and judged disproportionate to a measured
tens-of-milliseconds ceiling on a fetch that already requires a per-URL operator approval and a byte
budget.

### 5. It stays inside the tool-result ceiling

The envelope is budgeted against `CODING_TOOL_MAX_READ_BYTES` so the downstream truncation in
`projectEgressRead` (`codingToolFacade.ts`) can never sever the closing fence and leave the model
holding an unterminated quarantine block.

### 6. It is asserted, not assumed

An accepted `research-performed` runtime event **must** declare `contentTrust: "untrusted"` — the
contract rejects an accepted research read that does not, and rejects the field on any denial (which
produced no read to classify). The **same binding is enforced again at the SSE boundary**, so a frame
cannot reach the timeline claiming that a skill invocation or a denied fetch took in untrusted page
content, nor an accepted research read that never said what it took in. That marker reaches the
Coding Workbench timeline, so an operator sees that the run took in third-party content, not merely
that a fetch succeeded.

## What the quarantine step does NOT do

This is the half that matters. Do not size any other control as though these were covered.

- **It does not detect, classify, or filter malicious instructions.** Plainly-worded directives that
  are _visible_ on the page survive extraction verbatim. This is by design: that text **is** the
  research content, and a filter that dropped it would either break legitimate research or provide
  a false assurance. The regression test asserts the injection string is still present — inside the
  fence.
- **It is a labelling and channel-narrowing control, not a barrier.** The defence against a model
  that reads the fenced instructions and follows them anyway remains the authority model: mode
  gates, per-action approval in `governed-assist` and `supervised-coding`, the mutation guard, the
  workspace containment boundary, the command allowlist, and the delivery gates. Those controls are
  what actually stop the mutation; the quarantine makes the provenance legible and removes the
  hiding places.
- **It does not re-check anything downstream.** Once a model has been steered, no later stage
  re-examines its intent. Every subsequent action is judged on its own merits by the authority model
  alone.
- **It is not a spec-compliant HTML parser.** It is a conservative single-pass scanner. On exotic or
  malformed markup it may drop legitimate visible text. It fails toward **less** content, never
  toward more — a dropped paragraph is a research-quality problem, leaked script text is a security
  problem.
- **It does not protect the read-only child agent beyond the same marking.** A child receives the
  same quarantined projection; its own containment comes from having no mutation authority at all.
- **It does not cover non-HTML binary payloads.** A PDF or image fetched through research egress
  yields no extracted text and reaches the model as an empty quarantine block reporting the
  extraction outcome. It is not parsed.
- **It does not make the model's context trustworthy.** Repository content, connector data, and
  model output remain independently untrusted and are governed by their own boundaries.

## Verification

| Claim                                                       | Test                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Visible page text is fenced, not handed over verbatim       | `researchEgressPort.test.ts` — "fences visible page text …"                          |
| Script/style/comment/attribute channels are dropped         | `researchEgressPort.test.ts`, `researchContentQuarantine.test.ts`                    |
| Invisible and control characters are removed                | `researchContentQuarantine.test.ts`                                                  |
| A page cannot forge or close the fence                      | `researchContentQuarantine.test.ts` — demonstrated failed forgery + marker redaction |
| A block-free page cannot outrun the parse deadline          | `bounded-document-extraction.test.ts` — tag-dense deadline test                      |
| The envelope survives the tool-result ceiling               | `researchEgressPort.test.ts`, `researchContentQuarantine.test.ts`                    |
| An accepted read must declare untrusted content             | `coding-workbench.test.ts`                                                           |
| The SSE frame enforces the same binding                     | `coding-workbench-runtime-api.test.ts`                                               |
| The classification reaches the SSE frame                    | `codingRuntimeOrchestrator.test.ts`                                                  |
| The timeline shows it                                       | `codingWorkbenchLabels.test.ts`                                                      |
| End to end, an injected page never even REQUESTS a mutation | `tests/e2e/code-task-research-skills-subagents.spec.ts` (scripted tool-call log)     |

## If you change this

- Widening `CodingWorkbenchContentTrust` beyond `"untrusted"` is an ADR-level decision. There is no
  trusted public web page.
- Removing the envelope, or moving it after the facade truncation, breaks the fence guarantee.
- Adding a "sanitiser" that strips suspicious phrasing would change this from a channel-narrowing
  control into a filter, and would need its own threat model and its own evasion analysis. Do not
  do it incidentally.
