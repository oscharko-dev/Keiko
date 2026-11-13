# ADR-0182: Windows owner-private files via handle-bound DACL inspection

## Status

Proposed (2026-11-01, Issue #4068, Parent Epic #3897). The decisions below were made by the #4068 assignee
under the scope transfer of 2026-10-24 and are pending repository-owner approval.

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

The retained session store (`opencodeSessionRetention.ts`) follows the same rule (#4068, W9). It
protects the staging directory, the database copy, the manifest and a checked-out copy, and reads
each file back through the verdict above. A path that cannot be protected or verified refuses the
retain or checkout: the failure propagates through the existing `coding-runtime.session-continuity`
failure path, the previous entry stays and no staging or copy remains.

A run's own state directory is made owner-private with inheritable entries when the run is prepared,
before anything is written below it (`opencodeRuntimeComposition.ts`, amended 2026-11-06, #4068;
proposed 2026-11-07 by the #4068 assignee under the scope transfer of 2026-10-24, pending repository-owner approval).
Every file the runtime or Keiko later writes there inherits that protection, a fresh run's database
included; before, those files inherited whatever the state directory's parents granted. A resumed
run's checked-out copy, protected owner-only by the store, is then handed back to that directory's
inherited DACL (`icacls /reset`), so it is exactly as private as the run root. Its protected DACL
had kept a confined Windows run's per-tree SID out: ADR-0043 D18 grants that SID modify on the
state directory, inheritably, at launch, and a protected child does not inherit it. Every resumed
run on Windows then ended before its first turn (`runtime-reap-unproven` after an unexpected
exit). A hand-over that fails refuses the prepare.

### D5 — The secret vault's key file and directory are attested, under a confidentiality policy

Amended 2026-11-13 (#4358, epic #4351). On POSIX the secret vault's directory is `0o700` and its key
file `0o600`. On Windows those modes change nothing, and until this amendment the custody of the key
file was only reported as inherited from the platform, so "not readable by another Windows user"
could not be claimed.

When the vault resolves its key from the key file on Windows, it now opens the key file once, has
D1's inspection report the directory and that file, and reads the key from the same descriptor
(`windows-vault-custody.ts`, called from `secret-vault.ts`). Two things differ from D1:

- **Policy.** D1 is an integrity policy: nobody else may change the object, reading it is not
  refused. Secret material needs confidentiality: `evaluateWindowsSecurityDescriptor(…, "none")`
  refuses any allow ACE for a principal other than the token user, SYSTEM and Administrators,
  whatever it grants (`foreign-access`), and reads inherit-only ACEs too, because they decide who
  reaches what is later created below the directory. SYSTEM and Administrators are accepted
  as owner for any process, not only an elevated one: the DACL rule already trusts both with full
  control, and a key file created by one elevated run must not lock the same person out afterwards.
- **Directory.** The inspection opens its handles with `FILE_FLAG_BACKUP_SEMANTICS`, which Windows
  requires to open a directory. The flag grants nothing by itself: it bypasses access checks only
  for a token whose backup privilege is enabled, and no Keiko process enables it. The directory is
  bound to the identity at its path after the inspection; a reparse point is refused.

Outcomes, each one body-free `security.vault.custody` line:

| Outcome      | Meaning                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attested`   | Both objects are private as found.                                                                                                                                   |
| `protected`  | One was not. Keiko gave it D4's protected owner-only DACL (inheritable on the directory) and it then attested.                                                        |
| `refused`    | An object is not private and could not be made private, was replaced, or is not a regular file or directory. The key is not read; the vault fails closed.             |
| `unattested` | The inspection itself could not run (PowerShell blocked or unavailable). Nothing is known and nothing is claimed; the vault keeps working as it did before (`warn`). |

`unattested` deliberately does not fail closed, unlike D3. D3 refuses optional operator inputs;
refusing here would take every stored credential away from a host that worked before this
amendment, only because it blocks PowerShell P/Invoke. Such a host keeps the earlier
platform-inherited custody, visibly, and the claim is made only where the attestation ran. A
repair that cannot be verified afterwards is refused: the object was seen reachable by another
principal.

A Windows credential-store tier (DPAPI or the Credential Manager) is not part of this decision.

### D6 — A fixed program is bounded twice: host start, and its own work

Amended 2026-11-13 (#4358). Every fixed program ran under one limit that covered both the inbox
PowerShell host coming up and the program's work (10 s for the local-volume check, 20 s for this
inspection, 3 s for the launcher's process-identity read, 5 s for the browser opener). The host
start is the larger and the less predictable part: 0.2 to 2 s on the qualified native host, 6.5 to
20 s measured under x64 emulation on Windows on ARM. A limit sized for the work therefore refused a
correct local disk (`Keiko.exe` did not start), left `keiko stop` unable to confirm the process it
was about to end, and reported a failed browser hand-off, whenever the host was slow.

`windows-powershell-program.ts` is the one owner of both bounds:

- The work keeps the caller's limit, unchanged, counted from the program's first statement and
  enforced inside the program by a watchdog that ends the process. A stalled volume or file query
  is cut off exactly as early as before.
- The host start has its own allowance of 60 s, three times the slowest start measured. It only
  bounds a host that never reaches the program.
- A run without the program's start marker never executed the program and is a failed run.

The verdict stays fail closed in every case. The two failures are told apart: the local-volume
refusal carries the phase `host-start` and no longer says the volume is not local, and a slow or
timed-out program is one `security.windows-program.run` line with its duration.

## Consequences

- MCP, native plugins, remote skills, global configuration and external instruction sources become
  usable on Windows, with an enforced boundary instead of a refusal of everything.
- Operator files on a non-system drive or in a directory with a broad inherited ACL are refused
  until the operator restricts them (troubleshooting:
  `owner-private-file-not-owner-private` on Windows).
- Each read set costs one PowerShell process (about 0.2 s warm, 1–2 s cold on the qualified host);
  writes cost two short system-binary processes. Reads are rare (registry and launch-time inputs).
  A retain or checkout runs several of these synchronously: about 3 s on the qualified Windows 11
  host, measured in the test suite. It runs when a run settles or resumes, not per turn. Protecting
  a run's state directory adds the two write processes once per prepared Windows run, and handing a
  resumed run's copy back to it one more.
- Enterprise hosts that block PowerShell P/Invoke cannot use these features; the refusal is
  explicit and closed.
- Other owner-trust checks (trusted toolchain executables, Keiko-created state reported as
  `platform-inherited`) are unchanged by this decision and keep their current Windows behaviour.
- Each vault whose key comes from the key file costs one inspection per process on Windows (D5),
  at the time the key is first used; a repair adds the write processes of D4 once.
- A host with a slow PowerShell start waits longer for a verdict instead of receiving a wrong one
  (D6). The longest a single program can block its caller is the host start allowance plus the
  program's own limit.
