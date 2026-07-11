# Atlassian Connector: Setup and Operations Guide

Status: user and operator guide for Epic
[#2238](https://github.com/oscharko-dev/Keiko/issues/2238) and child issues
[#2239](https://github.com/oscharko-dev/Keiko/issues/2239) (authority and security ADR),
[#2240](https://github.com/oscharko-dev/Keiko/issues/2240) (contracts),
[#2241](https://github.com/oscharko-dev/Keiko/issues/2241) (credential custody),
[#2242](https://github.com/oscharko-dev/Keiko/issues/2242) (Confluence ingestion),
[#2243](https://github.com/oscharko-dev/Keiko/issues/2243) (Jira ingestion),
[#2244](https://github.com/oscharko-dev/Keiko/issues/2244) (governed write actions),
[#2245](https://github.com/oscharko-dev/Keiko/issues/2245) (UI),
[#2246](https://github.com/oscharko-dev/Keiko/issues/2246) (end-to-end verification), and
[#2248](https://github.com/oscharko-dev/Keiko/issues/2248) (live Jira read).

The connector's authority, credential, egress, sync-bounds, evidence, and permissions decisions are
fixed by [ADR-0128](../adr/ADR-0128-atlassian-connector-authority-and-security-design.md). This guide
restates that record for operators; where the two differ, the ADR is authoritative. Autonomy-mode
language follows [ADR-0127](../adr/ADR-0127-product-wide-authority-and-autonomy-model.md): the three
user-facing modes are **Ask for approval**, **Approve for me**, and **Full access**.

## What the connector does

The Atlassian connector is a governed, local-first lane that connects Keiko to an Atlassian Cloud
site (Confluence and Jira) using a single Atlassian API token supplied by a local user. It supports
three families of operation:

- **Sync** — explicit, user-triggered synchronization of selected Confluence spaces and Jira
  projects into Local Knowledge connector pods, so their content is retrievable alongside every
  other [Knowledge Pod](knowledge-pods.md).
- **Live read** — an ad-hoc live Jira JQL query (for example, the built-in "issues assigned to me"
  query) that returns current results without persisting a pod.
- **Write** — governed Jira and Confluence write actions (create/update issues and pages,
  transition issues, add comments) whose disposition depends on the workspace's autonomy mode and
  the Authority Envelope.

A synced Confluence or Jira source becomes a **connector pod**: a Local Knowledge pod backed by the
synced content, using the same retrieval, grounding, readiness, and redacted-summary machinery as
every other pod. The connector does not add a second retrieval engine, a second registry, or a
second knowledge store.

v1 targets Atlassian **Cloud** REST APIs only. Data Center, OAuth, webhooks, scheduled sync,
attachment/worklog content, and deletion actions are out of scope; see
[Limitations and follow-ups](#limitations-and-follow-ups).

## 1. Create an Atlassian Cloud API token

The connector authenticates as an Atlassian **identity** using an API token — the same credential
Atlassian issues for scripts and integrations. Create one from your Atlassian account security
settings:

1. Open the official Atlassian API token page:
   <https://id.atlassian.com/manage-profile/security/api-tokens>. This is the stable,
   version-independent location; Keiko does not reproduce Atlassian's in-product navigation, which
   changes over time.
2. Create an API token, give it a descriptive label (for example, `keiko-connector`), and copy the
   token value. Atlassian shows the token **once**; store it in your password manager if you need it
   again.
3. Note the **account email** the token belongs to and the **site base URL** you intend to connect
   (for example, `https://example.atlassian.net`).

For regulated deployments, create the token from a **dedicated service account** scoped to only the
spaces and projects the workspace should expose, rather than a broad personal account. See
[Permissions and privacy](#permissions-and-privacy) for the reasoning.

The connector never asks for your Atlassian **password**. Cloud connectors use API-token Basic
authentication (`email` + token); the password is never entered, stored, or transmitted.

## 2. Register a connector in Keiko

Registering a connector stores its non-secret descriptor and seals its token in a dedicated local
credential vault. Provide three values:

| Field         | Example (synthetic)             | Rules                                                                      |
| ------------- | ------------------------------- | -------------------------------------------------------------------------- |
| Base URL      | `https://example.atlassian.net` | HTTPS only; no username/password in the URL; no query string; no fragment. |
| Account email | `service-account@example.com`   | The email the API token belongs to.                                        |
| API token     | `<redacted-api-token>`          | The token from step 1. Accepted once, sealed immediately, never displayed. |

Keiko generates an opaque reference (`authRef`, of the form `atlassian-cred:<redacted>`) for the
sealed token. The descriptor Keiko stores and shows you afterward contains only non-secret fields —
id, provider, display name, base URL, auth scheme, and that `authRef`. The token itself is written
to the vault exactly once, at registration, and is read back only inside the outbound HTTP adapter
immediately before a request is signed. No screen, log, evidence record, or model prompt ever shows
the token again (ADR-0128 D2).

The base URL's host becomes the connector's **sole** permitted egress host. A connector can only
reach that one host; there is no wildcard or cross-connector allowlist (ADR-0128 D3).

### The verify step and its five statuses

After you enter the three values, run **Verify**. Verify makes one authenticated call against the
site (Jira `/rest/api/3/myself` or Confluence `/wiki/rest/api/user/current`) with a 30-second
timeout and reports exactly one status:

| Verify status | Meaning                                                                 | What to do                                                             |
| ------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `ok`          | The token authenticated and the identity was resolved.                  | Proceed to select spaces/projects.                                     |
| `auth-failed` | The credential was rejected (wrong, revoked, or expired token).         | Re-check the email/token pair; re-create the token if needed.          |
| `forbidden`   | The token authenticated but the identity lacks permission for the call. | Grant the identity access, or use a token from an account that has it. |
| `unreachable` | The host could not be reached (DNS, proxy, CA, or network failure).     | Check connectivity and enterprise proxy/CA configuration.              |
| `timeout`     | The call did not complete within the timeout.                           | Retry; if it persists, check network latency and proxy health.         |

Each non-`ok` status has a matching entry in the
[Atlassian connector troubleshooting runbook](../troubleshooting/atlassian-connector.md).

## 3. Select spaces, projects, and optional JQL

A connector reaches content only within the scope you approve. Sync scope is declared per run:

- **Confluence** — one or more **space keys** (for example, `ENG`, `OPS`). The run syncs pages in
  those spaces.
- **Jira** — one or more **project keys** (for example, `EXAMPLE`, `PLATFORM`), with an optional
  **JQL** filter to narrow which issues sync (for example,
  `project = EXAMPLE AND status = "In Progress"`). JQL is bounded to 2048 characters.

The approved scope is persisted with the connector source and re-used on every re-sync. A sync run
never widens egress beyond the connector's single allowlisted host; an attempt to reach content
outside the approved scope fails closed with the `scope-exceeded` reason (ADR-0128 D3, D5).

## 4. Run and re-run syncs

Sync is **explicit and user-triggered**. There is no scheduled, background, or webhook-driven sync
in v1 (ADR-0128 D5, D7).

Starting a sync creates a **sync job** you can poll and cancel. Each run is bounded by declared,
non-wideneable defaults (ADR-0128 D5):

| Bound           | Default    | Applies to                          |
| --------------- | ---------- | ----------------------------------- |
| Max items       | 2 000      | issues or pages per run             |
| Max bytes       | 50 MB      | total normalized content per run    |
| Max duration    | 15 minutes | wall-clock budget for one run       |
| Max concurrency | 4          | concurrent paginated fetch requests |

Re-running a sync repeats the same bounded fetch over the same approved scope and applies changes
incrementally. Change detection uses a per-item content fingerprint (a SHA-256 over the normalized
item), so a re-sync re-indexes only what actually changed upstream. The full fingerprint set for a
source is replaced **atomically** at the end of a completed run: nothing is partially applied. A
cancelled or failed-before-commit run applies nothing and leaves the prior pod fully intact and
queryable (ADR-0128 D5).

### Reading change summaries

A completed run reports a body-free change summary — counts and reason codes only, never item
bodies. The counts are:

| Count     | Meaning                                                                                     |
| --------- | ------------------------------------------------------------------------------------------- |
| Added     | New items indexed this run.                                                                 |
| Changed   | Items whose content fingerprint changed and were re-indexed.                                |
| Removed   | Items present in the prior run but no longer found in scope, pruned from the pod.           |
| Unchanged | Items whose fingerprint was identical; skipped (not re-indexed).                            |
| Failed    | Items that could not be fetched or normalized this run.                                     |
| Denied    | Items visible in scope that the token identity could not read (per-item permission denial). |

A run that did not apply (cancelled, or failed before commit) reports zero for added, changed, and
removed, so a partial or aborted run can never be misread as "nothing changed upstream."

### Degradation states

A sync job carries one of six states, which map onto the shared Knowledge Pod readiness vocabulary
(ADR-0128 D5):

| Sync job state | Pod readiness                 | Meaning                                                                       |
| -------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| `pending`      | `draft`                       | Queued, or no completed sync yet.                                             |
| `running`      | `indexing`                    | A run is in progress.                                                         |
| `succeeded`    | `ready`                       | The run completed within budget; the pod is fully current.                    |
| `partial`      | `degraded`                    | The run completed but some items failed, were denied, or a bound was reached. |
| `failed`       | `error`                       | The run failed before committing; the prior pod is unchanged.                 |
| `cancelled`    | unchanged (keeps prior state) | The run was cancelled; nothing applied, prior readiness kept.                 |

When a run reports `partial` or `failed`, the diagnostics carry one of the connector's degradation
reason codes: `auth-failed`, `permission-denied`, `rate-limited`, `timeout`, `unavailable`,
`scope-exceeded`, `bounds-exceeded`, `cancelled`, or `malformed-payload`. Each code has a matching
entry in the
[Atlassian connector troubleshooting runbook](../troubleshooting/atlassian-connector.md).

## 5. Live Jira read: "issues assigned to me"

Separate from sync, the connector can run a **live** Jira JQL read (issue #2248). A live read
queries Jira directly and returns current results without creating or updating a pod, without
computing fingerprints, and without persisting any document. It is the right tool for "what is true
right now" questions rather than "what is in my indexed knowledge."

A built-in template, **"issues assigned to me"** (`assigned-to-me-open`), runs the query
`assignee = currentUser() AND resolution = EMPTY ORDER BY updated DESC` — the open, unresolved
issues assigned to the token identity, most recently updated first. You can also supply your own
JQL.

A live read is bounded: at most 100 results per call, a 15-second budget, and a fixed page ceiling.
Because it is a Jira read, its disposition follows the read row of the mode matrix below: it is
`review-required` in **Ask for approval** (the query is parked for approval, then executed on
approve) and `allowed` in **Approve for me** and **Full access** when the Authority Envelope carries
the `issue-tracker.read` scope. The raw JQL is never stored in evidence; only a SHA-256 digest of
the query may be recorded for correlation (ADR-0128 D6).

## 6. How write actions behave in each mode

Every governed connector operation maps to exactly one action class, one connector scope, one risk
tier, and one disposition per mode. This is the normative mapping from ADR-0128 D4, restated:

| Action                | Provider   | Connector scope        | Risk   | Ask for approval | Approve for me  | Full access |
| --------------------- | ---------- | ---------------------- | ------ | ---------------- | --------------- | ----------- |
| `sync-space`          | Confluence | `knowledge-base.read`  | low    | review-required  | allowed         | allowed     |
| `sync-project`        | Jira       | `issue-tracker.read`   | low    | review-required  | allowed         | allowed     |
| `search-issues-live`  | Jira       | `issue-tracker.read`   | low    | review-required  | allowed         | allowed     |
| `create-issue`        | Jira       | `issue-tracker.write`  | high   | review-required  | review-required | allowed     |
| `update-issue-fields` | Jira       | `issue-tracker.write`  | medium | review-required  | allowed         | allowed     |
| `transition-issue`    | Jira       | `issue-tracker.write`  | high   | review-required  | review-required | allowed     |
| `add-issue-comment`   | Jira       | `issue-tracker.write`  | low    | review-required  | allowed         | allowed     |
| `create-page`         | Confluence | `knowledge-base.write` | high   | review-required  | review-required | allowed     |
| `update-page`         | Confluence | `knowledge-base.write` | medium | review-required  | allowed         | allowed     |
| `add-page-comment`    | Confluence | `knowledge-base.write` | low    | review-required  | allowed         | allowed     |

How to read this per mode:

- **Ask for approval** — every connector operation, read or write, is `review-required`. Even a
  sync or a live read parks for your approval before it runs. This mode never acts on the external
  site without an explicit per-action confirmation.
- **Approve for me** — low- and medium-risk actions proceed without interruption: syncs, live
  reads, comments, and bounded field/page edits. High-risk actions — creating an issue, creating a
  page, transitioning an issue — still pause for review, because they create a new externally
  visible artifact or change workflow state with side effects Keiko does not control.
- **Full access** — every row is `allowed` **provided the required connector scope is present in
  the Authority Envelope**. Full access removes per-action approval; it does not remove the scope
  requirement.

**Scope is required in every mode, including Full access.** An action whose required connector scope
is missing from the Authority Envelope is **denied** — with `connector-write-denied` for a write, or
`connector-access-denied` for a read — in every mode, Full access included. Full access grants
autonomy inside the validated envelope; it never grants a scope the envelope does not carry.

When an action is `review-required`, it produces a pending approval you resolve (approve or reject)
from the connector's approvals surface. Approving executes the action; rejecting records the
outcome without executing. When an action is `denied`, no external call is made.

Write actions and syncs never touch the git delivery path. Commit, push, pull-request creation, and
merge remain separately human-approved delivery actions governed by the existing delivery substrate;
this connector does not widen or bypass them (ADR-0128 D4).

## Permissions and privacy

This section is a deliberate, honest statement of what the connector's permission model does and
does not do (ADR-0128 D8). Read it before exposing a synced pod to a shared workspace.

**A pod reflects the token identity's visibility at sync time.** A synced pod — and every live read
and write action — reflects the visibility and permissions of the **token identity at the moment of
the call**. It is a point-in-time snapshot, not a live or continuously re-evaluated permission set.
If the identity's Atlassian permissions are later narrowed, an already-synced pod still contains
what the token could read at sync time until the next re-sync.

**Keiko adds no access control on top of the token.** Keiko does not replicate Confluence space
permissions or Jira project/issue-level security schemes into a local ACL. It applies no additional
per-user or per-team access control beyond what the connected token can already see. Treat a synced
pod as equivalent, from an access-control perspective, to a local export of everything that token
could read at sync time.

**Single-user scope; no multi-user ACL replication.** The connector is scoped to a single local
user's own credential. There is no multi-user permission model and no per-viewer filtering of pod
content. Every local user of the workspace the pod belongs to can retrieve everything in the pod.

**Content is stored locally and encrypted at rest.** Synced Confluence and Jira content becomes the
connector pod's retrievable knowledge product and legitimately carries real titles, field values,
and body text — exactly like any other Local Knowledge source. It is stored **locally** and
**encrypted at rest** by Local Knowledge's existing content-encryption boundary
([ADR-0047](../adr/ADR-0047-local-knowledge-content-encryption.md)), not sent to any Keiko-hosted
service.

**What evidence and audit records contain.** The connector's governance trail — the record of what
was attempted and its disposition — is content-free. Each action attempt (allowed, review-required,
denied, or failed) produces exactly one audit record carrying: action type, connector id, provider,
target key or id (an issue key or page id — an identifier, not a body), disposition, reason code,
correlation id, duration, and result status. A sync run additionally records the change counts, the
outcome, and the run's fingerprint-set digest. Audit and evidence records **never** contain issue or
page bodies, comment text, field values, ADF/storage-format payloads, tokens, or token-bearing URLs.
**JQL is hashed or omitted, never stored verbatim** (ADR-0128 D6). This body-free rule governs the
audit trail only; it does not redact the synced knowledge content itself, which is protected by
encryption at rest as described above.

**Guidance for regulated deployments:**

- **Use a dedicated service-account token,** not a broad personal token. The local pod inherits the
  token's full read scope for every local user of the workspace, so scope the token to only the
  projects and spaces the deployment intends to expose.
- **Minimize scope at the source.** Grant the service account access to the smallest set of spaces
  and projects that satisfies the need; the connector cannot restrict below what the token can see.
- **Re-sync after permission changes.** Because a pod is a point-in-time snapshot, re-sync on your
  organization's cadence after any permission change so the pod reflects the current access posture.
  Token rotation is a single vault update against the same `authRef`; no descriptor or pod-metadata
  change is required.
- **Govern local retention and distribution** of a synced pod as you would any local export of the
  underlying Atlassian content.

## Limitations and follow-ups

Each limitation below is a deliberate v1 scope decision from ADR-0128 D7, with its stated rationale.
None is a defect.

- **Cloud only; Data Center is a follow-up.** v1 targets Atlassian Cloud REST APIs against a
  configurable per-connector base URL. Data Center uses different base-path conventions, more
  commonly self-signed or private CAs, and the `bearer-pat` auth scheme (declared in the credential
  shape but not implemented in v1). It is deferred because verifying it requires access to a Data
  Center instance this epic does not have.
- **No OAuth 2.0 (3LO).** API-token Basic authentication is sufficient for a single local user's own
  credential and needs no redirect-based consent flow, browser round-trip, or refresh-token custody.
  OAuth is deferred until multi-user or app-marketplace distribution creates an actual need.
- **No webhooks.** v1 sync is pull-based and explicitly user-triggered. Webhook ingestion would
  require an inbound listener and a different trust boundary (accepting unsolicited external input)
  that ADR-0128 does not evaluate.
- **No attachment or worklog content.** Attachment and worklog **content** is not indexed; only
  attachment metadata is available where the sync surfaces it. Deferred as a scope extension of the
  document/metadata mapping, not a policy change.
- **No scheduled or background sync.** Sync is explicit-trigger only. A scheduler is deferred until
  explicit-trigger sync has proven its bounds in production; scheduling would also change the
  "explicit user action" framing the mode dispositions assume for reads (a `review-required`
  disposition presumes a human is present to review).
- **No deletion actions.** Issue deletion, page deletion or archival, and comment deletion are
  excluded from the v1 action set entirely. A destructive, generally irreversible action against a
  customer's system of record needs its own risk-tier and disposition decision ADR-0128 does not
  make; adding it later is an additive table extension, not a reopening of the record.
- **Page ancestors and breadcrumbs are not captured.** The Confluence sync does not persist a page's
  ancestor chain or breadcrumb hierarchy; pages are indexed by stable page id. This is a tracked
  follow-up of the sync content model, not a policy limitation.

**Future direction: ticket-to-workbench handoff.** Taking a synced or live Jira ticket directly into
a Coding Workbench task is a documented future direction, tracked as a separate epic
([#2249](https://github.com/oscharko-dev/Keiko/issues/2249)). It is not part of Epic #2238 and is
not implemented by this lane.

## Release impact

Advisory release-note metadata for the release owner to encode in governed
[ADR-0099](../adr/ADR-0099-governed-in-app-updates-and-release-impact-contract.md) metadata, per the
epic's aggregation rule. The structured
[`release-impact.catalog.json`](../../release-impact.catalog.json) remains the authoritative release
source once release-owner review evidence is recorded; a pending entry must not be added to that
catalog if it would make the machine-checked gate fail before release-owner approval exists (see the
same posture in [knowledge-pods.md](knowledge-pods.md#release-impact-and-limits) and the
[release-impact runbook](../release/release-impact-runbook.md)).

**Aggregated connector bullet (one customer-readable outcome for the epic):**

> Keiko can now connect to an Atlassian Cloud site (Confluence and Jira) with a local API token,
> sync selected spaces and projects into governed Local Knowledge pods, run a live "issues assigned
> to me" Jira read, and perform governed Jira and Confluence write actions under the workspace's
> autonomy mode.

**Advisory categories for the aggregation:**

| Category                         | Applies to                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `new-additions`                  | The Atlassian connector capability (sync, live read, governed writes) as a whole.   |
| `improvements`                   | Governed write dispositions and the live Jira read surfaced through existing modes. |
| `ui-polish`                      | Connector registration, verify, scope selection, and sync surfaces.                 |
| `state-or-compatibility-changes` | Additive contracts and the additive, backward-compatible connector store migration. |

- **Priority:** `normal`.
- **User-visible change:** a new governed connector lane; documentation (this issue, #2247) is
  `update-notes`.
- **Supported-from versions:** the first release containing this epic's completed children; the
  release owner assigns the concrete version at release time on the `0.2.0` reviewed baseline path.
- **Affected state stores:** an additive, backward-compatible connector store migration
  (`connector_sources`, `connector_item_fingerprints`). Existing stores keep working with no user
  action; remediation is `no-action-required`.
- **User action required and remediation:** none.
- **Internal-only items kept out of default patch notes:** the contract layer, credential custody,
  HTTP adapters, and policy-seam plumbing are internal implementation slices; they are aggregated
  under the single connector bullet above and do not receive their own public patch-note lines.

The authoritative catalog entry, tied to the release version and carrying release-owner review
evidence, is finalized by the release owner at release time — not by this documentation change.

## Related documentation

- [Atlassian connector troubleshooting runbook](../troubleshooting/atlassian-connector.md) — one
  entry per known failure mode, with redacted diagnostics and resolutions.
- [Atlassian connector lifecycle ledger](atlassian-connector-lifecycle-ledger.md) — epic closure
  evidence: children, reuse decisions, limitations, and follow-ups.
- [ADR-0128](../adr/ADR-0128-atlassian-connector-authority-and-security-design.md) — the normative
  authority, credential, egress, sync-bounds, evidence, and permissions decisions.
- [ADR-0127](../adr/ADR-0127-product-wide-authority-and-autonomy-model.md) — the three-mode
  authority model and the exact mode names.
- [Knowledge Pods](knowledge-pods.md) — the Local Knowledge pod model the connector's synced content
  becomes part of.
- [Security and audit boundaries](../security-and-audit-boundaries.md) — trust boundaries that
  constrain the resolutions in the troubleshooting runbook.
