# Workspace filesystem identity unsupported

## Symptom

Workspace Trust remains restricted and Editor Local History reports
`filesystem-identity-unsupported` even though the workspace root is readable.

## Root Cause

The filesystem does not expose a durable creation-time (`birthtime`) for the workspace root. Keiko
uses that fact together with the device and inode as a fail-closed object-identity proof. Docker
overlay2 layers and some NFS or SMB mount configurations may not provide it.

## Diagnostic Steps

Check the content-free operator diagnostic for `FILESYSTEM_IDENTITY_UNSUPPORTED`. This reason is
structural and distinct from a transient unreadable root or an identity-drift event. Do not include
workspace paths, stat output, or file contents in diagnostic reports.

## Resolution

Relocate the workspace root to a filesystem that reports a durable creation time, then register and
trust that root again. Keiko deliberately does not fabricate an identity or weaken this protection;
there is no safe configuration bypass for an unsupported filesystem.

## A related refusal at the managed task-workspace boundary

Managed task workspaces prove their identity separately, and one of their refusals is easy to
mistake for an attack when it is really a migration.

`managed-root-identity-schema-retired` on the activity log — or, from the provisioning path, the
drift message "managed worktree identity predates the current identity rule; re-register to reissue
it" — means the workspace is intact but was registered before the identity bound its Git pointer
files. The stored proof was built from the device and inode alone, and an inode number is REUSED:
deleting a directory and recreating it at the same path hands the new directory the old number, so
that older proof could not separate an authentic worktree from a same-path replacement.

Re-register the workspace through the operator-approved pointer repair to reissue the proof. Keiko
does not accept the retired proof even once. Accepting a forgeable identity is precisely what would
let an already-replaced worktree be reissued as a trusted one, so the one-time "self-healing upgrade"
that looks convenient here is the one option that must not be taken.

That boundary does not report this document's unsupported-filesystem condition, because it does not
depend on a creation time being available: it stamps its two pointer files with the creation time
where the platform reports one and falls back to the change time where it does not. The fallback is
stricter, never weaker — both stamps change when a file is recreated, and neither can be set from
userland.

## Diagnostic Steps for the managed boundary

Grep the activity log for `decision: "denied"` and read the `reason` discriminator. The denial lines
are body-free by contract: they carry the reason, the correlation id, and counts — never the
workspace path, the repository path, or the stored identity. A correlation id ties the refusal to the
request that triggered it.
