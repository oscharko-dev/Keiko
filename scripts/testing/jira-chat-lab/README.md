# Synthetic Jira HTTPS laboratory

This development/qualification harness supports #4081/#4082. It uses synthetic
data only and is independent of the product’s in-process MCP host. Jira Software
Data Center 10.3.26, PostgreSQL 16 and the TLS frontend have digest-pinned images.
Published ports bind loopback only; the frontend forwards to one fixed Jira service.

Prerequisites: Docker Compose, the repository’s supported Node version, OpenSSL
and built workspace packages. State, passwords, PATs, license material and private
keys stay outside the repository in a private session directory.

## Start an isolated session

The directory’s parent must already exist. Initialization refuses an existing directory.

```sh
node scripts/testing/jira-chat-lab/session.mjs init "$HOME/.local/share/keiko-jira-4081-new"
node scripts/testing/jira-chat-lab/session.mjs start "$HOME/.local/share/keiko-jira-4081-new"
node scripts/testing/jira-chat-lab/session.mjs status "$HOME/.local/share/keiko-jira-4081-new"
```

Every initialization creates an independent Compose project, persistent volumes,
three independent private passwords, and a private seven-day development CA and
server certificate under `secrets/tls`. The frontend container receives only its
server key/certificate as read-only mounts; the CA key remains on the host. System
trust is unchanged. HTTP administration uses port 18081 (an optional final `init`
argument changes it); product-path qualification uses HTTPS port 18443. Stop the
previous session before starting another frontend on that port.

Complete Jira’s normal first-run setup on the local HTTP administration port:
private access mode, the published test license, administrator `keiko-admin` with
the generated `secrets/admin-password`, and email delivery disabled. Setup automation
is still pending; never paste secrets into tracked files, commands or evidence.

The [published test license](https://developer.atlassian.com/platform/marketplace/timebomb-licenses-for-testing-server-apps/)
has a three-hour lifetime. A healthy container or successful read does not establish
write availability. Each qualification group requires license/read/write/HTTPS
preflight and completion within the valid session. An expired group must be repeated
in full. Never change clocks, licensing code or license data. A normal update did
not renew the original expired laboratory; its data remains retained.

`session.mjs stop <directory>` stops only that manifest’s containers and retains
its volumes. This harness does not delete existing laboratories or renew licenses
in the background. Use a new directory/project for an independent session.

## Seed and inspect basic fixtures

```sh
node scripts/testing/jira-chat-lab/seed.mjs "$HOME/.local/share/keiko-jira-4081-new"
```

The seed verifies license validity before and after its work, creates the synthetic
project and non-admin API actor, stores its PAT privately, creates three issues and
reads each back. Repeated runs locate existing identities/issues and reuse the PAT.
A marker prevents repeating PAT creation after a lost response. No failed mutation
is automatically retried. Output contains case names, status codes and counts only.

Restricted identities, independent permission grants, required-field and transition
screen fixtures, pagination, hostile content and second-project isolation remain
pending. This basic seed does not yet satisfy #4082 AC5.

## Verify the actual product HTTPS path

```sh
npm run build:packages
node scripts/testing/jira-chat-lab/verify-connection.mjs \
  "$HOME/.local/share/keiko-jira-4081-new/secrets/api-token" \
  "$HOME/.local/share/keiko-jira-4081-new/secrets/tls"
```

The PAT must be a private regular file. The harness invokes the production custody,
encrypted vault, HTTP adapter and domain verifier, then removes its temporary vault.
It checks trusted HTTPS, rejection without CA trust, and refusal after exact admission
is removed. It emits only closed outcomes. It does not qualify mutations through the
product, model calls, complete fixture coverage or Chat UX.

The equivalent operator-owned configuration is:

```json
{
  "atlassian": {
    "privateTargets": [{ "baseUrl": "https://127.0.0.1:18443", "addressClass": "loopback" }]
  }
}
```

Use the existing gateway `egress.caBundlePath` setting for the generated `ca.pem`.
Never disable certificate validation or enable global private-network access.

Checkpoint (2026-10-26): the fresh licensed instance passed basic PAT/non-admin,
three-create/three-read and repeat-seed checks. All three production HTTPS probes
then passed through the Compose frontend. The remaining acceptance work is recorded
in `docs/qa/jira-chat-pods-4081.md`; no full criterion is closed by this checkpoint.
