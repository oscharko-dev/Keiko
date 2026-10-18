# Chat/Files qualification observations

These are bounded body-free observations for #4037/#4040 and #4017–#4021. They do not close
those issues or replace exact-head CI, native browser qualification, semantic review or the
inherited 96-criterion ledger.

- `native-skill-observations-2026-10-18.json` contains 36 case-level records from four declared
  native Gemma batches, including the failed six-case generation batch. Runtime/fixture/skill
  digests, physical-attempt counts, accounting/persistence checks, unchanged generated-test
  hashes and restricted execution outcomes retain their original identities. Later skill
  revisions are not qualified by earlier outputs. A correct-subject failure earns no mutation
  credit. Semantic and customer-profile review is separately pending.
  The original `status` is frozen at generation return; `executionStatus` and the variant records
  describe subsequent execution. The six failed React v4 cases each have zero case-bound answer
  attempts. Their separately recorded setup readiness probe returned HTTP 500; setup waiting is
  not an answer attempt. Failed setup and generation remain in the denominator.
- `symbol-discovery-read-batching.json` compares the actual production retrieval path on the
  same one-file corpus and original question/grants, with no model call. Ordered ranges, byte
  lengths and content hashes agree. Read amplification is corrected. The original mechanical joins retain their
  observed presence/absence; equivalent current implementation ranges may establish the same budget
  facts. Named-function probes alone do not establish semantic recall success or failure. Timing
  under concurrent local work is an observation, not latency qualification.

Raw source/prompt/answer content, provider locations and credentials stay outside the checkout.

`github-pr-lifecycle.json` records a separate native GitHub fixture with the three product job
name/admission expressions copied verbatim. Open and reopened runs publish canonical required
names; closed metadata edits and a rerun of that closed payload skip the jobs without those names.
GitHub labels skipped jobs with their unexpanded name expressions. The initial expectation of
literal inactive labels failed and is retained. These results qualify name/admission semantics,
not the complete product matrix or strict merge-candidate verification. The isolated fixture PR
is closed without merging; product delivery remains governed by PR #4046.

The existing Chat skills lab owns runtime pairing, selected-skill import/accounting, real product
requests and offline execution. Private run receipts preserve failed setup, transport, interrupted
and unavailable-history attempts. Fresh recreated environments never establish a byte-exact
historical replay. Independent reviewer measurements are reported separately in PR #4046.
