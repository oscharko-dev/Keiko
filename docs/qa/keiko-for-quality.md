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

It publishes **no required status check**. It cannot write code, commit, push, merge, change branch
protection, or approve. The ten App-bound required checks from ADR-0169 D3 are untouched.

## Provisioning

Until the model endpoint variable is set, the job does not run at all. This is deliberate: an
unconfigured reviewer is visibly absent rather than a failing job on every pull request.

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

Repository **variables**:

| Name                           | Example                     |
| ------------------------------ | --------------------------- |
| `KEIKO_QUALITY_MODEL_ENDPOINT` | `https://api.anthropic.com` |
| `KEIKO_QUALITY_MODEL_ID`       | `claude-sonnet-5`           |
| `KEIKO_QUALITY_MODEL_PROTOCOL` | `anthropic`                 |

Environment **secrets** on `keiko-for-quality`:

| Name                            | Value                       |
| ------------------------------- | --------------------------- |
| `KEIKO_QUALITY_MODEL_TOKEN`     | model provider credential   |
| `KEIKO_QUALITY_APP_ID`          | the App's numeric id        |
| `KEIKO_QUALITY_APP_PRIVATE_KEY` | the App's private key (PEM) |

Pin a provider snapshot in `KEIKO_QUALITY_MODEL_ID` where the provider offers one. Behaviour drifts
behind a stable identifier, and the qualification evidence is bound to the identifier that produced
it.

## The review profile

[`.github/keiko-for-quality.json`](../../.github/keiko-for-quality.json) declares which paths are
review-relevant, which deletions are review-critical, which are generated, and every other exclusion
with its justification.

A changed path matching none of the lists is **unclassified**, which fails the run. The profile
therefore ends with a catch-all exclusion so that every path is described. Inclusion is evaluated
before exclusion, so the catch-all never overrides a specific review-relevant entry.

Adding a new top-level directory or file type usually means editing this file. If the reviewer
reports an incomplete run with `inventory.unclassified_path`, that is what happened.

## Reading the diagnostics

Job logs contain only redacted JSON lines: a reason code from a closed vocabulary, the head SHA,
counts, digests, and durations. There is no field that can carry source, prompts, model output, or
finding bodies.

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

**Fastest, no merge required:** delete or rename the `KEIKO_QUALITY_MODEL_ENDPOINT` repository
variable. The job's `if:` condition stops matching and no runner starts. Reverse it by setting the
variable again.

**Durable:** open a pull request removing `.github/workflows/keiko-for-quality.yml`, its zizmor
anchor in `.github/zizmor.yml`, and the profile. Re-run `npm run check:zizmor-anchors` afterwards,
because the anchors below the removed entry shift.

**Do not** disable it by dismissing findings, resolving conversations without repair, or relaxing
Required Conversation Resolution.

## Mass disposition after a precision failure

If a bad model or configuration publishes many wrong findings:

1. Disable via the variable, so nothing new is published while you work.
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
