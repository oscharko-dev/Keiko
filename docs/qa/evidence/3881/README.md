# Epic #3881 signed-history provenance

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
