# Recover a stalled repository-add dialog

| Field             | Value                                                 |
| ----------------- | ----------------------------------------------------- |
| Severity          | High                                                  |
| Surface           | Local UI                                              |
| Stable identifier | `client.git-operation.settled`, `discarded-succeeded` |

**Symptom**

The Add repository dialog remains on “Adding…” after selecting a local repository or cloning one.
No error appears and the Git window keeps its previous repository.

**Root Cause**

The dialog's unmount guard was set by React StrictMode's effect cleanup, without being reset by
the subsequent setup. The visible dialog therefore discarded both successful and failed responses.
Registration could already have succeeded on the server.

**Diagnostic Steps**

Use `keiko support analyze <activity-log-file> --correlation-id <request-id> --json`.
A successful request followed by `repository-register` or `repository-clone` with
`discarded-succeeded`, while the dialog was never dismissed, identifies this defect. Older logs
may also report `lifecycle-start-missing`; the corrected dialog emits the attempt before the request.
A failed HTTP request indicates a separate server failure.

**Resolution**

Apply the dialog lifecycle fix and reopen the dialog. An already registered repository can be
selected from the repository list. Before repeating a clone, check for the completed destination.
The fix resets the guard on effect setup, preserves dismissal protection, surfaces failures with
retry available, and records the attempt and settlement through the existing Activity Log.
