# ADR-0170: Keiko for Quality as an external reviewer

## Status

Accepted (owner decision, 2026-08-02). Epic #2881 tracks the adoption.

## Supersedes and amends

This decision supersedes the ADR-0167 Keiko for Quality retirement **for this surface only**.
ADR-0167 remains current for the Qodo retirement, the deterministic OSS gates, Sonar independence,
and the zero-payment boundary. ADR-0168 D2 remains current for CodeRabbit. ADR-0169 remains current
in full; this decision adds nothing to and removes nothing from its ten-check topology.

It amends ADR-0135 with a bounded auto-merge arming interlock.

## Context

Keiko integrates agent-authored changes faster than human review can absorb them, and every earlier
attempt to add a model-backed reviewer failed for the same reason: the reviewer was built as
repository surface.

ADR-0142 and ADR-0143 built a Keiko-for-Quality execution shell inside this repository. ADR-0167
retired it. ADR-0168 D3 then froze the complete `.github/workflows` tree and the reviewer-policy
digests as an interim trust anchor, "until Keiko for Quality replaces this bridge". That freeze
existed to stop a second Actions job from forging the same **required** status context as the
base-owned producer.

The freeze deadlocked. PR #2918 demonstrated it: the policy job pinned its own validator, so the
pull request containing that validator's repair could not pass the job it was repairing. ADR-0169 D4
generalized the lesson:

> A gate must not byte-pin the complete workflow tree or its own changeable implementation and then
> require that pin to approve its repair.

The first draft of epic #2881 nevertheless instructed the implementer to reuse the deleted
`CodSpeed policy` workflow's materialization pattern and to perform "the one-time workflow
trust-anchor bootstrap that ADR-0168 D3 requires". Both premises were void, and following them would
have rebuilt the exact construct ADR-0169 retired.

## Decision

### D1 — Keiko for Quality is an external product, not Keiko surface

