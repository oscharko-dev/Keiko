"use client";

// Issue #211 — MemoriaViva list with URL-state filter sync.
// Uses useSearchParams (wrapped in Suspense by the parent page) to keep filters
// deep-linkable. Filter state is read from / written to URL query params.
//
// WCAG: focus-visible rings, aria-live on status regions, role="status" on counters.
// Static export: useSearchParams requires Suspense wrapper (applied in page.tsx).
// URL encoding: URLSearchParams.set already encodes; useSearchParams.get already decodes
// — no double encode/decode (#64 lesson).

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { MemoryRecord } from "@oscharko-dev/keiko-contracts";
import { fetchMemories, type MemoryListFilters, type MemoryListResponse } from "@/lib/memory-api";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { NATIVE_BLOCK_STYLE } from "../../components/desktop/native-element-styles";
import { formatError } from "./format-error";
import {
  MemoryFilters,
  type MemoryFilterState,
  scopeLabel,
  sensitivityLabel,
  statusLabel,
  typeLabel,
} from "./MemoryFilters";
import {
  MEMORY_SCOPE_KINDS,
  MEMORY_TYPES,
  MEMORY_STATUSES,
  MEMORY_SENSITIVITIES,
} from "@oscharko-dev/keiko-contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCsvParam<T extends string>(raw: string | null, allowed: readonly T[]): readonly T[] {
  if (raw === null || raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is T => (allowed as readonly string[]).includes(s));
}

function filtersFromParams(params: ReturnType<typeof useSearchParams>): MemoryFilterState {
  return {
    query: params.get("q") ?? "",
    scope: parseCsvParam(params.get("scope"), MEMORY_SCOPE_KINDS),
    type: parseCsvParam(params.get("type"), MEMORY_TYPES),
    status: parseCsvParam(params.get("status"), MEMORY_STATUSES),
    sensitivity: parseCsvParam(params.get("sensitivity"), MEMORY_SENSITIVITIES),
  };
}

function filtersToParams(filters: MemoryFilterState): URLSearchParams {
  const p = new URLSearchParams();
  if (filters.query.trim().length > 0) p.set("q", filters.query.trim());
  if (filters.scope.length > 0) p.set("scope", filters.scope.join(","));
  if (filters.type.length > 0) p.set("type", filters.type.join(","));
  if (filters.status.length > 0) p.set("status", filters.status.join(","));
  if (filters.sensitivity.length > 0) p.set("sensitivity", filters.sensitivity.join(","));
  return p;
}

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

const STATUS_COLORS: Readonly<Record<string, string>> = {
  proposed: "mc-badge-proposed",
  accepted: "mc-badge-accepted",
  conflicted: "mc-badge-conflicted",
  rejected: "mc-badge-rejected",
  archived: "mc-badge-archived",
  forgotten: "mc-badge-forgotten",
  superseded: "mc-badge-superseded",
  expired: "mc-badge-expired",
};

// No role="status": these badges are static metadata labels, not live status
// messages — N rows produced N live regions for screen readers (uiux-fix F005).
export function StatusBadge({
  status,
  t,
}: {
  readonly status: MemoryRecord["status"];
  readonly t: I18nTranslate;
}): ReactNode {
  const cls = STATUS_COLORS[status] ?? "mc-badge-default";
  return <span className={`mc-badge ${cls}`}>{statusLabel(status, t)}</span>;
}

function formatConfidence(confidence: number, t: I18nTranslate): string {
  return t("memoria.confidenceMeta", { confidence: (confidence * 100).toFixed(0) });
}

// ---------------------------------------------------------------------------
// MemoryRow
// ---------------------------------------------------------------------------

export function MemoryRowScaffold({
  body,
  metadata,
  trailing,
}: {
  readonly body: string;
  readonly metadata: ReactNode;
  readonly trailing: ReactNode;
}): ReactNode {
  return (
    <>
      <div className="mc-row-main">
        <span className="mc-row-body" title={body}>
          {body}
        </span>
        <div className="mc-row-meta">{metadata}</div>
      </div>
      {trailing}
    </>
  );
}

