# Model-backed review: unexpected spend and containment

Operator failure modes for the Keiko for Quality reviewer
([`keiko-for-quality.yml`](../../.github/workflows/keiko-for-quality.yml)). The cost arithmetic
these entries refer to — prices per million tokens, tokens per reviewed file, and what a review of a
given size costs — is in [`docs/qa/review-cost-model.md`](../qa/review-cost-model.md); this document
covers only what to do when something is wrong.

---

## Memoization is not persisting, and every push pays for every file

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

- the store identity changed — the profile (`.github/keiko-for-quality.json`), the model id, the
  model protocol, or the reviewer pin, all four of which are hashed into the artifact name and
  bound into the signature context. Under `pull_request_target` the run derives these from the
  **protected base**, not from the candidate: a pull request that edits the profile or the pin
  does not shift its own identity, so the partition changes only once that change reaches `dev`;
- the seven-day artifact retention expired;
- an incomplete run uploaded no replacement **and** no older complete artifact remains retained
  under the same identity. The locator takes the newest eligible same-named artifact, not the
  immediately preceding run's, so an earlier complete store inside the retention window is still
  found;
- `KEIKO_QUALITY_STORE_HMAC` was rotated. The signing key is deliberately **not** part of the
  store identity — that is profile, model, protocol, and pin — so a retained artifact stays
  eligible by name, and the verify step then recomputes its MAC with the new key and discards it.
  Zero entries on the first run after a rotation is the boundary working, not a defect;
- the store is disabled for the run, which the log states explicitly.

Suspect a real failure only when a prior run under the same identity completed inside the
retention window and this run still loads nothing.

**Diagnostic Steps**

```bash
# 1. Confirm the current run loaded nothing, and how many files it paid for.
gh run view <run-id> --log | grep -oE '"code":"cache[^}]*}'

# 2. Find the earlier runs on this branch...
gh run list --workflow keiko-for-quality.yml --branch <branch> --limit 20 \
  --json databaseId,createdAt

# ...and read how the REVIEWER settled, which is not the workflow's conclusion. A review can
# settle complete and the workflow still fail afterwards (a hand-off or signing failure), and a
# workflow can succeed while the review settled incomplete. Only this diagnostic answers it.
gh run view <earlier-run-id> --log | grep -oE '"code":"settlement\.[^}]*}'

# 3. Check that the signing job ran and that a signed artifact exists for that run.
gh run view <earlier-run-id> --json jobs --jq '.jobs[] | "\(.name): \(.conclusion)"'
gh api repos/<owner>/<repo>/actions/runs/<earlier-run-id>/artifacts \
  --jq '.artifacts[] | "\(.name) \(.size_in_bytes)"'
```

A store artifact named `keiko-review-store-pr<number>-<identity>` confirms the producing half
worked, so the fault is in locating, downloading, or verifying. No such artifact, with the signing
job green, points at the hand-off condition; no signing job at all points at the review job's own
outcome.

**Resolution**

1. If the earlier run settled **incomplete**, it uploaded nothing — the hand-off and the signing
   job both gate on `outcome == 'complete'`. That explains the cold start **only when no older
   complete artifact under the same identity is still retained**; the locator scans all eligible
   artifacts, so if one exists this is still a real lookup or verification failure and the
   investigation continues at step 3. Where it is the explanation, reduce the size of the change so
   the review completes, rather than raising or lowering `token_budget`.
2. If the earlier run settled complete and produced no artifact, read the hand-off and signing
   steps' logs — every archive-gate refusal writes a `::warning::` naming what it rejected.
3. If an artifact exists but the next run discarded it, the verify step logs
   `restored review store failed context-bound HMAC verification` (a genuine mismatch, so the store
   is correctly refused) or `restored artifact carries no readable signature`. Do not weaken the
   verification to make a store load: an unverified store can mark files reviewed that never were.

---

## Model spend must be stopped immediately

| Field             | Value                   |
| ----------------- | ----------------------- |
| Severity          | Blocker                 |
| Surface           | Workflows               |
| Stable identifier | `KEIKO_QUALITY_ENABLED` |

**Symptom**

Model credit is being consumed faster than the work justifies, or a budget ceiling is about to be
reached and other services on the same subscription must keep working.

**Root Cause**

Each eligible pull request event starts a reviewer run, and each run dispatches every reviewable
file that the store cannot answer. Nothing throttles the number of runs per pull request.

**Diagnostic Steps**

```bash
# How many reviewer runs happened, and on which branches.
gh run list --workflow keiko-for-quality.yml --limit 100 \
  --json createdAt,headBranch,conclusion

# How many files a given run actually sent to the model. Use the MISSES here, not
# inventory.completed: the inventory counts every reviewable path including the ones the store
# answered, so on a healthy repeat run it overstates paid work by nearly the whole pull request.
gh run view <run-id> --log | grep -oE '"code":"cache.hits"[^}]*}'
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
