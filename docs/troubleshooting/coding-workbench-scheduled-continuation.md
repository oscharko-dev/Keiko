# Coding Workbench Scheduled Continuation Does Not Run

Operator guidance for a Coding Workbench task whose schedule, created by its model in a native run,
is due but has not continued the task. The entry follows the
[troubleshooting entry template](./_template.md).

---

## A due schedule waits, or was paused after missed wakes

| Field             | Value                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Severity          | Low                                                                                      |
| Surface           | Local UI / Coding Workbench                                                              |
| Stable identifier | `coding-runtime.schedule.wake`, `coding-runtime.schedule.control`, `outcome=auto-paused` |

**Symptom**

The task's Scheduled continuations list in the Coding Workbench shows a schedule whose time has
passed, with a waiting reason, or shows it as paused although nobody paused it. No scheduled
continuation run appears in Coding History.

**Root Cause**

Keiko continues a task only while Keiko runs, and only when the runtime slot is free (ADR-0137,
"Scheduled continuations"). A due schedule waits:

- `run-active`: another run is live, is held for undo, or waits to be recovered. The wake starts
  after that run settles.
- `workspace-inactive`: the task belongs to a workspace other than the active one, or is not this
  operator's task.
- `retrying`: the task woke less than a minute ago, or the previous wake of this schedule was
  missed and the next attempt backs off (one minute, doubling, at most an hour).

A wake whose schedule did not fire within two minutes is a miss. Three misses in a row pause the
schedule, recorded with `initiator=missed-wakes`. The usual causes are a task whose retained
session is gone (expired, refused by the retention audit, or replaced by a run without the
schedule) and a deployment ceiling or mode that refuses the start.

**Diagnostic Steps**

Export and analyze the activity log, then look for the task's `coding-runtime.schedule.wake` lines:

```bash
keiko support export   # prints the path of the private report it writes
keiko support analyze <report.json> --clusters
```

A `waiting` line carries the closed `wait`; a `refused` line the closed `refusal`; a `missed` line
the `missCount`; a `retain-lost` line means the wake run did not leave a retained session within ten
minutes. The wake run's own `coding-runtime.schedule.lease` and `coding-runtime.session-continuity`
lines carry its run id as correlation and say whether the schedule fired and whether the session
was resumed. The lines hold digests and counts only, never a schedule's name or prompt.

**Resolution**

For `run-active` and `retrying`, no action is needed: the wake starts by itself. For
`workspace-inactive`, open the task's workspace. A schedule paused after missed wakes resumes with
Resume in the Workbench once the task runs normally again; a schedule that is no longer wanted is
removed with Delete. Do not edit the retained session store by hand: its audit is a safety boundary,
and Keiko removes an entry it has refused or that has expired.
