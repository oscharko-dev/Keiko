// Issue #542 (Epic #532) — bounded impact / dependency detail card.
//
// Renders the result of the bounded dependency walk for a relationship in both directions:
//   • Downstream — what the relationship's target leads to (outgoing edges).
//   • Upstream   — what leads into the relationship's source (incoming edges).
// Each direction lists the impacted endpoints and relationships and states truncation explicitly
// (#542 AC: "UI explains truncation or insufficient evidence states clearly").
//
// The impacted set is derived by `deriveImpact` (relationships/impact.ts), NOT by dropping the
// first endpoint: the wire report always carries the origin relationship and BOTH of its
// endpoints, so `endpoints.slice(1)` left the origin's other endpoint in the list and no direction
// could ever read zero. The inspector's forward/reverse counts call the same derivation.
//
// A FAILED walk is stated, never hidden: the card used to render "Loading…" forever because the
// inspector swallowed the error and kept both reports at null.
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
import { deriveImpact, type ImpactOrigin } from "../../../../relationships/impact";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";

const UI_RENDER_CAP = 50;

function endpointLabel(node: DependencyNode): string {
  return `${node.kind}: ${node.id}`;
}

function TruncationNote({ t }: { readonly t: I18nTranslate }): ReactNode {
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
      {t("relationships.impact.truncated")}
    </p>
  );
}

function PathRelationships({
  relationships,
  onSelectRelationship,
  t,
}: {
  readonly relationships: readonly ApiRelationship[];
  readonly onSelectRelationship: (id: string) => void;
  readonly t: I18nTranslate;
}): ReactNode {
  if (relationships.length === 0) return null;
  const shown = relationships.slice(0, UI_RENDER_CAP);
  return (
    <details style={{ marginTop: 6 }}>
      <summary style={{ fontSize: 11, color: "var(--fg-muted)", cursor: "pointer" }}>
        {t(
          relationships.length === 1
            ? "relationships.impact.pathRelationship"
            : "relationships.impact.pathRelationships",
          { count: relationships.length },
        )}
      </summary>
      <ul style={{ listStyle: "none", margin: "4px 0 0", padding: 0 }}>
        {shown.map((rel: ApiRelationship) => (
          <li key={rel.id} style={{ marginBottom: 2 }}>
            <button
              type="button"
              className="arun-btn ghost"
              onClick={() => onSelectRelationship(rel.id)}
              aria-label={t("relationships.impact.inspectAria", {
                type: rel.type,
                source: `${rel.source.kind} ${rel.source.id}`,
                target: `${rel.target.kind} ${rel.target.id}`,
              })}
              style={{
                display: "flex",
                width: "100%",
                gap: "var(--space-3)",
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
  );
}

function ImpactedEndpoints({
  endpoints,
  t,
}: {
  readonly endpoints: readonly DependencyNode[];
  readonly t: I18nTranslate;
}): ReactNode {
  const shown = endpoints.slice(0, UI_RENDER_CAP);
  return (
    <>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {shown.map((node) => (
          <li key={`${node.kind}:${node.id}`} className="rb-row" style={{ fontSize: 12 }}>
            <span className="mono">{endpointLabel(node)}</span>
          </li>
        ))}
      </ul>
      {endpoints.length > shown.length && (
        <p role="note" style={{ margin: "4px 0 0", fontSize: 11, color: "var(--fg-muted)" }}>
          {t("relationships.impact.showingFirst", {
            cap: UI_RENDER_CAP,
            count: endpoints.length,
          })}
        </p>
      )}
    </>
  );
}

function ImpactDirection({
  testId,
  title,
  help,
  report,
  origin,
  onSelectRelationship,
  t,
}: {
  readonly testId: string;
  readonly title: string;
  readonly help: string;
  readonly report: DependencyReport | null;
  readonly origin: ImpactOrigin;
  readonly onSelectRelationship: (id: string) => void;
  readonly t: I18nTranslate;
}): ReactNode {
  if (report === null) {
    return (
      <section style={{ marginBottom: 12 }} data-testid={testId}>
        <h4 className="rb-section-label">{title}</h4>
        <p style={{ fontSize: 12, color: "var(--fg-muted)", margin: 0 }}>
          {t("relationships.impact.loading")}
        </p>
      </section>
    );
  }
  const impact = deriveImpact(report, origin);

  return (
    <section style={{ marginBottom: 12 }} aria-label={title} data-testid={testId}>
      <h4 className="rb-section-label">
        {title}
        <span className="rb-count" aria-hidden="true">
          {impact.endpoints.length}
        </span>
      </h4>
      <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--fg-muted)" }}>{help}</p>

      {impact.endpoints.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--fg-muted)", margin: 0 }}>
          {t("relationships.impact.none")}
        </p>
      ) : (
        <>
          <ImpactedEndpoints endpoints={impact.endpoints} t={t} />
          <PathRelationships
            relationships={impact.relationships}
            onSelectRelationship={onSelectRelationship}
            t={t}
          />
        </>
      )}
      {report.truncated && <TruncationNote t={t} />}
    </section>
  );
}

export function RelationshipImpactCard({
  outgoing,
  incoming,
  origin,
  error = null,
  onRetryImpact,
  onSelectRelationship,
}: {
  readonly outgoing: DependencyReport | null;
  readonly incoming: DependencyReport | null;
  readonly origin: ImpactOrigin;
  /** Message from a failed walk. Non-null replaces both directions — neither report exists. */
  readonly error?: string | null;
  readonly onRetryImpact?: (() => void) | undefined;
  readonly onSelectRelationship: (id: string) => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <div
      style={{
        marginTop: 8,
        padding: "8px 10px",
        border: "1px solid var(--line)",
        borderRadius: 8,
        background: "var(--inset)",
      }}
      aria-label={t("relationships.impact.cardAria")}
    >
      {error !== null ? (
        // A failed walk is a degraded SECTION, not a failed panel: role=status keeps it out of
        // the assertive queue the inspector's own error banner owns (error-and-denial-ux.md §10).
        <div className="lk-alert" role="status" data-testid="impact-error">
          <span>{error}</span>
          {onRetryImpact !== undefined && (
            <button type="button" className="lk-alert-retry" onClick={onRetryImpact}>
              {t("relationships.impact.retry")}
            </button>
          )}
        </div>
      ) : (
        <>
          <ImpactDirection
            testId="impact-downstream"
            title={t("relationships.impact.downstreamTitle")}
            help={t("relationships.impact.downstreamHelp")}
            report={outgoing}
            origin={origin}
            onSelectRelationship={onSelectRelationship}
            t={t}
          />
          <ImpactDirection
            testId="impact-upstream"
            title={t("relationships.impact.upstreamTitle")}
            help={t("relationships.impact.upstreamHelp")}
            report={incoming}
            origin={origin}
            onSelectRelationship={onSelectRelationship}
            t={t}
          />
        </>
      )}
    </div>
  );
}
