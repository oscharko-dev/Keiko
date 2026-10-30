# Review agent baseline — 2026-10-30

What the producers that reviewed Keiko's pull requests achieved on Keiko's own history, measured
before any Keiko for Quality review agent exists (Issue #4132, Epic #4130, ADR-0182 D9). Every
definition — the dataset fields, the region-change rule, the labeling rules and the named
quantities — is in [review-agent-measurement.md](review-agent-measurement.md). Every rate below is
shown with its absolute counts and its 95 % Wilson score interval.

## Harvest run

| Item              | Value                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Repository        | `oscharko-dev/Keiko`                                                                                     |
| Population        | Every merged and closed pull request: 2,176 (1,782 merged, 394 closed), #14 to #4146                     |
| Not covered       | The 7 pull requests open at harvest time (their history is still moving)                                 |
| Run               | 2026-10-30, 02:10:01Z to 02:20:00Z (read-only; 1,125 GraphQL points)                                     |
| Reproduction run  | 2026-10-30, 02:20:00Z to 02:26:48Z, page size 25 instead of 10 (1,221 GraphQL points) — identical digest |
| Dataset           | `packages/keiko-evaluations/src/review/fixtures/review-harvest-dataset.v1.json.gz`                       |
| Dataset digest    | `sha256:c6dfbede99249e9fda874649d4a938e4d3e69b4b8fb8e70be0d3c099b486f194`                                |
| Size              | 4.8 MB of JSON, committed gzip-compressed (836 kB); no comment body, login, email address or token       |
| Threads           | 10,648 on 695 pull requests; 152 coverage notices of the retired reviewer excluded and counted           |
| Region unmeasured | 16 threads (all anchored on the base side of the diff)                                                   |

Command (the bare repository holds every `refs/pull/*/head`, prepared as the measurement document
describes; `--fetch-missing-commits` fetched the 156 reviewed commits that later force-pushes had
made unreachable):

```bash
node scripts/review-harvest.mjs --repo oscharko-dev/Keiko --git-dir <bare repository> \
  --checkpoint <checkpoint file> --fetch-missing-commits --page-size 10 \
  --out packages/keiko-evaluations/src/review/fixtures/review-harvest-dataset.v1.json.gz
node scripts/review-harvest.mjs --verify packages/keiko-evaluations/src/review/fixtures/review-harvest-dataset.v1.json.gz
```

## Per producer

Thread-change rate and acceptance rate are different quantities. The thread-change rate is the
share of all measurable threads whose anchored region the pull request's own later commits
changed. The acceptance rate is the share of decided threads (hits plus confirmed refutations) that
were hits. Refutations are first foreign replies classified `refuted`; a refutation is confirmed
when the code stayed unchanged (a false alarm) and contradicted when the region changed afterwards
(counted as a hit).

| Producer                        | PRs reviewed | Threads | Findings per reviewed PR | Thread-change rate                      | Region unmeasured | Refutations                          | Hits / false alarms / undecided | Acceptance rate                           |
| ------------------------------- | ------------ | ------- | ------------------------ | --------------------------------------- | ----------------- | ------------------------------------ | ------------------------------- | ----------------------------------------- |
| Keiko for Quality               | 85           | 1528    | 17.98                    | 44.4 % (675/1519; 95 % CI 42.0-46.9 %)  | 9                 | 433 (337 confirmed, 94 contradicted) | 675 / 337 / 507                 | 66.7 % (675/1012; 95 % CI 63.7-69.5 %)    |
| CodeRabbit                      | 368          | 2460    | 6.68                     | 78.6 % (1933/2460; 95 % CI 76.9-80.2 %) | 0                 | 65 (47 confirmed, 18 contradicted)   | 1933 / 47 / 480                 | 97.6 % (1933/1980; 95 % CI 96.9-98.2 %)   |
| Codex                           | 160          | 1697    | 10.61                    | 68.2 % (1156/1694; 95 % CI 66.0-70.4 %) | 3                 | 35 (22 confirmed, 13 contradicted)   | 1156 / 22 / 516                 | 98.1 % (1156/1178; 95 % CI 97.2-98.8 %)   |
| Qodo                            | 149          | 575     | 3.86                     | 71.7 % (411/573; 95 % CI 67.9-75.3 %)   | 2                 | 6 (4 confirmed, 2 contradicted)      | 411 / 4 / 158                   | 99.0 % (411/415; 95 % CI 97.5-99.6 %)     |
| Human                           | 431          | 3208    | 7.44                     | 71.8 % (2302/3206; 95 % CI 70.2-73.3 %) | 2                 | 0 (0 confirmed, 0 contradicted)      | 2302 / 0 / 904                  | 100.0 % (2302/2302; 95 % CI 99.8-100.0 %) |
| Other bots and deleted accounts | 378          | 1180    | 3.12                     | 63.7 % (752/1180; 95 % CI 60.9-66.4 %)  | 0                 | 4 (3 confirmed, 1 contradicted)      | 752 / 3 / 425                   | 99.6 % (752/755; 95 % CI 98.8-99.9 %)     |

"PRs reviewed" counts pull requests on which the producer submitted a review or opened at least
one thread; "findings per reviewed PR" divides its threads by that count. First foreign replies per
producer (fixed / unclassified / unanswered): Keiko for Quality 420 / 368 / 307, CodeRabbit 1463 /
251 / 681, Codex 1284 / 88 / 290, Qodo 226 / 30 / 313, human 1 / 28 / 3179, other 477 / 62 / 637.

### Qodo (PR-Agent prompts)

The harvest establishes that Qodo (`qodo-code-review`) reviewed **149** pull requests, the count the
concept document reported, all between #2470 and #2872, so all of them fall into the development
set. It opened 575 threads (3.86 per reviewed pull request); the pull requests' own later commits
changed 411 of 573 measurable regions (thread-change rate 71.7 %, 95 % CI 67.9-75.3 %). Of its
findings only 6 were refuted — 4 with the code unchanged, 2 contradicted by a later change — so its
acceptance rate is 99.0 % (411/415; 95 % CI 97.5-99.6 %) over 415 decided threads, with 158
undecided.

### Reading the numbers

- Few readers refute in prose. Most decided threads are decided by the code changing, so the
  acceptance rate sits near 100 % for every producer except Keiko for Quality, the only producer
  whose findings drew hundreds of refuting replies (433). The acceptance rate is therefore only
  comparable within one producer's reply culture; the thread-change rate is the cross-producer
  quantity.
- "Human" means a `User` account. Almost all of those threads (3,187 of 3,208) fall at or after
  #3066, and almost none were answered (3,179 unanswered), so they are mostly decided by the region
  changing or remain undecided.
- The retired reviewer reported thread-change rates of 23 % (Keiko for Quality), 44 % (CodeRabbit)
  and 64 % (Codex) on its own arena windows. These figures are recomputed, not copied: this
  baseline covers the whole history, carries each anchor through every own commit and excludes base
  merges, so it is not the same population or rule and the numbers are not expected to match.

## Holdout boundary

**`holdoutFromPullRequest = 3066`** (the constant in `REVIEW_EVALUATION_MANIFEST`).

Rule: the smallest pull request number from which the most recent 30 % of the merged pull requests
carrying at least one review thread are held out. 592 merged pull requests carry threads; the most
recent 178 (⌈0.3 × 592⌉) start at #3066. Development set: pull requests below #3066 (1,750 pull
requests, 466 with threads, 3,879 threads). Holdout: #3066 and later (426 pull requests, 229 with
threads, 6,769 threads), plus every pull request merged after this baseline.

