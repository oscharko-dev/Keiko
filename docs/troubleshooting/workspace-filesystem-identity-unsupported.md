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
