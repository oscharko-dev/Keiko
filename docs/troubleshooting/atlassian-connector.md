# Atlassian Connector Troubleshooting Runbook

This runbook addresses failures when verifying a connector, syncing Confluence or Jira into a
connector pod, running a live Jira read, or performing a governed write action. Each entry follows
the troubleshooting guide format
([Symptom / Root Cause / Diagnostic Steps / Resolution](./README.md)).

Setup and normal operation are documented in the
[Atlassian connector setup and operations guide](../local-knowledge/atlassian-connector-guide.md);
the authority, credential, egress, evidence, and permissions decisions are fixed by
[ADR-0128](../adr/ADR-0128-atlassian-connector-authority-and-security-design.md). Autonomy-mode names
follow [ADR-0127](../adr/ADR-0127-product-wide-authority-and-autonomy-model.md): **Ask for
approval**, **Approve for me**, and **Full access**.

All examples use synthetic hosts, keys, and identifiers (`example.atlassian.net`, `EXAMPLE-1`,
`service-account@example.com`) and redacted placeholders (`<redacted-api-token>`,
`<correlation-id>`). Never paste a real token, tenant name, private endpoint, or unredacted log line
into a finding.

## Reason-code index

Every status and degradation reason the connector can surface maps to one entry below.

| Reason code / status                                                  | Entry                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------ |
| `auth-failed` (verify, sync, write)                                   | [1](#1-auth-failed)                                          |
| `forbidden` (verify), `permission-denied` (sync, write)               | [2](#2-forbidden-and-permission-denied)                      |
| `unreachable` (verify), `unavailable` (sync, write)                   | [3](#3-unreachable-and-unavailable-proxy-and-ca-failures)    |
| `timeout` (verify, sync, write, live read)                            | [4](#4-timeout)                                              |
| `rate-limited` (sync, write)                                          | [5](#5-rate-limited-http-429)                                |
| `scope-exceeded` (sync)                                               | [6](#6-scope-exceeded)                                       |
| `bounds-exceeded` (sync, write, live read)                            | [7](#7-bounds-exceeded)                                      |
| `cancelled` (sync)                                                    | [8](#8-cancelled-and-partial-runs)                           |
| `malformed-payload` (sync, write)                                     | [9](#9-malformed-payload)                                    |
| `conflict` (write)                                                    | [10](#10-conflict-confluence-version-conflict)               |
| `invalid-transition` (write)                                          | [11](#11-invalid-transition)                                 |
| `not-found` (write)                                                   | [12](#12-not-found)                                          |
| `field-validation` (write)                                            | [13](#13-field-validation)                                   |
| `connector-access-denied`, `connector-write-denied` (disposition)     | [14](#14-connector-access-denied-and-connector-write-denied) |
| `authority-invalid`, `authority-expired`, `authority-budget-exceeded` | [15](#15-authority-envelope-failures)                        |

---

## 1. `auth-failed`

| Field             | Value                                                       |
| ----------------- | ----------------------------------------------------------- |
| Severity          | High                                                        |
| Surface           | Local UI, Atlassian connector (verify, sync, write actions) |
| Stable identifier | `auth-failed` verify status / sync / write failure reason   |

**Symptom**

Verify reports `auth-failed`, or a sync run or write action ends with the `auth-failed` reason. The
identity call was rejected before any content was read or written.

**Root Cause**

The API token could not authenticate. Common causes: the token was revoked or has expired, the token
was pasted with a leading/trailing character, or the account email does not match the account the
token belongs to. Cloud connectors authenticate with `email` + API token; both must belong to the
same identity.

**Diagnostic Steps**

1. Confirm the token still exists at the official token page:
   <https://id.atlassian.com/manage-profile/security/api-tokens>. A token deleted or expired there
   will always fail `auth-failed`.

2. Confirm the email/token pair by making one manual identity call (this is exactly what Verify
   does), replacing the placeholders with your own values:

   ```bash
   # Uses your own credentials; do not commit or log the output.
   curl --silent -o /dev/null -w "%{http_code}\n" \
     -u "service-account@example.com:<redacted-api-token>" \
     https://example.atlassian.net/rest/api/3/myself
   ```

   `401` confirms `auth-failed`. `403` indicates a permission problem instead — see entry 2.

3. Check the connector's redacted activity for the failed attempt's `<correlation-id>`; the audit
   record carries the reason code and correlation id, never the token.

**Resolution**

1. Create a fresh API token from the token page and re-register (or rotate) the connector's
   credential. Rotation writes the new token to the same `authRef`; no descriptor change is needed.
2. Re-run Verify. A `ok` status confirms the fix.
3. Do not disable authentication or weaken the credential vault to work around this — the failure is
   the boundary working correctly.

---

## 2. `forbidden` and `permission-denied`

| Field             | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| Severity          | Medium                                                         |
| Surface           | Local UI, Atlassian connector (verify, sync, write actions)    |
| Stable identifier | `forbidden` verify status / `permission-denied` failure reason |

**Symptom**

Verify reports `forbidden`; or a sync run reports `permission-denied` (and its change summary shows
a nonzero **Denied** count for items the token could not read); or a write action ends with
`permission-denied`. The credential authenticated, but the identity lacks permission for the
operation.

**Root Cause**

The token identity is valid but does not have the Confluence space permission or Jira project/issue
permission required for the call. During sync, items visible in scope but unreadable by the identity
are counted as **Denied** rather than failing the whole run. Keiko applies no permission model of its
own; it can only do what the token can already do (ADR-0128 D8).

**Diagnostic Steps**

1. Identify the operation. For sync, note whether the run outcome is `partial` with a nonzero Denied
   count (some items unreadable) versus fully `permission-denied` (the scope itself is unreadable).

2. Confirm the identity's access directly in Atlassian: open the space or project in a browser as
   the token's account and check that the content is visible.

3. Confirm the connector base URL and scope target the site the identity actually has access to.

**Resolution**

1. Grant the token identity the missing Confluence/Jira permission, or switch the connector to a
   token from an account that already has it. For regulated deployments, prefer a dedicated
   service account scoped to exactly the spaces/projects to be exposed.
2. Re-sync. Items that become readable move out of the Denied count on the next run.
3. Do not attempt to bypass provider permissions locally; the connector cannot and must not read
   what the token cannot.

---

## 3. `unreachable` and `unavailable` (proxy and CA failures)

| Field             | Value                                                      |
| ----------------- | ---------------------------------------------------------- |
| Severity          | High                                                       |
| Surface           | Local UI, Atlassian connector; outbound egress transport   |
| Stable identifier | `unreachable` verify status / `unavailable` failure reason |

**Symptom**

Verify reports `unreachable`, or a sync/write action reports `unavailable`. In enterprise networks
this frequently presents as a TLS certificate error in the underlying diagnostic (for example
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`) even though the same host resolves and loads in a browser.

**Root Cause**

The connector's outbound call could not complete at the network or TLS layer. The connector reuses
Keiko's shared, proxy- and custom-CA-aware egress transport (ADR-0038); it does **not** have its own
proxy or CA settings. Common causes in enterprise networks:

- An HTTPS proxy is required for outbound traffic but is not configured for Keiko.
- A TLS-inspecting proxy presents a corporate root CA that Node does not trust by default, so the
  handshake fails even though a browser (which trusts the OS store) succeeds.
- DNS resolution or the host itself is unavailable, or a redirect to a different host was returned
  (redirects fail closed and are never followed).

**Diagnostic Steps**

1. Confirm basic reachability from the same machine, honoring the proxy your organization uses:

   ```bash
   curl --silent -o /dev/null -w "%{http_code}\n" https://example.atlassian.net/status
   ```

   A TLS error here (not an HTTP status) points to a CA-trust problem; a hang or connection refused
   points to a proxy or DNS problem.

2. Check whether a proxy is expected. Keiko honors `KEIKO_HTTPS_PROXY`, then `HTTPS_PROXY`, then
   `https_proxy`, with `NO_PROXY` exclusions. Confirm the value your shell and Keiko see:

   ```bash
   printenv KEIKO_HTTPS_PROXY HTTPS_PROXY https_proxy NO_PROXY
   ```

3. If a corporate root CA is in use, confirm whether Node trusts it. `curl` may succeed (it uses the
   OS store) while Node fails, which is the classic split symptom.

**Resolution**

1. **Configure the proxy** if outbound traffic must traverse one. Set `KEIKO_HTTPS_PROXY` (or the
   standard `HTTPS_PROXY`) to the proxy URL. The proxy URL must not embed credentials (ADR-0038).
2. **Add the corporate CA** so Node trusts the inspecting proxy's certificate. Point
   `NODE_EXTRA_CA_CERTS` at the PEM bundle for your organization's root CA before starting Keiko:

   ```bash
   export NODE_EXTRA_CA_CERTS=/path/to/corporate-root-ca.pem
   ```

   This is the supported way to make Node's TLS accept an enterprise CA; do **not** disable TLS
   verification (for example via `NODE_TLS_REJECT_UNAUTHORIZED=0`) — that removes the trust boundary
   the transport exists to hold. See the
   [security and audit boundaries](../security-and-audit-boundaries.md) note.

3. Restart Keiko so the transport picks up the proxy and CA configuration, then re-run Verify.
4. If a redirect caused the failure, confirm the base URL is the canonical site host; the connector
   refuses cross-host and non-HTTPS redirects by design.

---

## 4. `timeout`

| Field             | Value                                                     |
| ----------------- | --------------------------------------------------------- |
| Severity          | Medium                                                    |
| Surface           | Local UI, Atlassian connector (verify, sync, write, live) |
| Stable identifier | `timeout` verify status / failure reason                  |

**Symptom**

Verify, a sync fetch, a write action, or a live read reports `timeout`. The call started but did not
complete within its bounded window.

**Root Cause**

The connector enforces bounded per-request timeouts (ADR-0128 D3): 30 seconds for interactive
read/write calls, 60 seconds per paginated sync fetch, and 15 seconds for a live JQL read. A timeout
means the upstream or the network did not respond in time — typically upstream latency, a slow or
saturated proxy, or a very large page of results.

**Diagnostic Steps**

1. Retry the operation. A single transient timeout that does not recur needs no further action.
2. Measure round-trip latency to the site through the same path Keiko uses (including any proxy):

   ```bash
   curl --silent -o /dev/null -w "connect=%{time_connect}s total=%{time_total}s\n" \
     https://example.atlassian.net/status
   ```

3. For a repeated sync timeout, narrow the scope (fewer spaces/projects, or a tighter JQL) so each
   paginated fetch returns less data per request.

**Resolution**

1. Address the underlying latency: check proxy health (entry 3) and upstream status.
2. Reduce per-request load by narrowing sync scope or JQL; the run's own bounds (items, bytes,
   duration) are governed defaults and are not user-raisable.
3. If a live read repeatedly times out, reduce `maxResults` or tighten the JQL filter.

---

## 5. `rate-limited` (HTTP 429)

| Field             | Value                                       |
| ----------------- | ------------------------------------------- |
| Severity          | Low                                         |
| Surface           | Local UI, Atlassian connector (sync, write) |
| Stable identifier | `rate-limited` failure reason               |

**Symptom**

A sync run or write action reports `rate-limited`. Atlassian returned HTTP 429 (Too Many Requests)
more times than the connector's bounded retry budget could absorb.

**Root Cause**

The connector already retries 429 and 5xx responses with bounded exponential backoff (500 ms
initial, factor 2, capped at 8 seconds per attempt, maximum 5 attempts), honoring a `Retry-After`
header when present (itself capped at 8 seconds so a hostile or misconfigured upstream cannot stall a
run past its budget). A `rate-limited` outcome means the retries were exhausted — the site is
throttling this identity harder than the bounded backoff can wait out, often because another
integration shares the same token, or a large sync coincides with other automation.

**Diagnostic Steps**

1. Confirm the outcome reason is `rate-limited` in the connector's redacted activity for the run's
   `<correlation-id>`.
2. Check whether other automation shares the same Atlassian identity; a shared token multiplies the
   request rate counted against it.

**Resolution**

1. Wait and re-run. The throttle is upstream and time-based; the connector will re-run the same
   bounded fetch cleanly once the limit clears.
2. Reduce concurrent pressure: run the sync when other integrations are idle, or narrow the scope so
   fewer requests are issued per run.
3. Use a dedicated token for the connector so its request budget is not shared with other tools.

---

## 6. `scope-exceeded`

| Field             | Value                                |
| ----------------- | ------------------------------------ |
| Severity          | Medium                               |
| Surface           | Local UI, Atlassian connector (sync) |
| Stable identifier | `scope-exceeded` failure reason      |

**Symptom**

A sync run reports `scope-exceeded`. The run stopped rather than fetching content it determined was
outside the connector's approved scope.

**Root Cause**

A connector's requests may only target its single allowlisted host, and a run may only fetch within
the approved spaces/projects (and optional JQL). Pagination can never widen egress beyond the
allowlisted base URL. When the run would have to reach beyond that boundary — for example a
paginated link pointing off-host, or content outside the approved scope — it fails closed with
`scope-exceeded` instead of following it (ADR-0128 D3, D5).

**Diagnostic Steps**

1. Confirm the connector base URL is the canonical site host and contains no path, query, or
   fragment.
2. Confirm the approved scope (space keys, project keys, JQL) matches content that genuinely lives
   on that host.
3. Check the run's redacted diagnostics for the `scope-exceeded` reason and its `<correlation-id>`.

**Resolution**

1. Re-declare the sync scope to stay within the connector's site and approved spaces/projects.
2. If content legitimately lives on a different Atlassian site, register a **separate** connector
   for that site's base URL; a single connector intentionally cannot span hosts.
3. Do not attempt to widen the allowlist; single-host egress is a fail-closed security boundary.

---

## 7. `bounds-exceeded`

| Field             | Value                                                  |
| ----------------- | ------------------------------------------------------ |
| Severity          | Medium                                                 |
| Surface           | Local UI, Atlassian connector (sync, write, live read) |
| Stable identifier | `bounds-exceeded` failure reason                       |

**Symptom**

A sync run reports `bounds-exceeded` (or its change summary shows individual items **Failed** with
`bounds-exceeded`), or a write action is rejected with `bounds-exceeded` before any external call.

**Root Cause**

Every run is bounded by governed defaults (ADR-0128 D5): 2 000 items, 50 MB total content, 15
minutes wall-clock, and a per-item body cap. When a run reaches a budget it stops (or skips the
oversized item and continues, for a single mid-fetch truncation), reporting `bounds-exceeded`. A
write action whose request body exceeds the request-size cap is rejected as `bounds-exceeded`
locally, without issuing the call. These bounds are narrowable by scope but not user-raisable.

**Diagnostic Steps**

1. Distinguish the case: a whole-run `bounds-exceeded` (the scope is larger than a single run's
   budget) versus per-item `bounds-exceeded` skips (individual oversized pages/issues) versus a
   write `bounds-exceeded` (an oversized request body).
2. For a run-level bound, estimate the scope size — number of pages/issues and their total size —
   against the 2 000-item / 50 MB / 15-minute budget.

**Resolution**

1. **Narrow the sync scope** so one run fits the budget: fewer spaces/projects per run, or a tighter
   JQL filter. Multiple narrower connectors or narrower runs cover a large space collectively.
2. For a **per-item** skip, the oversized page or issue is expected to be rare; if a specific item
   must be indexed, reduce its upstream size where possible.
3. For a **write** `bounds-exceeded`, reduce the payload (shorter body/comment) below the request
   cap.
4. The governed bounds cannot be raised by Keiko without a new governed change; do not attempt to
   edit them locally.

---

## 8. `cancelled` and partial runs

| Field             | Value                                       |
| ----------------- | ------------------------------------------- |
| Severity          | Low                                         |
| Surface           | Local UI, Atlassian connector (sync)        |
| Stable identifier | `cancelled` sync job state / failure reason |

**Symptom**

A sync run reports `cancelled` after you cancel it (or it is aborted). The pod appears unchanged; the
change summary shows zero added, changed, and removed.

**Root Cause**

Cancellation aborts the in-flight requests before the next page boundary. A run applies its
fingerprint replacement and Local Knowledge index update **once, atomically, at the end of a
completed run** — so a cancelled run commits nothing. The pod keeps its prior successful state
fully intact and queryable; its readiness neither advances nor downgrades (ADR-0128 D5).

**Diagnostic Steps**

1. Confirm the job state is `cancelled` and the change summary reports zero added/changed/removed.
2. Confirm the pod still returns results by running a query against it; the prior indexed content is
   unchanged.

**Resolution**

1. No repair is needed — a cancelled run is safe by construction. Re-run the sync when ready.
2. If the run was cancelled because it was slow, narrow the scope first (see entries 4 and 7) so the
   next run completes within budget.

---

## 9. `malformed-payload`

| Field             | Value                                       |
| ----------------- | ------------------------------------------- |
| Severity          | Medium                                      |
| Surface           | Local UI, Atlassian connector (sync, write) |
| Stable identifier | `malformed-payload` failure reason          |

**Symptom**

A sync item is reported **Failed** with `malformed-payload`, or a write action reports
`malformed-payload`. The upstream response, or a response segment, could not be parsed into the
expected shape.

**Root Cause**

The connector normalizes provider responses into a fixed document/metadata shape. A response that is
not valid JSON, is truncated mid-structure, or does not match the expected schema is rejected as
`malformed-payload` rather than being indexed or acted on with partial data. This fails closed to
avoid persisting corrupt content.

**Diagnostic Steps**

1. Confirm the reason is `malformed-payload` (not `bounds-exceeded`, which is a size/truncation
   condition) in the run's redacted diagnostics.
2. Check whether an intermediary (a proxy or gateway) might be altering or truncating responses.
3. Note whether the failure is isolated to specific items or affects the whole run.

**Resolution**

1. Re-run the sync; a transient truncation from a proxy or upstream hiccup usually clears.
2. If a specific item persistently fails, capture its redacted reason code and `<correlation-id>`
   and open a finding — a consistently unparseable response may indicate an upstream API change.
3. Rule out a response-rewriting proxy in the egress path (entry 3).

---

## 10. `conflict` (Confluence version conflict)

| Field             | Value                                       |
| ----------------- | ------------------------------------------- |
| Severity          | Medium                                      |
| Surface           | Local UI, Atlassian connector (write: page) |
| Stable identifier | `conflict` write failure reason             |

**Symptom**

An `update-page` write action reports `conflict`. The page was not updated.

**Root Cause**

Confluence updates are protected by an optimistic version check. The connector submits the update
against the page version it read; if the page changed in Confluence between the read and the write,
the version no longer matches and Confluence rejects the update. The connector surfaces this as
`conflict` rather than overwriting the newer version.

**Diagnostic Steps**

1. Confirm the target page id (for example, `123456`) and open it in Confluence to check whether it
   was edited recently by someone else or another integration.
2. Confirm the write reason is `conflict` in the connector's redacted activity.

**Resolution**

1. Re-read the page and re-issue the update so it applies against the current version.
2. If concurrent edits are frequent on that page, coordinate timing or narrow what the write
   changes.
3. The conflict check is protective; do not attempt a force-overwrite path — none is exposed, by
   design.

---

## 11. `invalid-transition`

| Field             | Value                                             |
| ----------------- | ------------------------------------------------- |
| Severity          | Medium                                            |
| Surface           | Local UI, Atlassian connector (write: transition) |
| Stable identifier | `invalid-transition` write failure reason         |

**Symptom**

A `transition-issue` write action reports `invalid-transition`. The issue's status was not changed.

**Root Cause**

A Jira transition is only valid from certain source statuses, as defined by the project's workflow.
Requesting a transition that is not available from the issue's current status — because the issue has
already moved, or the workflow does not permit that step from here — is rejected as
`invalid-transition`.

**Diagnostic Steps**

1. Confirm the issue's current status in Jira (for example, `EXAMPLE-1`).
2. Confirm which transitions the workflow allows from that status; the requested transition must be
   one of them.
3. Confirm the write reason is `invalid-transition` in the connector's redacted activity.

**Resolution**

1. Choose a transition that is valid from the issue's current status, or first move the issue to a
   status from which the desired transition is available.
2. If the issue already reached the target status, no action is needed.
3. If the project workflow itself needs to change, that is a Jira administration task, not a
   connector change.

---

## 12. `not-found`

| Field             | Value                                 |
| ----------------- | ------------------------------------- |
| Severity          | Medium                                |
| Surface           | Local UI, Atlassian connector (write) |
| Stable identifier | `not-found` write failure reason      |

**Symptom**

A write action targeting a specific issue or page reports `not-found`. The action was not applied.

**Root Cause**

The target issue key or page id does not exist (or is not visible to the token identity) at the time
of the write. The issue/page may have been deleted, moved, or the id/key may be mistyped. A
`not-found` that is really a permission problem is reported as `permission-denied` instead (entry 2).

**Diagnostic Steps**

1. Confirm the target key/id exists and is visible to the token identity by opening it in Atlassian.
2. Confirm the key/id was passed correctly to the action.

**Resolution**

1. Correct the target key/id, or re-target the action at an existing artifact.
2. If the artifact was intentionally removed upstream, the write is moot; no action is needed.

---

## 13. `field-validation`

| Field             | Value                                   |
| ----------------- | --------------------------------------- |
| Severity          | Medium                                  |
| Surface           | Local UI, Atlassian connector (write)   |
| Stable identifier | `field-validation` write failure reason |

**Symptom**

A create or update write action reports `field-validation`. The action was not applied.

**Root Cause**

The request was well-formed and within size limits, but the provider rejected its field content — a
required field was missing, a field value was not accepted by the project's field configuration or
screen, or a value referenced something that does not exist for that project. This is distinct from
`malformed-payload` (unparseable) and `bounds-exceeded` (oversized).

**Diagnostic Steps**

1. Confirm the target project/space and the fields the action is setting.
2. In Jira/Confluence, confirm which fields are required and permitted for that issue type or page,
   and that referenced values (for example, an issue type or label) exist.
3. Confirm the write reason is `field-validation` in the connector's redacted activity.

**Resolution**

1. Supply the required fields and correct any values that the project's configuration rejects, then
   re-issue the action.
2. If a project screen requires fields the action cannot set, adjust the request to include them or
   have a Jira/Confluence administrator review the field configuration.

---

## 14. `connector-access-denied` and `connector-write-denied`

| Field             | Value                                                            |
| ----------------- | ---------------------------------------------------------------- |
| Severity          | Medium                                                           |
| Surface           | Local UI, Atlassian connector (disposition)                      |
| Stable identifier | `connector-access-denied` / `connector-write-denied` deny reason |

**Symptom**

A read (sync or live) is **denied** with `connector-access-denied`, or a write is **denied** with
`connector-write-denied`. No external call is made. This can occur even in **Full access**.

**Root Cause**

Each connector action requires a specific connector scope in the Authority Envelope:
`knowledge-base.read` / `issue-tracker.read` for reads, and `knowledge-base.write` /
`issue-tracker.write` for writes. If the required scope is not present, the action is denied in
**every** mode, Full access included. Full access removes per-action approval; it does not grant a
scope the envelope does not carry (ADR-0128 D4).

**Diagnostic Steps**

1. Identify the action and its required scope from the mode table in the
   [setup and operations guide](../local-knowledge/atlassian-connector-guide.md#6-how-write-actions-behave-in-each-mode).
2. Confirm which connector scopes the active Authority Envelope carries.
3. Confirm the deny reason (`connector-access-denied` vs `connector-write-denied`) in the connector's
   redacted activity.

**Resolution**

1. Add the required connector scope to the Authority Envelope for the task, then re-run the action.
   Widening authority is a human-approved step by design.
2. If the scope should not be granted, the denial is the correct outcome; do not route around it.
3. Note that a missing scope is a governance denial, not a credential or network failure — the token
   and connectivity are unaffected.

---

## 15. Authority Envelope failures

| Field             | Value                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| Severity          | Medium                                                                  |
| Surface           | Local UI, Atlassian connector (agent-initiated actions)                 |
| Stable identifier | `authority-invalid` / `authority-expired` / `authority-budget-exceeded` |

**Symptom**

An agent-initiated connector action is refused with `authority-invalid`, `authority-expired`, or
`authority-budget-exceeded` before any external call.

**Root Cause**

Agent-initiated write and live-read actions must present a valid Authority Envelope (run id,
envelope digest, workspace root). The action is refused when the envelope fails validation
(`authority-invalid`), has expired (`authority-expired`), or its action budget is exhausted
(`authority-budget-exceeded`). These are mode-independent hard denials: invalid or expired authority
and exhausted budgets fail closed in every mode (ADR-0127; ADR-0128 D2).

**Diagnostic Steps**

1. Confirm the action was agent-initiated (a human-initiated action from the UI does not require an
   agent envelope).
2. Confirm which of the three reasons was reported in the connector's redacted activity for the
   attempt's `<correlation-id>`.
3. For `authority-budget-exceeded`, review how many governed tool calls the run has already
   consumed.

**Resolution**

1. For `authority-invalid` or `authority-expired`, re-establish a valid Authority Envelope for the
   run (a fresh, validated authority scope) and retry.
2. For `authority-budget-exceeded`, the run has spent its allotted budget; start a new task/run with
   its own validated envelope.
3. Do not attempt to bypass envelope validation — it is the boundary that keeps agent-initiated
   external actions inside human-approved authority.

---

## Related documentation

- [Atlassian connector setup and operations guide](../local-knowledge/atlassian-connector-guide.md)
  — token creation, registration, scope selection, sync, live read, and write-action modes.
- [Atlassian connector lifecycle ledger](../local-knowledge/atlassian-connector-lifecycle-ledger.md)
  — epic closure evidence.
- [ADR-0128](../adr/ADR-0128-atlassian-connector-authority-and-security-design.md) — the normative
  authority, credential, egress, evidence, and permissions decisions.
- [Security and audit boundaries](../security-and-audit-boundaries.md) — trust boundaries that
  constrain the resolutions above.
- [Troubleshooting guide](./README.md) — the full local-failure runbook and the entry template.
