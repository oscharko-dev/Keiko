# Restore connected-folder file grounding

| Field             | Value                         |
| ----------------- | ----------------------------- |
| Severity          | Medium                        |
| Surface           | Local UI, Workspace, Evidence |
| Stable identifier | `retrieval-miss`              |

**Symptom**

Keiko asks to paste a file that lies inside the connected folder, or says it has not read that file
while answering a diagnostic or follow-up question. The chat's visible folder/file scope may be
narrower than the folder containing the file.

**Root Cause**

Retrieval operates within the selected scope and bounded read/elapsed budgets. Before the
connected-folder retrieval repair, explicit paths could fail to reach the excerpt shortlist,
assistant references could be lost on a short follow-up, and same-basename diversity could move an
addressed file behind a decoy. Low-confidence selection and stale semantic fingerprints could
also leave insufficient evidence. The corrected flow admits safe explicit references, preserves
continuity, ranks path evidence, retains live lexical evidence, and can perform one bounded
follow-up after a structured insufficiency declaration.

Scope escape, sensitive paths, unreadable files, ignored/generated discovery, unsupported formats,
and exhausted budgets remain enforced. A declared path outside the active scope is a scope issue;
it is not proof that a permitted file was read.

**Diagnostic Steps**

Export and inspect the affected request on the local installation:

```bash
keiko support query --correlation-id <request-id> --json
keiko support export --correlation-id <request-id>
keiko support analyze <report.json> --json
```

Read `selection.status/reasons` and `analysis.sufficiency` first. Then inspect optional
`analysis.findings` or timeline `findings` with `kind: retrieval-miss`. Each finding names its
correlation, closed reason, and triggering fields. Match process and scope identities when reading
the source, selection, completion, and answer siblings.

- `explicitPathRejectedCount` and `explicitPathRejectionReasons` distinguish missing, denied,
  outside-scope, ignored/generated, binary, oversized, and unsupported files.
- `declaredUnreadInScopeCount`, `followUpPassCount`, and `followUpOutcome` show whether an actual
  unread declaration received a bounded follow-up and whether it answered.
- `keepOneFallbackApplied` identifies low confidence; `addressedBasenameDedupDemotedCount`
  identifies demotion of an addressed file. General basename diversity alone is healthy.
- `retrievalIntent` with `continuityReferentSource` identifies an overview classification applied
  to a referent follow-up. `semanticProviderDisposition` needs actual miss evidence; unavailable
  semantic embedding alone does not invalidate a successful lexical answer.
- Available `omissionGroups.ranking` and `.eligibility` distinguish ranking/budget loss from file
  eligibility. They require complete per-reason counters; missing historical fields stay unknown.

The log contains counts and identities, not source bodies or raw paths. An old report without the
new counters cannot retroactively confirm these causes. A dependency failure or incomplete report
requires its own diagnostic investigation. Follow the
[controlled support workspace guide](../observability/support-workspace.md) before sharing evidence.

**Resolution**

1. Confirm the chat's scope pill names the intended source and includes the required path. If the
   file is outside a narrowed scope, use Files to add the permitted file to the chat scope.
2. Name the scope-relative file and, when useful, its line in the question. The repaired retrieval
   flow handles safe named paths and prior assistant references automatically.
3. Inspect the explicit rejection reason. Correct a missing path, choose a supported readable
   document, or select an appropriate permitted file through Files. Preserve sensitive-path and
   workspace boundaries.
4. If the follow-up remains insufficient or a budget was refused, narrow the question to the
   relevant permitted file and retry. Do not widen authority or disable redaction to obtain evidence.
5. If the problem persists with complete current evidence, retain the report and the closed finding
   through the organization's approved support process. See
   [Activity Log reconstruction](../observability/README.md#what-a-validated-timeline-shows).
