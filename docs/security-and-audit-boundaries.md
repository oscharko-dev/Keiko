# Security Boundaries

Keiko is a local coding assistant. It is designed for reviewable work in regulated engineering environments, not for unattended code changes.

## Enforced Controls

| Area              | Boundary                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| UI                | Binds to `127.0.0.1` and rejects non-loopback hosts.                                                     |
| Credentials       | Loaded from local config, local environment, or the first-run UI flow; never accepted through CLI flags. |
| Browser responses | Never return API tokens or raw provider credentials.                                                     |
| Workspace reads   | Stay inside the selected local project path with deny-list and realpath checks.                          |
| Commands          | Use an allowlist, run without a shell, and write redacted evidence for supported surfaces.               |
| Patches           | Dry-run by default and require explicit local review before application.                                 |
| Evidence          | Redacted before writing and kept in contained local paths.                                               |

## User Responsibilities

- Run Keiko only on repositories you are allowed to inspect.
- Keep tokens, gateway config files, `.env`, and `.keiko/` out of version control.
- Review every proposed diff before applying it.
- Treat evidence as project review material and handle it according to your delivery process.
- Stop immediately if a credential appears in output or evidence.

## Known Limits

- Keiko is not a sandbox and does not provide OS-level isolation.
- Verification can run repository-authored scripts, such as project test commands.
- Evidence files are ordinary local files; they are not encrypted or tamper-evident.
- Keiko does not authenticate multiple users and is not a hosted web service.
- Offline evaluation does not prove model quality for every repository.

## Memory

Keiko's Governed Enterprise Memory Vault stores durable, scoped, governed memory records on the local machine. The vault is a SQLite database under the local keiko data directory (resolved through `KEIKO_MEMORY_DIR`, then a project-local default). No memory record ever leaves the machine without an explicit user action.

- **Scope isolation** — every record is scoped to a concrete coordinate (user, workspace, project, workflow, or global). Two records at different scopes are never visible to one another; cross-scope reads require an explicit retrieval that names every scope.
- **Deletion semantics** — destructive operations are tombstoned: the row is removed from the live memory table and a small append-only tombstone record is written for audit. The tombstone carries the original scope and the forgetter surface; it does not carry the body.
- **Audit event categories** — every vault mutation produces one of eleven audit events: `memory:proposed`, `memory:accepted`, `memory:rejected`, `memory:updated`, `memory:superseded`, `memory:pinned`, `memory:unpinned`, `memory:archived`, `memory:forgotten`, `memory:retrieved`, `memory:workflow-used`. Events are appended to a date-bucketed JSON manifest in the same evidence ledger used by other Keiko surfaces.
- **Redaction guarantee** — every audit event's summary string is redacted at the persist boundary with the same secret-shape redactor used by the live-payload redactor. The audit ledger never carries a raw memory body or payload.
- **Retention levers** — a programmatic retention pass enforces four optional policy fields: maximum record age, maximum records per scope, proposal expiry age, and a forgotten-purge backlog count. Pinned records are never eligible for retention.
- **Diagnostics export** — a body-free support snapshot is available with per-scope counts, status histogram, redacted storage path, and the last N audit events. The snapshot never includes a memory body or payload.

## Practical Rule

Use Keiko as an assistant that prepares reviewable work. Do not use it as an autonomous release, merge, or approval system.
