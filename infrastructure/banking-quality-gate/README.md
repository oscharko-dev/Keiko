# Keiko Banking Quality Gate runtime

This directory contains the deployment template for the independent GitHub App described in
[`../../docs/qa/banking-quality-gate.md`](../../docs/qa/banking-quality-gate.md). The runtime is
deliberately outside GitHub Actions so pull-request code cannot mint the required aggregate check.

## One-time setup

1. Create a private GitHub App from `github-app-manifest.json.example`, replacing the webhook URL
   with the deployed Worker URL.
2. Generate a webhook secret and a private key. Convert GitHub's downloaded key to unencrypted
   PKCS#8 before storing it:

   ```sh
   openssl pkcs8 -topk8 -nocrypt -in github-app-private-key.pem -out github-app-private-key.pkcs8.pem
   ```

3. Install the app only on `oscharko-dev/Keiko`.
4. Create the KV namespace, copy `wrangler.toml.example` to an untracked deployment config, and
   replace the KV identifier.
5. Store `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY_PKCS8`, and `GITHUB_WEBHOOK_SECRET` with
   `wrangler secret put`. They must never be committed or stored in repository Actions secrets.
6. Deploy `scripts/banking-quality-gate-worker.mjs` with Wrangler and set the GitHub App webhook
   URL to the resulting HTTPS endpoint.

`TARGET_REPOSITORY`, `STABILITY_WINDOW_MS`, `SOCKET_RISK_ALLOWLIST_JSON`, and
`SOCKET_RISK_ACTORS_JSON` are non-secret Worker variables. Socket entries are exact
`npm/package@version` identifiers, and only explicitly listed maintainers may issue an acceptance
command. They are valid only while
the matching version and integrity digest in
[`../../docs/qa/supply-chain-risk-acceptances.json`](../../docs/qa/supply-chain-risk-acceptances.json)
still match `package-lock.json`; the required repository test enforces that binding.

## Activation boundary

Do not add `Banking Quality Gate` to `dev` branch protection until the installed app has emitted
that name from its own App ID and every negative probe in the QA policy has blocked a normal and
administrator merge. Do not enable the approval-only bypass for `oscharko` and `Niko4417` before
the positive probe also succeeds.
