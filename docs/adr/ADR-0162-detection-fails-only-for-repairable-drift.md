# ADR-0162 — A detection lane fails only for drift a repair outlives

- Status: Accepted
- Amends: [ADR-0156](ADR-0156-measurement-and-verdict-separation.md) (D6 scheduled-lane scope; D1,
  D2, D3, D4 and D5 stand unchanged)

## Context

ADR-0156 D6 stopped the scheduled lane from measuring — a hosted 4-core runner cannot meet budgets
calibrated on the reference class — and had it answer the environment-independent question instead:
do the committed documents still bind `dev`? It files a tracking issue when they do not.

That question is broader than the one a repair can answer. `sourceTreeSha256` binds the whole
performance subject: `packages/keiko-editor/`, `packages/keiko-ui/`, `packages/keiko-contracts/`,
`packages/keiko-server/src/editor/`, `src/`, and the root lockfile and tsconfigs (ADR-0139 D2). A
merge into any of them makes the committed documents stop binding the branch. That is not a defect.
It is what an integration branch does.

Nor can any automation repair it. Only the declared reference environment produces comparable
numbers (D6) — a ~35-minute exclusive run on a developer machine — and the next editor merge
invalidates the result again. The measured history is unambiguous:

- The documents regenerated at `5560893c` (2026-07-25 13:08Z) stopped binding `dev` at `d1ca594d`,
  **1 hour 41 minutes** later.
- Of the 18 commits that followed that regeneration, **8 moved the measured subject**.
- The lane's first regular night after the cutover (run 30188731898) went red with **exactly one**
  finding — that digest. The ruler, the pinned baseline anchor, the candidate lockfile and every
  budget still held. It filed [#2740](https://github.com/oscharko-dev/Keiko/issues/2740).
- Its only green run was a manual dispatch minutes after the regeneration, before any merge landed.
- The subject moved again the same morning: the digest the run computed (`ac228d21…`) was already
  stale four hours later (`7459a0f2…`).

So the lane demanded, every night, a repair that could not hold until morning, and reported a red
verdict for a condition it had no power to change. A lane that is red every night carries exactly as
much information as one that never speaks — the failure ADR-0156 D3 was written to prevent, reached
from the opposite direction. The freshness contract was correct; the mistake was routing all of it
to an exit code. The enforcing mode was designed for the regeneration wrapper, which validates its
own fresh output where exact-tree equality holds by construction, and was made "available to the
nightly lane for drift diagnosis". Diagnosis became verdict.

## Decision

**D1 — A detection lane fails only for drift that a re-measurement repairs for good.** A moved
measurement toolchain, an unsound or non-canonical document, a broken pinned-baseline anchor, a
missing stamp, a dirty subject working tree, a budget overrun: each is repaired by one regeneration
and stays repaired. Those keep failing the lane, keep filing the tracking issue, and keep saying
that a pull request touching `D12_MEASUREMENT_TOOLCHAIN_PATHS` has no route to green.

Subject drift — the source-tree digest and the candidate lockfile digest, the two findings that say
only "the product moved on" — is reported instead. `--report-subject-drift` selects this, the lane
stays green, and the findings are written to the run's job summary so the age of the numbers is
visible to anyone who looks, rather than inferred from a red badge nobody reads.

**D2 — What is evaluated does not change; only what may fail.** The lane still runs the complete
enforcing contract, and both digests are still computed and still compared. Nothing is skipped,
weakened, or made conditional. The flag is refused without `--enforce-source-freshness`, where it
would silently mean nothing.

**D3 — Membership in the reported class is established by construction.** `subjectDriftFinding`
registers the two drift messages as it formats them, and `isSubjectDriftFinding` answers by
membership — the same construction ADR-0156 D5 fixed for budget verdicts, adopted for the same
reason. The malfunction branches inside those very evaluators (a digest that cannot be recomputed, a
binding that is not a SHA-256) deliberately do not register, so a broken checker can never be read
as ordinary age. An evaluator that forgets the wrapper stays fatal, which is the fail-closed
direction.

**D4 — The pull-request gate and the regeneration wrapper are untouched.** The gate never evaluated
source freshness (ADR-0139 D10) and still does not. The wrapper still runs the full enforcing
contract with every finding fatal: it validates a document it has just produced against the tree it
measured, so exact-tree equality is a property that run can hold — and must, or a producer could
publish evidence binding a tree it never measured.

## Consequences

- The scheduled lane's red is meaningful again: it fires only for something a person can fix and
  keep fixed, so `#2740`-shaped issues stop being filed for the normal state of a branch.
- The age of the committed numbers stops being a red badge and becomes a line in the job summary,
  which is what it always was: information, not an alarm.
- Nothing that could ever have gone green is now allowed to stay red — the two downgraded findings
  had no reachable green state on a living branch. No gate loses strength: toolchain drift, budget
  overruns and document defects fail exactly where they failed before, on the lane and on every
  pull request that moved the ruler.
- Evidence still ages, and now ages quietly. That is accepted: per-pull-request performance
  protection is the deterministic bundle gates (`check:editor-release-evidence`,
  `check:editor-bundle-size`), which rebuild the shipped editor on every pull request; D12
  wall-clock evidence is a milestone artifact measured deliberately, which is what ADR-0156 D6
  already concluded when it removed measurement from CI.

## Alternatives rejected

- **Re-measure nightly on the reference environment.** There is no hosted runner of that class
  (D6), and a nightly 35-minute exclusive run on a developer machine — which must stay unloaded for
  the duration, or the numbers are an environment verdict — is not automation.
- **Drop the source-tree question from the lane entirely.** Cheaper, and it loses the one thing the
  comparison is good for: saying how far the committed numbers have travelled from the product.
  Reporting keeps that, at no cost.
- **Keep failing, but file the issue only once.** Treats the noise and leaves the cause: a red lane
  every night for a condition no one can clear, and a required-looking signal that trains everyone
  to ignore it.
- **Narrow `sourceTreeSha256` to fewer paths so it drifts less often.** Moves a measurement
  boundary to make a reporting problem quieter, and would make the evidence claim to bind product
  code it no longer covers.