function MemoryRow({
  record,
  onOpenDetail,
  t,
}: {
  readonly record: MemoryRecord;
  readonly onOpenDetail?: ((id: string) => void) | undefined;
  readonly t: I18nTranslate;
}): ReactNode {
  const metadata = (
    <>
      <span className="mc-row-type">{typeLabel(record.type, t)}</span>
      <span className="mc-row-scope">{scopeLabel(record.scope.kind, t)}</span>
      <span className="mc-row-source">
        {t("memoria.sourceMeta", { source: record.provenance.sourceKind })}
      </span>
      <span className="mc-row-confidence">{formatConfidence(record.provenance.confidence, t)}</span>
      <span className="mc-row-sensitivity">
        {t("memoria.sensitivityMeta", {
          sensitivity: sensitivityLabel(record.provenance.sensitivity, t),
        })}
      </span>
      {record.pinned ? (
        <span className="mc-badge mc-badge-pinned">{t("memoria.pinned")}</span>
      ) : null}
    </>
  );
  const row = (
    <MemoryRowScaffold
      body={record.body}
      metadata={metadata}
      trailing={<StatusBadge status={record.status} t={t} />}
    />
  );

  return (
    <li>
      {onOpenDetail !== undefined ? (
        <button
          type="button"
          className="mc-row mc-row-button"
          onClick={() => onOpenDetail(record.id)}
        >
          {row}
        </button>
      ) : (
        <Link href={`/memoriaviva/detail?id=${encodeURIComponent(record.id)}`} className="mc-row">
          {row}
        </Link>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

function EmptyState({
  hasFilters,
  t,
}: {
  readonly hasFilters: boolean;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <div data-testid="memory-empty-state" className="lk-empty">
      <div>
        <p className="lk-empty-title">{t("memoria.noMemoriesFound")}</p>
        <p className="lk-empty-body">
          {hasFilters ? t("memoria.emptyFiltered") : t("memoria.emptyFresh")}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HeaderActionLink
// ---------------------------------------------------------------------------

// Header secondary actions (consolidation / review queue / health scan) render
// as an internal-navigation button in workspace-window mode (onClick supplied)
// or a plain route Link otherwise. Extracted so MemoryListContent doesn't carry
// the same conditional-render branch three times.
function HeaderActionLink({
  href,
  label,
  className,
  onClick,
}: {
  readonly href: string;
  readonly label: string;
  readonly className: string;
  readonly onClick?: (() => void) | undefined;
}): ReactNode {
  if (onClick !== undefined) {
    return (
      <button type="button" className={className} onClick={onClick}>
        {label}
      </button>
    );
  }
  return (
    <Link href={href} className={className}>
      {label}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// MemoryListBody
// ---------------------------------------------------------------------------

export function MemoryListState({
  loading,
  hasItems,
  error,
  loadingLabel,
  retryLabel,
  loadingIsStatus = false,
  emptyState,
  onRetry,
  children,
}: {
  readonly loading: boolean;
  readonly hasItems: boolean;
  readonly error: string | null;
  readonly loadingLabel: string;
  readonly retryLabel: string;
  readonly loadingIsStatus?: boolean;
  readonly emptyState: ReactNode;
  readonly onRetry: () => void;
  readonly children: ReactNode;
}): ReactNode {
  if (loading && !hasItems) {
    return loadingIsStatus ? (
      <p role="status" aria-live="polite" className="lk-loading">
        {loadingLabel}
      </p>
    ) : (
      <p className="lk-loading">{loadingLabel}</p>
    );
  }
  if (error !== null) {
    return (
      <div role="alert" aria-live="assertive" className="lk-alert">
        {error}
        <button type="button" className="lk-alert-retry" onClick={onRetry}>
          {retryLabel}
        </button>
      </div>
    );
  }
  return hasItems ? children : emptyState;
}

// The section content is one of four mutually exclusive states — loading,
// error, empty, or populated. Extracted as early returns (same shape as
// EmptyState above) instead of a nested ternary chain in MemoryListContent.
function MemoryListBody({
  loading,
  error,
  memories,
  hasFilters,
  onOpenDetail,
  onRetry,
  t,
}: {
  readonly loading: boolean;
  readonly error: string | null;
  readonly memories: readonly MemoryRecord[];
  readonly hasFilters: boolean;
  readonly onOpenDetail?: ((id: string) => void) | undefined;
  readonly onRetry: () => void;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <MemoryListState
      loading={loading}
      hasItems={memories.length > 0}
      error={error}
      loadingLabel={t("memoria.loadingMemories")}
      retryLabel={t("memoria.retry")}
      loadingIsStatus
      emptyState={<EmptyState hasFilters={hasFilters} t={t} />}
      onRetry={onRetry}
    >
      <ul
        aria-label={t("memoria.memoryList")}
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: 4,
          opacity: loading ? 0.6 : 1,
          transition: "opacity 0.15s ease",
        }}
      >
        {memories.map((record) => (
          <MemoryRow key={record.id} record={record} onOpenDetail={onOpenDetail} t={t} />
        ))}
      </ul>
    </MemoryListState>
  );
}

// ---------------------------------------------------------------------------
// MemoryList
// ---------------------------------------------------------------------------

interface MemoryListProps {
  readonly fetchMemoriesImpl?: typeof fetchMemories;
}

export function MemoryList({ fetchMemoriesImpl = fetchMemories }: MemoryListProps): ReactNode {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);

  const handleFilterChange = useCallback(
    (next: MemoryFilterState): void => {
      const qs = filtersToParams(next).toString();
      const queryString = qs.length > 0 ? `?${qs}` : "";
      startTransition(() => {
        router.push(`/memoriaviva${queryString}`);
      });
    },
    [router, startTransition],
  );

  return (
    <MemoryListContent
      filters={filters}
      onFilterChange={handleFilterChange}
      fetchMemoriesImpl={fetchMemoriesImpl}
      showWorkspaceBackLink
    />
  );
}

export interface MemoryListContentProps {
  readonly filters: MemoryFilterState;
  readonly onFilterChange: (next: MemoryFilterState) => void;
  readonly fetchMemoriesImpl?: typeof fetchMemories;
  readonly onOpenDetail?: ((id: string) => void) | undefined;
  readonly onOpenConsolidation?: (() => void) | undefined;
  readonly onOpenReviewQueue?: (() => void) | undefined;
  readonly onOpenHealthScan?: (() => void) | undefined;
  readonly onOpenJournal?: (() => void) | undefined;
  readonly showWorkspaceBackLink?: boolean;
  readonly settingsSlot?: ReactNode;
}

export function MemoryListContent({
  filters,
  onFilterChange,
  fetchMemoriesImpl = fetchMemories,
  onOpenDetail,
  onOpenConsolidation,
  onOpenReviewQueue,
  onOpenHealthScan,
  onOpenJournal,
  showWorkspaceBackLink = true,
  settingsSlot,
}: MemoryListContentProps): ReactNode {
  const t = useTranslate();
  const [memories, setMemories] = useState<readonly MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const hasFilters =
    filters.query.trim().length > 0 ||
    filters.scope.length > 0 ||
    filters.type.length > 0 ||
    filters.status.length > 0 ||
    filters.sensitivity.length > 0;

  // Monotonic request guard (GEN-PERF-WIDGET-003): the debounced filter (MemoryFilters) still lets a
  // slower earlier request resolve after a newer one; drop any response that is not the latest so a
  // stale, out-of-order result can never clobber the current list.
  const requestSeqRef = useRef(0);
  const load = useCallback(
    async (f: MemoryListFilters): Promise<void> => {
      const seq = (requestSeqRef.current += 1);
      setLoading(true);
      setError(null);
      try {
        const res: MemoryListResponse = await fetchMemoriesImpl(f);
        if (seq !== requestSeqRef.current) return;
        setMemories(res.memories);
      } catch (err) {
        if (seq !== requestSeqRef.current) return;
        setError(formatError(err));
      } finally {
        if (seq === requestSeqRef.current) setLoading(false);
      }
    },
    [fetchMemoriesImpl],
  );

  useEffect(() => {
    void load(filters);
  }, [filters, load]);

  return (
    <>
      <header className="lk-header">
        <h1 className="lk-title">MemoriaViva</h1>
        <div className="mc-view-actions">
          {/* Declared exit back to the desktop shell — the memoriaviva routes
              live outside the workspace and had no way back (uiux-fix F035). */}
          {showWorkspaceBackLink ? (
            <Link href="/" className="lk-btn lk-btn-ghost lk-btn-lg">
              {t("memoria.backToWorkspace")}
            </Link>
          ) : null}
          <HeaderActionLink
            href="/memoriaviva/journal"
            label={t("memoria.journal.open")}
            className="lk-btn lk-btn-ghost lk-btn-lg"
            onClick={onOpenJournal}
          />
          <HeaderActionLink
            href="/memoriaviva/consolidation"
            label={t("memoria.consolidation")}
            className="lk-btn lk-btn-ghost lk-btn-lg"
            onClick={onOpenConsolidation}
          />
          <HeaderActionLink
            href="/memoriaviva/review-queue"
            label={t("memoria.reviewQueue")}
            className="lk-btn lk-btn-ghost lk-btn-lg mc-queue-link"
            onClick={onOpenReviewQueue}
          />
          <HeaderActionLink
            href="/memoriaviva/health-scan"
            label={t("memoria.healthScan")}
            className="lk-btn lk-btn-ghost lk-btn-lg"
            onClick={onOpenHealthScan}
          />
        </div>
      </header>

      {settingsSlot}

      <MemoryFilters filters={filters} onChange={onFilterChange} />

      {/* Compact live region instead of aria-live on the whole list section —
          announcing every inserted row flooded screen readers after each
          filter change (uiux-fix F035). <output> is the native status live
          region (S6819); NATIVE_BLOCK_STYLE restores the block box the <p> had,
          since `.visually-hidden` declares no display of its own (#2721). */}
      <output className="visually-hidden" style={NATIVE_BLOCK_STYLE}>
        {!loading && error === null ? t("memoria.memoriesFound", { count: memories.length }) : null}
      </output>

      <section
        aria-label={t("memoria.memoryRecords")}
        aria-busy={loading}
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
      >
        <MemoryListBody
          loading={loading}
          error={error}
          memories={memories}
          hasFilters={hasFilters}
          onOpenDetail={onOpenDetail}
          onRetry={() => {
            void load(filters);
          }}
          t={t}
        />
      </section>
    </>
  );
}
