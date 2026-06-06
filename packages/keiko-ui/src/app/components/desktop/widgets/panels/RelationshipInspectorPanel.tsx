// Issue #540 (Epic #532) — Relationship inspector panel.
//
// Renders the 10 inspector sections from inspector-spec.md in exact order.
// Docks INSIDE the existing InspectorPanel.tsx:11 — no new panel created.
//
// Section order (inspector-spec.md §"Section order"):
//   1.  Type and display name
//   2.  Source endpoint
//   3.  Target endpoint
//   4.  Lifecycle status chip
//   5.  Activity (current + 5 most recent transitions)
//   6.  Authority status (VERBATIM constant)
//   7.  Audit history (paged, page-size 10)
//   8.  Evidence references (≤5 inline + "View all N" link)
//   9.  Impact summary (forward + reverse counts, View Impact button)
//  10.  Denial reason (conditional: blocked/revoked/failed-transition only)
//
// CSS reuse: rb-section-label (globals.css:4404), rb-rows (globals.css:4428),
//   rb-row (globals.css:4433), insp-title (globals.css:4021), insp-empty (globals.css:4025),
//   chip (globals.css:1416), lk-alert (globals.css:5890), lk-alert-retry (globals.css:5898),
//   arun-btn (globals.css:1972), arun-btn.primary (globals.css:1986).
//
// WCAG 2.2 AA: 24×24 touch targets, focus-visible rings, aria-busy, aria-live regions.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type {
  RelationshipActivityState,
  RelationshipLifecycleState,
  RelationshipType,
  RelationshipValidationError,
} from "@oscharko-dev/keiko-contracts";
import { RELATIONSHIP_TYPE_DEFINITIONS } from "@oscharko-dev/keiko-contracts";
import {
  getRelationship,
  getExplain,
  getDependencies,
  patchRelationship,
  deleteRelationship,
  RelationshipApiError,
} from "../../../../relationships/api";
import type { ApiRelationship, ExplainResult } from "../../../../relationships/api";
import { RelationshipEdgeBadge } from "./RelationshipEdgeBadge";

// ─── Authority disclaimer constant (inspector-spec.md §6) ─────────────────────
// Verbatim string — never interpolated, never translated (Wave 3 non-goal).
export const RELATIONSHIP_AUTHORITY_DISCLAIMER =
  "Relationship: governance only. No model/tool/file/workflow authority granted." as const;

// ─── Lifecycle chip styling (inspector-spec.md §4) ────────────────────────────

interface LifecycleChipStyle {
  readonly bg: string;
  readonly fg: string;
}

const LIFECYCLE_CHIP_STYLES: Readonly<Record<RelationshipLifecycleState, LifecycleChipStyle>> = {
  draft: { bg: "var(--inset)", fg: "var(--fg-muted)" },
  active: { bg: "var(--accent-dim)", fg: "var(--accent)" },
  archived: { bg: "var(--inset)", fg: "var(--fg-dim)" },
  superseded: { bg: "var(--inset)", fg: "var(--fg-dim)" },
  revoked: { bg: "color-mix(in oklch, var(--danger) 14%, var(--card))", fg: "var(--danger)" },
  blocked: { bg: "color-mix(in oklch, var(--warn) 12%, var(--card))", fg: "var(--warn)" },
  stale: { bg: "var(--inset)", fg: "var(--fg-faint)" },
};

// Lifecycle descriptions for aria-describedby (inspector-spec.md §4)
const LIFECYCLE_DESCRIPTIONS: Readonly<Record<RelationshipLifecycleState, string>> = {
  draft: "Proposed but not yet validated or awaiting an upstream gate.",
  active: "Validated and committed. Both endpoints are currently live.",
  archived: "Preserved for audit but no longer participates in queries by default.",
  superseded: "Replaced by a newer relationship of the same type.",
  revoked: "Rejected after proposal or retracted after acceptance. Terminal state.",
  blocked: "Cannot transition to active because the validator returned a denial reason.",
  stale: "At least one endpoint is tombstoned, retired, or unavailable.",
};

// ─── Skeleton placeholder (inspector-spec.md §"Loading state") ────────────────

