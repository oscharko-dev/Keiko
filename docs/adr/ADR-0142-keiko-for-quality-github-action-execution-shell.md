# ADR-0142: Keiko for Quality GitHub Action execution shell

## Status

Accepted as the target execution shell (Issue #2506, Epic #2504, 2026-07-18). The decision is to
**adopt the GitHub Action and retire the Cloudflare Worker**, but the cutover is gated: the Worker
remains the canonical producer until the Action passes the live-probe equivalence gate defined in
[ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md) and
[`../qa/keiko-for-quality.md`](../qa/keiko-for-quality.md). This ADR records the decision and ships
the proof-of-concept; the scope, cron, and liveness children of Epic #2504 complete the migration.

## Amends

This decision narrowly refines the operational runtime note in
[ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md) D5 and the
[`../../infrastructure/keiko-for-quality/README.md`](../../infrastructure/keiko-for-quality/README.md)
claim that the aggregate runtime is "deliberately outside GitHub Actions so pull-request code cannot
mint the required aggregate check." That rationale is correct only for `pull_request`-triggered
workflows, which run pull-request-controlled code. It is **not** a property of GitHub Actions as
such: `check_run`, `check_suite`, `issue_comment`, and `schedule` workflows run the definition from
the repository default branch (`dev`), which pull-request code cannot alter. The fail-closed,
head-SHA-currency, evidence-redaction, and app-id-verification decisions of ADR-0135 are unchanged.

## Context

`Keiko for Quality` (KFQ) is the advisory aggregate that bridges the comment-only Qodo review into a
gateable check and cross-checks it against the direct app-bound required checks, SonarQube Cloud, and
Socket on the exact current head. Its evaluator, `scripts/keiko-for-quality-core.mjs`, is a pure
function: evidence in, `{ passed, failures }` out.

Today the evaluator runs inside a Cloudflare Worker
(`scripts/keiko-for-quality-worker.mjs`) that carries real operational weight the evaluator does not
need:

- a manual `wrangler deploy` on every change (a forgotten redeploy silently runs stale gate logic);
- a per-minute `scheduled` cron as a liveness backstop;
- a D1 database for webhook-delivery replay suppression and tracked-pull persistence;
- a webhook HMAC secret, a GitHub App private key, and a separate hosting account and dashboard.

The Worker was chosen for one property: tamper-resistance. Its rationale — "outside GitHub Actions"
— conflated "a `pull_request` workflow runs pull-controlled code" with "any GitHub Actions workflow
runs pull-controlled code." The second is false. An event-driven Action triggered from the default
branch preserves the same tamper-resistance while deleting all of the operational weight above.

## Decision

### D1 — The pure evaluator is reused unchanged

`scripts/keiko-for-quality-core.mjs` is imported verbatim by the Action shell. No parallel evaluator
is created. The shared GitHub helpers in `scripts/keiko-for-quality-worker.mjs` (evidence shaping,
merge-parent context, check/dashboard rendering, publish, GitHub client, App-token minting) are
reused directly; the only additions to that module are four new exports and four optional identity
parameters whose defaults preserve the Worker's exact behaviour.

### D2 — The Action is a thin execution shell, not a second gate

`scripts/keiko-for-quality-action.mjs` reads the runner event, resolves the affected pull requests,
fetches the exact-head evidence, evaluates through D1's pure core, and publishes the same check and
dashboard comment the Worker publishes. It carries no database: webhook-delivery replay suppression
is unnecessary (GitHub delivers each event to one workflow run, and per-pull `concurrency` serialises
overlapping runs), and tracked-pull persistence is replaced by event triggers plus a bounded
reconciliation (deferred to the cron child).

### D3 — Base-branch triggers are the gate authority; the pull-request path is untrusted

The workflow separates trust into two jobs so pull-request-controlled code can never reach the
privileged publisher (Qodo review of PR #2513):

- The **authoritative `evaluate` job** runs only on the default-branch-defined triggers
  (`check_run`, `issue_comment`, `workflow_dispatch`, and future `schedule`), whose definition
  pull-request code cannot alter. It holds `checks`/`issues`/`pull-requests: write` and the App
  private key, and publishes the aggregate. Its per-pull `concurrency` group resolves to the pull
  number (via `check_run.pull_requests[0].number`, not the per-check id) so concurrent check
  completions for one pull cannot race to PATCH the aggregate into a stale state.
- The **untrusted `preview` job** runs only on `pull_request`, which uses the pull's own copy of the
  workflow and script. It is read-only, holds no secrets, and runs dry-run (`KFQ_DRY_RUN`): it logs
  the verdict for fast feedback and performs no writes. Pull-controlled code therefore cannot
  exfiltrate credentials or publish under any identity. The authoritative verdict is always the next
  base-branch re-evaluation of the exact current head.

### D4 — Producer identity is preserved by default

The shell authenticates as the Keiko for Quality GitHub App (App id `4290143`) when the App
credentials are present, so the produced check keeps the exact App id the branch-protection pin
targets — the migration requires **no** branch-protection change. Absent the App secrets it falls
back to the workflow `GITHUB_TOKEN`, producing the check under the GitHub Actions App id (`15368`);
that path is for a zero-secret proof-of-concept and would require re-pinning protection. The App
private key moves from Cloudflare secret storage to a repository Actions secret — a lateral move, not
new attack surface — and the webhook HMAC secret is deleted outright. Per D3 the App private key is
exposed only on the authoritative `evaluate` job; the untrusted `pull_request` `preview` job never
receives it.

### D5 — Fail-closed and head-SHA currency are unchanged

All evidence is filtered to the pull's freshly fetched head SHA. A hard failure (wrong producer,
unresolved Qodo/Socket finding, unsuccessful direct check) publishes a `failure` conclusion; missing
or in-progress evidence publishes an `in_progress` check with no conclusion, so the required check
stays pending and merge stays blocked. Neither state is ever converted into false success.

### D6 — The proof-of-concept coexists with the live Worker

Until the cutover, the Action publishes under a distinct check name (`Keiko for Quality (Action)`)
and dashboard marker, and evaluates only pull requests carrying the opt-in label `kfq-action-poc`
(or a manual `workflow_dispatch`). It therefore runs side by side with the live Worker on sample
pull requests for equivalence comparison without touching the real gate. The cutover is a
configuration flip: point the Action at the canonical name and marker, remove the label gate, and
retire the Worker.

### D7 — Migration is gated; rollback is trivial

Adopting the Action as the canonical producer is gated on the same six live-probe conditions ADR-0135
sets for making KFQ required (exactly-one app-bound check per head, neutral pending inputs, bounded
settlement without redundant writes, quota independence, a repair path that does not depend on the
gate, and passing negative-plus-positive probes). Rollback is deleting or disabling the workflow: the
Worker remains deployed and canonical throughout the evaluation, so no rollback migration exists.

## Consequences

- **Removed on cutover:** the D1 database, the per-minute cron cost, the webhook HMAC secret, the
  manual `wrangler deploy` step, and the separate hosting account — "merge = deployed," with the
  gate logic versioned in-repo and reviewed like any other change.
- **Improved repair path:** a broken evaluator is fixed by a normal pull request instead of an
  out-of-band redeploy, which strengthens ADR-0135's "no gate depends on itself to be repaired."
- **Retained cost:** one repository Actions secret (the App private key) under App auth. Under the
  `GITHUB_TOKEN` fallback there are no secrets but branch protection must be re-pinned to App id
  `15368`.
- **Residual risk — fork pull requests:** a `pull_request` run from a fork receives a read-only token
  and no secrets, so it cannot publish; the base-branch `check_run`/`issue_comment` triggers still
  evaluate it with full authority. Keiko's governed flow uses same-repository branches, so this is a
  documented edge, not a regression.
- **Empirical equivalence:** the shell reproduced the live Worker's verdict byte-for-byte on real
  open pull requests (see [`../qa/keiko-for-quality-action-evaluation.md`](../qa/keiko-for-quality-action-evaluation.md)).

## Verification

- `scripts/__tests__/keiko-for-quality-action.test.mjs` proves verdict parity, fail-closed pending,
  exact-head currency, the loop-safe event filter, both auth modes, and the opt-in gate against a
  mocked GitHub API.
- The unchanged `scripts/__tests__/keiko-for-quality-core.test.mjs` and
  `scripts/__tests__/keiko-for-quality-worker.test.mjs` continue to pass, proving the reuse
  additions are behaviour-preserving.
- The evaluation record documents the dry-run equivalence check on PRs #2472 and #2470.
