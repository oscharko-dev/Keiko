# ADR-0182: Windows owner-private files via handle-bound DACL inspection

## Status

Accepted (2026-11-01, Issue #4068, Parent Epic #3897). Product-owner decisions recorded below.

## Context

Keiko reads operator-controlled inputs through one owner-private reader
(`packages/keiko-server/src/ownerPrivateStateFile.ts`): the MCP server registry (Central Settings
and the Coding Workbench), the native plugin registry and plugin package trees, remote skills,
global OpenCode configuration documents and instruction sources outside the workspace. A file is
trusted only when it is owned by the user Keiko runs as and nobody else may modify it.

On POSIX that is decided from the open descriptor's uid and mode. Windows has neither: Node
reports a synthesized mode (`0o666` for every writable file, `0o444` with the read-only attribute)
and no uid, and `O_NOFOLLOW` does not exist. The reader therefore refused every file on Windows,
except that a file with the read-only attribute passed whatever its ACL said. Inherited ACLs make
this a real boundary, not a formality: on a qualified Windows 11 host, `%TEMP%` and
`%LOCALAPPDATA%` granted Modify to eleven other local accounts, and a non-system drive grants
Authenticated Users Modify by default.

## Decision

### D1 — Windows answers "owner-private" from the file's security descriptor

On Windows the reader asks one fixed PowerShell program (inbox Windows PowerShell 5.1, resolved
through the identity-validated system-directory owner, trusted environment, paths as Base64 lines
on standard input) to open each file with `FILE_FLAG_OPEN_REPARSE_POINT` and report, from that one
handle, the attributes, volume serial number, file index, link count and the self-relative
security descriptor, plus the process token's user and default owner SIDs. The program decides
nothing and emits no exception text.

The decision is one pure TypeScript function, `evaluateWindowsSecurityDescriptor`
(`packages/keiko-security/src/windows-security-descriptor.ts`), tested on every platform:

- the owner is the token user, or SYSTEM/Administrators only when that is the process token's own
  default owner (an elevated process);
- the DACL must be present and non-NULL;
- an applicable allow ACE (inherit-only ACEs are skipped) may grant any write, delete, ownership
  or ACL right only to the token user, SYSTEM or Administrators — Authenticated Users, Users,
  Everyone and every other principal are untrusted writers;
- deny ACEs only restrict and are ignored; any ACE type outside allow/deny (plain, callback,
  object) is refused, as is any malformed descriptor.

This mirrors the portable update coordinator's directory policy
(`native/portable-launcher/keiko-portable-update-coordinator-windows.h`), except that unknown ACE
types are refused rather than skipped and Authenticated Users is never trusted.

### D2 — The facts are bound to the descriptor Keiko reads

The reader keeps its existing flow (lstat, open, fstat on the descriptor). On Windows it requires
the descriptor's `dev`/`ino` (`fstat(fd, { bigint: true })`) to equal the inspected volume serial
and file index, and refuses a reported reparse point or directory. A file replaced after the
inspection is therefore refused (`replaced`), not read. Because the verified object grants write,
delete and `WRITE_DAC` only to trusted principals, the order of inspection and open does not
matter, which permits batching: a plugin package tree is listed first and inspected by one process.

### D3 — Fail closed

An inspection that cannot run (PowerShell missing, blocked by AppLocker or Constrained Language
Mode, timed out, malformed output) proves nothing: every file of that read is refused with the
existing closed reason. Refusals map onto the existing `not-owner-private` / `not-regular-file`
reasons, so contracts and consumer evidence are unchanged; the detailed phase is a body-free
`security.windows-owner-private.refused` event (`windows-owner-private` failure class).

### D4 — Keiko protects the private files it writes

`savePrivateJson` gives the temporary file a protected DACL (token user, SYSTEM and Administrators,
full control, inheritance removed) with the identity-validated `icacls.exe` before the atomic
rename; a same-volume rename keeps the descriptor. `icacls` receives SIDs only (the user SID comes
from `whoami.exe /user`, whose SID column is not localized) and is judged by exit status. A file
that cannot be protected is not written. POSIX keeps `0o600`.

## Consequences

- MCP, native plugins, remote skills, global configuration and external instruction sources become
  usable on Windows, with an enforced boundary instead of a refusal of everything.
- Operator files on a non-system drive or in a directory with a broad inherited ACL are refused
  until the operator restricts them (troubleshooting:
  `owner-private-file-not-owner-private` on Windows).
- Each read set costs one PowerShell process (about 0.2 s warm, 1–2 s cold on the qualified host);
  writes cost two short system-binary processes. Reads are rare (registry and launch-time inputs).
- Enterprise hosts that block PowerShell P/Invoke cannot use these features; the refusal is
  explicit and closed.
- Other owner-trust checks (trusted toolchain executables, Keiko-created state reported as
  `platform-inherited`) are unchanged by this decision and keep their current Windows behaviour.
