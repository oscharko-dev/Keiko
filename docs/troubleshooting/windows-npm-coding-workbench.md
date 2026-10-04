# Windows npm Coding Workbench availability

Tracks [#3665](https://github.com/oscharko-dev/Keiko/issues/3665) and the earlier report
[#3658](https://github.com/oscharko-dev/Keiko/issues/3658).

## Symptom

The Coding Workbench cannot bind a registered Windows checkout, or shows an unavailable runtime
with installation instructions that apply only to macOS.

## Root cause

These are separate failures:

- Local checkout selection compared Git's `rev-parse --show-toplevel` output directly with the
  canonical filesystem path. Git for Windows prints forward slashes while Node returns backslashes.
  The same directory was rejected as `REPOSITORY_UNREACHABLE` before activation.
- The npm runtime packages support macOS only. Windows also lacks the required implementation of
  gateway network isolation. The Job Object supervisor controls process lifetime, but cannot enforce
  the gateway-only network policy. Adding an npm runtime package alone cannot enable coding runs.

## Diagnostic steps

1. Distinguish workspace binding from runtime availability. A successfully bound workspace does not
   imply that coding runs can start.
2. Inspect the local Activity Log with `keiko support analyze` for the binding request's correlation
   id. `task-workspace.lifecycle` records `activate`, its outcome and any closed failure kind.
   A successful selection records `activated`; no repository path or branch contents are logged.
3. Check the installation method and platform. The macOS `keiko-coding-runtime-darwin-*` packages
   cannot run on Windows. Rebinding, restarting or choosing another model cannot supply the missing
   Windows network isolation implementation.

## Resolution

The checkout fix compares canonical filesystem paths and preserves the checks that reject
noncanonical selected roots, nested directories and invalid Git state. Existing workspace records
need no migration. Restart an installation containing the fix and bind the registered checkout again.

**Windows coding execution remains unavailable.** Completion depends on
[#3423](https://github.com/oscharko-dev/Keiko/issues/3423): the enforcing Windows backend, its
installation/provisioning path, runtime packaging and real Windows security qualification. Do not
disable confinement or claim that a packaged Windows install is a workaround without that proof.

The live Windows finding is tracked in [#3666](https://github.com/oscharko-dev/Keiko/issues/3666).
A local DesignPatterns checkout on `behavioral/state` reached model-ready and workspace-ready
status, but the runtime stayed unavailable and the coding-run button stayed disabled. No coding
task, commit or remote publication executed. A repository stored inside `.keiko` must also be
distinguished from a normal project checkout: that reserved application-state directory is excluded
from project access. Test with a regular checkout without moving or exposing application secrets.

## Release impact

Proposed category: fixes. Proposed release note: "Windows local checkout binding accepts Git's
native path spelling. Coding Workbench setup explains the Windows npm runtime limitation."
This is a binding and diagnostic repair, not a claim of Windows coding-runtime support. No state
migration is required, and published release metadata is unchanged. Keep #3665 open until execution
and the complete required pipeline matrix have been verified.