Keiko for Quality is developed and released from
[oscharko-dev/Keiko-for-Quality](https://github.com/oscharko-dev/Keiko-for-Quality) under Apache-2.0,
with its own governance, tests, threat model, and release line. Keiko consumes it as a GitHub Action
referenced at a full 40-hex commit SHA.

Reviewer product code does not enter this repository. A reviewer defect is fixed upstream and adopted
here by advancing the pin. This keeps the reviewer's release cadence independent of Keiko's and keeps
Keiko's gate surface free of a subsystem that is not about Keiko.

**What this decision is scoped to.** Every guarantee below is a property of *this adoption* — the
trigger, what is checked out, the granted permissions, the absence of a required status context, the
fork rule, and the environment binding — and not of any particular upstream release number.
Advancing the pin is ordinary maintenance for as long as those properties still hold. A release that
changes any of them may not be adopted until this ADR is amended in the same pull request that
advances the pin. Stating it this way is deliberate: an earlier draft scoped the guarantees to
"version 0.1", and the pin then moved to v0.2.0 while the accepted decision still named a release
that was no longer running.

### D2 — No trust-anchor mechanism is reconstructed

The ADR-0168 D3 freeze is **not** reinstated, in any form. No Keiko gate byte-pins the workflows
tree, the reviewer's implementation, or its own validator.

This is safe because the threat the freeze addressed is out of scope by construction rather than by
mitigation. The freeze existed to prevent a forged **required** status context. This adoption
introduces no required check, so there is no context to forge. What remains is ordinary
`pull_request_target` semantics — GitHub takes the workflow definition from the BASE ref's file,
which for the eligible runs this decision governs (base `dev`, a protected branch) is the protected
one a candidate cannot alter — plus an action reference that is immutable because it is a commit SHA
in a repository the candidate cannot write to. Stated precisely because D3's later analysis proved
the unscoped form wrong: a pull request opened against a contributor-controlled base executes that
base's own workflow copy under the same trigger, which is exactly why the D3 containments
(environment deployment branch policy, context-bound store MAC) never lean on the trigger alone.

The consequence is that a new reviewer workflow takes effect only after it is merged to `dev`. That
is not a bootstrap problem requiring special handling; it is how every workflow in this repository
already behaves.

### D3 — Least privilege, candidate as data

The consumer workflow holds exactly `actions: read`, `contents: read`, and `pull-requests:
write`. It receives no write scope beyond the review conversations themselves: no
contents-write, checks-write, actions-write, administration, branch-protection, commit, push, or
merge authority — and `actions: write` exists nowhere in the workflow.

That absence is the durable answer to a three-round review escalation on the adopting pull
request. The review store first persisted through `actions/cache`, whose service demands
`actions: write`; that scope also satisfies the workflow-dispatch endpoint, and dispatch takes a
caller-chosen ref — so any holder could start a dispatchable workflow from a candidate branch,
whose workflow file the candidate controls, up to and including a `release.yml` variant that
drops its own approval environment. Fencing the scope (separate job, environment approvals)
narrowed but could not close that class. Removing it did: the store now persists as a run
artifact, which needs no write scope to upload, and the previous push's store is located and
downloaded with `actions: read` — a scope that can neither cancel, re-run, nor dispatch.

Artifacts carry their own poisoning model, and the review escalation on the adopting pull
request sharpened it to its final form: digest validation is not authentication. Every input of
the store's public key formula is candidate-visible, so a fabricated store with valid digests
and empty findings could mark files "reviewed clean" — and the metadata predicates (producing
event, workflow path, pull-request association) narrow but cannot decide, because a pull request
opened against a contributor-controlled base receives `pull_request_target` with that base's
candidate-authored workflow copy, which can upload a matching artifact before the pull request
is retargeted to `dev`. Authenticity therefore rests on cryptography: the producing run signs
the store with an HMAC whose key (`KEIKO_QUALITY_STORE_HMAC`) is a keiko-for-quality environment
secret, and the consuming run verifies before use, discarding anything unsigned or mismatched.
The environment's protected-branches-only deployment policy is what makes the signature mean
something: only a run executing a protected ref's own workflow file can hold the key. Beneath
that, the action still re-derives every entry's digests on load — integrity on top of
authenticity, not instead of it.

Two containments hold independently of this workflow's scopes, because other token holders
retain `actions: write` (infra-failure-retry):

1. The `keiko-for-quality` environment carries a protected-branches-only deployment branch
   policy, so a job running a candidate branch's workflow file cannot declare the environment
   and its secrets never materialize there.
2. `release.yml`'s publish job runs behind the `npm-publish` environment, whose required human
   reviewer is a provisioned operating prerequisite (verify with
   `gh api repos/<owner>/<repo>/environments/npm-publish` — the `required_reviewers` rule must
   be present). Because a dispatched candidate-branch `release.yml` variant could omit the
   environment declaration entirely, the npm Trusted Publisher (ADR-0130) must additionally be
   bound to the `npm-publish` environment on npmjs.com — an operator-side setting; until it is
   set, that residual path is a stated fail-open window, not a closed one.

State the approval case precisely rather than in that list. GitHub's create-review API accepts an
`APPROVE` event from any token holding `pull-requests: write`, so the platform does **not** withhold
approval from either the App installation token or `GITHUB_TOKEN`. What withholds it is the pinned
action's behaviour: it creates review comments and never a review event. That is a behavioural
guarantee bound to an immutable commit SHA, not a permission boundary, and the product repository
pins it with a test. Approval is not required for `dev`, so the coupling costs nothing here — but
describing the capability as absent would misstate the trust model.

It checks out the protected base and fetches the candidate head as Git objects only. The candidate
tree is never checked out, symlink-followed, or submodule-initialized, and no candidate script, hook,
action, package manager, or repository command is executed.

Fork-originated heads receive no model review. Model budget and the credential-bearing
execution path are not exposed to arbitrary external heads, and a per-review budget bounds one review,
not an attacker opening many pull requests.

Eligibility is enforced twice, and the two layers report differently:

1. **The workflow's job condition** rejects drafts, fork heads, and wrong-base heads before a runner
   starts. This is the security-relevant layer: a job that never starts never has the environment's
   secrets materialized. Its evidence is the skipped job in the Actions run — GitHub's own record,
   not a redacted diagnostic, because no process runs to emit one.
2. **The action's own eligibility check** covers every head that reaches it and emits a redacted
   skipped-eligibility reason code. It is the authoritative check — it also decides the base-retarget
   `edited` case, which the job condition cannot distinguish — and it is what protects a consumer who
   relaxes the job condition.

The earlier draft of this decision claimed that fork and draft heads record a redacted outcome. They
do not, because the workflow deliberately never starts for them. Starting a secret-bearing job in
order to produce a nicer diagnostic would trade the actual security property for a cosmetic one.

The model credential is scoped to the `keiko-for-quality` environment and passed to the action by
variable **name**, never as an input value — an input appears in the step context that every other
action in the job can read.

The environment limitation stated in D4 applies to **every** secret stored there, the model
credential included: an environment scopes its secrets to jobs that *declare* it, not to one
workflow. A future protected-base job declaring `environment: keiko-for-quality` could reference the
same model token. The boundary is that adding such a job requires a reviewed, merged change to the
protected base — the same boundary that protects every other gate here — not that the platform
prevents it.

### D4 — Dedicated bot posting identity

Findings publish under a Keiko for Quality GitHub App installation token, not the shared Actions
identity.

This is a security property, not presentation. The reviewer suppresses a duplicate finding only when
an existing conversation carries its marker **and** was authored by the reviewer itself. A marker is
a public string in a public comment, so anyone able to comment can reproduce one. Under the shared
`github-actions[bot]` identity, any other workflow in this repository could author a comment carrying
a valid marker and permanently silence a real finding. A dedicated identity is what makes the
authorship check meaningful.

State the limit of that guarantee precisely. A GitHub environment scopes its secrets to jobs that
**declare** it, not to one workflow: another job declaring `environment: keiko-for-quality` could
reference the same App credentials and mint the same installation identity. The protection is
therefore not "no other workflow can assume this identity" in an absolute sense — it is twofold:
no *existing* workflow does, and adding one requires a reviewed, merged change to the protected
base; and the environment's protected-branches-only deployment policy (D3) refuses the
declaration to any run executing a candidate ref's workflow file, which closes the
caller-chosen-ref dispatch path that a reviewed-base-only boundary leaves open. Binding issuance
to this workflow's OIDC identity would make the guarantee absolute and is the correct follow-up;
it is not part of this adoption.

### D5 — Bounded auto-merge arming interlock

ADR-0135 is amended. The delivering agent arms GitHub native auto-merge only after the Keiko for
Quality run for the current head has terminated — published its result or failed — or after a
documented bounded wait has expired **and every run for that head that has not reached a terminal conclusion has been cancelled**.

"Not terminal" is the whole set, not two named statuses. A run can be `queued`, `requested`,
`waiting` on environment protection, or `pending` — none of those has produced a result, and each
can still start and publish after integration. Naming only `queued` and `in_progress` would let an
agent satisfy the wording while leaving a run waiting on the very environment gate that holds the
model credential.

Cancellation before arming is part of the decision, not an operating convenience. Without it the
expiry branch arms while a review is still running, so the reviewer can publish a binding
conversation onto a pull request that auto-merge has already integrated — the widest form of the
late-publication window, reachable on every slow run rather than only on a race. A failed
cancellation is not an expiry: containment was not established, so the agent does not arm.

An expired wait is recorded as a delivery-policy event and is never presented as a clean review.

This is delivery policy, not branch protection. It must not create an unbounded wait: a reviewer
outage may delay integration, never block it indefinitely.

### D6 — The required-check set is unchanged

The ten App-bound checks fixed by ADR-0169 D3 remain exactly as they are. This adoption adds no
required context, replaces nothing, and aggregates nothing. Blocking comes solely from GitHub's
existing Required Conversation Resolution rule acting on the reviewer's published conversations.

Two fail-open windows follow, and are documented rather than minimized:

1. A total absence of the workflow, a runner that never starts, or a failure preventing all
   publication cannot be made fail-closed by review conversations alone.
2. A review that terminates only after the bounded arming wait has expired can publish after
   integration. D5's cancel-before-arm requirement narrows this window to whatever is already in
   flight when the cancellation lands — a run that has begun writing its conversations is not
   stopped mid-write. It does not close the window, and must not be described as closing it.

Both are the promotion path for a later required-check stage. Neither may be described as closed.

### D7 — No benign-warning allowlist, and a type-keyed review profile

The reviewer's profile carries an **empty** benign-warning allowlist. Any engine warning settles the
run as incomplete.

The first draft allowlisted `context_truncated`, with a justification that admitted the file was
reviewed only in part. That would have permitted a clean verdict over a partially inspected file —
this repository holds production sources above 250 KB, so the case is real, not theoretical — which
is the exact false-clean outcome the reviewer exists to prevent. If truncation becomes common the
answer is engine-side chunking, not an allowlist entry.

The review-relevant list is keyed by **file type**, not by directory. A location-keyed list left
`native/` (including the endpoint-security system extension and `secure_workspace_read.c`),
`sandbox/scripts/`, and `design-system/` unreviewed — three separate gaps, each found only after the
previous one was patched. A type-keyed list cannot be defeated by adding a directory. Entitlement
property lists, gate configuration, and the `docs/qa/*.json` ratchet baselines are named explicitly,
because each is a way to weaken a gate rather than to change product behaviour.

The profile has **no catch-all**. An earlier `**/*` exclusion made `inventory.unclassified_path`
unreachable — the fail-closed behaviour this decision relies on — so an unknown executable type would
have been silently excluded and the review reported clean. The final entry is an explicit list of
tooling ignore files.

A profile change is verified by enumerating every tracked file and confirming that none is
unclassified and no code-like path is excluded. Sampling recent commits is not sufficient and is
what missed the earlier gaps.

## Consequences

- Keiko gains model-backed review without adding a subsystem to its own gate surface.
- The reviewer's trust boundary is an immutable commit SHA in a separate repository, not a mutable
  digest pin over Keiko's own tree — so it cannot deadlock on its own repair.
- A reviewer defect is fixed once, upstream, and adopted by advancing one SHA.
- Reviewer availability is not merge-blocking, which is a deliberate, stated limitation of this
  adoption rather than an oversight.
- The workflow uses `pull_request_target`, which `workflow hygiene` flags through zizmor's
  `dangerous-triggers` rule. That acceptance is line-anchored and justified in `.github/zizmor.yml`,
  and `npm run check:zizmor-anchors` must be re-run whenever nearby lines move.
- Promoting the reviewer to a required check, retiring CodeRabbit, or changing branch protection each
  require their own decision and live evidence.

## References

- [Epic #2881](https://github.com/oscharko-dev/Keiko/issues/2881)
- [oscharko-dev/Keiko-for-Quality](https://github.com/oscharko-dev/Keiko-for-Quality)
- [ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md)
- [ADR-0167](ADR-0167-zero-cost-autonomous-quality-gates.md)
- [ADR-0168](ADR-0168-quota-tolerant-review-settlement.md)
- [ADR-0169](ADR-0169-retire-codspeed-and-greptile.md)
- [External quality gates](../qa/external-quality-gates.md)
