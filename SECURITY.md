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