| Producer          | Development thread-change rate        | Development acceptance rate             | Holdout thread-change rate              | Holdout acceptance rate                   |
| ----------------- | ------------------------------------- | --------------------------------------- | --------------------------------------- | ----------------------------------------- |
| Keiko for Quality | 46.7 % (400/856; 95 % CI 43.4-50.1 %) | 71.0 % (400/563; 95 % CI 67.2-74.6 %)   | 41.5 % (275/663; 95 % CI 37.8-45.3 %)   | 61.2 % (275/449; 95 % CI 56.7-65.6 %)     |
| CodeRabbit        | 79.6 % (720/904; 95 % CI 76.9-82.1 %) | 99.3 % (720/725; 95 % CI 98.4-99.7 %)   | 78.0 % (1213/1556; 95 % CI 75.8-79.9 %) | 96.7 % (1213/1255; 95 % CI 95.5-97.5 %)   |
| Codex             | 72.5 % (494/681; 95 % CI 69.1-75.8 %) | 98.2 % (494/503; 95 % CI 96.6-99.1 %)   | 65.4 % (662/1013; 95 % CI 62.4-68.2 %)  | 98.1 % (662/675; 95 % CI 96.7-98.9 %)     |
| Qodo              | 71.7 % (411/573; 95 % CI 67.9-75.3 %) | 99.0 % (411/415; 95 % CI 97.5-99.6 %)   | — (0/0)                                 | — (0/0)                                   |
| Human             | 85.7 % (18/21; 95 % CI 65.4-95.0 %)   | 100.0 % (18/18; 95 % CI 82.4-100.0 %)   | 71.7 % (2284/3185; 95 % CI 70.1-73.2 %) | 100.0 % (2284/2284; 95 % CI 99.8-100.0 %) |
| Other             | 59.5 % (496/834; 95 % CI 56.1-62.8 %) | 100.0 % (496/496; 95 % CI 99.2-100.0 %) | 74.0 % (256/346; 95 % CI 69.1-78.3 %)   | 98.8 % (256/259; 95 % CI 96.7-99.6 %)     |

