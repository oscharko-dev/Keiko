# Keiko for Quality: GitHub Action vs Cloudflare Worker

Evaluation and trade-off analysis for Issue #2506 (Epic #2504). Records the decision to move the
`Keiko for Quality` (KFQ) execution shell from a Cloudflare Worker to a GitHub Action, the
proof-of-concept that proves equivalence, and the migration and rollback plan. The governing
decision is [ADR-0142](../adr/ADR-0142-keiko-for-quality-github-action-execution-shell.md); the gate
semantics it must not weaken are in [`keiko-for-quality.md`](keiko-for-quality.md) and
[ADR-0135](../adr/ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md).

## What is shared and what changes

The evaluator `scripts/keiko-for-quality-core.mjs` is a pure function and is **reused unchanged** by
both shells. Only the execution shell around it differs:

| Concern               | Cloudflare Worker (`…-worker.mjs`)            | GitHub Action (`…-action.mjs`)                            |
| --------------------- | --------------------------------------------- | --------------------------------------------------------- |
| Evaluator             | `keiko-for-quality-core.mjs` (pure)           | Same file, imported verbatim                              |
| GitHub helpers        | evidence/merge/render/publish/token in worker | Same functions, imported from the worker module           |
| Trigger               | GitHub App webhook + per-minute cron          | `check_run` / `issue_comment` / `pull_request` / dispatch |
| Deployment            | Manual `wrangler deploy` per change           | Merge to `dev` — "merge = deployed"                       |
| Replay suppression    | D1 unique-delivery table                      | Not needed (one event → one run; per-pull `concurrency`)  |
| Pull tracking / sweep | D1 `tracked_pulls` + per-minute cron          | Event triggers (+ a future bounded `schedule`)            |
| Secrets               | App key + webhook HMAC secret                 | App key only (or none, on the `GITHUB_TOKEN` fallback)    |
| Hosting               | Cloudflare account, Worker, D1, dashboard     | None beyond the repository                                |
| Check producer        | KFQ App id `4290143`                          | `4290143` (App auth) or `15368` (`GITHUB_TOKEN` fallback) |

## Tamper-resistance comparison

The Worker's stated rationale is that its runtime is "deliberately outside GitHub Actions so
pull-request code cannot mint the required aggregate check." That is true for a `pull_request`
workflow — which checks out and runs pull-controlled code — but it is **not** a property of GitHub
Actions in general. Which branch's workflow definition runs depends on the event:

| Trigger             | Workflow definition runs from     | Pull can alter it? | Token / secrets                               |
| ------------------- | --------------------------------- | ------------------ | --------------------------------------------- |
| `check_run`         | Repository default branch (`dev`) | No                 | Full, repository secrets available            |
| `issue_comment`     | Repository default branch (`dev`) | No                 | Full, repository secrets available            |
| `schedule` (future) | Repository default branch (`dev`) | No                 | Full, repository secrets available            |
| `pull_request`      | The pull request's own head/merge | Yes (same-repo)    | `preview` job: read-only, no secrets, dry-run |

