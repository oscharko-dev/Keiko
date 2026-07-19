# Keiko for Quality runtime (retired — rollback template)

> **Retired on the ADR-0142 cutover (2026-07-19).** The canonical producer is the GitHub Action
> (`.github/workflows/keiko-for-quality-action.yml`); the Worker cron, webhook, and D1 database are
> decommissioned. This directory is retained solely as the documented rollback path:
> `wrangler deploy` from here plus reverting the workflow identity block restores the Worker.

This directory contains the deployment template for the independent GitHub App described in
[`../../docs/qa/keiko-for-quality.md`](../../docs/qa/keiko-for-quality.md). The runtime is
deliberately outside a `pull_request`-triggered GitHub Actions workflow so pull-request code cannot
mint the required aggregate check.

> **Note (Issue #2506):** "outside GitHub Actions" is a property of the `pull_request` trigger, not
> of GitHub Actions as such. A workflow triggered on `check_run` / `issue_comment` runs its
> definition from the default branch (`dev`), which pull-request code cannot alter, and therefore
> preserves this tamper-resistance. Epic #2504 executed exactly that replacement: the ADR-0142
> cutover completed on 2026-07-19, the Action is the canonical producer, and this Worker (with its
> cron, webhook secret, and D1 database) was decommissioned. This directory is retained solely as
> the rollback template — `wrangler deploy` from here plus reverting the Action workflow's
> identity block restores the Worker. See
> [`../../docs/qa/keiko-for-quality-action-evaluation.md`](../../docs/qa/keiko-for-quality-action-evaluation.md)
> and [ADR-0142](../../docs/adr/ADR-0142-keiko-for-quality-github-action-execution-shell.md).

## One-time setup

1. Create a private GitHub App named `Keiko for Quality` from
   `github-app-manifest.json.example`, replacing the webhook URL with the deployed Worker URL. Set
   its avatar to `packages/keiko-ui/public/icon-512.png` so checks and comments use the Keiko logo.
2. Generate a webhook secret and a private key. Convert GitHub's downloaded key to unencrypted
   PKCS#8 before storing it:

   ```sh
   openssl pkcs8 -topk8 -nocrypt -in github-app-private-key.pem -out github-app-private-key.pkcs8.pem
   ```

3. Install the app only on `oscharko-dev/Keiko` and `oscharko-dev/Keiko-Native`.
4. Create the D1 database, apply `schema.sql`, copy `wrangler.toml.example` to an untracked
   deployment config, and replace the D1 identifier.
5. Store `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY_PKCS8`, and `GITHUB_WEBHOOK_SECRET` with
   `wrangler secret put`. For this Worker shell they live in Cloudflare secret storage and are
   never committed. (The canonical Action path is different by design: ADR-0142 D4 stores
   `KFQ_APP_ID`/`KFQ_PRIVATE_KEY_PKCS8` as repository Actions secrets, exposed only to the
   privileged base-branch `evaluate` job.)
6. Deploy `scripts/keiko-for-quality-worker.mjs` with Wrangler and set the GitHub App webhook
   URL to the resulting HTTPS endpoint.
7. Enable Workers Observability with redacted application logs. Verify a fresh webhook delivery,
   one scheduled reconciliation, and one app-authored check before making the check required.

`TARGET_REPOSITORIES_JSON`, `STABILITY_WINDOW_MS`, and `RECONCILE_BACKSTOP_MS` are non-secret
Worker variables. `RECONCILE_BACKSTOP_MS` (default 15 minutes) bounds how often the scheduled sweep
re-evaluates a settled pull request whose exact head is unchanged; it must stay well inside the
one-hour post-merge reconciliation window. Since Issue #2508
([ADR-0143](../../docs/adr/ADR-0143-keiko-for-quality-narrowed-to-the-qodo-bridge.md)) the aggregate
evaluates only the Qodo review bridge; the direct required checks — including both Socket contexts —
are branch-protection authority on the exact head, so the former `SOCKET_RISK_ALLOWLIST_JSON` and
`SOCKET_RISK_ACTORS_JSON` variables no longer exist.

`TARGET_REPOSITORIES_JSON` declares a unique repository, protected base branch, and quality profile
for every target. The two-minute schedule is a liveness backstop, not merely a stability timer. It
discovers every open pull request targeting each declared base branch through the exact GitHub App
installation, so webhook loss or replay rejection cannot strand a new pull request. Keep the
schedule enabled even when webhook delivery is healthy. Each sweep re-evaluates only the pull
requests whose verdict can still move — never evaluated, still waiting on evidence (so the stability
window can converge), a changed head, or a settled verdict older than `RECONCILE_BACKSTOP_MS` — and
skips a settled pull request whose exact head is unchanged, because a webhook (not the cron) carries
its next same-head evidence. Fail-closed currency is preserved: nothing merges without a current
app-bound check, every head move is re-evaluated, and the backstop re-checks each settled pull
request periodically. Unchanged dashboard comments are not rewritten.

D1 is the atomic replay and metadata store. A unique delivery identifier rejects duplicate GitHub
webhooks without relying on eventually consistent reads. The Worker reserves a delivery only after
signature validation and after confirming that the event can trigger a pull-request evaluation;
pings, self-events, wrong repositories, and events without a pull-request target perform no write.
The hourly cleanup removes delivery identifiers after 24 hours; a tracked pull row is upserted on
every evaluation with the head it was evaluated against, whether that verdict was settled, and when,
and is removed when the pull request is closed or no longer targets `dev`. That persisted metadata is
what lets the sweep skip a settled, unchanged pull request without re-fetching its evidence. The
worker self-heals the reconcile-metadata columns: if it is deployed against a `tracked_pulls` table
created before those columns existed, the first access that hits a missing column adds it and retries,
so the new gate logic does not have to be deployed after a manual migration. Do not replace this
binding with Workers KV: the Free-plan KV write ceiling is lower than the webhook volume generated by
concurrent large pull requests.

## Activation boundary

Do not add `Keiko for Quality` to `dev` branch protection until the installed app has emitted that
name from its own App ID and every negative probe in the QA policy has blocked native auto-merge,
including for administrators. Do not enable Qodo auto-approval or add Qodo to branch protection
before the positive probe also succeeds.
