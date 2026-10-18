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
- `symbol-discovery-read-batching.json` compares the actual production retrieval path on the
  same one-file corpus and original question/grants, with no model call. Ordered ranges, byte
  lengths and content hashes agree. Read amplification is corrected; the explicitly absent
  deadline and read-charge windows remain acceptance failures. Timing under concurrent local
  work is an observation, not latency qualification.

Raw source/prompt/answer content, provider locations and credentials stay outside the checkout.
The existing Chat skills lab owns runtime pairing, selected-skill import/accounting, real product
requests and offline execution. Private run receipts preserve failed setup, transport, interrupted
and unavailable-history attempts. Fresh recreated environments never establish a byte-exact
historical replay. Independent reviewer measurements are reported separately in PR #4046.
