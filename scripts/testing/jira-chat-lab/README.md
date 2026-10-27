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

Save the published Jira Software Data Center test license in a private regular file
(mode 0600) outside the repository, then run the normal first-run setup:

```sh
node scripts/testing/jira-chat-lab/setup.mjs "$HOME/.local/share/keiko-jira-4081-new" /absolute/private/test-license
```

This drives Jira's existing forms: private access, the supplied test license,
administrator `keiko-admin` with `secrets/admin-password`, and disabled email. An exclusive
`setup-pending` marker prevents repeating a potentially completed setup after interruption.
Reconcile the normal UI and license endpoint before removing that marker. A completed setup
records a private receipt. Setup does not modify Jira licensing code, clocks or database values.
Never paste secrets into tracked files, commands or evidence. The 2026-10-27 session verified
these same form operations; an end-to-end fresh execution of the consolidated script remains
pending for the next qualification group.

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

The seed also creates restricted, edit-only and assignable identities with private
PATs. Explicit permission schemes separate edit, assignment and transition, and
separate project visibility. It verifies the permission matrix and actual denied
read/assignment/transition calls, then confirms status and assignee stayed unchanged.
The additional fixture groups below supply pagination, hostile content and isolated-project cases. Complete integrated journeys remain pending; the basic seed alone does not satisfy #4082 AC5.

## Qualify required fields and transition screens

```sh
node scripts/testing/jira-chat-lab/qualify-fields.mjs "$HOME/.local/share/keiko-jira-4081-new"
```

Run this after the basic seed, before a qualification group, with no concurrent lab
consumer. It creates a built-in text custom field and uses supported Jira admin UI
controls to require it and associate the transition screen. A legacy issue predating
the requirement has no value: a transition omitting it must fail; sending the field
and transition together must succeed and match independent readback. The script also
checks create refusal, unchanged issue count, and successful required-field data.
Jira supplies a default Resolution automatically, so Resolution alone is not used as
the missing-field proof. No third-party workflow app or modified Jira code is needed.

Fixture preparation temporarily makes the field optional to prepare the legacy issue,
then restores the requirement in a `finally` block. It leaves that issue ready for the
next consumer. License checks bracket the group. Configuration, issue IDs and field
IDs stay in the private fixture manifest; diagnostics contain closed cases/counts.

## Seed content and isolation fixtures

```sh
node scripts/testing/jira-chat-lab/seed-content.mjs "$HOME/.local/share/keiko-jira-4081-new"
```

Run after required-field qualification. This creates 21 pagination issues, a hostile
summary/description/comment fixture and an isolated-project issue. It verifies two
nonoverlapping search pages, exact hostile-content readback, restricted-project read
success, the other identity's read refusal and unchanged comments after a denied write.
Jira 10.3.26 reports this permission refusal as 400. Repeating the seed reuses fixtures.

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
is removed, using the same already-created HTTP port throughout. It emits only closed
outcomes. This probe alone does not qualify mutations, model calls or Chat UX.

```sh
node scripts/testing/jira-chat-lab/preflight.mjs "$HOME/.local/share/keiko-jira-4081-new"
```

Start each live group with this licensed HTTPS/read/write preflight. It performs a
unique description edit (204) and comment (201) through the production vault and HTTP
adapter, then checks independent state, exactly one matching change and a one-comment
count increase. An already-confirmed assignment is not repeated. A private exclusive
pending marker prevents automatic reruns after interruption: reconcile its possible
remote effects by read-only inspection before removing that marker. Never assume a
transport failure means a mutation was not committed. Finish each group with a license
check; an interrupted or expired-license group is not acceptance evidence.

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
