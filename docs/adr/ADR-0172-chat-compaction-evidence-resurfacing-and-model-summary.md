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

### D1 — Compaction evidence persistence is best-effort and never reaches the send path

`persistChatCompactionEvidence` returns `void` and wraps everything after its fast-path guard —
the chatId hash, the runId construction, and the store write — so that a malformed chatId or a
throwing evidence store cannot escape into the chat send path. A chat turn is never failed, delayed,
or altered because its compaction evidence could not be written.

The fast path (no compaction record) returns immediately without touching the store.

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

`enrichChatCompactionWithModelSummary` makes a real gateway call with a JSON-schema response format.
It is bounded by the contract constants `CONTEXT_COMPACTION_MODEL_SUMMARY_MAX_CHARS`,
`…_MAX_ITEM_CHARS`, and `…_MAX_ITEMS`, and carries `CONTEXT_COMPACTION_MODEL_SUMMARY_PROMPT_VERSION`
so a prompt change is identifiable in persisted records.

Failure is absorbed: the enrichment is best-effort and its failure leaves the send unaffected. A
compaction record without a model summary is a complete, valid record — the summary adds continuity,
it never carries the only copy of anything. Nothing downstream may require it to be present.

### D5 — Summary output is validated and redacted before persistence

The model's response is not trusted. Output passes `validateContextCompactionRecord`,
`redactAbsolutePaths`, `stripUnsafeFormatChars`, and `containsPseudoRoleMarker`, and the record
retains the resulting `validationState` as either `accepted` or `redacted` — so a persisted summary
always states whether it was altered on the way in.

A summary that cannot be brought into a valid, redacted state is dropped rather than stored in a
degraded form.

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