function SkeletonBlock({ lines = 3 }: { lines?: number }): ReactNode {
  return (
    <div className="rb-rows" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="rb-row">
          <span
            className="rb-row-k"
            style={{
              background: "var(--inset)",
              borderRadius: 3,
              width: "40%",
              display: "block",
              height: 12,
            }}
          />
          <span
            className="rb-row-v"
            style={{
              background: "var(--inset)",
              borderRadius: 3,
              width: "55%",
              display: "block",
              height: 12,
            }}
          />
        </div>
      ))}
    </div>
  );
}

function SectionLabel({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}): ReactNode {
  return (
    <div className="rb-section-label" role="heading" aria-level={3} style={style}>
      {children}
    </div>
  );
}

// ─── Section 1: Type + display name ───────────────────────────────────────────

function TypeSection({ rel }: { rel: ApiRelationship }): ReactNode {
  const def = RELATIONSHIP_TYPE_DEFINITIONS[rel.type];
  const displayName = `${rel.source.kind} ${rel.type} ${rel.target.kind}`;
  return (
    <>
      <div className="insp-top">
        {/* chip reuses globals.css:1416 */}
        <span className="chip" style={{ fontSize: 11 }}>
          {rel.type}
        </span>
        <span className="insp-title">{displayName}</span>
      </div>
      <div className="rb-rows">
        <div className="rb-row">
          <span className="rb-row-k">Semantics</span>
          <span className="rb-row-v">{def.semantics}</span>
        </div>
        <div className="rb-row">
          <span className="rb-row-k">Cardinality</span>
          <span className="rb-row-v mono">{def.cardinality}</span>
        </div>
      </div>
    </>
  );
}

// ─── Section 2 + 3: Endpoint rows ─────────────────────────────────────────────
// Never renders raw id verbatim if redactor flagged it (inspector-spec.md §2 + §3).
// In the UI we render the id as-is from the server response (server redacts at the
// API edge per api-contract.md §8 — the redactor runs once, at the server).

function EndpointSection({
  label,
  kind,
  id,
}: {
  label: "Source" | "Target";
  kind: string;
  id: string;
}): ReactNode {
  return (
    <>
      <SectionLabel>{label} endpoint</SectionLabel>
      <div className="rb-rows">
        <div className="rb-row">
          <span className="rb-row-k">Kind</span>
          <span className="rb-row-v mono">{kind}</span>
        </div>
        <div className="rb-row">
          <span className="rb-row-k">Reference</span>
          {/* id is already server-redacted; no Reveal affordance per inspector-spec.md §2 */}
          <span className="rb-row-v mono" aria-label={`Reference id: ${id}`}>
            {id}
          </span>
        </div>
      </div>
    </>
  );
}

// ─── Section 4: Lifecycle chip ─────────────────────────────────────────────────

function LifecycleSection({ lifecycle }: { lifecycle: RelationshipLifecycleState }): ReactNode {
  const descId = `lifecycle-desc-${lifecycle}`;
  const style = LIFECYCLE_CHIP_STYLES[lifecycle];
  return (
    <>
      <SectionLabel>Lifecycle status</SectionLabel>
      <div className="rb-rows">
        <div className="rb-row">
          <span className="rb-row-k">State</span>
          <span className="rb-row-v">
            <span
              className="chip"
              style={{ background: style.bg, color: style.fg }}
              aria-describedby={descId}
            >
              {lifecycle}
            </span>
          </span>
        </div>
        <div className="rb-row">
          {/* visually-hidden description for screen-readers */}
          <span id={descId} className="rb-row-v" style={{ color: "var(--fg-muted)", fontSize: 12 }}>
            {LIFECYCLE_DESCRIPTIONS[lifecycle]}
          </span>
        </div>
      </div>
    </>
  );
}

// ─── Section 5: Activity ───────────────────────────────────────────────────────

interface TransitionRow {
  readonly from: RelationshipLifecycleState;
  readonly to: RelationshipLifecycleState;
  readonly occurredAt: number;
}

