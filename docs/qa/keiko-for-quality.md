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
credentials and mint the same App identity — which would let it pre-post deduplication markers. The
protection is that no such workflow exists and adding one requires a reviewed, merged change to the
protected base, the same boundary that protects every other gate here. Binding issuance to this
workflow's OIDC identity would close the gap absolutely and is tracked as follow-up.

### 3. Set variables and secrets

Repository **variables** — non-sensitive only. Variables are **not** masked in logs, so nothing
that could identify a private endpoint belongs here:

| Name                           | Example   |
| ------------------------------ | --------- |
| `KEIKO_QUALITY_ENABLED`        | `true`    |
| `KEIKO_QUALITY_MODEL_ID`       | `gpt-5.4` |
| `KEIKO_QUALITY_MODEL_PROTOCOL` | `openai`  |

`KEIKO_QUALITY_ENABLED` is a separate switch rather than the endpoint itself because a job condition
cannot read a secret.

Environment **secrets** on `keiko-for-quality`:

| Name                            | Value                                                |
| ------------------------------- | ---------------------------------------------------- |
| `KEIKO_QUALITY_MODEL_ENDPOINT`  | e.g. `https://<resource>.openai.azure.com/openai/v1` |
| `KEIKO_QUALITY_MODEL_TOKEN`     | model provider credential                            |
| `KEIKO_QUALITY_APP_ID`          | the App's numeric id                                 |
| `KEIKO_QUALITY_APP_PRIVATE_KEY` | the App's private key (PEM)                          |

The endpoint is a secret, not a variable: it can be a private provider address, and this repository's
redaction contract states that logs carry no endpoints.

### 4. Retrigger the pull requests that are already open

Setting a variable emits **no** pull-request activity event. Every eligible `dev` pull request that
is already open with an unchanged head therefore still has no reviewer run, and the delivery policy
only waits for runs that actually started. Provisioning is not finished until those heads have been
reviewed:

```bash
# Non-draft, same-repository heads only, and an explicit limit — `gh pr list` returns 30 by default.
# The draft filter is not cosmetic: `gh pr ready` on a draft would PUBLISH someone else's draft.
# Abort on the first failure rather than continuing: a pull request whose `--undo` succeeded and
# whose `ready` failed is left AS A DRAFT, which is exactly the state that makes it ineligible.
set -euo pipefail
gh pr list --base dev --state open --limit 200 \
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

Then confirm every eligible open pull request has a `keiko-for-quality` run on its **current** head
before treating the reviewer as active.

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
   # Fails closed for real. Two Bash behaviours defeat the obvious version of this loop:
   # `set -e` does not apply inside a command substitution, and a `for` compound returns the
   # status of its LAST iteration — so an early failed query followed by a successful one would
   # yield a short list and the loop would exit reporting containment it never achieved.
   # Each query's status is therefore checked on its own line.
   set -euo pipefail
   while :; do
     ids=""
     for st in queued in_progress requested waiting pending; do
       if ! page=$(gh run list --workflow keiko-for-quality.yml --status "$st" \
                     --limit 100 --json databaseId --jq '.[].databaseId'); then
         echo "FAILED to list $st runs — containment NOT established" >&2
         exit 1
       fi
       ids="${ids}${page}"$'\n'
     done
     ids=$(printf '%s' "$ids" | grep -v '^$' | sort -u || true)
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

Reverse it by setting `KEIKO_QUALITY_ENABLED` back to `true`, then retrigger the open pull
requests as in provisioning step 4 — re-enabling emits no pull-request event either.

**Durable:** open a pull request removing `.github/workflows/keiko-for-quality.yml`, its zizmor
anchor in `.github/zizmor.yml`, and the profile. Re-run `npm run check:zizmor-anchors` afterwards,
because the anchors below the removed entry shift.

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
