// Issue #542 (Epic #532) — bounded impact / dependency detail card.
//
// Renders the result of the bounded dependency walk for a relationship in both directions:
//   • Downstream — what the relationship's target leads to (outgoing edges).
//   • Upstream   — what leads into the relationship's source (incoming edges).
// Each direction lists the impacted endpoints and relationships and states truncation explicitly
// (#542 AC: "UI explains truncation or insufficient evidence states clearly").
//
// Presentational only: the inspector already fetches both reports (for the forward/reverse counts),
// so this card receives them as props rather than re-fetching. Render is UI-capped at UI_RENDER_CAP
// per list on top of the server's bound, so a high-degree node cannot cause unbounded rendering.
//
// State is conveyed by text + counts, never colour alone. No new dependency, CSS var, or @keyframes.

"use client";

import type { ReactNode } from "react";
import type {
  DependencyReport,
  DependencyNode,
  ApiRelationship,
} from "../../../../relationships/api";

const UI_RENDER_CAP = 50;

function endpointLabel(node: DependencyNode): string {
  return `${node.kind}: ${node.id}`;
}

function TruncationNote(): ReactNode {
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
      The walk hit a bound before the graph was fully traversed; more objects may be affected than
      shown.
    </p>
  );
}

function ImpactDirection({
  title,
  help,
  report,
  onSelectRelationship,
}: {
  title: string;
  help: string;
  report: DependencyReport | null;
  onSelectRelationship: (id: string) => void;
}): ReactNode {
  if (report === null) {
    return (
      <section style={{ marginBottom: 12 }}>
        <div className="rb-section-label" role="heading" aria-level={4}>
          {title}
        </div>
        <p style={{ fontSize: 12, color: "var(--fg-muted)", margin: 0 }}>Loading…</p>
      </section>
    );
  }
  // The walk always includes the origin endpoint; the impacted set is everything beyond it.
  const impactedEndpoints = report.endpoints.slice(1);
  const relationships = report.relationships;
  const endpointsShown = impactedEndpoints.slice(0, UI_RENDER_CAP);
  const relsShown = relationships.slice(0, UI_RENDER_CAP);

  return (
    <section style={{ marginBottom: 12 }} aria-label={title}>
      <div className="rb-section-label" role="heading" aria-level={4}>
        {title}
        <span className="rb-count" aria-hidden="true">
          {impactedEndpoints.length}
        </span>
      </div>
      <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--fg-muted)" }}>{help}</p>

      {impactedEndpoints.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--fg-muted)", margin: 0 }}>
          No further objects are affected in this direction.
        </p>
      ) : (
        <>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {endpointsShown.map((node) => (
              <li key={`${node.kind}:${node.id}`} className="rb-row" style={{ fontSize: 12 }}>
                <span className="mono">{endpointLabel(node)}</span>
              </li>
            ))}
          </ul>
          {impactedEndpoints.length > endpointsShown.length && (
            <p role="note" style={{ margin: "4px 0 0", fontSize: 11, color: "var(--fg-muted)" }}>
              Showing the first {String(UI_RENDER_CAP)} of {String(impactedEndpoints.length)}{" "}
              objects.
            </p>
          )}
          {relationships.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ fontSize: 11, color: "var(--fg-muted)", cursor: "pointer" }}>
                {String(relationships.length)} relationship
                {relationships.length === 1 ? "" : "s"} on the path
              </summary>
              <ul style={{ listStyle: "none", margin: "4px 0 0", padding: 0 }}>
                {relsShown.map((rel: ApiRelationship) => (
                  <li key={rel.id} style={{ marginBottom: 2 }}>
                    <button
                      type="button"
                      className="arun-btn ghost"
                      onClick={() => onSelectRelationship(rel.id)}
                      aria-label={`Inspect ${rel.type} relationship from ${rel.source.kind} ${rel.source.id} to ${rel.target.kind} ${rel.target.id}`}
                      style={{
                        display: "flex",
                        width: "100%",
                        gap: 6,
                        alignItems: "center",
                        textAlign: "left",
                        fontSize: 12,
                      }}
                    >
                      <span className="mono">{rel.type}</span>
                      <span style={{ color: "var(--fg-muted)" }}>
                        {rel.source.id} → {rel.target.id}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {report.truncated && <TruncationNote />}
    </section>
  );
}

export function RelationshipImpactCard({
  outgoing,
  incoming,
  onSelectRelationship,
}: {
  readonly outgoing: DependencyReport | null;
  readonly incoming: DependencyReport | null;
  readonly onSelectRelationship: (id: string) => void;
}): ReactNode {
  return (
    <div
      style={{
        marginTop: 8,
        padding: "8px 10px",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--inset)",
      }}
      aria-label="Bounded impact analysis"
    >
      <ImpactDirection
        title="Downstream impact"
        help="Objects this relationship's target leads to. Deleting or revoking here may affect them."
        report={outgoing}
        onSelectRelationship={onSelectRelationship}
      />
      <ImpactDirection
        title="Upstream impact"
        help="Objects that depend on this relationship's source."
        report={incoming}
        onSelectRelationship={onSelectRelationship}
      />
    </div>
  );
}