The workflow encodes this as two jobs with different trust levels so pull-request-controlled code can
never reach the privileged publisher (Qodo review of PR #2513):

- The **authoritative `evaluate` job** runs only on the default-branch-defined triggers (`check_run`,
  `issue_comment`, `workflow_dispatch`), holds `checks`/`issues`/`pull-requests: write` and the App
  private key, and publishes the aggregate. This is the same tamper-resistance the Worker provides.
- The **untrusted `preview` job** runs only on `pull_request` (the pull's own copy of the workflow):
  it is read-only, holds no secrets, and runs dry-run — it logs the verdict for fast feedback and
  performs no writes. Pull-controlled code therefore cannot exfiltrate credentials or publish under
  any identity. The authoritative verdict is always the next base-branch re-evaluation of the exact
  current head.

The `evaluate` job's per-pull `concurrency` group resolves to the pull number (via
`check_run.pull_requests[0].number`, not the per-check id) so concurrent check completions for one
pull cannot race to PATCH the aggregate into a stale state. It also reacts to a `check_run`
completion only when the completed check is one the aggregate reads, which both scopes work and
structurally prevents a self-trigger loop (its own job status check and posted aggregate check are
not aggregated names).

## Producer identity

`Keiko for Quality` is app-id-verified. Two options preserve or change that identity:

- **App auth (recommended).** The Action authenticates as the Keiko for Quality App (id `4290143`)
  using `KFQ_APP_ID` + `KFQ_PRIVATE_KEY_PKCS8`. The produced check keeps the exact id any
  branch-protection pin targets, so the migration needs **no** protection change and anti-spoofing is
  unchanged (only the App can post as `4290143`). The App private key moves from a Cloudflare secret
  to a repository Actions secret — a lateral move — and the webhook HMAC secret is deleted.
- **`GITHUB_TOKEN` fallback (zero-secret PoC).** Absent the App secrets, the check is produced under
  the GitHub Actions App id (`15368`). This is the simplest demonstration but would require re-pinning
  branch protection to `15368` before the Action could be the required producer. The proof-of-concept
  defaults to this path so it runs with no configured secrets.

## Fail-closed and head-SHA currency

Both preserved, because the pure core and the exact-head evidence fetch are identical to the Worker:

- Evidence is filtered to the pull's freshly fetched `head.sha`; stale-head results are never reused.
- A hard failure publishes a `failure` conclusion; missing or in-progress evidence publishes an
  `in_progress` check with no conclusion, keeping the required check pending and the merge blocked.
- A merge-commit head whose Qodo review is pinned to a feature parent is resolved through the shared
  `mergeContextForHead` helper, exactly as in the Worker, and only accepts a parent-bound review that
  post-dates the merge commit.

## Empirical equivalence (Acceptance Criterion 1)

The shell was run in dry-run mode (real evidence, no writes) against real open `dev` pull requests
using a repository read token, and the verdict was compared to the live Worker's dashboard comment on
the same head. The verdicts matched exactly:

| Pull request | Head           | Live Worker verdict                              | Action dry-run verdict                                   |
| ------------ | -------------- | ------------------------------------------------ | -------------------------------------------------------- |
| #2472        | `6f6ee51d7140` | Blocked — ci ✗, ui ✗, Qodo 4 findings (3)        | failing, 3 failures — ci ✗, ui ✗, Qodo 4                 |
| #2470        | `8b218236e677` | Waiting — Qodo missing, stability incomplete (2) | failing, 2 failures — Qodo missing, stability incomplete |

Reproduce locally (read-only, no side effects):

```sh
export GITHUB_TOKEN="$(gh auth token)"
export GITHUB_REPOSITORY="oscharko-dev/Keiko"
export KFQ_DRY_RUN=1 STABILITY_WINDOW_MS=60000
export SOCKET_RISK_ALLOWLIST_JSON='[]' SOCKET_RISK_ACTORS_JSON='[]'
export TARGET_REPOSITORIES_JSON='[{"repository":"oscharko-dev/Keiko","baseBranch":"dev","profile":"keiko"}]'
KFQ_PR=<pull-number> node scripts/keiko-for-quality-action.mjs
```

## Decision

**Adopt the GitHub Action and retire the Cloudflare Worker**, with App auth so the producer id and
branch-protection pin are unchanged. The Action is strictly simpler (no D1, no cron, no manual
redeploy, no webhook secret, versioned in-repo) while preserving every gate property. The cutover is
gated on the live-probe conditions below; the Worker stays canonical until they pass.

## Migration plan

1. **Land the PoC (this change).** The Action coexists under `Keiko for Quality (Action)` + the
   `kfq-action-poc` label. The Worker is untouched and canonical.
2. **Add App secrets.** Store `KFQ_APP_ID` and `KFQ_PRIVATE_KEY_PKCS8` (the existing PKCS#8 key) as
   repository Actions secrets so the Action produces the check under App id `4290143`.
3. **Run the live-probe gate** from [`keiko-for-quality.md`](keiko-for-quality.md): exactly one
   app-bound check per head; missing/running inputs stay pending while terminal failures stay red;
   bounded settlement without repeated unchanged writes; quota independence; a repair path that does
   not depend on the gate; and the full negative-plus-positive probe set (stale head, wrong producer,
   failed direct check, Socket warning, Sonar failure all block, then a clean pass).
4. **Cut over.** Point the Action at the canonical name and marker (`KFQ_CHECK_NAME` /
   `KFQ_DASHBOARD_MARKER`) and remove the label gate. Confirm the Action's check is the one branch
   protection observes.
5. **Retire the Worker** (separate change, tracked by the Epic #2504 cron/scope/liveness children):
   uninstall the scheduled cron, remove the D1 database and its secrets, and archive
   `infrastructure/keiko-for-quality/` deployment templates. Delete the webhook HMAC secret.

## Rollback plan

Rollback is trivial and needs no data migration, because the Worker is never removed during
evaluation:

- **Before cutover:** delete or disable `.github/workflows/keiko-for-quality-action.yml`. The
  coexisting PoC vanishes; the Worker was always the real gate.
- **After cutover, if the Action regresses:** redeploy the retained Worker (`wrangler deploy` from
  `infrastructure/keiko-for-quality/`), re-pin protection to the Worker's check if it was changed, and
  disable the Action workflow. Because both shells drive the identical pure core against the identical
  exact-head evidence, either producer yields the same verdict.
