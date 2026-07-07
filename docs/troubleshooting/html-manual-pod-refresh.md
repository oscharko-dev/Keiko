# HTML Manual Knowledge Pod Refresh Runbook

This runbook addresses failures and unexpected behavior when refreshing an indexed HTML
manual Knowledge Pod. Each entry follows the troubleshooting guide format
([Symptom / Root Cause / Diagnostic Steps / Resolution](./README.md)).

## Refresh reports "reached a crawl limit" or "removed pages not detected"

| Field             | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| Severity          | Medium                                                         |
| Surface           | Local Knowledge Pod management, UI diagnostics panel           |
| Stable identifier | `scope-limit-reached` / `not-evaluated-page-limit` reason code |

**Symptom**

A manual Knowledge Pod refresh completes but its diagnostics panel shows "The refresh
reached a crawl limit; some pages were not visited" and/or "The crawl reached its page
limit, so removed pages could not be detected this run." The outcome is reported as
`partial` rather than `unchanged` or `updated`. The `removedPages` count is `0`.

**Root Cause**

When a manual pod is created, an approved scope (origin or root path) and crawl limits
(maximum pages, bytes, depth, and time) are persisted. A refresh re-runs the EXACT
bounded crawl from those persisted limits. The limits are enforced to prevent unbounded
crawling of large documentation sites. If a refresh crawl reaches any limit (page count,
byte budget, depth, or elapsed time), the partial result is **not applied** to the pod.
Instead, the previous usable pod state is preserved unchanged.

When the crawl truncates, removal detection is skipped because a truncated crawl cannot
distinguish "pages that are no longer reachable upstream" from "pages beyond the budget."
Reporting zero removals under a limit-reached crawl would risk under-counting and silently
deleting live pages that were simply not visited due to budget constraints.

**Diagnostic Steps**

1. Open the Local Knowledge section of the UI and locate the manual pod's diagnostics
   panel. Note the `removedPages` count and the reason codes listed.

2. Check the pod's current coverage. The persisted limits are accessible via local
   Knowledge inspection:

   ```bash
   # Find the UI log to confirm the refresh crawl limit(s) that were applied.
   tail -n 50 .keiko/ui.log | grep -i "manual\|crawl\|limit"
   ```

   Look for log lines mentioning page count, byte size, or depth bounds that were hit.

3. Confirm the approved scope boundaries. For a remote (HTTP) manual, the refresh
   crawls only the approved `origin` (e.g. `https://docs.example.com`) and optional
   `pathPrefix` (e.g. `/api/v2`). For a local manual, the refresh crawls only within
   the approved root directory.

**Resolution**

The issue is that the manual's scope is larger than the approved crawl budget. You have
two choices:

- **Narrow the scope:** close the pod, re-index it with a narrower `pathPrefix` (for
  remote manuals) or a smaller root directory (for local manuals), and refresh against
  the tighter bounds. The UI will ask you to approve the new scope before indexing.

- **Raise the governed limit:** the crawl limits are governed and cannot be extended by
  Keiko without a new human approval step. Review the persisted limits in your Local
  Knowledge store (visible in diagnostics) and determine whether increasing the `maxPages`
  or `maxBytes` boundary is acceptable. If your manual has grown beyond the original
  budget, contact your Local Knowledge administrator to approve new limits for that scope.

Once the scope is narrowed or the limit is approved and applied to a new pod creation, a
refresh will re-index the entire approved manual within the new budget.

---

## Refresh outcome "failed" with embedding-incompatible error

| Field             | Value                                                       |
| ----------------- | ----------------------------------------------------------- |
| Severity          | High                                                        |
| Surface           | Local Knowledge Pod management, indexing, embedding gateway |
| Stable identifier | `embedding-incompatible` reason code                        |

**Symptom**

A manual Knowledge Pod refresh attempts to run but fails. The diagnostics report an
outcome of `failed` with a reason code of `embedding-incompatible`. The previous pod
state is unchanged and remains available for search.

**Root Cause**

When a pod is first created, the embedding model identity is recorded alongside the
indexed chunks. When a refresh tries to re-index, Keiko detects that the current
embedding model (configured in Settings) is different from the model that indexed the
original pod. Because embeddings are model-specific, reusing old embeddings with a new
model would produce incorrect similarity scores. The refresh fails rather than silently
corrupting the vector index.

**Diagnostic Steps**

1. Open the Local Knowledge section of the UI and locate the manual pod's diagnostics
   panel. Confirm the outcome is `failed` and the reason code is `embedding-incompatible`.

2. Check the current embedding model in Settings. Navigate to the embedding configuration
   and note which model is selected.

3. Check the UI log to confirm the mismatch:

   ```bash
   tail -n 100 .keiko/ui.log | grep -E "embedding|model.*identity"
   ```

**Resolution**

You have two choices:

- **Revert the embedding model:** if the model change was recent and unintended, reopen
  Settings and restore the original embedding model. Then retry the refresh. The pod will
  re-index all pages using the original model, and embeddings will remain correct.

- **Re-index the pod:** if you intentionally changed the embedding model and want the pod
  to use new embeddings, close the pod and create a new one from the same approved scope.
  The entire manual will be re-indexed with the new embedding model. This is the only way
  to adopt a new model for an existing manual.

---

## Refresh outcome "failed" or "cancelled" with prior pod still intact

