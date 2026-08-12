# Model-backed review: unexpected spend and containment

Operator failure modes for the Keiko for Quality reviewer
([`keiko-for-quality.yml`](../../.github/workflows/keiko-for-quality.yml)). The cost arithmetic
these entries refer to — prices per million tokens, tokens per reviewed file, and what a review of a
given size costs — is in [`docs/qa/review-cost-model.md`](../qa/review-cost-model.md); this document
covers only what to do when something is wrong.

---

## Restore a review store that is not persisting

| Field             | Value                                                |
| ----------------- | ---------------------------------------------------- |
| Severity          | High                                                 |
| Surface           | Workflows                                            |
| Stable identifier | `"code":"cache.store_loaded","counts":{"entries":0}` |

**Symptom**

A pull request that has already been pushed to keeps reviewing every changed file. The reviewer run
log shows, near the start of the review step:

```text
{"code":"cache.store_loaded","counts":{"entries":0}}
{"code":"cache.hits","counts":{"hits":0,"misses":<all reviewable paths>}}
```

Nothing fails. The run settles complete, findings publish normally, and the only visible signal is
the model bill. This is why the failure can persist for weeks unnoticed.

**Root Cause**

The per-file review store is not reaching the next run. It travels between runs as a
context-bound, HMAC-signed run artifact: the review job hands off an unsigned copy, the
`sign-store` job signs it and uploads the final artifact, and the next run locates, downloads, and
verifies it before the reviewer starts. A break anywhere in that chain leaves the next run with an
empty store, and an empty store means every reviewable file is dispatched to the model again.

A cold start is **expected and correct** in each of these cases, none of which is a defect:

- the store identity changed — the profile (`.github/keiko-for-quality.json`), the model id, or the
  model protocol, all three of which are hashed into the artifact name and bound into the signature
  context. The reviewer pin is cross-checked but deliberately not a partition: the action validates
  each entry's publication semantics. Under `pull_request_target` the run derives the profile from
  the **protected base**, not from the candidate, so a pull request that edits it does not shift its
  own identity; the partition changes only once that profile change reaches `dev`. A pin edit also
  takes effect only after merge, but compatible entries remain in the same partition;
- the seven-day artifact retention expired;
- a run produced `store_written=false` **and** no older artifact remains retained under the same
  identity. An incomplete run can still persist safely memoizable covered paths; the action output,
  not the settlement label alone, decides. The locator takes the newest eligible same-named
  artifact, not the immediately preceding run's;
- `KEIKO_QUALITY_STORE_HMAC` was rotated. The signing key is deliberately **not** part of the
  store identity — that is profile, model, and protocol — so a retained artifact stays
  eligible by name, and the verify step then recomputes its MAC with the new key and discards it.
  Zero entries on the first run after a rotation is the boundary working, not a defect;
- the store is disabled for the run, which the log states explicitly.

Suspect a real failure only when a prior run under the same identity completed inside the
retention window and this run still loads nothing.

**Diagnostic Steps**

```bash
# 1. Confirm the current run loaded nothing, and how many files it paid for.
gh run view <run-id> --log | grep -oE '"code":"cache[^}]*}'

# 2. Find the earlier runs FOR THIS PULL REQUEST. Branch alone is not enough: a reused head branch
# mixes in the previous pull request's runs, and artifacts partition by pull-request number — so a
# complete run from the old one would look like a producer for the new one and turn an expected
# empty store into a phantom lookup failure. Raise the limit until the list stops saturating;
# twenty was not enough for the incident recorded here: the change settled at twenty-one
# completed reviews in one day, and one branch alone produced thirty-four runs.
gh run list --workflow keiko-for-quality.yml --branch <branch> --limit 200 \
  --json databaseId,createdAt,event --jq 'length'   # equals the limit? raise it and repeat
gh api repos/<owner>/<repo>/actions/runs/<candidate-run-id> \
  --jq '{prs: [.pull_requests[]?.number], branch: .head_branch, repo: .head_repository.full_name}'
# Accept the candidate when `prs` carries THIS pull request's number — or, when GitHub
# omits the association entirely and `prs` is empty, when the branch and repository match.
# That fallback is not leniency: the workflow's own locator applies exactly the same rule,
# so a stricter diagnostic would dismiss a run the reviewer itself would have accepted and
# end the investigation early.

# ...and read how the REVIEWER settled, which is not the workflow's conclusion. A review can
# settle complete and the workflow still fail afterwards (a hand-off or signing failure), and a
# workflow can succeed while the review settled incomplete. Only this diagnostic answers it.
gh run view <earlier-run-id> --log | grep -oE '"code":"(settlement|inventory)\.[^}]*}'
# `inventory.*` is included deliberately: an unclassified path fails the run WITHOUT a
# settlement code, so a settlement-only search returns nothing and the table below is never
# reached for the one reason whose remedy is a profile change rather than size or the engine.

# 3. Check that the signing job ran and that a signed artifact exists for that run.
gh run view <earlier-run-id> --json jobs --jq '.jobs[] | "\(.name): \(.conclusion)"'
gh api repos/<owner>/<repo>/actions/runs/<earlier-run-id>/artifacts \
  --jq '.artifacts[] | "\(.name) \(.size_in_bytes)"'
```