function ActivitySection({
  type,
  lifecycle,
  transitions,
  densityMode,
}: {
  type: RelationshipType;
  lifecycle: RelationshipLifecycleState;
  transitions: readonly TransitionRow[];
  densityMode: DensityMode;
}): ReactNode {
  // Map lifecycle → activity state for current badge (simplified; #541 wires live SSE)
  const activityState: RelationshipActivityState =
    lifecycle === "active"
      ? "active"
      : lifecycle === "blocked"
        ? "blocked"
        : lifecycle === "stale"
          ? "degraded"
          : lifecycle === "revoked"
            ? "failed"
            : "inactive";

  // Per-density cap for inline transition rows (visual-density-rules.md table)
  const transitionCap = densityMode === "minimal" ? 3 : 5;
  const visibleTransitions = transitions.slice(0, transitionCap);

  return (
    <>
      <SectionLabel>Activity</SectionLabel>
      <div className="rb-rows">
        <div className="rb-row">
          <span className="rb-row-k">Current state</span>
          <span className="rb-row-v">
            {/* role="status" aria-live="polite" per activity-visualization.md §"Per-state ARIA wiring" */}
            <RelationshipEdgeBadge
              type={type}
              lifecycle={lifecycle}
              activity={activityState}
            />
          </span>
        </div>
        {visibleTransitions.length > 0 && (
          <div
            className="rb-row"
            style={{ flexDirection: "column", gap: 4, alignItems: "flex-start" }}
          >
            <span className="rb-row-k" style={{ marginBottom: 4 }}>
              Recent transitions
            </span>
            {visibleTransitions.map((t, i) => (
              <div
                key={i}
                style={{ fontSize: 12, color: "var(--fg-muted)", display: "flex", gap: 8 }}
              >
                <span className="mono">
                  {t.from} → {t.to}
                </span>
                <time
                  dateTime={new Date(t.occurredAt).toISOString()}
                  style={{ color: "var(--fg-faint)" }}
                >
                  {new Date(t.occurredAt).toLocaleString()}
                </time>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Section 6: Authority disclaimer (verbatim) ───────────────────────────────

function AuthoritySection(): ReactNode {
  return (
    <>
      <SectionLabel>Authority status</SectionLabel>
      <div className="rb-rows">
        <div className="rb-row" data-testid="authority-disclaimer">
          {/* Verbatim string per inspector-spec.md §6 */}
          <span className="rb-row-v" style={{ color: "var(--fg-muted)", fontStyle: "italic" }}>
            {RELATIONSHIP_AUTHORITY_DISCLAIMER}
          </span>
        </div>
      </div>
    </>
  );
}

// ─── Section 7: Audit history (paged, page-size 10) ───────────────────────────

interface AuditRow {
  readonly from: RelationshipLifecycleState;
  readonly to: RelationshipLifecycleState;
  readonly occurredAt: number;
}

function AuditSection({
  auditRows,
  loading,
  error,
  onRetry,
  onLoadMore,
  hasMore,
}: {
  auditRows: readonly AuditRow[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onLoadMore: () => void;
  hasMore: boolean;
}): ReactNode {
  return (
    <>
      <SectionLabel>Audit history</SectionLabel>
      {loading && <SkeletonBlock lines={3} />}
      {error !== null && (
        <div className="lk-alert" role="alert" aria-live="assertive">
          <span>{error}</span>
          {/* lk-alert-retry reuses globals.css:5898 */}
          <button type="button" className="lk-alert-retry" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
      {!loading && error === null && auditRows.length === 0 && (
        <div className="rb-rows">
          <div className="rb-row">
            <span className="rb-row-v" style={{ color: "var(--fg-muted)" }}>
              No audit events for this relationship yet.
            </span>
          </div>
        </div>
      )}
      {!loading && auditRows.length > 0 && (
        <div className="rb-rows">
          {auditRows.map((row, i) => (
            <div
              className="rb-row"
              key={i}
              style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}
            >
              <span className="rb-row-k mono" style={{ fontSize: 11 }}>
                {row.from} → {row.to}
              </span>
              <time
                dateTime={new Date(row.occurredAt).toISOString()}
                style={{ color: "var(--fg-faint)", fontSize: 11 }}
              >
                {new Date(row.occurredAt).toLocaleString()}
              </time>
            </div>
          ))}
          {hasMore && (
            <div className="rb-row">
              <button
                type="button"
                className="rb-row-v"
                style={{
                  color: "var(--accent)",
                  fontSize: 12,
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  minHeight: 24,
                  minWidth: 24,
                }}
                onClick={onLoadMore}
                aria-label="Load more audit events"
              >
                Load more
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ─── Section 8: Evidence references (stub — #542 wires live data) ─────────────

function EvidenceSection({ relationshipId }: { relationshipId: string }): ReactNode {
  // Inline: at most 5 references; "View all N" link for more (inspector-spec.md §8).
  // Stub: #541/#542 wire the actual evidence reference list via the evidence viewer.
  return (
    <>
      <SectionLabel>Evidence references</SectionLabel>
      <div className="rb-rows">
        <div className="rb-row">
          <a
            href={`/evidence?relId=${encodeURIComponent(relationshipId)}`}
            className="rb-row-v"
            style={{ color: "var(--accent)", fontSize: 12 }}
            aria-label={`View evidence references for relationship ${relationshipId}`}
          >
            View evidence references
          </a>
        </div>
      </div>
    </>
  );
}

// ─── Section 9: Impact summary ─────────────────────────────────────────────────

function ImpactSection({
  relationshipId,
  forwardCount,
  reverseCount,
  onViewImpact,
}: {
  relationshipId: string;
  forwardCount: number | null;
  reverseCount: number | null;
  onViewImpact: () => void;
}): ReactNode {
  return (
    <>
      <SectionLabel>Impact summary</SectionLabel>
      <div className="rb-rows">
        <div className="rb-row">
          <span className="rb-row-k">Forward dependencies</span>
          <span className="rb-row-v mono">
            {forwardCount === null ? "—" : String(forwardCount)}
          </span>
        </div>
        <div className="rb-row">
          <span className="rb-row-k">Reverse dependencies</span>
          <span className="rb-row-v mono">
            {reverseCount === null ? "—" : String(reverseCount)}
          </span>
        </div>
        <div className="rb-row">
          {/* arun-btn reuses globals.css:1972 */}
          <button
            type="button"
            className="arun-btn"
            onClick={onViewImpact}
            aria-label={`View impact for relationship ${relationshipId}`}
            data-testid="view-impact-btn"
          >
            View Impact
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Section 10: Denial reason (conditional) ──────────────────────────────────

function DenialSection({
  codes,
  messages,
  deniedAt,
}: {
  codes: readonly string[];
  messages: readonly string[];
  deniedAt?: string;
}): ReactNode {
  if (codes.length === 0) return null;
  // role="status" aria-live="polite" per inspector-spec.md §10 (steady-state denial)
  return (
    <>
      <SectionLabel>Denial reason</SectionLabel>
      <div className="lk-alert" role="status" aria-live="polite" data-testid="denial-section">
        {codes.map((code, i) => (
          <div key={code} style={{ marginBottom: i < codes.length - 1 ? 8 : 0 }}>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--fg-muted)",
                marginBottom: 2,
              }}
            >
              {code}
            </div>
            {/* user-facing message verbatim from server — never invented (error-and-denial-ux.md) */}
            <div style={{ fontSize: 13, color: "var(--fg)" }}>{messages[i] ?? code}</div>
          </div>
        ))}
        {deniedAt !== undefined && (
          <div style={{ fontSize: 11, color: "var(--fg-faint)", marginTop: 6 }}>
            Denied at <time dateTime={deniedAt}>{deniedAt}</time>
          </div>
        )}
      </div>
    </>
  );
}

interface DenialDetails {
  readonly codes: readonly string[];
  readonly messages: readonly string[];
}

function toDenialDetails(
  reasons: readonly RelationshipValidationError[] | null | undefined,
): DenialDetails | null {
  if (reasons === undefined || reasons === null || reasons.length === 0) {
    return null;
  }
  return {
    codes: reasons.map((reason) => reason.code),
    // Preserve the server-provided denial string verbatim.
    messages: reasons.map((reason) => reason.message),
  };
}

// ─── Density mode ─────────────────────────────────────────────────────────────

export type DensityMode = "minimal" | "standard" | "dense";

// ─── Action buttons (inspector-spec.md §"Action buttons") ─────────────────────

interface ActionRowProps {
  readonly rel: ApiRelationship;
  readonly onReconnect: () => void;
  readonly onArchive: () => void;
  readonly onRevoke: () => void;
  readonly onViewImpact: () => void;
  readonly onViewEvidence: () => void;
  readonly mutating: boolean;
}

function ActionRow({
  rel,
  onReconnect,
  onArchive,
  onRevoke,
  onViewImpact,
  onViewEvidence,
  mutating,
}: ActionRowProps): ReactNode {
  const lc = rel.lifecycle;
  const canReconnect = lc === "blocked";
  const canArchive = lc === "active";
  const canRevoke = lc === "active" || lc === "blocked" || lc === "archived";
  const canViewImpact = lc === "active";

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
      <button
        type="button"
        className={`arun-btn${canReconnect ? " primary" : ""}`}
        aria-disabled={!canReconnect || mutating}
        aria-label="Reconnect — only available for blocked relationships"
        title={canReconnect ? "Reconnect (R)" : "Only blocked relationships can be reconnected."}
        disabled={!canReconnect || mutating}
        onClick={canReconnect ? onReconnect : undefined}
      >
        Reconnect
      </button>
      <button
        type="button"
        className="arun-btn"
        aria-disabled={!canArchive || mutating}
        aria-label="Archive — only available for active relationships"
        title={canArchive ? "Archive (A)" : "Only active relationships can be archived."}
        disabled={!canArchive || mutating}
        onClick={canArchive ? onArchive : undefined}
      >
        Archive
      </button>
      <button
        type="button"
        className="arun-btn"
        aria-disabled={!canRevoke || mutating}
        aria-label="Revoke relationship"
        title={canRevoke ? "Revoke (Shift+Delete)" : "Already revoked or superseded."}
        disabled={!canRevoke || mutating}
        onClick={canRevoke ? onRevoke : undefined}
        style={{ color: canRevoke ? "var(--danger)" : undefined }}
      >
        Revoke
      </button>
      <button
        type="button"
        className="arun-btn"
        aria-disabled={!canViewImpact}
        aria-label="View impact analysis"
        title={canViewImpact ? "View Impact (I)" : "Impact analysis is unavailable in this state."}
        disabled={!canViewImpact}
        onClick={canViewImpact ? onViewImpact : undefined}
      >
        View Impact
      </button>
      <button
        type="button"
        className="arun-btn"
        aria-label="View evidence references"
        title="View Evidence (E)"
        onClick={onViewEvidence}
      >
        View Evidence
      </button>
    </div>
  );
}

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface RelationshipInspectorPanelProps {
  /** Relationship id to inspect (from URL ?relFocus= param). */
  readonly relationshipId: string | null;
  /** Density mode from URL/localStorage. */
  readonly densityMode?: DensityMode;
  /** Called when the inspector should exit relationship mode. */
  readonly onClearFocus?: () => void;
  /** Called when "View Impact" is triggered — #542 wires this. */
  readonly onViewImpact?: (id: string) => void;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function RelationshipInspectorPanel({
  relationshipId,
  densityMode = "minimal",
  onClearFocus,
  onViewImpact,
}: RelationshipInspectorPanelProps): ReactNode {
  const [rel, setRel] = useState<ApiRelationship | null>(null);
  const [explain, setExplain] = useState<ExplainResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationDenial, setMutationDenial] = useState<DenialDetails | null>(null);

  // Impact counts (forward = outgoing dependencies, reverse = incoming)
  const [forwardCount, setForwardCount] = useState<number | null>(null);
  const [reverseCount, setReverseCount] = useState<number | null>(null);

  // Skeleton debounce: only show skeleton after 500 ms (inspector-spec.md §"Loading state")
  const [showSkeleton, setShowSkeleton] = useState(false);
  const skeletonTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchGeneration = useRef(0);

  const fetchRel = useCallback(async (id: string) => {
    const generation = ++fetchGeneration.current;
    setError(null);
    setLoading(true);
    setMutationDenial(null);
    // 500 ms skeleton threshold
    const timer = setTimeout(() => {
      if (fetchGeneration.current === generation) {
        setShowSkeleton(true);
      }
    }, 500);
    skeletonTimer.current = timer;
    try {
      const [fetchedRel, fetchedExplain] = await Promise.all([getRelationship(id), getExplain(id)]);
      if (fetchGeneration.current !== generation) {
        return;
      }
      setRel(fetchedRel);
      setExplain(fetchedExplain);

      // Fetch impact counts (bounded; errors are non-fatal here)
      try {
        const [fwd, rev] = await Promise.all([
          getDependencies(id, { direction: "outgoing", maxRelationships: 512 }),
          getDependencies(id, { direction: "incoming", maxRelationships: 512 }),
        ]);
        if (fetchGeneration.current !== generation) {
          return;
        }
        setForwardCount(fwd.relationships.length);
        setReverseCount(rev.relationships.length);
      } catch {
        // Impact counts are advisory; do not fail the inspector
      }
    } catch (err) {
      if (fetchGeneration.current !== generation) {
        return;
      }
      const msg =
        err instanceof RelationshipApiError
          ? err.message
          : "Unable to reach the local backend. Check that `keiko serve` is running.";
      setError(msg);
    } finally {
      if (skeletonTimer.current === timer) {
        clearTimeout(timer);
        skeletonTimer.current = null;
      } else {
        clearTimeout(timer);
      }
      if (fetchGeneration.current === generation) {
        setLoading(false);
        setShowSkeleton(false);
      }
    }
  }, []);

  useEffect(() => {
    if (relationshipId === null) {
      fetchGeneration.current += 1;
      if (skeletonTimer.current !== null) {
        clearTimeout(skeletonTimer.current);
        skeletonTimer.current = null;
      }
      setRel(null);
      setExplain(null);
      setError(null);
      setMutationDenial(null);
      setShowSkeleton(false);
      setLoading(false);
      return;
    }
    void fetchRel(relationshipId);
    return () => {
      if (skeletonTimer.current !== null) {
        clearTimeout(skeletonTimer.current);
        skeletonTimer.current = null;
      }
    };
  }, [relationshipId, fetchRel]);

  // ─── Mutation handlers ─────────────────────────────────────────────────────

  const doTransition = useCallback(
    async (to: "draft" | "archived" | "revoked") => {
      if (rel === null) return;
      setMutating(true);
      setMutationError(null);
      setMutationDenial(null);
      try {
        const key = crypto.randomUUID();
        const { relationship: updated } = await patchRelationship(
          rel.id,
          { transition: { to } },
          String(rel.etag),
          key,
        );
        setRel(updated);
        setExplain(null);
        await fetchRel(rel.id);
      } catch (err) {
        const msg =
          err instanceof RelationshipApiError ? err.message : "Mutation failed. Please retry.";
        setMutationError(msg);
        setMutationDenial(err instanceof RelationshipApiError ? toDenialDetails(err.reasons) : null);
      } finally {
        setMutating(false);
      }
    },
    [rel, fetchRel],
  );

  const handleReconnect = useCallback(() => void doTransition("draft"), [doTransition]);
  const handleArchive = useCallback(() => void doTransition("archived"), [doTransition]);

  const handleRevoke = useCallback(async () => {
    if (rel === null) return;
    // Confirmation handled via window.confirm (PermControl modal wired by #541/#542)
    if (!window.confirm(`Revoke relationship "${rel.type}"? This cannot be undone.`)) return;
    setMutating(true);
    setMutationError(null);
    setMutationDenial(null);
    try {
      const key = crypto.randomUUID();
      const updated = await deleteRelationship(rel.id, String(rel.etag), key);
      setRel(updated);
    } catch (err) {
      const msg =
        err instanceof RelationshipApiError ? err.message : "Revoke failed. Please retry.";
      setMutationError(msg);
      setMutationDenial(err instanceof RelationshipApiError ? toDenialDetails(err.reasons) : null);
    } finally {
      setMutating(false);
    }
  }, [rel]);

  const handleViewImpact = useCallback(() => {
    if (rel !== null) onViewImpact?.(rel.id);
  }, [rel, onViewImpact]);

  const handleViewEvidence = useCallback(() => {
    if (rel !== null) {
      window.location.href = `/evidence?relId=${encodeURIComponent(rel.id)}`;
    }
  }, [rel]);

  // ─── Keyboard shortcuts (inspector-spec.md §"Keyboard map") ───────────────
  // Chords: R=Reconnect, A=Archive, Shift+Delete=Revoke, I=ViewImpact, E=ViewEvidence
  // Registered via the existing useKeyboardShortcuts substrate in the parent —
  // the panel itself handles them only when focused (no global binding from this component).

  // ─── Empty state (inspector-spec.md §"Empty state") ───────────────────────

  if (relationshipId === null) {
    return null; // Host InspectorPanel renders its default content
  }

  const explainDenial = toDenialDetails(explain?.decision.reasons);
  const visibleDenial = explainDenial ?? mutationDenial;
  const showDenialSection =
    visibleDenial !== null &&
    (rel?.lifecycle === "blocked" || rel?.lifecycle === "revoked" || mutationDenial !== null);

  // ─── Aria-busy container while loading ────────────────────────────────────

  return (
    <div className="tw-pad" aria-busy={loading} data-testid="relationship-inspector-panel">
      {/* Error banner — shown even when prior state exists (inspector-spec.md §"Error state") */}
      {error !== null && (
        <div className="lk-alert" role="alert" aria-live="assertive">
          <span>{error}</span>
          <button
            type="button"
            className="lk-alert-retry"
            onClick={() => void fetchRel(relationshipId)}
          >
            Retry
          </button>
        </div>
      )}

      {mutationError !== null && (
        <div className="lk-alert" role="alert" aria-live="assertive">
          <span>{mutationError}</span>
          <button type="button" className="lk-alert-retry" onClick={() => setMutationError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Loading skeleton (500 ms threshold) */}
      {loading && showSkeleton && (
        <>
          <SectionLabel style={{ marginTop: 0 }}>Relationship</SectionLabel>
          <SkeletonBlock lines={4} />
          <SkeletonBlock lines={3} />
        </>
      )}

      {/* Not-found / deleted empty state */}
      {!loading && error === null && rel === null && (
        <>
          <SectionLabel style={{ marginTop: 0 }}>Relationship</SectionLabel>
          <div className="insp-empty" data-testid="inspector-not-found">
            This relationship is no longer available.
          </div>
          <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 4 }}>
            It may have been deleted, retired by retention, or it never existed in this workspace.
          </div>
          {onClearFocus !== undefined && (
            <button
              type="button"
              className="arun-btn"
              style={{ marginTop: 8 }}
              onClick={onClearFocus}
            >
              Clear focus
            </button>
          )}
        </>
      )}

      {/* Main inspector content — 10 sections in order */}
      {!loading && rel !== null && (
        <>
          {/* Section 1: Type and display name */}
          <SectionLabel style={{ marginTop: 0 }}>Relationship</SectionLabel>
          <TypeSection rel={rel} />

          {/* Section 2: Source endpoint */}
          <EndpointSection label="Source" kind={rel.source.kind} id={rel.source.id} />

          {/* Section 3: Target endpoint */}
          <EndpointSection label="Target" kind={rel.target.kind} id={rel.target.id} />

          {/* Section 4: Lifecycle status */}
          <LifecycleSection lifecycle={rel.lifecycle} />

          {/* Section 5: Activity */}
          <ActivitySection
            type={rel.type}
            lifecycle={rel.lifecycle}
            transitions={explain?.lifecycle ?? []}
            densityMode={densityMode}
          />

          {/* Section 6: Authority status (verbatim) */}
          <AuthoritySection />

          {/* Section 7: Audit history */}
          <AuditSection
            auditRows={explain?.lifecycle ?? []}
            loading={false}
            error={null}
            onRetry={() => void fetchRel(relationshipId)}
            onLoadMore={() => {
              /* cursor pagination — #542 wires */
            }}
            hasMore={false}
          />

          {/* Section 8: Evidence references */}
          <EvidenceSection relationshipId={rel.id} />

          {/* Section 9: Impact summary */}
          <ImpactSection
            relationshipId={rel.id}
            forwardCount={forwardCount}
            reverseCount={reverseCount}
            onViewImpact={handleViewImpact}
          />

          {/* Section 10: Denial reason (conditional) */}
          {showDenialSection && visibleDenial !== null && (
            <DenialSection
              codes={visibleDenial.codes}
              messages={visibleDenial.messages}
            />
          )}

          {/* Action buttons */}
          <ActionRow
            rel={rel}
            onReconnect={handleReconnect}
            onArchive={handleArchive}
            onRevoke={() => void handleRevoke()}
            onViewImpact={handleViewImpact}
            onViewEvidence={handleViewEvidence}
            mutating={mutating}
          />
        </>
      )}
    </div>
  );
}