| Field             | Value                                                     |
| ----------------- | --------------------------------------------------------- |
| Severity          | Medium                                                    |
| Surface           | Local Knowledge Pod management, indexing                  |
| Stable identifier | `failed` / `cancelled` outcome; prior pod state unchanged |

**Symptom**

A manual Knowledge Pod refresh is initiated but does not complete. The outcome reports
`failed` or `cancelled`. Despite the failed refresh, the previous pod state remains
available for search and diagnostics show that the pod's document count, embedding count,
and other metrics are unchanged.

**Root Cause**

The refresh process is designed to fail closed: if a crawl is cancelled (the user stops the
operation), if an indexing job fails mid-run, or if the refresh reaches one of its other
terminal failure states, the changes are **not applied** to the pod. The previous state is
left fully intact and usable. This is by design — a partial or corrupted refresh should
never silently overwrite a working pod.

Reasons for failure include:

- The user cancelled the refresh from the UI.
- The embedding gateway became unreachable during indexing.
- The local Knowledge Store encountered a transient write error.
- An indexing job timed out or ran out of memory.

**Diagnostic Steps**

1. Check the outcome in the manual pod's diagnostics panel and note the exact reason codes
   (e.g. `crawl-cancelled`, `index-failed`).

2. Inspect the UI log for the specific error that caused the failure:

   ```bash
   tail -n 200 .keiko/ui.log | grep -E "refresh|error|failed|cancelled"
   ```

   Look for a stack trace or error message that indicates the root cause (gateway error,
   timeout, out of memory, etc.).

3. Confirm the pod is still usable by running a search query against it in the UI. The
   search should succeed and return results from the pre-refresh content.

**Resolution**

The pod is safe and requires no manual intervention. The refresh failed before modifying
the pod, so the previous state is unchanged.

- **Transient failures** (gateway timeout, network glitch, memory pressure): wait a few
  minutes for the system to stabilize, then retry the refresh. Transient failures are
  often self-healing.

- **Cancelled refresh:** if you cancelled the refresh intentionally, there is nothing to
  resolve. The pod remains ready for search. Retry the refresh when you are ready.

- **Persistent failure** (e.g. embedding gateway is consistently unreachable): address the
  underlying issue (e.g. restore gateway connectivity, increase memory budget) and retry.
  Until the underlying issue is resolved, the pod will remain in its pre-refresh state.

If the same failure recurs across multiple refresh attempts despite stable system
conditions, capture the redacted error message and the reason code, and open a finding.

---

## Refresh with an empty crawl does not wipe the pod

| Field             | Value                                        |
| ----------------- | -------------------------------------------- |
| Severity          | Low                                          |
| Surface           | Local Knowledge Pod management, web crawling |
| Stable identifier | `crawl-empty` outcome                        |

**Symptom**

A manual Knowledge Pod refresh is attempted, but the crawl finds no pages at the
approved scope. The outcome is reported as `failed` with the `crawl-empty` reason code.
The manual pod's document count remains positive; search still works. No pages are deleted.

**Root Cause**

A refresh crawl can discover that a manual at an approved scope is temporarily
unreachable or has been moved. For example:

- The HTTP origin is returning a 404 or is offline.
- A local file-based manual's root directory is now empty (files were deleted upstream).
- The `pathPrefix` (for remote manuals) no longer exists at the origin.

Because the crawl found zero pages, Keiko cannot distinguish between "the manual is
temporarily unavailable" and "the manual has been moved elsewhere." To prevent accidental
data loss, an empty crawl is never applied: the previous pod state is left unchanged, and
the operator is told to investigate.

**Diagnostic Steps**

1. Check the outcome in the manual pod's diagnostics panel. Confirm the outcome is
   `crawl-empty`.

2. For a remote manual, verify the origin is reachable:

   ```bash
   curl --silent --show-error https://docs.example.com/ | head -n 20
   ```

   Confirm the HTTP status code is 200 and the page is not a 404 or error page.

3. For a local file-based manual, verify the approved root directory still exists and
   contains HTML files:

   ```bash
   ls -la /path/to/manual/root/
   find /path/to/manual/root/ -name "*.html" | head -5
   ```

4. Inspect the UI log for crawl diagnostics:

   ```bash
   tail -n 100 .keiko/ui.log | grep -E "crawl|empty|manual"
   ```

**Resolution**

- **Temporary outage:** if the manual's origin or file system is temporarily offline,
  wait for it to be restored and retry the refresh. The empty crawl will be replaced by
  a full crawl once connectivity is restored.

- **Manual moved or restructured:** if the manual's root path or scope prefix has
  legitimately changed, close the pod and create a new one with the updated scope.
  The UI will guide you to approve the new scope before indexing.

- **Intentional deletion:** if the manual was deliberately removed, close the pod via
  the UI. An empty pod serves no purpose and should not be kept around.

Do not manually delete or edit the underlying Knowledge Store to "force" a refresh with
an empty crawl. The fail-closed behavior is intentional and protective.

---

## Related documentation

- [Local Knowledge troubleshooting](../local-knowledge/) — overview of Local Knowledge
  diagnostics and common issues.
- [HTML Manual Knowledge Pod refresh lifecycle
  ledger](../local-knowledge/html-manual-refresh-lifecycle-ledger.md) — design decisions,
  reused components, and regression coverage for refresh.
- [Local runtime state contract](../local-runtime-state-contract.md) — files and state
  written under `.keiko/`.
