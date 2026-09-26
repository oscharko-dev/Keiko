# Coding Workbench Run Starts With Less Authority Than Selected

Operator guidance for a Coding Workbench run that starts with a lower authority than the one selected
in the composer. The entry follows the [troubleshooting entry template](./_template.md).

---

## A run selected as Supervised workspace or Full access still asks for approval

| Field             | Value                                                           |
| ----------------- | --------------------------------------------------------------- |
| Severity          | Medium                                                          |
| Surface           | Local UI / Coding Workbench                                     |
| Stable identifier | `coding-runtime.run.started`, `KEIKO_CODING_DEPLOYMENT_CEILING` |

**Symptom**

The composer's Run authority shows `Supervised workspace` or `Full access`, and the Workbench states
`<selected> is above this installation's authority limit, so runs start with <limit>.` The run then
asks for approval before workspace edits and commands, and the information panel names the lower
authority as the run's mode.

**Root Cause**

Every run is clamped to the installation's deployment ceiling before its Authority Envelope is
minted: the effective mode is the lower of the selected mode and the ceiling. The shipped ceiling is
`governed-assist` (Ask for approval), so a wider selection takes effect only once the installation
raises its ceiling. The composer keeps the selection, so it applies to the next run that starts after
the ceiling allows it. A run that is already live keeps the authority it was minted with.

**Diagnostic Steps**

The activity log records both modes on every run start. Export and analyze it:

```bash
keiko support export --out keiko-support.jsonl
keiko support analyze keiko-support.jsonl --clusters
```

A `coding-runtime.run.started` line whose `requestedMode` is wider than its `effectiveMode` confirms
the clamp. When both modes are equal and the run still asks for approval, the action itself needs a
decision in that mode; see [ADR-0138](../adr/ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md)
for what each mode allows.

**Resolution**

1. Decide which authority this installation may grant. The ceiling is part of the human-control
   invariant: it is the local operator's decision, never a default to widen silently.
2. Stop Keiko, then start it again with the ceiling set, for example:

   ```bash
   KEIKO_CODING_DEPLOYMENT_CEILING=supervised-coding keiko ui
   ```

   Accepted values are `governed-assist`, `supervised-coding` and `autonomous-delivery`; an
   unrecognized value is ignored and the ceiling stays `governed-assist`.

3. Start a new run. The composer no longer shows the limit notice, and `coding-runtime.run.started`
   reports the selected mode as the effective mode.
