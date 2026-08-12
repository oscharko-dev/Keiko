# Keiko for Quality — operating the external reviewer

Governed by [ADR-0170](../adr/ADR-0170-keiko-for-quality-as-an-external-reviewer.md). Tracked by
[epic #2881](https://github.com/oscharko-dev/Keiko/issues/2881).

The reviewer is an external product —
[oscharko-dev/Keiko-for-Quality](https://github.com/oscharko-dev/Keiko-for-Quality) — consumed here
as a GitHub Action pinned to a full commit SHA. This repository owns only the workflow, the review
profile, and the credentials.

## What it is and is not

It reads the exact change on an eligible `dev` pull request, runs a model over it, and publishes
findings as native review conversations. Each unresolved conversation blocks the merge through the
existing Required Conversation Resolution rule.

It publishes **no required status check**. It cannot write code, commit, push, merge, or change
branch protection. The ten App-bound required checks from ADR-0169 D3 are untouched.

Approval is a different case and ADR-0170 D3 states it precisely: GitHub accepts an `APPROVE` review
from any token holding `pull-requests: write`, which both the App token and `GITHUB_TOKEN` hold. The
platform does not withhold it — the pinned action's behaviour does, and that behaviour is pinned by
a test upstream. When assessing a compromised or defective action, assume the capability exists.

## Activation record

Activated on 2026-08-02 against Keiko for Quality `v0.4.0`
(`80bda11eec1e113573c09878b91a885981211009`), model `gpt-5.4` over an OpenAI-compatible endpoint.

Repinned repeatedly the same day — the first three advances because a live run exposed a defect
no fixture had, the fourth for capability:

| pin                                                 | why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v0.4.0` `80bda11eec1e113573c09878b91a885981211009` | activation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `v0.5.0` `be392820f2839ba9b9711c1a5a4ccceaa465e6d6` | v0.4.0 passed the profile's exclusions to the engine, whose filter resolves an overlap the opposite way to the inventory. Every documentation pull request settled incomplete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `v0.7.0` `688e34f077f3aec328614e77212e8cfd486d84ab` | v0.6.0 lets the reviewer search the repository before making a claim; v0.7.0 publishes the findings a partial run did produce instead of discarding them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `v0.8.0` `3721f42e9b58ef8bce23879a74a0adcc67232614` | the engine's own `--max-tokens-budget` gate was dormant, so an 87-file pull request paid for every file before the overrun was noticed; v0.8.0 allots a size-scaled budget the engine enforces mid-run, and stops spending model tokens on byte-identical renames. The consumer ceiling rises to 6,000,000 in the same change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `v0.9.0` `3e458cdc86eb102b3a06a7dfb161d3c0f12e8364` | per-file review memoization. A push re-reviews only content that actually changed; untouched files replay from a per-pull-request store carried between runs by `actions/cache`, keyed on content, rule, engine, and model identity, and saved only from runs that settled complete. First advance driven by cost rather than a defect — findings replayed from the store pass the same sanitizer as fresh ones. Replay is content-scoped by design: a verdict for a byte-identical file is not re-derived when a later push changes only _other_ files, so cross-file context drift between pushes is re-examined solely through the files whose own diff changed. Raised by the Codex reviewer on the adopting pull request; bound and mitigation tracked upstream as oscharko-dev/Keiko-for-Quality#50. Consumer persistence note: the `actions/cache` wording describes the original adoption; since the #2931 hardening the store travels as a context-bound, HMAC-signed run artifact located under `actions: read` — the workflow is authoritative, this row is history. |

| `v0.10.0` `ec48db94d70d9a07d729d814ea405157652530be` | the store from v0.9.0 had never persisted in production — `cache.store_loaded` reported zero entries and `cache.hits` zero on every run, because persisting it needed the artifact plumbing that only landed with #2931. The cost was concrete: a 135-file pull request was re-priced in full twenty-one times in one day. v0.10.0 makes the store persist and verify, and carries two rule defects that qualification surfaced — a citation instruction that asked for an angle-bracketed `Source:` line while another instruction states bare angle brackets discard the finding, and an unbounded body ending through which a prompt injection appended an exfiltration beacon after the diff (the sanitizer blocked it and the correct finding died with it). Also: code-region masking, so quoting generics or a fenced HTML sample no longer costs a finding, on a linear masker that replaced an exponentially backtracking one. Qualified on two consecutive green corpus runs — 19/19 recall, 19/19 classified, 4/4 precision, 23/23 publishable, 0 noise — against engine `484a232e017c` and rule `b7558fc533cc`. The consumer ceiling drops to 2,000,000 in the same change, under credit pressure: the allotment formula leaves ordinary pull requests untouched, and a review that needs more now settles incomplete, which publishes a blocking conversation rather than passing silently. |

The pin in [`keiko-for-quality.yml`](../../.github/workflows/keiko-for-quality.yml) is the
authoritative one; this table is history, and a disagreement between them means the table is
stale.

The production workflow admits a current head through a 120-second debounce free of model, store,
and environment secrets before the job that declares the `keiko-for-quality` environment can start.
It checks the server-owned pull ref both before and after the wait, and the review job rechecks once
more before its first secret-bearing step. A superseded head therefore produces no model review;
concurrency remains the containment for a run that already passed admission and began spending.
Both workspaces are checked out at `github.workflow_sha`, so the pin synchronization check reads the
same protected workflow revision GitHub is executing even when a long-lived pull request's payload
still carries an older base SHA. The event's immutable base/head pair continues to define the diff.

**The delivery freeze in step 4 was not applied, and coverage for that window was therefore not
established.** Recorded as a shortfall rather than as an exception, because the reasoning that
justified skipping it was wrong.

The observation was that zero pull requests were open against `dev`, and the conclusion drawn was
that there was nothing to hold. That conclusion only covers _already-armed_ pull requests. It says
nothing about the arrival race, which is the reason step 4 locks the branch in the first place: the
count was taken before the variable was set, so a same-repository pull request opening or becoming
ready in between would have fired its event while the reviewer was still off, and gone unreviewed
with nothing holding it. An empty list at one instant is not an empty window.

No such pull request is known to have arrived, and that is a statement about luck rather than about
the procedure. Every later activation or re-enable follows step 4 as written, including when the
initial list is empty — the lock is what closes the race, and the emptiness of a snapshot has no
bearing on it.

## Provisioning

Until `KEIKO_QUALITY_ENABLED` is `true`, the job does not run at all — that variable, not the
endpoint, is what the job condition tests. This is deliberate: an unconfigured reviewer is visibly
absent rather than a failing job on every pull request.

### 1. Register the GitHub App

Create a GitHub App named **Keiko for Quality** with:

- Repository permissions: **Pull requests: read & write**, **Contents: read**
- No webhook, no account permissions

Install it on this repository and generate a private key.

The dedicated identity is a security requirement, not branding. Deduplication suppresses a repost
only when the existing conversation carries the finding's marker **and** was authored by the
reviewer itself. A marker is a public string in a public comment; under the shared
`github-actions[bot]` identity, any other workflow here could author one and silence a real finding.

### 2. Create the environment

Create a repository environment named `keiko-for-quality`. This keeps the credential out of every
workflow that does not ask for it.

Be precise about what that buys. An environment scopes secrets to jobs that **declare** it, not to
one workflow: another job declaring `environment: keiko-for-quality` could reference the same
credentials and mint the same App identity — which would let it pre-post deduplication markers.
Two boundaries hold together. First, no such workflow exists on the protected base, and adding one
requires a reviewed, merged change. Second — because `workflow_dispatch` runs execute the workflow
file of a **caller-chosen ref**, so "reviewed base" alone does not bind a dispatched run — the
environment carries a protected-branches-only deployment branch policy: a job running a candidate
branch's workflow file cannot declare this environment at all — a Codex reviewer finding on
pull request 2931. Verify with `gh api repos/<owner>/<repo>/environments/keiko-for-quality` — the
`deployment_branch_policy.protected_branches` flag must be `true`. Binding issuance to this
workflow's OIDC identity would close the gap absolutely and is tracked as follow-up.

The same review also made a second environment an operating prerequisite: `npm-publish`, with a
required human reviewer, in front of `release.yml`'s publish job — because any job token holding
`actions: write` (today only `infra-failure-retry`) can dispatch that
workflow. Verify its protection the same way; a missing `required_reviewers` rule there reopens a
production-publish path and must be treated as a provisioning failure, not a nicety. The
environment declaration alone is not sufficient either: a dispatched candidate-branch
`release.yml` variant could omit it, so the npm Trusted Publisher (ADR-0130) must also be bound
to the `npm-publish` environment in the package's Trusted Publisher settings on npmjs.com — an
operator-only step; until it is done, ADR-0170 D3 records that residual path as a stated
fail-open window.

### 3. Set variables and secrets

The store-authenticity key is part of provisioning: create `KEIKO_QUALITY_STORE_HMAC` in the
`keiko-for-quality` environment (any 32-byte random value; it is never read by a human again).
The workflow signs each persisted review store with it and discards any restored store that does
not verify — the boundary that keeps a candidate-base `pull_request_target` run from donating a
fabricated store through a retarget (ADR-0170 D3). Verify existence with
`gh api repos/<owner>/<repo>/environments/keiko-for-quality/secrets`.

Repository **variables** — non-sensitive only. Variables are **not** masked in logs, so nothing
that could identify a private endpoint belongs here:

| Name                           | Example   |
| ------------------------------ | --------- |
| `KEIKO_QUALITY_MODEL_ID`       | `gpt-5.4` |
| `KEIKO_QUALITY_MODEL_PROTOCOL` | `openai`  |

**`KEIKO_QUALITY_ENABLED` is deliberately not in that table.** It is the switch, and setting it here
would defeat the hold that step 4 establishes: between this step and that lock, an already-armed
pull request whose final required check turns green integrates unreviewed, because enabling emits no
review event and this reviewer publishes no required status. Set it in step 4, after `dev` is locked
and the first hold has succeeded — and nowhere else.

It is a separate variable rather than the endpoint itself because a job condition cannot read a
secret.

Environment **secrets** on `keiko-for-quality`:

| Name                            | Value                                                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KEIKO_QUALITY_MODEL_ENDPOINT`  | e.g. `https://<resource>.openai.azure.com/openai/v1`                                                                                                           |
| `KEIKO_QUALITY_MODEL_TOKEN`     | model provider credential                                                                                                                                      |
| `KEIKO_QUALITY_APP_ID`          | the App's numeric id                                                                                                                                           |
| `KEIKO_QUALITY_APP_PRIVATE_KEY` | the App's private key (PEM)                                                                                                                                    |
| `KEIKO_QUALITY_STORE_HMAC`      | store-authenticity key: ≥32 random bytes, generated once, never read again — a run refuses to start without it (the workflow asserts it before any model cost) |

The endpoint is a secret, not a variable: it can be a private provider address, and this repository's
redaction contract states that logs carry no endpoints.

### 4. Retrigger the pull requests that are already open

Setting a variable emits **no** pull-request activity event. Every eligible `dev` pull request that
is already open with an unchanged head therefore still has no reviewer run, and the delivery policy
only waits for runs that actually started. Provisioning is not finished until those heads have been
reviewed.

**Hold delivery before setting the variable.** An open pull request can already have native
auto-merge armed. Its last required check can go green in the window between enabling the reviewer
and retriggering that pull request — and because enabling emits no event and this reviewer publishes
no required status, GitHub integrates it immediately, unreviewed, with the loop below still to reach
it. Nothing afterward can undo that, so the confirmation step would attest to coverage this
procedure never had.

So the hold is a step with its own fail-closed check, not an instruction to be careful. Run it
**before** setting the variable, and do not set the variable if it aborts — a partially disarmed
fleet is the same hazard as an undisarmed one, and the only safe response to a failed disarm is to
leave the reviewer off. The same hold applies to the re-enable instruction in the disable section
below.

**Lock `dev` first, and be clear about why.** The hold is a _snapshot_, and no number of snapshots
closes a race against arrivals: a pull request opened, marked ready, or armed between two runs — or
after the last run but before the retrigger loop reaches it — is outside every hold that has been
taken, and integrates on green required checks because this reviewer publishes none. Only an
authoritative gate closes that window. Enable **Lock branch** on `dev` in branch protection for the
duration of activation, and release it only after the confirmation step below passes. Activation is
a one-time operation; a bounded merge freeze is the honest price of being able to say afterwards
that every eligible head was reviewed.

If you choose not to freeze, say so in the delivery-policy record rather than to yourself. The two
holds still narrow the window substantially, but the claim "every eligible open pull request was
reviewed before delivery resumed" is then not one this procedure can support.

Save this as `hold.sh` — it is run **twice**, and the second run is not optional. See below.

```bash
#!/usr/bin/env bash
# Establishes the delivery hold: no eligible pull request may have auto-merge armed.
#
# Every loop here is a plain `for` over the main shell, not a `while` fed by a pipe. A `while` at
# the end of a pipeline runs in a subshell, and `set -e` does not apply inside a command
# substitution either — so a query that fails for any pull request except the last one lets the
# compound return a later success, and an empty result then reads as "nothing armed". That is the
# same defect this repository already fixed once in the cancellation loop; it does not get to
# reappear in the procedure that guards activation.
set -euo pipefail
LIMIT=200

total=$(gh pr list --base dev --state open --limit "$LIMIT" --json number --jq 'length')
if [ "$total" -ge "$LIMIT" ]; then
  echo "open pull requests reached the query limit ($LIMIT) — raise it; hold NOT established" >&2
  exit 1
fi

if ! eligible=$(gh pr list --base dev --state open --limit "$LIMIT" \
  --json number,isDraft,headRepositoryOwner,headRepository \
  --jq '.[] | select(.isDraft == false)
            | select(.headRepositoryOwner.login == "oscharko-dev" and .headRepository.name == "Keiko")
            | .number'); then
  echo "FAILED to list eligible pull requests — hold NOT established" >&2
  exit 1
fi

# Disarm. Abort on the first failure: continuing past one leaves an armed pull request behind
# while the rest of the procedure reports success.
for n in $eligible; do
  if ! gh pr merge --disable-auto "$n"; then
    echo "FAILED to disable auto-merge on #$n — hold NOT established" >&2
    exit 1
  fi
done

# Verify, rather than trust the loop above. This catches a disable that silently no-ops and a pull
# request armed between the listing and the loop. Each query is checked on its own line.
armed=""
for n in $eligible; do
  if ! state=$(gh pr view "$n" --json autoMergeRequest \
                 --jq 'if .autoMergeRequest == null then "off" else "on" end'); then
    echo "FAILED to read the auto-merge state of #$n — hold NOT established" >&2
    exit 1
  fi
  if [ "$state" = "on" ]; then
    armed="$armed #$n"
  fi
done
if [ -n "$armed" ]; then
  echo "still armed after disarm:$armed — hold NOT established, do NOT enable" >&2
  exit 1
fi
echo "hold established over $(printf '%s\n' "$eligible" | sed '/^$/d' | wc -l | tr -d ' ') pull request(s)"
```

**Now set the switch.** With `dev` locked and the first hold reporting clean, set the repository
variable `KEIKO_QUALITY_ENABLED` to `true`. This is the only place in the procedure where it is set.

**Run `hold.sh` again after setting the variable, before releasing the hold.** A pull request opened or
marked ready between the first run and the variable change was never disarmed _and_ its activity
event fired while the reviewer was still off, so it has neither a review nor a hold — and it can
integrate while the retrigger loop below is still working through the list. The second run disarms
those newcomers; the retrigger loop then covers them like everything else.

**If the second run aborts, roll back — do not continue.** By then the variable is already `true`,
so "do not enable" is no longer available and the failure needs an action rather than a decision.
In order: set `KEIKO_QUALITY_ENABLED` to something other than `true`, cancel every nonterminal
reviewer run using the containment loop in the disable section, run `hold.sh` until it reports a
clean hold, and record the failure as a delivery-policy event. Do **not** retrigger and do **not**
re-arm: retriggering starts credential-bearing runs over a fleet whose armed state is unknown, which
is the one combination this whole procedure exists to prevent. Start again from the top once the
cause is understood.

Re-arm only once each current head has a terminated review under the ADR-0170 D5 interlock.

```bash
# Non-draft, same-repository heads only, and an explicit limit — `gh pr list` returns 30 by default.
# The draft filter is not cosmetic: `gh pr ready` on a draft would PUBLISH someone else's draft.
# Abort on the first failure rather than continuing: a pull request whose `--undo` succeeded and
# whose `ready` failed is left AS A DRAFT, which is exactly the state that makes it ineligible.
#
# The limit is checked rather than trusted. A query returning exactly LIMIT rows is indistinguishable
# from one that was truncated, so the loop would retrigger 200 pull requests, report success, and
# leave the rest unreviewed — this runbook's own failure mode, wearing a green tick.
set -euo pipefail
LIMIT=200
total=$(gh pr list --base dev --state open --limit "$LIMIT" --json number --jq 'length')
if [ "$total" -ge "$LIMIT" ]; then
  echo "open pull requests reached the query limit ($LIMIT) — raise it; coverage NOT established" >&2
  exit 1
fi
gh pr list --base dev --state open --limit "$LIMIT" \
  --json number,isDraft,headRepositoryOwner,headRepository \
  --jq '.[] | select(.isDraft == false)
            | select(.headRepositoryOwner.login == "oscharko-dev" and .headRepository.name == "Keiko")
            | .number' |
while read -r n; do
  gh pr ready "$n" --undo || { echo "FAILED to unset ready on #$n" >&2; exit 1; }
  if ! gh pr ready "$n"; then
    echo "FAILED to restore ready on #$n — it is STILL A DRAFT, fix it before continuing" >&2
    exit 1
  fi
done
```

The toggle briefly marks each pull request as a draft. That is visible to watchers, so do it once,
deliberately, at provisioning time — not as a routine operation.

### 5. Confirm coverage, then release the freeze

This is the condition on which `dev` gets unlocked, so state it exactly. For **every** eligible open
pull request, its **current head** must carry one of two things:

- a completed review — the run reached settlement and published its result; or
- a published incomplete-review conversation, which is itself blocking and therefore visible.

A run against an earlier head does not count. Neither does the absence of findings: a clean review
and a run that never started look identical from the outside, which is the whole reason this step
exists.

**A failed run is not coverage.** "Terminated" is the right word for the arming interlock in
ADR-0170 D5, where the question is whether a review can still publish; it is the wrong word here,
where the question is whether one _did_. A run that dies at `settlement.*` or `publish.*` — or
before either — leaves the head with no reviewer output at all, so treat it exactly as if no run had
happened: keep the freeze, retrigger, and escalate if it fails again.

This is deliberately stricter than steady state. ADR-0170 D6 accepts, as a stated fail-open window,
that a run which never publishes cannot be made fail-closed by review conversations alone. During
activation that window is closable, because the freeze is holding — so close it. If any eligible
pull request lacks a published result, the freeze stays on. Do not release on "it probably ran".

There is deliberately **no script here**, and the reason is worth knowing before you write one.
This paragraph originally warned — as an unverified activation-day assumption with an explicit
confirm-against-a-real-run instruction — that under `pull_request_target` a run's `head_sha` and
`head_branch` would be `dev`'s. That instruction has now been carried out, and the assumption was
wrong: verified against run `30759440660` (2026-08-02, PR #2930), the API reports the PULL
REQUEST'S head branch and head SHA, and the `pull_requests` array names the pull request. So
both associations work: `pull_requests` is the explicit one and remains preferred; `head_branch`
plus `head_repository` is a valid fallback where the API omits the array. What remains true and
load-bearing: confirm any matching snippet's query shape against a real run before committing it
here — two shell snippets in this document have already shipped with a fail-open defect, and
this one gates a branch unlock.

Pin a provider snapshot in `KEIKO_QUALITY_MODEL_ID` where the provider offers one. Behaviour drifts
behind a stable identifier, and the qualification evidence is bound to the identifier that produced
it.

## The review profile

[`.github/keiko-for-quality.json`](../../.github/keiko-for-quality.json) declares which paths are
review-relevant, which deletions are review-critical, which are generated, and every other exclusion
with its justification.

A changed path matching none of the lists is **unclassified**, which fails the run. That is the
intended fail-closed behaviour and the profile deliberately has **no catch-all**: an earlier `**/*`
exclusion made `inventory.unclassified_path` unreachable, so an unknown executable type would have
been silently excluded and the review reported clean. The last entry is an explicit list of tooling
ignore files, not a wildcard. Inclusion is evaluated before exclusion, so a review-relevant entry
always wins.

**The relevant list is keyed by file type, not by directory — deliberately.** An earlier
location-keyed version silently left `native/` (including the endpoint-security system extension and
`secure_workspace_read.c`), `sandbox/scripts/`, and `design-system/` unreviewed, each discovered
only after the previous gap was patched. A type-keyed list cannot be defeated by adding a directory;
only by adding a language, which is rarer and more visible. Entitlement property lists, gate
configuration (`sonar-project.properties`, `osv-scanner.toml`, `.coderabbit.yaml`), and the
`docs/qa/*.json` ratchet baselines are named explicitly because each is a way to weaken a gate.

Verify a profile change the same way: enumerate every tracked file, classify it, and confirm that
none is unclassified and no code-like path is excluded. There is no catch-all to audit against —
that is the point. Sampling recent commits is not enough; it was exactly what missed all three gaps
above.

**A new file type cannot be classified by the pull request that introduces it.** The review reads
the profile from the protected base, so a profile edit in the same head has no effect on that run —
every rerun stays `inventory.unclassified_path` and publishes a blocking incomplete-review notice.
Land a profile-only pull request first, then rebase the change onto it.

**There is no benign-warning allowlist.** `context_truncated` was allowlisted at first, with a
justification admitting the file was reviewed only in part. That permitted a clean verdict over a
partially inspected file — this repository has production sources above 250 KB — which is precisely
the false-clean outcome the reviewer exists to prevent. Any engine warning now settles the run as
incomplete. If truncation becomes common, the fix is engine-side chunking, not an allowlist entry.

Adding a new top-level directory or file type usually means editing this file. If the reviewer
reports an incomplete run with `inventory.unclassified_path`, that is what happened.

## Reading the diagnostics

**The reviewer's own output** is redacted JSON lines and nothing else: a reason code from a closed
vocabulary, the head SHA, counts, digests, and durations. There is no field that can carry source,
prompts, model output, or finding bodies — that is a property of the diagnostic sink's types, not a
convention.

Be precise about the scope. The _job_ log is not entirely the reviewer's: the checkout and
`git fetch` steps that run before it emit ordinary Actions output — setup lines, the fetched ref, and
commit ids. Those are public facts about the pull request, not review material, and `git fetch` runs
quiet so the ref line is all it contributes. But the guarantee is about what the reviewer writes, not
about every line the runner produces, and reading it more broadly would be wrong.

| Reason code family | What to do                                                             |
| ------------------ | ---------------------------------------------------------------------- |
| `eligibility.*`    | The head was not reviewed by policy. No action unless policy is wrong. |
| `inventory.*`      | A changed path had no classification. Extend the review profile.       |
| `engine.*`         | Acquisition or execution failed. Check the pin and the endpoint.       |
| `settlement.*`     | The review did not complete. **Treat the pull request as unreviewed.** |
| `publish.*`        | Findings could not be published. Check the App installation.           |

An incomplete run also publishes one bounded file-level conversation carrying the reason code, so
the incomplete state is visible and blocking without leaking diagnostics.

## Disable path

The reviewer has no required status context, so disabling it never blocks delivery and needs no
branch-protection change.

**Fastest, no merge required — two steps, both required:**

1. Set the `KEIKO_QUALITY_ENABLED` repository variable to anything other than `true`, or delete
   it. That is the value the job condition tests, so no _new_ runner starts. Removing the endpoint
   secret instead would let the job start and then fail — noisy, and slower to take effect.
2. **Cancel every in-progress `keiko-for-quality` run.** Step 1 does not stop a runner that already
   started: it has its inputs and credentials and will keep publishing findings until it finishes or
   hits the 30-minute job timeout. Treating step 1 alone as "nothing new is published" is wrong, and
   during a precision failure that is exactly the window that matters.

   ```bash
   # Fails closed for real. Three things defeat the obvious version of this loop:
   #
   # `set -e` does not apply inside a command substitution, and a `for` compound returns the
   # status of its LAST iteration — so an early failed query followed by a successful one would
   # yield a short list and the loop would exit reporting containment it never achieved. The
   # query's status is therefore checked on its own line.
   #
   # And `--status` filters per invocation, so one query per status is five non-atomic snapshots
   # of a moving target: a run that goes from `requested` to `queued` after the `queued` query but
   # before the `requested` one appears in neither, and the loop declares containment over a run
   # that is still holding the credential. Ask once, filter locally.
   #
   # And the limit is checked, not trusted: a truncated window can hide an older live run behind
   # newer completed ones, and the loop would then report containment it never achieved.
   set -euo pipefail
   LIMIT=200
   while :; do
     if ! seen=$(gh run list --workflow keiko-for-quality.yml --limit "$LIMIT" \
                   --json databaseId --jq 'length'); then
       echo "FAILED to size the run list — containment NOT established" >&2
       exit 1
     fi
     if [ "$seen" -ge "$LIMIT" ]; then
       echo "run list reached the query limit ($LIMIT) — raise it; containment NOT established" >&2
       exit 1
     fi
     if ! ids=$(gh run list --workflow keiko-for-quality.yml --limit "$LIMIT" \
                  --json databaseId,status \
                  --jq '["queued","in_progress","requested","waiting","pending"] as $live
                        | .[] | select(.status as $s | $live | index($s)) | .databaseId'); then
       echo "FAILED to list reviewer runs — containment NOT established" >&2
       exit 1
     fi
     # `sed`, not `grep -v`. `grep -v '^$'` exits 1 when nothing remains, which is the ordinary
     # "no live runs" case, so it needed `|| true` — and that also swallowed a real grep or sort
     # failure, after which an empty `ids` read as containment. `sed` exits 0 either way, so the
     # suppression can go and `pipefail` still catches a genuine failure.
     ids=$(printf '%s\n' "$ids" | sed '/^$/d' | sort -u)
     [ -z "$ids" ] && break
     for id in $ids; do
       if ! gh run cancel "$id"; then
         echo "FAILED to cancel run $id — containment NOT established" >&2
         exit 1
       fi
     done
     sleep 5
   done
   echo "no cancellable reviewer runs remain"
   ```

Reversing it is the provisioning sequence again, not a single variable change, and in the same
order — **including both runs of the hold**: run `hold.sh` and do not set the variable if it aborts,
set `KEIKO_QUALITY_ENABLED` back to `true`, **run `hold.sh` a second time** to catch anything that
opened or became ready while the reviewer was still off, then retrigger the open pull requests, then
re-arm each one only after its current-head review has terminated under the ADR-0170 D5 interlock.
Re-enabling emits no pull-request event either, so an already-armed pull request whose last required
check turns green in that window is integrated unreviewed — the same hazard as the initial
activation, reached by a different door.

**Durable:** removing the files is only half of it. Deleting the workflow removes the only
legitimate consumer of the credentials, not the credentials — and an identity that outlives its
consumer is a standing hazard, because any later protected-base workflow that declares the retained
environment can mint it. Do both halves:

1. Open a pull request removing `.github/workflows/keiko-for-quality.yml`, its zizmor anchor in
   `.github/zizmor.yml`, and the profile. Re-run `npm run check:zizmor-anchors` afterwards, because
   the anchors below the removed entry shift.
2. Deprovision, after that pull request merges:
   - uninstall the Keiko for Quality GitHub App from this repository and revoke its private key —
     while the App is installed and the key is valid, the marker-authoring identity can still be
     minted;
   - delete `KEIKO_QUALITY_APP_ID`, `KEIKO_QUALITY_APP_PRIVATE_KEY`, `KEIKO_QUALITY_MODEL_ENDPOINT`,
     and `KEIKO_QUALITY_MODEL_TOKEN` from the `keiko-for-quality` environment, then delete the
     environment itself;
   - delete the `KEIKO_QUALITY_ENABLED`, `KEIKO_QUALITY_MODEL_ID`, and
     `KEIKO_QUALITY_MODEL_PROTOCOL` variables.

   Order matters: revoke before deleting the environment, or the key stays valid with nothing left
   in the repository pointing at it.

**Do not** disable it by dismissing findings, resolving conversations without repair, or relaxing
Required Conversation Resolution.

## Mass disposition after a precision failure

If a bad model or configuration publishes many wrong findings:

1. Set `KEIKO_QUALITY_ENABLED` to something other than `true` **and cancel every in-progress run**
   (both steps above). Step one alone leaves an already-running review publishing for up to 30 more
   minutes.
2. Do **not** bulk-resolve conversations to clear the board. A resolved conversation is a claim that
   the defect was repaired or technically dispositioned, and a false one is worse than the noise.
3. Triage the published findings. Repair the real ones; on each false one, reply stating why it is
   wrong, then resolve it. That reply is the evidence for the precision record.
4. Record the false-positive rate in the epic's observation evidence — counts and reason codes only,
   never raw review content.
5. Fix the cause upstream in the product repository, release, and advance the pinned SHA here. Do
   not patch reviewer behaviour in this repository; it holds none.

## Known limitations

Stated plainly, per ADR-0170 D6.

1. **No required check.** A missing workflow, a runner that never starts, or a failure before any
   publication cannot be made fail-closed by review conversations alone.
2. **A late review can publish after integration.** The bounded arming interlock reduces this window
   but must not create an unbounded wait, so an expired wait is recorded and delivery proceeds.
3. **Fork heads are not reviewed.** The workflow's job condition refuses them before a runner starts, so the credential is never materialized — the evidence is the skipped job in the Actions run, not a redacted diagnostic. The action re-checks eligibility for every head that does reach it.
4. **Findings are model output** — claims to evaluate, not verdicts to obey.
