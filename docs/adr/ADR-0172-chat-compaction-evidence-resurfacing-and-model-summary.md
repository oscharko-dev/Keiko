# ADR-0172: Chat-compaction evidence, resurfacing, and model-generated continuity summaries

## Status

Accepted (Issue #2901, audit finding KEIKO-0183, 2026-08-16).

Documents an already-shipped, already-wired feature set. This ADR records the decisions the code
embodies and the boundaries it holds; it changes no behavior.

## Context

ADR-0052 through ADR-0057 established structured context compaction: what a `ContextCompactionRecord`
contains, the `fileContentHash` invalidation key (ADR-0053), and bounded rehydration. ADR-0057 closed
that series by recording that chat-compaction evidence had gone live.

Three substantial mechanisms were built on top of that foundation and wired into the chat send path
without a governing decision record. An audit of the repository found no ADR mentioning
`resurfacing`, `chat-compaction-evidence`, or `modelSummary` anywhere:

- **Evidence persistence** — `persistChatCompactionEvidence`
  (`packages/keiko-server/src/chat-compaction-evidence.ts`), called from `chat-handlers.ts` on the
  send path.
- **Resurfacing** — `buildChatCompactionResurfacingContext`
  (`packages/keiko-server/src/chat-compaction-resurfacing.ts`), called from `chat-prompt-budget.ts`,
  which re-injects persisted compaction context into *later* turns of the same chat.
- **Model-generated continuity summary** — `enrichChatCompactionWithModelSummary`
  (`packages/keiko-server/src/chat-compaction-model-summary.ts`), which makes a real model-gateway
  call with a JSON-schema response format to produce a rolling summary of dropped turns.

The third is the one that most needed recording: compaction had been a purely deterministic,
structural operation, and this introduces a model call into it. That is an architectural change in
kind, not degree — it adds a failure mode, a cost, and a trust boundary that the earlier ADRs never
had to reason about.

## Decision

### D1 — Compaction evidence persistence is failure-isolated from the send path

`persistChatCompactionEvidence` returns `void` and wraps everything after its fast-path guard —
the chatId hash, the runId construction, and the store write — so that a malformed chatId or a
throwing evidence store cannot escape into the chat send path. A chat turn is never **failed** or
**altered** because its compaction evidence could not be written.

It is failure-isolated, not latency-isolated. The store write is synchronous and runs before the
buffered handler returns its `RouteResult`, so a slow filesystem or store still adds latency to the
send. That is a deliberate trade — the record is written while the data is unambiguously in hand,
rather than deferred to a path where a crash could lose it — but it is a real cost and is recorded
here rather than claimed away. Moving persistence off the response path is the obvious future
change if that latency ever becomes material.

The fast path (no compaction record) returns immediately without touching the store.

**Operational-state correction (#4155, 2026-10-30).** Audit manifests are optional evidence,
not the owner of the working continuity checkpoint. Revision-bound captures now commit to the
existing private Chat SQLite store before a buffered/streaming answer or grounded answer uses
the compacted history; manual compaction also requires this write. An unavailable private store
pauses that request with a retryable error. A subsequent audit failure cannot undo the private
commit or fail the answer. Post-answer audit persistence remains best-effort.

The private row is chat-scoped, generation-checked and bound to an existing message and current
history revision. Its bounded, whitelisted payload carries an integrity digest; writes use the
existing immediate transaction. History revisions invalidate the row and Chat deletion cascades
to it. Completing an earlier pending turn behind a later eligible turn also advances the revision:
that completion changes the prefix even though it does not edit an older message's text.

Loads prefer private state; legacy audit checkpoints remain a compatibility input. A damaged or
unreadable private checkpoint does not fall back to an older audit summary. A damaged payload's
generation remains available for a compare-and-swap rebuild from canonical originals. Model
enrichment rechecks the exact prefix/profile and current summary before atomically committing;
late work cannot replace a newer valid summary. A newer capture of the same prefix can retain
the completed enrichment. Valid existing summaries survive unsuccessful refreshes.

Private persistence uses the store's existing Chat content projection, including the credential
floor. Audit projection remains unconditional. This does not change the summary model call's
content policy, grant cross-chat memory authority or turn historical observations into fresh
source evidence. `chat.continuity.checkpoint` records only I/O outcome and optional generation;
its complete observation is not a claim of complete semantic recall or summary source coverage.

### D2 — Resurfacing renders persisted context as bounded, sanitized text

`buildChatCompactionResurfacingContext` emits a `# Persisted compaction context` block built from at
most the **3 most recent** records (`MAX_RECORDS`), at most **8 items per section**
(`MAX_ITEMS_PER_SECTION`), each at most **220 characters** (`MAX_LINE_CHARS`).

Every value passes through the shared contract-layer filters before it is emitted:
`stripUnsafeFormatChars`, NFKC normalization, whitespace collapsing, `containsPseudoRoleMarker`, and
`containsAbsolutePath`. A value that trips a filter is dropped, not escaped — resurfaced text is
model-facing input assembled from previously stored data, so it is treated as untrusted and filtered
at the boundary rather than sanitized in place.

The bounds are hard caps, not budget hints. Resurfacing competes for the same prompt budget as
everything else and must never be able to grow without limit as a chat's history accumulates.

The chat continuity checkpoint is the canonical, revision-bound digest. A narrower deployment,
a large current prompt, or the grounded continuity lane may require a smaller prompt projection;
that projection must never replace the canonical digest or remove its valid model summary. The
assembler first tries folding additional old turns with the complete summary, and trims the rendered
projection only when no complete-summary candidate fits. Per-turn omissions are recorded in prompt
text and body-free assembly diagnostics. A later roomy turn can render the full checkpoint again.
Source messages remain stored; canonical digest and rehydration bounds still apply.

Same-chat conversation recall selects complementary relevant excerpts within a stored message,
instead of only its final query-term match. Query-term coverage ranks candidates, with later
positions winning ties. An older overlapping claim is not reintroduced solely for incidental
additional terms after a newer matching excerpt has been selected. Excerpts retain source order
and message identity, and remain reference data. The existing eight-excerpt, 800-token,
1,024-unit, and 1,048,576 UTF-16-code-unit scan ceilings remain binding. Eligibility, excluded turns, redaction,
Unicode-safe matching, and unsafe-path/role checks apply before excerpts reach prompt assembly;
role checks precede whitespace folding. Existing body-free continuity evidence reports the
resulting candidate/excerpt counts and budget disposition.

Recall retains literal short identifiers, versions and abbreviations alongside the existing
five-code-point word prefixes (#4155). Identifier punctuation is escaped and numeric/code identifiers
are not shortened. Complete boundaries on both sides reject identifier suffixes after a dot or colon,
as well as partial matches such as `Q7-420` for `Q7-42`. A bounded set of common
technical abbreviations (including MCP, API, RAG and LLM) also works in lowercase within multiword
questions; ordinary short function words are not admitted through that set. Policy v2 retains
read compatibility for v1 evidence.
Unicode dash variants may match an identifier without rewriting the returned source. Identifier
terms receive priority within the existing 24-term ceiling. The current redaction policy,
credential floor, message exclusions, source scope and all scan/token ceilings remain binding.
The same Activity Log event includes optional query/identifier counts and a closed matching-policy
version; it never records the query or excerpt body.
A checkpoint stamped with a smaller context window must not stop a larger-window history scan,
even when the complete conversation still exceeds the larger input budget. The visitor rebuilds
that window's full bounded verbatim tail from canonical messages before folding older units.
The overflow-based restoration fallback applies only to legacy checkpoints without a window stamp.
This also prevents one bounded grounded turn from permanently shrinking subsequent plain-chat turns.

Connected repository retrieval keeps conversation reference text separate from source evidence.
The existing bounded previous-user-question prefix retains its 4,096-character ceiling and its
optional-assembly fallback. Independently, the last eligible assistant turn in the same chat can
supply at most six case-preserving path hints: at most three closed missing-evidence declarations
first, followed by citation order and other path tokens. Persisted folder citations retain their
prior source fingerprint and line hint; Pod locators do not become folder references. The bounded
structured-citation scan uses the existing hybrid candidate safety ceiling and retains at most six
references after validation and deduplication by source fingerprint and path. Each selected folder
accepts only hints matching its current source fingerprint; an absent prior fingerprint is never
replaced with a current identity. Legacy prose hints remain path-deduplicated. Canonical store
whole-turn eligibility remains authoritative; orphaned, failed, or cross-chat messages do not become
retrieval history. These hints use the existing `assistant` reference origin and do not consume the
user-term anchor cap or alter current query text. A newly named independent target suppresses them;
bounded English/German anaphoric patterns also preserve previous effective diagnostic/targeted intent.
All hints pass the same live explicit-path admission, containment, denial, ignore, format, size,
and budget checks as query references before they become floor-protected evidence candidates.
Cross-source selection prefers at most one actually read window containing each bound hint's
line, when present. If that old location no longer exists, an explicitly selected path that was
successfully freshly read survives as an unlocated navigation hint, and at most one actual current
window is retained. Other nonoverlapping located atoms do not gain evidence authority. Citations
still authenticate only the fresh returned range; no old line or content is restored.
The original provisional candidate/byte ceilings remain binding; the reranker
still receives every provisionally admitted document. Final top-N selection and model-window fitting
retain those windows first without changing native relevance scores or authorizing omitted ranges.
Plural folder byte fitting uses the same actual-window priority within each existing source share;
its no-hint packing remains unchanged. Oversized or unfittable windows cannot bypass any ceiling.
Admission telemetry distinguishes supplied referents from admitted referents, counting a basename
fanout as one admitted referent. The existing correlated selection-details operation carries only
closed origin and counts; no assistant prose or paths are logged.

### D3 — Resurfacing surfaces invalidation; it does not evaluate it

This is the explicit boundary against ADR-0053.

The resurfacing block carries two distinct sections: **"Rehydration available"** (rehydration
handles and source spans) and **"Re-verification required"** (entries whose ADR-0053 invalidation
key indicates the underlying content may have changed).

Resurfacing does **not** re-read files, does not recompute `fileContentHash`, and does not
automatically rehydrate or suppress an entry. It reports the invalidation state it was given and
leaves the decision to the model and to the existing rehydration path. Evaluating invalidation keys
at resurfacing time would mean a filesystem read per entry on every subsequent turn, on the send
path, for context the turn may not even use.

The consequence is stated plainly rather than minimized: a resurfaced "Rehydration available" entry
is only as fresh as its last invalidation check. It is a pointer, never a substitute for
rehydration.

### D4 — The model-generated summary is enrichment, never a dependency

`enrichChatCompactionWithModelSummary` makes a real gateway call. `modelSummaryResponseMode`
selects between two modes: a JSON-schema response format when gateway configuration is present and
the model advertises `supportsResponseFormat`, and a **legacy** mode otherwise, where no
`responseFormat` is sent and JSON is parsed out of ordinary response content. The structured-output
boundary is therefore provider-enforced only in the first mode; in legacy mode it rests entirely on
this side's own parsing and the D5 validation below, which is why that validation is not optional.

It is bounded by the contract constants `CONTEXT_COMPACTION_MODEL_SUMMARY_MAX_CHARS`,
`…_MAX_ITEM_CHARS`, and `…_MAX_ITEMS`, and carries `CONTEXT_COMPACTION_MODEL_SUMMARY_PROMPT_VERSION`
so a prompt change is identifiable in persisted records.

Failure is absorbed: the enrichment is best-effort and its failure leaves the send unaffected. A
compaction record without a model summary is a complete, valid record — the summary adds continuity,
it never carries the only copy of anything. Nothing downstream may require it to be present.

### D5 — Summary output is validated and redacted before persistence

The model's response is not trusted. Output passes `validateContextCompactionRecord`,
`redactAbsolutePaths`, `stripUnsafeFormatChars`, and `containsPseudoRoleMarker`. A summary that
survives retains `validationState` as either `accepted` or `redacted`.

`redacted` has a narrower meaning than "altered in any way". `normalizeSummaryText` computes it from
redaction, unsafe-format stripping, and length clamping only — NFKC normalization and whitespace
collapsing are applied but deliberately **not** counted, so a summary whose only change was
`"foo   bar"` → `"foo bar"` is persisted as `accepted`. The state answers "was content removed or
rewritten for safety?", not "is this byte-identical to what the model returned?".

A summary that cannot be brought into a valid state is **not silently dropped**. The failure is
recorded with request-correlated, body-free diagnostics. If no valid summary exists,
`failureModelSummary` persists `validationState: "rejected"`, empty content and the failure reason:
`invalid`, `timed-out`, or `unavailable`. If a valid running summary already exists, a failed refresh
retains that summary and its earlier `coveredItems`; it must not claim coverage of the newly folded
turns. Later enrichment can retry those uncovered turns. Successful enrichment recounts the complete
checkpoint through the shared gateway token-accounting path before persistence.

The detached buffered call's backstop follows the normal Gateway buffered budget and shared
transport grace, with the platform timer ceiling; it must not cut a valid native attempt short at
an independent 15-second limit (#4155). No Coding outage policy is added. Identical in-flight
summaries are coalesced per exact handler graph and current configuration identity, keyed by chat,
model, safe prompt hash, response mode, revision/boundary and source-reference hash. Failed work
releases its key. This is transient work sharing, not a new persistent response cache or source
freshness guarantee.

The existing handler disposal cancels and drains these calls before closing its services. Queued
work is refused once that graph stops, and a late result cannot persist after shutdown begins.
`chat.compaction.summary.work` records the actual backstop, local monotonic elapsed time, planned
UTF-16 prompt size, model-port invocation and closed outcome without source bodies. Its `accepted`
outcome denotes output validation, not complete source coverage, answer accuracy or durable
persistence. Coalesced work does not count as a second model-port call or provider KV-cache hit.

A reader can normally distinguish an attempted enrichment from an absent attempt using the
persisted failure state or the correlated diagnostic when a valid earlier summary was retained.
A record carrying only a rejected summary remains a complete, valid compaction record.

That distinction is best-effort, not an audit guarantee. The rejected record is written through the
same D1 path, so if that write throws it is swallowed and the earlier summary-free record is all
that remains — indistinguishable from an attempt that never happened. Enrichment observability is
therefore as reliable as evidence persistence itself, and no more.

## Consequences

- Compaction is no longer purely deterministic: one path now depends on a model call. D4 confines
  that dependency to enrichment, so the deterministic record remains the source of truth and the
  model call is never on the critical path for correctness.
- Resurfacing adds recurring prompt-budget cost to every turn after the first compaction. The D2
  caps bound it, but the cost is real and grows with the number of retained records up to that cap.
- D3 leaves a genuine freshness gap between an invalidation key and its next evaluation. This is
  accepted deliberately in exchange for keeping the send path free of per-entry filesystem reads;
  the "Re-verification required" section exists so the gap is visible rather than silent.
- The model summary is a second place chat content is sent to a model. D5's validation and
  redaction, plus the prompt-version stamp, are what keep that boundary auditable.

## References

- ADR-0052 – ADR-0057: structured compaction records, invalidation keys, bounded rehydration.
- `packages/keiko-server/src/chat-compaction-evidence.ts`
- `packages/keiko-server/src/chat-compaction-resurfacing.ts`
- `packages/keiko-server/src/chat-compaction-model-summary.ts`
- Wiring: `chat-handlers.ts` (persist + enrich), `chat-prompt-budget.ts` (resurfacing).
