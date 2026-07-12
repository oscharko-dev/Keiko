# Hosted feedback intake operator runbook

This runbook is for operators who deploy and maintain the separate hosted feedback intake service.
It covers readiness, storage, identity, publication, recovery, and safe diagnostics. It does not
turn Keiko's loopback UI/BFF into a hosted service. Treat the [privacy contract](privacy-contract.md),
[threat model](threat-model.md), [review-state contract](review-state-contract.md), and
[ADR-0134](../adr/ADR-0134-governed-feedback-intake.md) as normative; this runbook is an operational
checklist, not a replacement for those documents.

## Deployment boundary and readiness

Deploy the intake package as its own process, origin, service account, PostgreSQL database, and
management plane. Put a TLS terminator and an operator-controlled proxy in front of the anonymous
submit and maintainer planes. Never expose the local Keiko UI/BFF or grant the intake process local
repository/filesystem access.

Before enabling traffic, verify:

- the supported Node.js runtime and package build are installed;
- required bounded intake settings, secret directory, proxy policy, and database connection are
  present in the service environment;
- the service account can read only its approved secret files and PostgreSQL schema;
- migrations completed in order and retention scheduling is active;
- anonymous intake readiness is healthy, and maintainer readiness is healthy when OIDC is enabled;
- publication is either explicitly disabled or passes GitHub App permission and installation
  inspection before the listener binds;
- TLS, security headers, host policy, and proxy forwarding policy are enforced at the edge.

Readiness is a release gate. A failed storage, migration, secret-custody, OIDC, or required
configuration check must keep the affected listener unready. GitHub provider or publication-worker
degradation must not silently widen anonymous intake or expose credentials.

For a local package verification pass, run the package's documented build and typecheck scripts from
the repository root:

```bash
npm run build --workspace @oscharko-dev/keiko-feedback-intake
npm run typecheck --workspace @oscharko-dev/keiko-feedback-intake
```

Use deployment-specific smoke checks against a non-production origin such as
`https://feedback.staging.example.test`; do not paste customer payloads into smoke tests.

## PostgreSQL migrations and retention

Use a dedicated PostgreSQL database and least-privilege service role. Apply the ordered migration
set shipped with the package before starting the service; do not hand-edit schema objects or skip a
version. A failed migration must fail startup and leave the service unready.

Retention is a deletion control, not a storage entitlement. Keep the scheduled retention worker
running, monitor that its deletion watermark advances, and investigate skipped-lock or failed-batch
signals. Legal holds preserve only the specifically held records allowed by policy; they do not
permit collecting data the privacy contract forbids. Verify that payload, review, preparation, and
publication records follow their documented terminal deadlines while content-free audit and
idempotency records follow their separate ceilings.

Back up PostgreSQL with encryption and access controls approved for the deployment. Test a restore
into an isolated database before relying on it. After restore, verify migration state, retention
watermarks, review-state integrity, outbox state, and readiness before allowing traffic. Never use a
production dump as a diagnostic fixture.

## Secret-file custody and rotation

Keep OIDC client secrets, session/signing material, abuse-key material, database credentials, and
GitHub App private keys in the approved secret provider or owner-only regular files. Files must not
be symlinks, group/world-readable, empty, or shared with application logs, backups, or user uploads.
Configuration should contain references and non-secret metadata, not secret values.

Rotate each secret through the provider's documented atomic replacement process. Confirm the new
material is readable by the service account, restart or reload only through the supported lifecycle,
and verify readiness and authentication afterward. Destroy retired key material according to the
provider's retention policy. Do not print key contents, tokens, cookies, OIDC claims, or database
URLs while testing rotation.

## Proxy forwarding and abuse controls

Configure the edge proxy to terminate TLS and forward only the documented client-address header.
Declare the exact trusted-proxy network and header family; the service must ignore forwarding claims
from untrusted peers and reject malformed or ambiguous chains. Do not treat forwarded addresses as
identity outside this boundary.

The service derives a rotating keyed abuse identity in request-local memory and stores no raw IP or
forwarding header. Keep the configured per-identity, global, concurrency, body, header, proxy-hop,
and storage limits within the validated contract. Monitor saturation and rejected-request reason
codes without publishing the configured numeric thresholds. Rate handling is abuse resistance, not
authentication, deduplication, or a review actor.

## OIDC and maintainer permissions

Register the hosted origin and exact callback with the approved OIDC provider. Require the configured
issuer, client, algorithm, and redirect policy; keep the client secret in the secret boundary. Verify
that sessions are short-lived, cookies are secure and same-site, and logout invalidates the browser
capability.

Assign permissions server-side. Authentication alone grants no queue access. Separate review,
publication, and private-security permissions; require both review and publication authorization
for publication actions, and require the security permission before private-security items are
visible. Review mutations must use the closed compare-and-swap state/action table in the
[review-state contract](review-state-contract.md). Do not accept actors, roles, repositories,
labels, or approval state from browser fields.

## GitHub App setup and publication readiness

Publication is disabled unless the complete GitHub App boundary is configured. Follow the
[GitHub App configuration contract](github-app-configuration.md) to provide the App identity,
hardened private-key file, rotation metadata, and strict targets policy. Configure a selected-
repositories installation with Issues write and mandatory Metadata read only. Do not grant pull
request, project, contents, administration, or generic API authority.

Before enabling publication, verify the installation and each configured target against GitHub,
confirm the fixed labels and target policy, and run a non-customer readiness check. Publication
worker failures must lower only the publication health facet; they must not lower anonymous intake
readiness or expose provider identifiers in browser responses.

## Backup, restore, shutdown, and recovery

Use this sequence for planned shutdown:

1. Mark the service unready and stop accepting new traffic at the edge.
2. Stop polling and cancel in-flight provider transport within the original shutdown deadline; let
   unfinished publication work remain in its durable outbox state for reconciliation.
3. Drain all HTTP listeners and wait for active retention to finish while publication and request
   pools remain live.
4. Close the publication pools under the original shutdown deadline. Checked-out publication clients
   that exceed that deadline are discarded.
5. Close the request pools used by intake and maintainer listeners.
6. Confirm the process exited and no secret, payload, or customer content was written to shutdown
   output.

For recovery, restore the database and secret references, apply any pending migrations, verify
readiness, and inspect content-free outbox/reconciliation state. A possibly committed provider
operation is reconciliation-only; never retry it by creating a second issue. If a public issue
already exists, use the documented manual-remediation path and record no customer content in
support notes.

## Safe diagnostics

Diagnostics may contain only category, closed failure code, count, elapsed timing, readiness facet,
and correlation identifier where the contract permits one. They must not contain report title/body,
raw drafts, paths, filenames, customer data, IP addresses, forwarding headers, repository strings,
issue markers, tokens, keys, OIDC claims, receipts, or review notes.

When investigating an incident:

1. Capture the affected readiness facet and correlation identifier.
2. Compare migration, retention, OIDC, proxy, secret-custody, and outbox status using the service's
   content-free management views.
3. Reproduce with synthetic data on a staging origin such as `https://feedback.staging.example.test`.
4. Escalate to security review if a stop condition in the threat model is reached.

Do not enable debug logging that serializes request bodies or headers. Do not ask users to resend
private material to reproduce an intake failure.

## Related contracts

- [Privacy contract](privacy-contract.md)
- [Threat model](threat-model.md)
- [Review-state contract](review-state-contract.md)
- [GitHub App configuration](github-app-configuration.md)
- [Security policy](../../SECURITY.md)
