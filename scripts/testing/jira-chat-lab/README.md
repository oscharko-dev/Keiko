# Synthetic Jira HTTPS laboratory

This harness is development/qualification tooling for #4081/#4082. It is not part of
the product's MCP transport. It never opens a public listener or accepts arbitrary
proxy destinations. Use only disposable synthetic Jira data and credentials.

Prerequisites: the repository's supported Node version, OpenSSL, built workspace
packages, and Jira Software Data Center **10.3.26** on loopback HTTP port 18080.
The current local fixture is under `$HOME/.local/share/keiko-jira-dev`; no state,
tokens, passwords, license text or certificate keys belong in this repository.

Start a TLS frontend in a separate terminal:

```sh
npm run build:packages
node scripts/testing/jira-chat-lab/tls-front.mjs \
  "$HOME/.local/share/keiko-jira-dev/tls-4081"
```

The frontend binds `127.0.0.1:18443` and forwards to the fixed loopback backend.
Optional third/fourth command arguments select frontend/backend ports. It creates
a private seven-day laboratory CA and server certificate; it does not modify any
system trust store. Existing complete TLS material is reused; partial material is
rejected. Stop the frontend with Ctrl-C. The generated keys remain in the private
directory for subsequent runs.

Run the real production custody/HTTP adapter/domain verifier:

```sh
node scripts/testing/jira-chat-lab/verify-connection.mjs \
  "$HOME/.local/share/keiko-jira-dev/secrets/api-token" \
  "$HOME/.local/share/keiko-jira-dev/tls-4081"
```

The PAT file must be regular and private. The script uses a temporary encrypted
vault, removes its temporary state afterwards, and emits only case names, closed
outcomes and pass/fail. It checks trusted HTTPS, rejection without CA trust, and
immediate refusal after operator admission is removed. It does not qualify model
calls, Jira mutations, full fixture coverage or Chat UX.

The equivalent operator block is:

```json
{
  "atlassian": {
    "privateTargets": [{ "baseUrl": "https://127.0.0.1:18443", "addressClass": "loopback" }]
  }
}
```

Use the existing gateway `egress.caBundlePath` setting for the generated `ca.pem`.
Do not turn off certificate validation or enable global private-network access.

Before an acceptance session, verify the license, HTTPS, identity, read and write
preflights. A healthy container or successful read does not prove a usable license.
The [official test licenses](https://developer.atlassian.com/platform/marketplace/timebomb-licenses-for-testing-server-apps/)
have bounded lifetimes. Treat an expired session as incomplete and rerun its entire
scenario group under a valid license; never change clocks or licensing code.

Current status (2026-10-26): all three transport probes pass against the existing
Jira 10.3.26 fixture. Its license is expired, and a normal license update did not
renew it. These are exploratory transport results, not completed live acceptance.
Fresh-session provisioning, additional fixture classes and the full live lane
remain outstanding in `docs/qa/jira-chat-pods-4081.md`.

## Fresh isolated sessions

The pinned Compose definition provides independent database/Jira volumes per
session. Initialize a new private directory (its parent must already exist):

```sh
node scripts/testing/jira-chat-lab/session.mjs init "$HOME/.local/share/keiko-jira-4081-new"
node scripts/testing/jira-chat-lab/session.mjs start "$HOME/.local/share/keiko-jira-4081-new"
node scripts/testing/jira-chat-lab/session.mjs status "$HOME/.local/share/keiko-jira-4081-new"
```

Each initialization creates a distinct project name and three private, independently
randomized passwords. The default HTTP port is 18081; an optional final `init`
argument selects another unprivileged port. Complete Jira's normal first-run setup
with the published test license, a `keiko-admin` account using the private
`secrets/admin-password`, and email delivery disabled. Do not reuse an expired
instance as an accepted test session. Automated setup and complete fixture seeding
are the next increment.

`stop` stops this manifest's containers and retains its volumes. The harness does
not delete an existing instance or its data. Use a new directory/project for the
next independent session. No background renewal or clock changes are performed.

Fresh-session checkpoint: the isolated instance provisioned on 2026-10-26 accepted
the official license through its normal setup flow. Its admin API reported
`valid: true`, `expired: false` and 10,553 seconds remaining at the checkpoint.
Full identity/read/write preflight and fixture coverage still need to run there.
