# Recover a stalled repository-add dialog

| Field             | Value                                                 |
| ----------------- | ----------------------------------------------------- |
| Severity          | Medium                                                |
| Surface           | Local UI                                              |
| Stable identifier | `client.git-operation.settled`, `discarded-succeeded` |

**Symptom**

The Add repository dialog remains on “Adding…” after selecting a local repository or cloning one.
No error appears and the Git window keeps its previous repository.

**Root Cause**

In development builds, React StrictMode replays effect cleanup/setup. The dialog's unmount guard
was not reset during setup, so the visible dialog discarded successful and failed responses.
Registration could already have succeeded on the server. This specific replay does not occur in
the shipped production static export; no production repository-add stall has been reproduced from
the customer images. A production stall requires its own request/lifecycle evidence.

**Diagnostic Steps**

Use `keiko support analyze <activity-log-file> --correlation-id <request-id> --json`.
Join the server clone/register request to `client.git-operation.attempted` and
`client.git-operation.settled`. A failed HTTP request identifies a server failure. A completed
request without settlement identifies missing client completion evidence. `discarded-succeeded`
proves that the client discarded the result, but does not distinguish a real dismissal from the
development replay defect: dismissal itself is not recorded. Older logs may report
`lifecycle-start-missing`; the corrected dialog emits the attempt before the request.

**Resolution**

For the reproduced development replay, apply the dialog lifecycle fix and reopen the dialog. An already registered repository can be
selected from the repository list. Before repeating a clone, check for the completed destination.
The fix resets the guard on effect setup, preserves dismissal protection, surfaces failures with
retry available, and records the attempt and settlement through the existing Activity Log.

All clone/register lifecycle reports, including discarded settlements, reject missing or malformed correlation ids at ingest; they never
fallback to independently generated ingest ids that cannot join an attempt to its settlement.