A store artifact named `keiko-review-store-pr<number>-<identity>` confirms the producing half
worked, so the fault is in locating, downloading, or verifying.

**A green signing job proves nothing on its own.** By design it never fails on an attacker-
reachable path: a missing or undownloadable unsigned artifact, an archive-gate refusal, an
extraction over the limits, and a failed signature all exit zero with a `::warning::` and simply
skip the upload. So when no artifact exists, read those warnings rather than inferring which half
broke from the job's conclusion:

```bash
gh run view <run-id> --log | grep -E "::warning::|::notice::"
```

No signing job at all has two causes, not one. The job is skipped when the action reports
`store_written=false` **and** when the store was disabled for the run — `Derive store identity` turns
persistence off when the declared pin is unreadable or disagrees with the pinned `uses:` line, and
that decision gates the signer independently of the outcome. Read the store-identity step's
warnings and its `store-enabled` output before concluding anything from the review outcome.

**Resolution**

1. If the earlier run reported `store_written=false`, it uploaded nothing. That explains the cold
   start **only when no older artifact under the same identity is still retained**; the locator
   scans all eligible artifacts, so if one exists this is still a real lookup or verification
   failure and the investigation continues at step 3. Do not infer this output from `incomplete`:
   safely covered paths can be retained from an incomplete review.

   Then read the settlement reason, because the remedy differs and only one of them is "make the
   change smaller":

   | Reason                                                   | What to do                                                                                                                       |
   | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
   | `settlement.incomplete.budget_exceeded`                  | Split the change, or raise `token_budget` knowingly                                                                              |
   | `settlement.incomplete.coverage_gap`                     | Compare the engine's coverage against the inventory — a path the profile classifies as reviewable that the engine did not select |
   | `settlement.incomplete.engine_status_not_success`        | The engine reported failure; `reviewed`/`expected` on the reason give the size of the gap                                        |
   | `settlement.incomplete.schema_rejected`, `…engine_error` | The manifest is not to be believed — check the engine pin and its output, not the change size                                    |
   | `settlement.incomplete.warning_not_allowlisted`          | An unlisted warning; decide whether it belongs in the profile's `benignWarnings`                                                 |
   | `inventory.unclassified_path`                            | A path the profile classifies neither way; extend the profile                                                                    |

   Reducing the change size for any of the others wastes another full-price run without making the
   store persist.

2. If the earlier run settled complete and produced no artifact, read the hand-off and signing
   steps' logs — every archive-gate refusal writes a `::warning::` naming what it rejected.
3. If an artifact exists but the next run discarded it, the verify step logs
   `restored review store failed context-bound HMAC verification` (a genuine mismatch, so the store
   is correctly refused) or `restored artifact carries no readable signature`. Do not weaken the
   verification to make a store load: an unverified store can mark files reviewed that never were.

---

## Stop model spend immediately

| Field             | Value                   |
| ----------------- | ----------------------- |
| Severity          | Blocker                 |
| Surface           | Workflows               |
| Stable identifier | `KEIKO_QUALITY_ENABLED` |

**Symptom**

Model credit is being consumed faster than the work justifies, or a budget ceiling is about to be
reached and other services on the same subscription must keep working.

**Root Cause**

Each eligible pull request event creates a workflow run. A secretless 120-second debounce prevents
superseded push bursts from entering the paid review job, and concurrency cancels an older run that
is already active. Neither mechanism caps a sustained sequence of current-head events; every head
that remains current after the debounce dispatches each reviewable file the store cannot answer.

**Diagnostic Steps**

```bash
# How many reviewer runs happened, and on which branches.
gh run list --workflow keiko-for-quality.yml --limit 100 \
  --json createdAt,headBranch,conclusion

# What a run actually paid. On a COMPLETE run the misses from cache.hits are the files that went
# to the model — use those, not inventory.completed, which also counts the ones the store answered.
gh run view <run-id> --log | grep -oE '"code":"cache.hits"[^}]*}'

# On a TRUNCATED run misses is only an upper bound: the engine stops dispatching at the limit, so
# the undispatched tail is still a miss that cost nothing. There the engine's own token total is
# the honest number, carried on the settlement itself.
gh run view <run-id> --log | grep -oE '"code":"settlement.incomplete.budget_exceeded"[^}]*}'
```

**Resolution**

Two steps, and the first alone is not enough.

1. Set the repository variable `KEIKO_QUALITY_ENABLED` to `false`. That is the variable's name; the
   `vars.` prefix seen in the workflow is the Actions expression context, not part of it. No new
   job then starts, so the environment's secrets are never materialized for one.
2. **Cancel every run already requested, queued, waiting, pending, or in progress.** The variable
   does not touch them: a run that has started keeps its credentials and can keep spending until it
   finishes or reaches the thirty-minute job timeout. Use the cancellation loop in the
   [activation record's disable procedure](../qa/keiko-for-quality.md) — it checks the query limit
   rather than trusting it, repeats until nothing live remains, and treats every failed call as
   containment not established. Do not substitute a one-line variant: a truncated run list hides an
   older live run behind newer completed ones and reports containment it never achieved.

Nothing else in this repository can spend model budget on review. The scheduled re-qualification
lives in the product repository, not here.
