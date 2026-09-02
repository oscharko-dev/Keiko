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
it" — means the workspace was registered under the retired identity rule, and under that rule its
authenticity is unproven: not disproven, but not established either. That proof was built from the
device and inode numbers of the worktree's Git pointer files and directories alone; it lacked the
creation time the current rule binds to each of them and to the worktree root. An inode number is
REUSED: deleting a directory and recreating it at the same path hands the new directory the old
number, so the retired proof cannot separate an authentic worktree from a same-path replacement —
which is why a matching retired proof is never read as "the worktree is intact". Inspect the tree
before re-registering it, or recreate it.

Re-register the workspace through the `reconcile-pointer` repair with operator approval
(`operatorApproved: true` on the repair request) to reissue the proof; it re-materialises the
existing worktree in place and recreates nothing. Keiko does not accept the retired proof even once
without that approval. Accepting a forgeable identity is precisely what would
let an already-replaced worktree be reissued as a trusted one, so the one-time "self-healing upgrade"
that looks convenient here is the one option that must not be taken.

`managed-root-identity-unsupported`, and the `identity-unsupported` drift marker, are this
document's condition reached through a managed worktree.
Every component of that identity — the worktree root, the Git common and admin directories, and the
two pointer files — carries its creation time, so a volume that cannot report one produces no
identity at all and the workspace is refused. The resolution above applies unchanged: the managed
root and the repository it links to may sit on different filesystems, and either one being unable to
answer is enough.

The root directory has to be included, not just the pointer files. A local process that can replace
the worktree does not have to create a new pointer: it can move the original `.git` out, recreate the
directory until the inode is handed back, then move the same file in again. A rename preserves both
the inode and the creation time, so a pointer-only identity still matches. The root directory's
creation time is the one component that cannot be relocated.

## Diagnostic Steps for the managed boundary

Grep the activity log for `decision: "denied"` and read the `reason` discriminator. The denial lines
are body-free by contract: `extra` carries exactly `decision` and `reason`, the line carries the
`errorKind` `WORKSPACE_MANAGED_AUTHORITY_DENIED` and the correlation id — never the workspace path,
the repository path, or the stored identity. The correlation id ties the refusal to the request or
lifecycle operation that triggered it: health reports and governed cleanup pass their own, so the
denial sits in that operation's timeline.

## What this guard is, and is not

It is **not** a security boundary against a local attacker running as the same user. Creation time is
writable on Windows (`SetFileTime`) and on macOS (`setattrlist`, `ATTR_CMN_CRTIME`), and Windows
documents that file identifiers may be reused after deletion. An attacker with local write access can
also read or rewrite anything Keiko itself records, so neither a stat-metadata scheme nor a
Keiko-written nonce closes that case.

What it does close is the accidental and the cheap replacement: on ordinary Linux filesystems a
deleted-and-recreated directory is handed the same inode by default, which required no privileges at
all. Binding creation time removes that, and it is defence in depth rather than proof.
