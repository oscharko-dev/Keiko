# Coding Workbench Task Continues With Context Only, Not Its Session

Operator guidance for a Coding Workbench task whose next run, or whose fork, starts a fresh runtime
instead of resuming the previous run's native session. The entry follows the
[troubleshooting entry template](./_template.md).

---

## A follow-up or fork starts a fresh runtime with the task's history as context

| Field             | Value                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------- |
| Severity          | Low                                                                                    |
| Surface           | Local UI / Coding Workbench                                                            |
| Stable identifier | `coding-runtime.session-continuity`, `KEIKO_CODING_SESSION_RETENTION`, `outcome=fresh` |

**Symptom**

A task's next message, or a fork made with Fork task or Fork from here, runs normally but the agent
does not continue the runtime's own session: it answers from the task's saved conversation (the
bounded Coding History context) rather than from the full earlier session. Nothing is blocked and
no error is shown.

**Root Cause**

A run's runtime session is retained, and resumed or forked by the next run, only when every safety
condition holds (ADR-0137 D10). Otherwise the run starts a fresh runtime session with the history
context, exactly as before native resume existed, and the Activity Log names the closed reason. The
usual reasons are:

- `not-succeeded`: the previous run was stopped, cancelled or failed, or the server was restarted
  while it ran. Only a run that ends `succeeded` through an orderly stop keeps its session.
- `disabled`: `KEIKO_CODING_SESSION_RETENTION` is `off`, or holds a value other than `on` (an
  unknown value fails closed to off).
- `expired`: the retained entry is older than 14 days. `no-retained-state`: there is none, for
  example for a task created before retention existed.
- `workspace-changed`, `version-changed`, `window-shrunk`: the task now points at another workspace,
  the runtime was upgraded, or the selected model has a smaller input window than the one the
  history was built under.
- `grant-present`, `credential-present`, `pending-input`, `revert-staged`, `integrity-failed`,
  `schema-unknown`, `session-mismatch`: the retained database failed its audit and was removed.
- `database-oversized`, `history-oversized`: the session exceeds the retention bounds (128 MiB or
  3,000 messages).
- `not-native-profile`: the run used the mapped tool profile, which retains nothing.

**Diagnostic Steps**

Export and analyze the activity log, then look for the task's `coding-runtime.session-continuity`
line:

```bash
keiko support export   # prints the path of the private report it writes
keiko support analyze <report.json> --clusters
```

An `outcome=fresh`, `skipped` or `refused` line carries the closed `reason`; a `failed` line also
carries the diagnostic frames and cause chain. A `resumed` or `forked` line means the session was
continued natively and this entry does not apply. The line holds counts and digests only, never a
path, a message or a session id.

**Resolution**

No action is needed for `not-succeeded`, `expired`, `workspace-changed`, `version-changed` and
`window-shrunk`: the task continues correctly from its history and the next successful run retains
its session again. For `disabled`, unset `KEIKO_CODING_SESSION_RETENTION` (or set it to `on`) and
restart Keiko. Do not remove the retained entries by hand: the audit that refuses an entry is a
safety boundary that must be preserved, and Keiko removes an entry it has refused or that has
expired.
