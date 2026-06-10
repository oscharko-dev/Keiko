# Troubleshooting Entry Template

Copy this template when adding a new entry to
[docs/troubleshooting/README.md](./README.md). Each new entry must follow
the same headings in the same order so the guide remains scannable.

Use professional English. Do not include API keys, customer data,
internal IP addresses, private endpoints, deployment names, or unredacted
log lines. Replace concrete user data in examples with `<placeholder>`.

---

## Title (one short imperative phrase)

| Field             | Value                                                                          |
| ----------------- | ------------------------------------------------------------------------------ |
| Severity          | Blocker / High / Medium / Low                                                  |
| Surface           | CLI / Local UI / Model gateway / Run engine / Workspace / Evidence / Workflows |
| Stable identifier | The exact error code, JSON `code`, or log message a user can search for.       |

**Symptom**

What the user sees. Quote the exact UI string, CLI output, or JSON
`{ "code": "...", "message": "..." }` body when one is emitted. Include
the surface (UI banner, CLI stdout/stderr, log file path) and the exit
code when relevant. Do not describe the root cause here.

**Root Cause**

Why the symptom occurs. Reference the responsible component, the
relevant invariant, and the limit or rule being enforced. Keep this
section grounded in code or a documented contract — do not speculate.

**Diagnostic Steps**

Commands or log lookups a user can run on their own machine to confirm
the root cause. Prefer commands that work on Linux, macOS, and Windows
PowerShell; otherwise label platform-specific commands. Use fenced code
blocks for shell input.

```bash
# Example command with redacted placeholders.
keiko status
tail -n 200 .keiko/ui.log
```

State which output confirms the root cause and which output indicates a
different entry should be consulted instead.

**Resolution**

The minimal, ordered set of steps that resolves the failure. Prefer
local actions (configuration, restart, environment variable) over
destructive actions. When a resolution would weaken a documented
security boundary (TLS verification, command allowlist, evidence
redaction), state that the boundary must be preserved and link to the
relevant document.

---

## Style rules

- One entry per failure mode. Do not bundle unrelated symptoms.
- Use `code` formatting for error codes, environment variables, file
  paths, and command names.
- Link to existing documentation rather than restating it. Use relative
  links inside the repository.
- Keep examples deterministic. Do not embed timestamps, machine names,
  or one-off identifiers.
- When citing log files, identify them by relative path
  (`.keiko/ui.log`), not by the user's home directory.
- Do not introduce new severity values. Use the four defined in the
  guide.
