# Epic #3881 evidence provenance

## Signed-history transition

[signed-history-map.json](signed-history-map.json) preserves the 170-commit source-identical
transition from the archived [PR #3912](https://github.com/oscharko-dev/Keiko/pull/3912) history to
the clean `codex/epic-3881-verified-delivery` history used by
[PR #3913](https://github.com/oscharko-dev/Keiko/pull/3913). The earlier history contained two
unsigned synchronization merges. Its replacement was pushed as a new branch; the original
branch and review evidence were retained without a force push.

The artifact records only timestamps, branch identity, commit and tree digests, and the old-to-new
commit mapping. Every mapped commit's tree and parent topology were checked against the local
Git objects; both complete 170-commit sets match the recorded base and heads. The two head tree
digests are identical. The orchestrator independently verified all 170 replacement commits through
GitHub's commit-verification API before integration.

Old review and producer-proof commit references can be resolved through this map without importing
the archived ancestry into the delivery branch. This provenance record does not certify later
commits or final quality gates. Fixture eligibility corrections and their authoritative red-to-green
evidence remain documented in the [grounded certification baseline](../../grounded-certification-baseline.md).

## Ordinary-folder matching metadata

[ordinary-folder-query-match-scale.json](ordinary-folder-query-match-scale.json) records six
pointed same-port workspace-search observations at `70bbffe82f13b7b855c4ce62262cd3493797a786`.
The synthetic non-Git corpus contains 100,000 files, deeply nested manuals, many duplicate basenames,
repeated navigation and late targets. Its identity and the external measurement driver's digest are
recorded without file bodies, question text, private paths or configuration. The original synthetic
target was restored after the single-file mutation control. This is one sample per mode on the
recorded developer environment, with no concurrent builds, tests or model calls; it is not an
authoritative latency gate or a model-answer certification.

Every unrestricted mode freshly enumerated 100,000 files and retained the unchanged 200-hit cap.
Coverage therefore remained incomplete with `match-cap`. Cold and novel-query modes performed
100,000 scan body reads; unchanged warm matching performed zero. The mutated target required one
fresh scan body read. Actual `readExcerpt` evidence reads remain separate and live, with a private
boolean check of the original or changed synthetic fact. The novel query only proves incompatible
metadata is not reused; retention of the original target does not certify the novel question's
answer. Active public known-fit observers may require live content until their capacity is exceeded.

The finite-deadline and client-cancel controls returned at 50 ms with the corresponding incomplete
reason. Recorded cleanup distinguishes an iterator still closing at return from settled resources;
both controls subsequently had zero active readers and iterators and no new reads after abort.
Elapsed-time observations include final index work. These results complement the failing-first
workspace storage/freshness/containment controls and both actual server-wrapper guards; they do not
replace final retrieval, context, support-report, local-model or complete quality gates.
