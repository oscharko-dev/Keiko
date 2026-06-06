# Epic #532 — Relationship Activity-State Model

Status: Wave 3 deliverable for [issue #536](https://github.com/oscharko-dev/Keiko/issues/536) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion documents: [audit-events.md](audit-events.md), [evidence-references.md](evidence-references.md), [retention-and-privacy.md](retention-and-privacy.md), [audit-activity-checklist.md](audit-activity-checklist.md), [ADR-0032](../adr/ADR-0032-relationship-audit-and-activity-model.md).

Date: 2026-06-06.

## 1. Purpose and privacy invariant

This document specifies the `RelationshipActivity` model: the closed set of transient activity states that a relationship may exhibit in the inspector and the controlled graph view, the source-of-truth event stream that drives each state, the bounded-render contract, and the accessibility rules that prevent reliance on color or motion alone.

**Privacy invariant (state it loudly):**

> Activity is **presentation**; durability lives in **audit events** (see [audit-events.md](audit-events.md)) and **evidence manifests** (see [evidence-references.md](evidence-references.md)).
>
> Activity state is **transient, in-memory only, derived from existing run / workflow / tool events**. It is **NEVER** persisted to disk, **NEVER** sent to a remote endpoint, **NEVER** logged outside the local Keiko runtime, and **NEVER** used as input to any retention, billing, or analytics surface.

Activity visualization is the rendered projection of state that already exists in other ledgers. It introduces no new telemetry stream and no new persisted record.

## 2. The nine activity states

The closed enumeration of relationship activity states:

```ts
export type RelationshipActivityState =
  | "inactive"
  | "queued"
  | "active"
  | "processing"
  | "completed"
  | "failed"
  | "blocked"
  | "degraded"
  | "high-throughput";
```

These are **distinct from**:

- the **lifecycle state set** in [lifecycle.md §1](lifecycle.md) (`draft`/`active`/`archived`/`superseded`/`revoked`/`blocked`/`stale`), which is durable in the `relationships.lifecycle` column ([storage.md §3.1](storage.md));
- the **live `RelationshipActivityKind` family** in [lifecycle.md §5](lifecycle.md) (`relationship:proposed`/`relationship:accepted`/…), which names SSE event types — not states.

The lifecycle is what the relationship **is**. The audit kind is what **happened** to it. The activity state in this document is what is **going on around it right now** — derived purely from observation of existing event streams.

### 2.1 State definitions

| State             | Meaning                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inactive`        | No observed traffic against this relationship in the activity window. The default state.                                                                                               |
| `queued`          | A workflow run that names this relationship has started but not yet emitted its first `model:call:started` or tool call.                                                               |
| `active`          | At least one model call has started; the run is mid-flight.                                                                                                                            |
| `processing`      | A tool call or command execution that names this relationship is in flight.                                                                                                            |
| `completed`       | The most recent run that touched this relationship emitted `run:completed`.                                                                                                            |
| `failed`          | The most recent run emitted `run:failed`, or a `verification:result` arrived with `outcome: "fail"`.                                                                                   |
| `blocked`         | The validator emitted a `denied/*` reason for the most recent proposal touching this relationship (see [denial-reasons.md](denial-reasons.md)).                                        |
| `degraded`        | The health-check pass flagged at least one endpoint as `tombstoned` / `retired` / `unavailable` but the relationship row remains `active` (no `* → stale` transition yet).             |
| `high-throughput` | The activity-derivation observed strictly more than the high-throughput threshold of events naming this relationship in the activity window. Numeric aggregate; no event-content kept. |

`inactive` is the absence-of-signal state. `high-throughput` is a numeric aggregate (count over time window T; see §5). The other seven each correspond to at least one source event-stream observation per §3.

## 3. Source event stream per state

Every activity state is **derived** from one or more existing event streams already emitted by the Keiko subsystems. **No new event type is introduced.**

| State             | Source event stream and citation                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inactive`        | Absence of any of the below in the activity window of length T (see §5).                                                                                                                                                                                                                                                                                                                                                                                            |
| `queued`          | `run:started` ([`packages/keiko-contracts/src/harness.ts:189`](../../packages/keiko-contracts/src/harness.ts)) where the run's input names this relationship's source or target id; AND no `model:call:started` ([`harness.ts:203`](../../packages/keiko-contracts/src/harness.ts)) yet observed for that run.                                                                                                                                                      |
| `active`          | `model:call:started` ([`packages/keiko-contracts/src/harness.ts:203`](../../packages/keiko-contracts/src/harness.ts)) or `workflow:model:call:started` ([`packages/keiko-contracts/src/unit-test-events.ts:84`](../../packages/keiko-contracts/src/unit-test-events.ts)) observed for a run naming this relationship.                                                                                                                                               |
| `processing`      | `tool:call:started` ([`packages/keiko-contracts/src/harness.ts:232`](../../packages/keiko-contracts/src/harness.ts)) or `command:executed` ([`harness.ts:256`](../../packages/keiko-contracts/src/harness.ts)) or `patch:applied` ([`harness.ts:280`](../../packages/keiko-contracts/src/harness.ts)) naming this relationship.                                                                                                                                     |
| `completed`       | `run:completed` ([`packages/keiko-contracts/src/harness.ts:309`](../../packages/keiko-contracts/src/harness.ts)) or `workflow:completed` ([`unit-test-events.ts:128`](../../packages/keiko-contracts/src/unit-test-events.ts)) or `bug:completed` ([`bug-investigation-events.ts:139`](../../packages/keiko-contracts/src/bug-investigation-events.ts)) for a run naming this relationship.                                                                         |
| `failed`          | `run:failed` ([`packages/keiko-contracts/src/harness.ts:321`](../../packages/keiko-contracts/src/harness.ts)) or `workflow:failed` ([`unit-test-events.ts:135`](../../packages/keiko-contracts/src/unit-test-events.ts)) or `bug:failed` ([`bug-investigation-events.ts:146`](../../packages/keiko-contracts/src/bug-investigation-events.ts)) or `verification:result` ([`harness.ts:303`](../../packages/keiko-contracts/src/harness.ts)) with `outcome: "fail"`. |
| `blocked`         | A `relationship.validation-denied` or `relationship.policy-denied` audit row (per [audit-events.md §4.5/§4.6](audit-events.md)) was written in the activity window for a proposal whose endpoints match this relationship. NOTE: also fires for the lifecycle `blocked` state (per [lifecycle.md §1](lifecycle.md)) which is durable; the activity-state derivation reads the lifecycle column directly.                                                            |
| `degraded`        | A `relationship.health-finding` audit row (per [audit-events.md §4.9](audit-events.md)) was written in the activity window with `sourceLiveness !== "live"` or `targetLiveness !== "live"`, AND the relationship's `lifecycle` column is still `active` (no `* → stale` transition yet — that becomes durable `stale`, not transient `degraded`).                                                                                                                   |
| `high-throughput` | Strictly more than `N_THROUGHPUT` (proposed default: 50) events from the streams above observed for this relationship in window T. Counted as an aggregate; no event content retained.                                                                                                                                                                                                                                                                              |

### 3.1 The naming convention "names this relationship"

A harness or workflow event "names this relationship" when at least one of its identity fields matches a relationship endpoint:

- `model:call:*` / `tool:call:*` events name a `runId`; the activity layer joins `runId` to the `relationship.sourceId` or `relationship.targetId` where `sourceKind: "workflow-run"` or `targetKind: "workflow-run"`.
- `command:executed` / `patch:applied` events name a `runId` AND a tool name; the join goes through the run, then to the relationship row where `sourceKind: "tool"` if the run resolved the tool.
- `verification:result` events name a `runId`; the join is identical to model calls.

The join is computed **only on the in-memory subscriber**; it never writes to disk.

### 3.2 Why activity reads `lifecycle` and audit rows but not vice versa

The activity derivation is a **read-only consumer** of:

- the in-process harness event stream (live, ephemeral);
- the `relationships.lifecycle` column from [storage.md §3.1](storage.md) (durable, but read-only here);
- the `relationship_audit_entries` table from [audit-events.md §5.5](audit-events.md) (durable, but read-only here).

No data flows **from** the activity layer **to** any durable store. The activity layer's view is regenerated on every restart from the durable sources above plus newly observed live events.

## 4. RelationshipActivity payload (in-memory only)

The in-memory representation, never persisted:

```ts
interface RelationshipActivity {
  readonly relationshipId: string;
  readonly workspaceId: string;
  readonly state: RelationshipActivityState;
  readonly observedAt: number; // epoch-ms; in-memory only
  readonly throughputCount: number; // events in window T; numeric aggregate
  readonly accessibility: {
    readonly label: string; // stable text label per §6
    readonly ariaDescription: string; // semantic description per §6
    readonly iconHint: RelationshipActivityIconHint; // shape/pattern per §6
    readonly colorHint?: RelationshipActivityColorHint; // optional; never load-bearing
  };
}
```

The payload is recomputed on every subscriber tick and never serialised. The SSE stream that powers the inspector emits the payload as a body-free transient message per [lifecycle.md §9.2](lifecycle.md) discipline.

## 5. Bounded-render and bounded-derive contract

### 5.1 Bounded derivation cost

Activity-state derivation is O(active-workflows) per workspace, **not** O(all-relationships). The derivation walks:

1. the live harness event sink for the current process (bounded by the in-process event sink cap);
2. the set of relationships whose `sourceId` or `targetId` matches a currently-mid-flight run (the count of currently-active runs is bounded by harness limits — see ADR-0004 lineage).

The derivation **never** scans the full `relationships` table; it joins forward from the small active-runs set to the relationship rows that name those runs.

### 5.2 Activity window length T

The activity window T is the rolling time interval over which events feed the derivation. Proposed default: **T = 60 seconds**. Rationale:

- shorter than typical workflow run duration so a mid-flight run lights `active` / `processing` continuously;
- long enough that a user navigating between inspector tabs does not lose the `completed` badge of a just-finished run;
- short enough that idle relationships return to `inactive` quickly, reducing visual noise.

T is operator-tunable per workspace; the default lives next to the existing harness limits in `keiko-server` configuration.

### 5.3 Bounded-render cap N_VISIBLE

At most **N_VISIBLE = 25** relationships in the controlled graph view render an animated activity state concurrently. Rationale:

- 25 is well below the WCAG 2.3.1 three-flashes-per-second risk floor (animation is per-card, not per-pixel);
- 25 is the upper bound at which a human can usefully visually track distinct activity glyphs on a single screen at typical inspector zoom (per Miller's number heuristic, doubled and rounded);
- it matches the default `limit: 64` cap on `GET /api/relationships/health` ([api-contract.md §4.10](api-contract.md)) divided down to the "actively-rendered" subset;
- it is small enough that the bounded-render check is O(1) per frame.

Beyond N_VISIBLE, the inspector renders a **redacted aggregate badge** — for example, "+12 more processing" — which is a count, never an enumeration. The aggregate carries no relationship ids.

### 5.4 `high-throughput` numeric threshold N_THROUGHPUT

Proposed default: **N_THROUGHPUT = 50** events naming the relationship within window T. Above the threshold, the relationship's badge switches to `high-throughput`. The badge surfaces only the count and never event payloads. Once below the threshold, the badge reverts to whichever single-event state was last observed (or `inactive` if none).

### 5.5 Idle and reduced-motion behaviour

When `prefers-reduced-motion: reduce` is set (per §6.3), all animated transitions are replaced with static state changes. When the page is not visible (per the Page Visibility API), the derivation pauses; the next visibility tick re-derives from the durable sources.

## 6. Accessibility contract (non-color-only, non-motion-only)

Every state has **four** descriptors. A conformant renderer MUST use at least three of them (the text label, the ARIA description, and the icon hint) and MAY add the color hint. **A rendering that conveys state through color alone, or through motion alone, is non-conformant.**

| State             | (a) Text label    | (b) ARIA description                                                                                      | (c) Icon / pattern hint                        | (d) Color hint (optional)                                                                   |
| ----------------- | ----------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `inactive`        | "Inactive"        | "No recent activity for this relationship."                                                               | hollow circle                                  | `text-ink-muted` (per the dark Keiko palette established in the issue #63 workspace shell). |
| `queued`          | "Queued"          | "A workflow run referencing this relationship is queued."                                                 | clock face                                     | `text-ink-muted`                                                                            |
| `active`          | "Active"          | "A model call referencing this relationship is in progress."                                              | filled circle                                  | `text-accent`                                                                               |
| `processing`      | "Processing"      | "A tool or command referencing this relationship is executing."                                           | rotating segment (paused under reduced motion) | `text-accent`                                                                               |
| `completed`       | "Completed"       | "The most recent run referencing this relationship completed successfully."                               | check mark                                     | `text-success` (semantic green per Keiko palette)                                           |
| `failed`          | "Failed"          | "The most recent run referencing this relationship failed."                                               | filled triangle with exclamation               | `text-warning` (semantic amber/red per Keiko palette)                                       |
| `blocked`         | "Blocked"         | "The validator denied a recent proposal referencing this relationship; see the inspector for the reason." | filled square                                  | `text-warning`                                                                              |
| `degraded`        | "Degraded"        | "The health check flagged at least one endpoint of this relationship as not currently live."              | broken-line pattern                            | `text-warning`                                                                              |
| `high-throughput` | "High throughput" | "More than fifty events referenced this relationship in the last sixty seconds."                          | three stacked horizontal lines                 | `text-accent` (deliberately reuses `active`'s color hint to keep the palette finite)        |

### 6.1 Icon hints are perceptible without color

Each icon hint in column (c) has a distinct **shape** (circle, square, triangle, check, broken-line, stacked-lines). Two states never share an identical icon. A renderer that prints in monochrome (or for a screen reader) still distinguishes the nine states by shape and label alone.

### 6.2 ARIA wiring (binding for #541)

Every activity badge in the inspector is wrapped in:

```html
<span role="status" aria-live="polite" aria-atomic="true">
  <span aria-hidden="true"><!-- icon --></span>
  <span class="visually-hidden">{{ariaDescription}}</span>
  <span aria-hidden="true">{{label}}</span>
</span>
```

`role="status"` matches the existing `RunSummaryCard` pattern in the workspace UI. `aria-live="polite"` ensures the assistive technology announces the change but does not interrupt the user. The visually-hidden description carries the full per-state semantic; the visible label is the short token.

### 6.3 Reduced-motion and contrast accommodations

- `prefers-reduced-motion: reduce` disables all transitions, replacing them with instantaneous state changes. The `processing` rotating segment becomes a static segmented circle. No flashing.
- `prefers-contrast: more` switches the icon hints to high-contrast variants (heavier strokes, larger shapes). The text label and ARIA description are unchanged. The color hint is replaced with a palette-locked high-contrast pair (foreground/background WCAG 7:1 AAA where possible).
- Color hints are never load-bearing. A renderer omitting (d) entirely MUST still convey state via (a)+(b)+(c).
- All color hints comply with WCAG 2.2 1.4.11 (3:1 against background) at minimum; informational color uses the 4.5:1 contrast tier from the dark Keiko palette lineage.

### 6.4 Per-state focus behaviour

Activity badges are not interactive by default. A relationship row in the inspector is the interactive surface; the badge is presentation only. If a future enhancement makes the badge interactive (e.g. "filter by `failed`"), it MUST adopt `:focus-visible:ring-2 ring-inset ring-accent` per the [issue #67 right-tool-area lesson](https://github.com/oscharko-dev/Keiko/issues/67), not `:focus` or `:focus-within`.

## 7. Forbidden activity fields

The FORBIDDEN list from [audit-events.md §8.3](audit-events.md) applies in full to every activity payload:

- raw prompts;
- model output text;
- document contents;
- tool stdout / stderr (counts only);
- patch bodies / diff bytes (file counts only);
- secrets;
- credentials;
- private logs;
- request bodies that include the above;
- customer data / PII;
- cross-workspace identifiers.

In addition, activity payloads MUST NOT carry:

- a list of `eventId`s contributing to the state (the count is the aggregate; the list is the leak);
- a list of run ids beyond the single most-recent relevant run (or zero of them, for `inactive` and `high-throughput`);
- exception messages from failed runs (the `failed` state surfaces "Failed" + the run id; the inspector's "Failure" panel reads the existing redacted `EvidenceFailure` at [`packages/keiko-evidence/src/types.ts:17`](../../packages/keiko-evidence/src/types.ts));
- raw timestamps of every contributing event (only the most-recent `observedAt`).

## 8. Cross-cutting invariants

1. **Zero disk writes.** No code path under the activity derivation calls `fs.writeFile`, `node:sqlite` writes, or evidence persist. The derivation is read-only against the durable sources.
2. **Zero network egress.** No `fetch`, no provider SDK, no telemetry endpoint. The activity layer composes only with in-process event subscribers and in-memory caches.
3. **Bounded fan-in.** The derivation cost is O(active-workflows) per workspace, never O(all-relationships) or O(history).
4. **Bounded fan-out.** At most N_VISIBLE = 25 animated states render concurrently; beyond, an aggregate count.
5. **Determinism per snapshot.** Given the same set of durable rows and the same in-memory event log, the derivation produces an identical state for every relationship. Useful for testing (see [audit-activity-checklist.md §"Activity-state determinism test"](audit-activity-checklist.md)).
6. **Workspace scope.** Activity derivation never crosses workspaces; the in-memory subscriber filters by `workspaceId` at source.
7. **No telemetry.** The activity layer is presentation only; "telemetry" is not the model. The privacy invariant in §1 forbids treating it as one.

## 9. References

- [audit-events.md](audit-events.md), [evidence-references.md](evidence-references.md), [retention-and-privacy.md](retention-and-privacy.md), [audit-activity-checklist.md](audit-activity-checklist.md)
- [lifecycle.md](lifecycle.md), [taxonomy.md](taxonomy.md), [denial-reasons.md](denial-reasons.md), [architecture.md](architecture.md), [api-contract.md](api-contract.md), [storage.md](storage.md), [security-checklist.md](security-checklist.md)
- [`packages/keiko-contracts/src/harness.ts`](../../packages/keiko-contracts/src/harness.ts), [`packages/keiko-contracts/src/unit-test-events.ts`](../../packages/keiko-contracts/src/unit-test-events.ts), [`packages/keiko-contracts/src/bug-investigation-events.ts`](../../packages/keiko-contracts/src/bug-investigation-events.ts)
- [`packages/keiko-evidence/src/types.ts`](../../packages/keiko-evidence/src/types.ts)
- [`docs/local-runtime-state-contract.md`](../local-runtime-state-contract.md)
- [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md), [ADR-0032](../adr/ADR-0032-relationship-audit-and-activity-model.md)
- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#536](https://github.com/oscharko-dev/Keiko/issues/536).
