// Issue #542 (Epic #532) — Graph health panel.
//
// Surfaces the categorized health findings exposed by GET /api/relationships/health: orphaned
// endpoints, stale / blocked / failed (revoked) relationships, invalid references, and cycle
// participants — the operationally critical relationship-graph defects. Previously the backend
// computed these but no UI rendered them (closure-evidence.md known limitation). This panel closes
// that gap inside the existing Workspace window, reusing inspector chrome only.
//
// Truthfulness of a BOUNDED scan (the rule this panel exists to honour):
//   • Every category is server-bounded at MAX_RELATIONSHIPS_PER_QUERY and carries its own
//     `*Truncated` flag. A bounded scan may NOT certify a clean graph — the part it never read
//     can hold every defect there is. So a zero-finding scan renders "Healthy" only when nothing
//     was truncated; otherwise it renders as an explicitly inconclusive partial scan that names
//     the bounded categories.
//   • A truncated category reports its count as a LOWER bound ("N+" / "at least N"), and a
//     truncated category that returned no items at all is still disclosed instead of vanishing.
//   • Totals and findings are installation-wide: the relationship engine resolves exactly one
//     workspace per loopback process (deps.ts `resolveLoopbackWorkspaceId`), so the numbers are
//     labelled installation-wide rather than presented as this project's.
//
// Bounds + privacy:
//   • This panel additionally caps UI rendering at UI_RENDER_CAP per category and states the cap,
//     so a large graph cannot cause unbounded rendering (#542 AC, #541 high-throughput bound).
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
import { useTranslate, type I18nTranslate } from "@/lib/i18n";

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
function relationshipCategories(
  t: I18nTranslate,
  f: HealthFindings,
): readonly RelationshipCategory[] {
  return [
    {
      key: "invalid",
      label: t("relationships.health.category.invalid.label"),
      help: t("relationships.health.category.invalid.help"),
      items: f.invalidReferences,
      truncated: f.invalidReferencesTruncated,
    },
    {
      key: "blocked",
      label: t("relationships.health.category.blocked.label"),
      help: t("relationships.health.category.blocked.help"),
      items: f.blockedRelationships,
      truncated: f.blockedRelationshipsTruncated,
    },
    {
      key: "failed",
      label: t("relationships.health.category.failed.label"),
      help: t("relationships.health.category.failed.help"),
      items: f.failedRelationships,
      truncated: f.failedRelationshipsTruncated,
    },
    {
      key: "cycle",
      label: t("relationships.health.category.cycle.label"),
      help: t("relationships.health.category.cycle.help"),
      items: f.cycleParticipants,
      truncated: f.cycleScanTruncated,
    },
    {
      key: "stale",
      label: t("relationships.health.category.stale.label"),
      help: t("relationships.health.category.stale.help"),
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

// Labels of every category whose scan stopped at its bound — the vocabulary the inconclusive
// state and the lower-bound note need in order to say WHAT was left unread.
function boundedCategoryLabels(t: I18nTranslate, f: HealthFindings): readonly string[] {
  const labels = relationshipCategories(t, f)
    .filter((category) => category.truncated)
    .map((category) => category.label);
  if (f.orphanedEndpointsTruncated) labels.push(t("relationships.health.category.orphaned.label"));
  return labels;
}

// A count that came out of a bounded scan is a lower bound, never an exact figure.
function countLabel(t: I18nTranslate, label: string, count: number, truncated: boolean): string {
  const key = truncated
    ? "relationships.health.category.ariaAtLeast"
    : "relationships.health.category.aria";
  return t(key, { label, count });
}

// ─── Sub-renderers ─────────────────────────────────────────────────────────────

function NoteLine({
  children,
  testId,
  warn = false,
}: {
  readonly children: ReactNode;
  readonly testId?: string | undefined;
  readonly warn?: boolean;
}): ReactNode {
  return (
    <p
      role="note"
      {...(testId === undefined ? {} : { "data-testid": testId })}
      style={{
        margin: "4px 0 0",
        fontSize: 11,
        color: "var(--fg-muted)",
        ...(warn ? { borderLeft: "2px solid var(--warn)", paddingLeft: 8 } : {}),
      }}
    >
      {children}
    </p>
  );
}

function CategoryItems({
  category,
  onSelectRelationship,
  t,
}: {
  readonly category: RelationshipCategory;
  readonly onSelectRelationship: (id: string) => void;
  readonly t: I18nTranslate;
}): ReactNode {
  const shown = category.items.slice(0, UI_RENDER_CAP);
  return (
    <>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {shown.map((ref) => (
          <li key={ref.id} style={{ marginBottom: 2 }}>
            <button
              type="button"
              className="arun-btn ghost"
              onClick={() => onSelectRelationship(ref.id)}
              aria-label={t("relationships.health.inspectAria", {
                type: ref.type,
                source: endpointLabel(ref.source),
                target: endpointLabel(ref.target),
                lifecycle: ref.lifecycle,
              })}
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
      {category.items.length > shown.length && (
        <NoteLine>
          {t("relationships.health.category.showingFirst", {
            cap: UI_RENDER_CAP,
            count: category.items.length,
          })}
        </NoteLine>
      )}
    </>
  );
}

function RelationshipFindingList({
  category,
  onSelectRelationship,
  t,
}: {
  readonly category: RelationshipCategory;
  readonly onSelectRelationship: (id: string) => void;
  readonly t: I18nTranslate;
}): ReactNode {
  // A truncated category with zero returned items is still a category whose scan did not
  // finish — rendering nothing would hide that the bound was hit at all.
  if (category.items.length === 0 && !category.truncated) return null;
  return (
    <section
      aria-label={countLabel(t, category.label, category.items.length, category.truncated)}
      style={{ marginBottom: 14 }}
    >
      <h3 className="rb-section-label">
        {category.label}
        <span className="rb-count" aria-hidden="true">
          {category.truncated ? `${String(category.items.length)}+` : category.items.length}
        </span>
      </h3>
      <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--fg-muted)" }}>{category.help}</p>
      {category.items.length > 0 && (
        <CategoryItems category={category} onSelectRelationship={onSelectRelationship} t={t} />
      )}
      {category.truncated && (
        <NoteLine
          warn
          testId={category.items.length === 0 ? "health-category-bounded-empty" : undefined}
        >
          {category.items.length === 0
            ? t("relationships.health.category.boundedEmpty")
            : t("relationships.health.category.truncated", {
                category: category.label.toLowerCase(),
              })}
        </NoteLine>
      )}
    </section>
  );
}

function OrphanedEndpointList({
  findings,
  t,
}: {
  readonly findings: HealthFindings;
  readonly t: I18nTranslate;
}): ReactNode {
  const truncated = findings.orphanedEndpointsTruncated;
  const total = findings.orphanedEndpoints.length;
  if (total === 0 && !truncated) return null;
  const label = t("relationships.health.category.orphaned.label");
  const shown = findings.orphanedEndpoints.slice(0, UI_RENDER_CAP);
  return (
    <section aria-label={countLabel(t, label, total, truncated)} style={{ marginBottom: 14 }}>
      <h3 className="rb-section-label">
        {/* No text-node space before the count pill by design — matches the same
            label+rb-count pattern in RelationshipFindingList and RelationshipImpactCard,
            where the pill's own padding/background provides the visual separation. */}
        {label}
        {/* The pill states the SERVER's count, not the rendered slice: `shown.length` would
            report 50 for a 200-endpoint finding set. */}
        <span className="rb-count" aria-hidden="true">
          {truncated ? `${String(total)}+` : total}
        </span>
      </h3>
      <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--fg-muted)" }}>
        {t("relationships.health.category.orphaned.help")}
      </p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {shown.map((ref) => (
          <li key={`${ref.kind}:${ref.id}`} className="rb-row" style={{ fontSize: 12 }}>
            <span className="mono">{endpointLabel(ref)}</span>
          </li>
        ))}
      </ul>
      {total > shown.length && (
        <NoteLine>
          {t("relationships.health.category.showingFirst", { cap: UI_RENDER_CAP, count: total })}
        </NoteLine>
      )}
      {truncated && (
        <NoteLine warn testId={total === 0 ? "health-category-bounded-empty" : undefined}>
          {total === 0
            ? t("relationships.health.category.boundedEmpty")
            : t("relationships.health.category.truncated", { category: label.toLowerCase() })}
        </NoteLine>
      )}
    </section>
  );
}

function BoundedCategorySentence({
  labels,
  t,
}: {
  readonly labels: readonly string[];
  readonly t: I18nTranslate;
}): ReactNode {
  if (labels.length === 0) return null;
  return (
    <>{` ${t("relationships.health.partial.categories", { categories: labels.join(", ") })}`}</>
  );
}

function InconclusiveState({
  labels,
  t,
}: {
  readonly labels: readonly string[];
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <div className="lk-empty" data-testid="health-inconclusive">
      <p className="lk-empty-title">{t("relationships.health.partial.title")}</p>
      <p className="lk-empty-body">
        {t("relationships.health.partial.body")}
        <BoundedCategorySentence labels={labels} t={t} />
      </p>
    </div>
  );
}

function LifecycleTotals({
  totals,
  t,
}: {
  readonly totals: HealthResult["totals"];
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <>
      <h3 className="rb-section-label">{t("relationships.health.totalsLabel")}</h3>
      <div className="rb-rows" style={{ marginBottom: 14 }}>
        {RELATIONSHIP_LIFECYCLE_STATES.filter(
          (s: RelationshipLifecycleState) => (totals[s] ?? 0) > 0,
        ).map((s: RelationshipLifecycleState) => (
          <div key={s} className="rb-row">
            <span className="rb-row-k">{s}</span>
            <span className="rb-row-v mono">{String(totals[s] ?? 0)}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function HealthFindingsBody({
  health,
  onSelectRelationship,
  t,
}: {
  readonly health: HealthResult;
  readonly onSelectRelationship: (id: string) => void;
  readonly t: I18nTranslate;
}): ReactNode {
  const boundedLabels = boundedCategoryLabels(t, health.findings);
  const scanBounded = health.truncated || boundedLabels.length > 0;
  if (totalFindings(health.findings) === 0) {
    if (!scanBounded) {
      return (
        <div className="lk-empty">
          <p className="lk-empty-title">{t("relationships.health.healthyTitle")}</p>
          <p className="lk-empty-body">{t("relationships.health.healthyBody")}</p>
        </div>
      );
    }
    return <InconclusiveState labels={boundedLabels} t={t} />;
  }
  return (
    <>
      {scanBounded && (
        <NoteLine warn testId="health-partial-note">
          {t("relationships.health.partial.note")}
          <BoundedCategorySentence labels={boundedLabels} t={t} />
        </NoteLine>
      )}
      {relationshipCategories(t, health.findings).map((category) => (
        <RelationshipFindingList
          key={category.key}
          category={category}
          onSelectRelationship={onSelectRelationship}
          t={t}
        />
      ))}
      <OrphanedEndpointList findings={health.findings} t={t} />
    </>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function RelationshipHealthPanel({
  onSelectRelationship,
}: {
  readonly onSelectRelationship: (id: string) => void;
}): ReactNode {
  const t = useTranslate();
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
        err instanceof RelationshipApiError ? err.message : t("relationships.health.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ padding: 12, height: "100%", overflowY: "auto" }} aria-busy={loading}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--fg)", flexGrow: 1 }}>
          {t("relationships.health.panelTitle")}
        </h2>
        <button
          type="button"
          className="arun-btn"
          onClick={() => void load()}
          aria-label={t("relationships.health.refreshAria")}
          style={{ minHeight: 24 }}
        >
          {t("relationships.health.refresh")}
        </button>
      </header>

      {loading && (
        <p style={{ fontSize: 12, color: "var(--fg-muted)" }} aria-live="polite">
          {t("relationships.health.running")}
        </p>
      )}

      {error !== null && (
        <div className="lk-alert" role="alert">
          {error}
          <button type="button" className="lk-alert-retry" onClick={() => void load()}>
            {t("relationships.health.retry")}
          </button>
        </div>
      )}

      {!loading && error === null && health !== null && (
        <>
          <p style={{ fontSize: 11, color: "var(--fg-faint)", margin: "0 0 4px" }}>
            {t("relationships.health.checkedAtPrefix")}{" "}
            <time dateTime={new Date(health.checkedAt).toISOString()}>
              {new Date(health.checkedAt).toLocaleString()}
            </time>
            .
          </p>
          {/* The relationship engine resolves ONE workspace per loopback process, so these
              numbers are installation-wide. Saying so is the difference between a total and a
              total the operator reads as "this project". */}
          <p
            data-testid="health-scope-note"
            style={{ fontSize: 11, color: "var(--fg-muted)", margin: "0 0 10px" }}
          >
            {t("relationships.health.scopeNote")}
          </p>

          {/* Lifecycle totals — non-color, count-only summary. */}
          <LifecycleTotals totals={health.totals} t={t} />

          <HealthFindingsBody health={health} onSelectRelationship={onSelectRelationship} t={t} />
        </>
      )}
    </div>
  );
}
