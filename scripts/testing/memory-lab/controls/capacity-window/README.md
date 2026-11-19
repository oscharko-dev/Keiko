# Capacity window qualification

This retrieval-only experiment checks whether an older, currently valid project memory survives a dense window of ineligible records. Its manifest was fixed before the capacity repair. The SHA-256 of its JSON serialized with two-space indentation and one final newline is `a9c026166d321bf86303f298d35c541bfc626afd8bbf14f379077c84e48620f7`.

Build each product revision in a separate clean checkout. Use the same driver file and a local gateway configuration with a single matching `qwen3-embedding-8b` provider for both runs. The runner restricts the embedding endpoint to loopback, checks the model identity and 4,096 dimensions, and verifies the compiled package digest before and after each run. Normal Chat retrieval selects the memories. This experiment does not generate an assistant response.

```sh
node scripts/testing/memory-lab/capacity-window.mjs \
  "$BASELINE_CHECKOUT" "$BASELINE_SHA" "$PRIVATE_GATEWAY_CONFIG" "$BASELINE_REPORT"

node scripts/testing/memory-lab/capacity-window.mjs \
  "$CANDIDATE_CHECKOUT" "$CANDIDATE_SHA" "$PRIVATE_GATEWAY_CONFIG" "$CANDIDATE_REPORT"
```

Run the two commands in sequence. Each repetition and condition receives a fresh encrypted temporary Vault. The runner inserts the same project fact and tests three conditions, with zero distractors, 550 archived distractors and 550 newer records whose validity starts in a year. Each condition is repeated three times. Each repetition requests the fact literally, requests it in paraphrase, then asks an unrelated question. Background records have no embeddings. A condition that discards the target before query embedding can legitimately make zero query calls.

Group the 27 report rows by `condition`, `repetition` and `probe`. Recall is the sum of `matched` divided by the sum of `expected` over the 18 positive probes. The nine negative probes expect an empty selection. For every paired row, compare the actual members of `unexpectedIdDigests` to find newly introduced false positives, including replacements with the same total count. `matchedIdDigests` likewise identifies gained and lost desired records. The reports contain digests and counts. Keep the local gateway configuration private.
