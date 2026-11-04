# Review agent measurement

How Keiko measures the quality of a pull request review: what the instruments are, what every
quantity means, the labeling rules, and the holdout discipline. Governing decision:
[ADR-0182](../adr/ADR-0182-keiko-for-quality-governed-pull-request-review-agent.md) D9. Introduced
by Issue #4132 (Epic #4130). The recorded baseline is
[review-agent-baseline-2026-10-30.md](review-agent-baseline-2026-10-30.md).

The instruments are ported in meaning from the retired Keiko for Quality reviewer
(`oscharko-dev/Keiko-for-Quality` v0.25.0, `corpus/harvest-lib.mjs`, `historical-replay-lib.mjs`,
`precision-gate-lib.mjs`, `seed-gate-lib.mjs`). Its engine invocation, arena, release evidence and
live telemetry were not ported.

## Instruments

| Instrument       | Where                                                                     | What it answers                                                                 |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Harvest          | `scripts/review-harvest.mjs`, `scripts/lib/review-harvest-*.mjs`          | What happened to every review thread on Keiko's merged and closed pull requests |
| Labeling rules   | `packages/keiko-evaluations/src/review/labels.ts`                         | Which threads were hits, false alarms, undecided or unmeasured                  |
| Replay           | `packages/keiko-evaluations/src/review/replay.ts`                         | What a review implementation finds on historical pull requests, scored          |
| Precision gate   | `packages/keiko-evaluations/src/review/precision-gate.ts`                 | Of the findings on measurable threads, how many were actionable, at what cost   |
| Seed gate        | `packages/keiko-evaluations/src/review/seed-gate.ts`, `consumer-seeds.ts` | Whether every required planted defect is found                                  |
| Synthetic corpus | `packages/keiko-server/src/review/qualification/seed-corpus/`             | The shippable seed fixtures customer pair qualification (Issue #4137) runs      |
| Baseline         | `packages/keiko-evaluations/src/review/baseline.ts`                       | What each producer that reviewed Keiko achieved                                 |

The evaluation family is exposed as `ReviewEval` from `@oscharko-dev/keiko-evaluations`. The review
pipeline under test enters the replay and the seed gate through an injected port; the model comes
from the package's existing offline-versus-live provider selector (`createEvaluationModelProvider`):
a scripted transcript in CI, the gateway only when a live run is authorized. Seed scoring is
`scoreReviewSeedRun` from `keiko-contracts`, the same rule the server's pair qualification uses.
The root test suite runs the family's deterministic tests; `npx vitest run packages/keiko-evaluations/src/review packages/keiko-server/src/review/qualification scripts/__tests__/review-harvest.test.mjs` runs them alone (after `npm run build:packages`).

## The harvest dataset

The harvest reads every review thread of every merged and closed pull request through
`gh api graphql` and writes one record per thread. It reads each comment body exactly once — to
classify a reply and to digest the root comment — and stores neither the text nor any login,
email address or token. The committed dataset is
`packages/keiko-evaluations/src/review/fixtures/review-harvest-dataset.v2.json.gz` (schema version 2,
gzip at a fixed level; the content digest covers the decompressed JSON, not the compressed bytes).
Schema version 2 adds the head anchor (R4130-007); every other field is unchanged from version 1.

| Field                          | Meaning                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `number`, `state`              | Pull request number; `merged` or `closed`                                                              |
| `headCommit`, `baseCommit`     | The pull request's final head and base object ids                                                      |
| `reviewedBy`                   | Every producer that submitted a review or opened a thread                                              |
| `id`                           | GraphQL node id of the thread                                                                          |
| `producer`                     | `keiko-for-quality`, `coderabbit`, `codex`, `qodo`, `human` or `other`                                 |
| `path`, `startLine`, `endLine` | Anchored file and 1-based inclusive range at the reviewed commit (`originalLine`, `originalStartLine`) |
| `fileLevel`, `side`            | A thread on the whole file; the diff side (`right` = the changed file, `left` = the base file)         |
| `reviewedCommit`               | The commit the root comment was originally written against (`originalCommit`)                          |
| `resolved`, `outdated`         | GitHub's resolution state of the thread                                                                |
| `reply`                        | Classification and producer of the first reply by someone other than the thread's author; null if none |
| `regionChange`                 | `changed`, `unchanged`, `no-later-commit` or `unavailable` (below)                                     |
| `headStartLine`, `headEndLine` | The right-side line anchor carried to `headCommit` (below); both null when there is none               |
| `bodyDigest`                   | `sha256:` of the root comment body, for duplicate detection only                                       |

Producer attribution: a thread belongs to the author of its first comment. A known bot login
(`keiko-for-quality`, `coderabbitai`, `chatgpt-codex-connector`, `qodo-code-review`) counts only when
GraphQL reports a `Bot` account; any `User` is `human`; every other bot and deleted account is
`other`. The retired reviewer's own coverage notices ("was not fully reviewed") are not findings and
are only counted (`excludedNoticeThreads`).

Reply classification: the first reply whose author differs from the thread's author is read with
the retired precision gate's phrase lists. Whichever verdict appears first wins; a reply nothing
matches is `unclassified`, never `fixed`.

Region change: the harvest walks the pull request's first-parent chain from the reviewed commit to
its final head and diffs the anchored file in every commit against that commit's first parent, with
a pinned `git diff-tree -U0` (Myers, indent heuristic, no renames, no external diff or textconv,
user and system Git configuration ignored). The anchor is carried from commit to commit: hunks
above it shift it, hunks inside it stretch it. An own commit of the pull request whose old-side hunk
overlaps the carried anchor within three lines (the retired `ACTED_UPON_LINE_TOLERANCE`) makes the
region `changed`; a file-level anchor changes with any own hunk; a binary change or a deleted file
counts as changed. A merge commit — the base branch flowing into the pull request — only carries
the anchor: a change the base brought is not the pull request acting on a finding. When a
force-push took the reviewed commit off the chain, the rule falls back to one cumulative diff from
the reviewed commit to the head. The region is `no-later-commit` when the head is the reviewed
commit, and `unavailable` when Git cannot answer: a commit is not served any more, or the anchor is
on the base side, whose line numbers the history does not carry. Known limits of the proxy,
inherited from the retired reviewer: a fix landing in another file is not seen, a change that is
later reverted inside the pull request still counts, and the cumulative fallback cannot separate a
rebased-in base change from the pull request's own.

Head anchor: a replay reviews each pull request at its final `headCommit`, so a replayed finding
carries head line numbers, while `startLine` and `endLine` are positions at the reviewed commit. The
harvest therefore carries each right-side line anchor to the head commit with the same walk
(`carryAnchorToHead`, built on `carryAnchor`). Unlike the region-change rule, the walk carries the
anchor through every commit, merges included, because head line numbers count every line at head;
a force-pushed history carries it across its one cumulative diff. `headStartLine` and `headEndLine`
are null for a file-level thread, a base-side thread, an `unavailable` history and an anchor whose
carry crossed a binary or whole-file change. A line anchor without a head range is unmeasured for
the replay.

Determinism: the dataset carries no wall-clock value and is sorted by pull request number and
thread id, and its digest is SHA-256 over canonical (key-sorted) JSON. The same GitHub state
therefore yields the same digest; `node scripts/review-harvest.mjs --verify packages/keiko-evaluations/src/review/fixtures/review-harvest-dataset.v2.json.gz` recomputes it.
`loadReviewHarvestDataset` recomputes the same digest on every load and refuses a file whose stored
`digest` field does not match its content (R4130-010).

### Running the harvest

The harvest is repository tooling (deterministic `PASS`/`FAIL` output, read-only against GitHub,
outside the Activity Log rules). The region probe needs a local object store holding every pull
request head; a bare repository that borrows the checkout's objects is enough:

```bash
git init --bare /tmp/keiko-review-git
echo "$PWD/.git/objects" > /tmp/keiko-review-git/objects/info/alternates
git -C /tmp/keiko-review-git remote add origin https://github.com/oscharko-dev/Keiko.git
git -C /tmp/keiko-review-git fetch --no-tags origin '+refs/pull/*/head:refs/pull/*/head'

node scripts/review-harvest.mjs --repo oscharko-dev/Keiko --git-dir /tmp/keiko-review-git \
  --checkpoint /tmp/keiko-review-harvest.checkpoint.json --fetch-missing-commits \
  --out packages/keiko-evaluations/src/review/fixtures/review-harvest-dataset.v2.json.gz
```

A schema-1 dataset gains its head anchors without another GitHub read. `--add-head-anchors`
verifies the input's digest, carries every thread's anchor with the local objects, refuses a thread
whose region change the probe no longer reproduces, and keeps every other recorded fact:

```bash
node scripts/review-harvest.mjs --add-head-anchors <schema-1 dataset>.json.gz \
  --git-dir /tmp/keiko-review-git \
  --out packages/keiko-evaluations/src/review/fixtures/review-harvest-dataset.v2.json.gz
```

`--fetch-missing-commits` fetches a reviewed commit that a later force-push made unreachable from
every pull request head, by object id, once (a read). The checkpoint is body-free like the dataset
and is rewritten after every page of pull requests, so an interrupted run resumes where it stopped.
Every GraphQL answer's `rateLimit` paces the next request: below 100 remaining points the harvest
pauses until the reset; a rate-limited answer waits at least a minute (or until the reset), a
transient one backs off, and both are retried up to six times. One page asks for ten pull requests
with their first 40 threads, 20 comments each and 50 review authors; overflowing connections are
completed with node queries, so no thread is graded on a partial conversation. A full harvest of
Keiko costs roughly 1,100 GraphQL points of the hourly 5,000.

## Labeling rules

Applied by `labelReviewThread`, once, for the replay, the precision gate and the baseline alike:

1. **Region changed later in the same pull request: hit.**
2. **Evidenced refutation with the code unchanged: false alarm.** An evidenced refutation is a
   first foreign reply classified `refuted`; unchanged means `unchanged` or `no-later-commit`.
3. **A refutation the code later contradicted is not a refutation: hit.** The region changed after
   a refuting reply; it is counted as a hit and reported as a contradicted refutation.
4. **No counterpart: a hand-graded sample, never counted automatically as a hit.** A replayed
   finding that overlaps no historical thread is `unmatched`; it is reported, excluded from every
   rate, and left for hand grading.

A thread whose region is unchanged and that nobody refuted is `undecided`. A thread whose region is
`unavailable` is `unmeasured` — an absent measurement never reads as a confirmed refutation.

A replayed finding sits at the head commit, so it is matched only against right-side threads, in
head line numbers: it matches when it names the same file and its range overlaps the thread's head
range. A file-level thread overlaps any range in its file. A right-side line thread without a head
range may lie under any finding in its file, so it contributes `unmeasured` and never credits a hit.
A base-side thread is never matched. When several threads match, the strongest evidence decides in
the order hit, false alarm, undecided, unmeasured.

A matched thread credits one hit per pull request (R4130-014). `scoreReviewFindings` scores a pull
request's findings in their presented order; a finding that would be a hit only on threads an
earlier finding was already credited for is a `duplicate`. A duplicate adds no hit and counts
against the actionable rate.

## Quantities

Every rate is reported with its absolute counts and a 95 % Wilson score interval
(`wilsonInterval` in `keiko-contracts`); a rate over nothing is shown as absent, never 0 % or 100 %.
These quantities answer different questions and are always reported under their own names:

- **Thread-change rate.** Of the threads whose region could be measured, the share whose region
  changed later in the same pull request. It describes a producer's history and includes threads
  nobody answered.
- **Acceptance rate.** Hits over hits plus false alarms. For a producer's history it counts
  threads; for a replayed review it counts findings. It is reported and never gated: few readers
  refute in prose, so almost every decided thread is a hit.
- **Actionable rate.** Hits over hits, false alarms and undecided (owner decision 2026-11-04,
  R4130-006). For a replayed review it counts findings, and duplicate findings join the
  denominator: hits / (hits + false alarms + undecided + duplicates). A finding that lands on a
  thread nobody answered or acted on counts against the agent. ADR-0182 D9's offline threshold of
  at least 50 % applies to this rate on the holdout. For a producer's history the baseline reports
  the same quantity over threads, which have no duplicates.
- **Findings per reviewed pull request.** Threads divided by the pull requests a producer
  reviewed (a submitted review or at least one thread).

## Holdout discipline

The development set is every pull request below `holdoutFromPullRequest` in
`REVIEW_EVALUATION_MANIFEST`; the holdout is that pull request and every later one. The boundary is
a constant, chosen once from the recorded baseline, and never an option of a run. Any
configuration, prompt or threshold change is made against the development set only. Every replay
run records its split, its purpose (`tuning` or `evaluation`), its selection and the pull requests
whose labels informed a change (`tuningInputs`). The selection is `default` when the run reviewed
exactly every pull request of its split that carries a thread, whether or not the caller listed
them, and `subset` otherwise (R4130-011). `runReviewReplay` refuses with `ReviewHoldoutViolationError`,
before any model call:

- `holdout-tuning-input` — a tuning input is a holdout pull request;
- `holdout-tuning-run` — a tuning run reads the holdout split;
- `split-mismatch` — a run selects a pull request from the other split;
- `unknown-pull-request` — a run selects a pull request the dataset does not hold.

Moving the boundary is a reviewed change to the manifest that records why; it never happens to make
a model pass.

## Precision gate

`summarizeReviewPrecision` reports, for one replay run: the actionable rate and the acceptance
rate; the absolute counts of findings, hits, false alarms, undecided, duplicate, unmeasured and
unmatched findings; the same per category and per severity, each with its own interval; findings
per pull request (mean and maximum); the settlements; and the cost per pull request — model calls,
input and output tokens as reported by the model, and wall time.

`evaluateReviewPrecisionGate` returns `unmeasured` unless the run is a holdout evaluation over the
default selection (R4130-011), and for a run that reviewed nothing or presented no finding on a
measurable thread. Otherwise it passes when all of these hold:

- the actionable rate is at least the manifest's `minimumActionableRate` (0.5);
- no pull request presented more than `maximumFindingsPerPullRequest` findings (three, the
  presented-finding limit);
- at most `maximumNotCompleteShare` (0.2) of the reviews settled other than `complete`.

The last bound exists because a review that did not complete often presents nothing, and the rate
would then describe only the reviews that finished. The report always prints that share.
`rescoreReviewReplayRun` scores a stored run again from its finding locations and the dataset alone,
so stored reviews can be re-scored under the current rules without a model call.

A precision rate cannot see true findings a model suppressed (the retired reviewer's
[instrument limits](https://github.com/oscharko-dev/Keiko-for-Quality/blob/v0.25.0/corpus/evidence/precision-instrument-2026-08-09-limits.md)).
That is why the seed gate exists, and both gates stay.

## Seed gate

`runReviewSeedGate` runs two seed sets through the injected review port:

- **Synthetic qualification corpus** — nine small generated repositories, one planted defect each
  (removed authorization guard, swallowed error, missing `await`, off-by-one boundary, nullish
  dereference after an optional, path traversal in a file read, unchecked external input reaching a
  shell command, a file handle not released on the error path, an inverted condition), all
  required, plus three clean controls. They contain no Keiko or customer code. The corpus is server
  data so customer pair qualification can ship it; the caller passes it to the gate.
- **Keiko consumer seeds** — real defects planted into real Keiko files at pinned `find` strings.
  Tier 1 (blatant) is always required; tier 2 (subtle) is required unless demoted with a dated note
  naming the run evidence; measurement seeds are advisory by design and name their own promotion
  criterion. A seed whose `find` no longer matches exactly once is `stale-seed` and blocks the gate:
  it is recalibrated deliberately, never skipped. A unit test plants every consumer seed into the
  current file, so a refactor of a seeded file meets its seed in the same change.

A defect seed is found when a presented finding overlaps its expected range in its file. The gate
fails when any required seed is missed, incomplete or stale (seed or run), and reports each seed's
outcome (`found`, `missed`, `incomplete`, `stale-run`, `stale-seed`, `clean`, `false-alarm`). An
incomplete run never counts as found. Findings on clean controls are counted as false alarms apart
from the recall verdict.
