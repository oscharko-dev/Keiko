// Issue #542 (Epic #532) — Graph health panel.
//
// Surfaces the categorized health findings exposed by GET /api/relationships/health: orphaned
// endpoints, stale / blocked / failed (revoked) relationships, invalid references, and cycle
// participants — the operationally critical relationship-graph defects. Previously the backend
// computed these but no UI rendered them (closure-evidence.md known limitation). This panel closes
// that gap inside the existing Workspace window, reusing inspector chrome only.
//
// Bounds + privacy:
//   • Every category is server-bounded at MAX_RELATIONSHIPS_PER_QUERY; this panel additionally caps
//     UI rendering at UI_RENDER_CAP per category and states the cap, so a large graph cannot cause
//     unbounded rendering (#542 AC, #541 high-throughput bound).
//   • Findings carry redacted ids + kinds only — no payloads (audit-events.md).
//   • State is conveyed by text labels + counts, never colour alone (#537 / accessibility-checklist).
//
// No new third-party dependency. No new CSS variable or @keyframes.

"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { RelationshipLifecycleState } from "@oscharko-dev/keiko-contracts";
import { RELATIONSHIP_LIFECYCLE_STATES } from "@oscharko-dev/keiko-contracts";
import {
  getHealth,
  RelationshipApiError,
  type HealthFindings,
  type HealthRelationshipRef,
  type HealthEndpointRef,
  type HealthResult,
} from "../../../../relationships/api";

// UI-side render cap per category (the server already bounds the query). Stated to the user.
const UI_RENDER_CAP = 50;

interface RelationshipCategory {
  readonly key: string;
  readonly label: string;
  readonly help: string;
  readonly items: readonly HealthRelationshipRef[];
  readonly truncated: boolean;
}

// Operational severity order: invalid references first (a structurally broken edge), then blocked /
// failed / cycle (active defects), then stale (degraded), per error-and-denial-ux severity.
function relationshipCategories(f: HealthFindings): readonly RelationshipCategory[] {
  return [
    {
      key: "invalid",
      label: "Invalid references",
      help: "An endpoint no longer resolves to a live workspace object.",
      items: f.invalidReferences,
      truncated: f.invalidReferencesTruncated,
    },
    {
      key: "blocked",
      label: "Blocked",
      help: "A policy or endpoint state is blocking this relationship.",
      items: f.blockedRelationships,
      truncated: f.blockedRelationshipsTruncated,
    },
    {
      key: "failed",
      label: "Failed (revoked)",
      help: "The relationship reached the revoked terminal state.",
      items: f.failedRelationships,
      truncated: f.failedRelationshipsTruncated,
    },
    {
      key: "cycle",
      label: "Cycle participants",
      help: "These relationships take part in a dependency cycle.",
      items: f.cycleParticipants,
      truncated: f.cycleScanTruncated,
    },
    {
      key: "stale",
      label: "Stale",
      help: "A health check flagged at least one endpoint as not currently live.",
      items: f.staleRelationships,
      truncated: f.staleRelationshipsTruncated,
    },
  ];
}

function endpointLabel(ref: HealthEndpointRef): string {
  return `${ref.kind}: ${ref.id}`;
}

function totalFindings(f: HealthFindings): number {
  return (
    f.orphanedEndpoints.length +
    f.staleRelationships.length +
    f.blockedRelationships.length +
    f.failedRelationships.length +
    f.invalidReferences.length +
    f.cycleParticipants.length
  );
}

// ─── Sub-renderers ─────────────────────────────────────────────────────────────

function TruncationNote({ category }: { category: string }): ReactNode {
  return (
    <p
      role="note"
      style={{
        margin: "4px 0 0",
        fontSize: 11,
        color: "var(--fg-muted)",
        borderLeft: "2px solid var(--warn)",
        paddingLeft: 8,
      }}
    >
      More {category} exist than the bounded query returned. Resolve the listed items, then re-run
      the health check.
    </p>
  );
}