Every configuration, prompt or threshold change in this epic is made against the development set;
the replay refuses a run that tunes on the holdout (`ReviewHoldoutViolationError`).

## Preserved evidence of the retired reviewer

The measurements of the retired Keiko for Quality reviewer, at tag `v0.25.0` (commit
`f1117fb2b56a62bcbec22afbc149d5bd1474060c`) of `oscharko-dev/Keiko-for-Quality`. The Git blob id of
each file lets its content be verified against any copy should the repository be archived (the
owner's decision, recorded on the epic).

| Evidence                                                                                                                                                                        | What it records                                                 | Blob id                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| [precision-2026-08-08-baseline.md](https://github.com/oscharko-dev/Keiko-for-Quality/blob/v0.25.0/corpus/evidence/precision-2026-08-08-baseline.md)                             | Actionable rate 21.0 % (17 of 81 graded findings) on live Keiko | `058539ad90fd36dd215f500cadd474d89879b008` |
| [precision-instrument-2026-08-09-limits.md](https://github.com/oscharko-dev/Keiko-for-Quality/blob/v0.25.0/corpus/evidence/precision-instrument-2026-08-09-limits.md)           | Why a precision rate cannot see suppressed true findings        | `2d60e305f6cc47f0ccec0654cacd097a09b2f960` |
| [production-2026-08-05-what-a-reader-acts-on.md](https://github.com/oscharko-dev/Keiko-for-Quality/blob/v0.25.0/corpus/evidence/production-2026-08-05-what-a-reader-acts-on.md) | What readers acted on in production                             | `f5702a5fe4e313c6cf75e3a18bb4494fd3ab6bf3` |
| [historical-replay-2026-08-13-v0.25.0.json](https://github.com/oscharko-dev/Keiko-for-Quality/blob/v0.25.0/corpus/evidence/historical-replay-2026-08-13-v0.25.0.json)           | Chronological replay, holdout before and after                  | `7a1fadf943042c43cf41ba53c66d51437222e404` |
| [harvest-2026-08-09-baseline-window.md](https://github.com/oscharko-dev/Keiko-for-Quality/blob/v0.25.0/corpus/evidence/harvest-2026-08-09-baseline-window.md)                   | The retired harvest over its baseline window                    | `b0cbd7ae7e9a638b1bc0a037efa6b67520f00fce` |
| [seed-gate-2026-08-13-v0.25.0.md](https://github.com/oscharko-dev/Keiko-for-Quality/blob/v0.25.0/corpus/evidence/seed-gate-2026-08-13-v0.25.0.md)                               | The last consumer seed gate run                                 | `d52a0e995a30bbef11543f909f7e0d44b798a2e1` |
| [arena-baseline-v0.11.0.md](https://github.com/oscharko-dev/Keiko-for-Quality/blob/v0.25.0/corpus/evidence/arena-baseline-v0.11.0.md)                                           | The arena comparison with CodeRabbit and Codex at v0.11.0       | `6ecf235447a38bdafcb200973743a53f3397b212` |
