# Security Policy

## Supported Versions

Keiko is currently a pre-1.0 project. Security fixes are prepared on the
`dev` branch and, when package publishing is in scope, are released for the
latest published `0.x` package line only.

| Version                        | Supported |
| ------------------------------ | --------- |
| Current `dev` branch           | Yes       |
| Latest published `0.x` release | Yes       |
| Earlier `0.x` releases         | No        |

## Reporting a Vulnerability

Report suspected vulnerabilities privately through GitHub Security Advisories:

<https://github.com/oscharko-dev/Keiko/security/advisories/new>

Do not report suspected vulnerabilities in public issues, pull requests, or
discussions before a fix or mitigation is available.

Please include:

- Affected version, commit, or branch.
- Reproduction steps, proof-of-concept details, or a minimal failing case.
- Impact assessment, including whether secrets, repository contents, generated
  patches, evidence manifests, memory records, or local UI access are affected.
- Any known workaround or mitigation.

Expected handling:

- Acknowledgement within 3 business days.
- Initial triage within 7 business days.
- Coordinated remediation on the private advisory before public disclosure.
- Public disclosure after a fix, mitigation, or explicit non-affected decision
  is available.

The current security and audit boundary model is documented in
[`docs/security-and-audit-boundaries.md`](docs/security-and-audit-boundaries.md)
and [ADR-0030](docs/adr/ADR-0030-workspace-security-evidence.md). Those documents
are the source of truth for the loopback-only UI, Model Gateway-only model access,
workspace containment, allowlisted command execution, patch/evidence protections,
and workspace durable-state restrictions.

## Secret-Scanning Triage for Maintainers

This procedure is for maintainers and security reviewers. Run it from an authenticated local
GitHub CLI session; never paste alert payloads, detected values, endpoints, or credentials into
issues, pull requests, logs, evidence, or test snapshots.

Query only the redacted metadata required for the generated-password review:

```bash
set -o pipefail

gh api --method GET \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  --paginate \
  --slurp \
  "repos/oscharko-dev/Keiko/secret-scanning/alerts?state=open&secret_type=password&hide_secret=true&per_page=100" |
jq '{
  open_generic_secret_alert_count: ([.[][]] | length),
  response_contains_secret_field: ([.[][] | has("secret")] | any)
}'
```

The current GitHub REST API behavior is documented in the
[Secret scanning API reference](https://docs.github.com/en/rest/secret-scanning/secret-scanning?apiVersion=2026-03-10).
`hide_secret=true` is mandatory because the API default exposes the matched value. The command emits
only allowlisted counts and booleans, never uses verbose output, and fails through `pipefail` on API,
authorization, pagination, or projection errors; a failed query must never be interpreted as an empty
queue.

Treat every returned alert as potentially real until its provenance is established privately.
Record only the alert identifier, path, status, disposition, reviewer, and remediation date; the
detected value remains hidden. Apply exactly one disposition:

- `revoked`: a real credential or generated key. Revoke or rotate it through the owning system,
  remove tracked generated output, and retain private rotation evidence before resolving the alert.
- `used_in_tests`: an intentionally synthetic, non-functional fixture required by a security test.
  Preserve the regression test and document why the value cannot authenticate anywhere.
- `false_positive`: the matched text is demonstrably not a credential. Record the reproducible
  classifier mismatch without copying the matched value.
- `unresolved`: provenance or revocation is incomplete. Keep the alert open and stop delivery until
  a maintainer has completed private investigation and, for a real credential, rotation.

Next.js build output is ignored repository-wide through `.next/`. The CI repository-hygiene gate
also inspects the Git index and fails if any `.next` directory is tracked, including legacy,
current, or future application paths. The gate reports paths and counts only; it never reads or
prints generated file contents.