function RelationshipFindingList({
  category,
  onSelectRelationship,
}: {
  category: RelationshipCategory;
  onSelectRelationship: (id: string) => void;
}): ReactNode {
  if (category.items.length === 0) return null;
  const shown = category.items.slice(0, UI_RENDER_CAP);
  const hidden = category.items.length - shown.length;
  return (
    <section
      aria-label={`${category.label} (${String(category.items.length)})`}
      style={{ marginBottom: 14 }}
    >
      <div className="rb-section-label" role="heading" aria-level={3}>
        {category.label}
        <span className="rb-count" aria-hidden="true">
          {category.items.length}
        </span>
      </div>
      <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--fg-muted)" }}>{category.help}</p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {shown.map((ref) => (
          <li key={ref.id} style={{ marginBottom: 2 }}>
            <button
              type="button"
              className="arun-btn ghost"
              onClick={() => onSelectRelationship(ref.id)}
              aria-label={`Inspect ${ref.type} relationship from ${endpointLabel(ref.source)} to ${endpointLabel(ref.target)}, lifecycle ${ref.lifecycle}`}
              style={{
                display: "flex",
                width: "100%",
                gap: 6,
                alignItems: "center",
                textAlign: "left",
                fontSize: 12,
              }}
            >
              <span className="mono" style={{ color: "var(--fg)" }}>
                {ref.type}
              </span>
              <span style={{ color: "var(--fg-muted)" }}>
                {endpointLabel(ref.source)} → {endpointLabel(ref.target)}
              </span>
              <span className="mono" style={{ marginLeft: "auto", color: "var(--fg-muted)" }}>
                {ref.lifecycle}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p role="note" style={{ margin: "4px 0 0", fontSize: 11, color: "var(--fg-muted)" }}>
          Showing the first {String(UI_RENDER_CAP)} of {String(category.items.length)}.
        </p>
      )}
      {category.truncated && <TruncationNote category={category.label.toLowerCase()} />}
    </section>
  );
}

function OrphanedEndpointList({ findings }: { findings: HealthFindings }): ReactNode {
  if (findings.orphanedEndpoints.length === 0) return null;
  const shown = findings.orphanedEndpoints.slice(0, UI_RENDER_CAP);
  return (
    <section
      aria-label={`Orphaned endpoints (${String(findings.orphanedEndpoints.length)})`}
      style={{ marginBottom: 14 }}
    >
      <div className="rb-section-label" role="heading" aria-level={3}>
        Orphaned endpoints
        <span className="rb-count" aria-hidden="true">
          {findings.orphanedEndpoints.length}
        </span>
      </div>
      <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--fg-muted)" }}>
        Endpoints that participate in no live relationship.
      </p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {shown.map((ref) => (
          <li key={`${ref.kind}:${ref.id}`} className="rb-row" style={{ fontSize: 12 }}>
            <span className="mono">{endpointLabel(ref)}</span>
          </li>
        ))}
      </ul>
      {findings.orphanedEndpointsTruncated && <TruncationNote category="orphaned endpoints" />}
    </section>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function RelationshipHealthPanel({
  onSelectRelationship,
}: {
  readonly onSelectRelationship: (id: string) => void;
}): ReactNode {
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getHealth();
      setHealth(result);
    } catch (err) {
      setError(
        err instanceof RelationshipApiError
          ? err.message
          : "Could not load the graph health check.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ padding: 12, height: "100%", overflowY: "auto" }} aria-busy={loading}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--fg)", flexGrow: 1 }}>
          Graph health
        </h2>
        <button
          type="button"
          className="arun-btn"
          onClick={() => void load()}
          aria-label="Re-run the graph health check"
          style={{ minHeight: 24 }}
        >
          Refresh
        </button>
      </header>

      {loading && (
        <p style={{ fontSize: 12, color: "var(--fg-muted)" }} aria-live="polite">
          Running health check…
        </p>
      )}

      {error !== null && (
        <div className="lk-alert" role="alert">
          {error}
          <button type="button" className="lk-alert-retry" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {!loading && error === null && health !== null && (
        <>
          <p style={{ fontSize: 11, color: "var(--fg-faint)", margin: "0 0 10px" }}>
            Checked at{" "}
            <time dateTime={new Date(health.checkedAt).toISOString()}>
              {new Date(health.checkedAt).toLocaleString()}
            </time>
            .
          </p>

          {/* Lifecycle totals — non-color, count-only summary. */}
          <div className="rb-rows" style={{ marginBottom: 14 }}>
            {RELATIONSHIP_LIFECYCLE_STATES.filter(
              (s: RelationshipLifecycleState) => (health.totals[s] ?? 0) > 0,
            ).map((s: RelationshipLifecycleState) => (
              <div key={s} className="rb-row">
                <span className="rb-row-k">{s}</span>
                <span className="rb-row-v mono">{String(health.totals[s] ?? 0)}</span>
              </div>
            ))}
          </div>

          {totalFindings(health.findings) === 0 ? (
            <div className="lk-empty">
              <p className="lk-empty-title">Healthy</p>
              <p className="lk-empty-body">No relationship-graph defects were found.</p>
            </div>
          ) : (
            <>
              {relationshipCategories(health.findings).map((category) => (
                <RelationshipFindingList
                  key={category.key}
                  category={category}
                  onSelectRelationship={onSelectRelationship}
                />
              ))}
              <OrphanedEndpointList findings={health.findings} />
            </>
          )}
        </>
      )}
    </div>
  );
}
