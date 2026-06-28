"use client";

// Issue #211 — MemoriaViva list with URL-state filter sync.
// Uses useSearchParams (wrapped in Suspense by the parent page) to keep filters
// deep-linkable. Filter state is read from / written to URL query params.
//
// WCAG: focus-visible rings, aria-live on status regions, role="status" on counters.
// Static export: useSearchParams requires Suspense wrapper (applied in page.tsx).
// URL encoding: URLSearchParams.set already encodes; useSearchParams.get already decodes
// — no double encode/decode (#64 lesson).

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import type { ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { MemoryRecord } from "@oscharko-dev/keiko-contracts";
import { fetchMemories, type MemoryListFilters, type MemoryListResponse } from "@/lib/memory-api";
import { Toggle } from "../../components/desktop/widgets/shared/Toggle";
import { formatError } from "./format-error";
import { MemoryFilters, type MemoryFilterState, SCOPE_LABELS, TYPE_LABELS } from "./MemoryFilters";
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
    scope: parseCsvParam(params.get("scope"), MEMORY_SCOPE_KINDS),
    type: parseCsvParam(params.get("type"), MEMORY_TYPES),
    status: parseCsvParam(params.get("status"), MEMORY_STATUSES),
    sensitivity: parseCsvParam(params.get("sensitivity"), MEMORY_SENSITIVITIES),
  };
}

function filtersToParams(filters: MemoryFilterState): URLSearchParams {
  const p = new URLSearchParams();
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
function StatusBadge({ status }: { readonly status: string }): ReactNode {
  const cls = STATUS_COLORS[status] ?? "mc-badge-default";
  return <span className={`mc-badge ${cls}`}>{status}</span>;
}

function formatConfidence(confidence: number): string {
  return `${(confidence * 100).toFixed(0)}% confidence`;
}

// ---------------------------------------------------------------------------
// MemoryRow
// ---------------------------------------------------------------------------

function MemoryRow({
  record,
  onOpenDetail,
}: {
  readonly record: MemoryRecord;
  readonly onOpenDetail?: ((id: string) => void) | undefined;
}): ReactNode {
  const row = (
    <>
      <div className="mc-row-main">
        {/* title: full text on hover — the row body is single-line truncated
            and otherwise only reachable via the detail view (uiux-fix F035). */}
        <span className="mc-row-body" title={record.body}>
          {record.body}
        </span>
        <div className="mc-row-meta">
          <span className="mc-row-type">{TYPE_LABELS[record.type]}</span>
          <span className="mc-row-scope">{SCOPE_LABELS[record.scope.kind]}</span>
          <span className="mc-row-source">Source {record.provenance.sourceKind}</span>
          <span className="mc-row-confidence">
            {formatConfidence(record.provenance.confidence)}
          </span>
          <span className="mc-row-sensitivity">Sensitivity {record.provenance.sensitivity}</span>
          {record.pinned ? (
            // Same badge as the detail page — a bare accent-coloured "P" was
            // cryptic, failed light-theme contrast (2.41:1), and aria-label on
            // a generic span is prohibited ARIA (uiux-fix F035).
            <span className="mc-badge mc-badge-pinned">Pinned</span>
          ) : null}
        </div>
      </div>
      <StatusBadge status={record.status} />
    </>
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

function EmptyState({ hasFilters }: { readonly hasFilters: boolean }): ReactNode {
  return (
    <div data-testid="memory-empty-state" className="lk-empty">
      <div>
        <p className="lk-empty-title">No memories found</p>
        <p className="lk-empty-body">
          {hasFilters
            ? "Try removing some filters to see more memories."
            : "Memories will appear here once the system captures them from your conversations and workflows."}
        </p>
      </div>
    </div>
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
  const [policyEnabled, setPolicyEnabled] = useState(true);
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);

  const handleFilterChange = useCallback(
    (next: MemoryFilterState): void => {
      const qs = filtersToParams(next).toString();
      startTransition(() => {
        router.push(`/memoriaviva${qs.length > 0 ? `?${qs}` : ""}`);
      });
    },
    [router, startTransition],
  );

  return (
    <MemoryListContent
      filters={filters}
      onFilterChange={handleFilterChange}
      fetchMemoriesImpl={fetchMemoriesImpl}
      policyEnabled={policyEnabled}
      onPolicyEnabledChange={setPolicyEnabled}
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
  readonly policyEnabled?: boolean | undefined;
  readonly onPolicyEnabledChange?: ((next: boolean) => void) | undefined;
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
  policyEnabled,
  onPolicyEnabledChange,
  showWorkspaceBackLink = true,
  settingsSlot,
}: MemoryListContentProps): ReactNode {
  const [memories, setMemories] = useState<readonly MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uncontrolledPolicyEnabled, setUncontrolledPolicyEnabled] = useState(true);
  const effectivePolicyEnabled = policyEnabled ?? uncontrolledPolicyEnabled;
  const setEffectivePolicyEnabled = onPolicyEnabledChange ?? setUncontrolledPolicyEnabled;

  const hasFilters =
    filters.scope.length > 0 ||
    filters.type.length > 0 ||
    filters.status.length > 0 ||
    filters.sensitivity.length > 0;

  const load = useCallback(
    async (f: MemoryListFilters): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const res: MemoryListResponse = await fetchMemoriesImpl(f);
        setMemories(res.memories);
      } catch (err) {
        setError(formatError(err));
      } finally {
        setLoading(false);
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
          <div className="mc-policy-switch">
            <Toggle
              on={effectivePolicyEnabled}
              onChange={setEffectivePolicyEnabled}
              label="Enable MemoriaViva policy"
            />
            <span>Policy {effectivePolicyEnabled ? "on" : "off"}</span>
          </div>
          {/* Declared exit back to the desktop shell — the memoriaviva routes
              live outside the workspace and had no way back (uiux-fix F035). */}
          {showWorkspaceBackLink ? (
            <Link href="/" className="lk-btn lk-btn-ghost lk-btn-lg">
              Back to Workspace
            </Link>
          ) : null}
          {onOpenConsolidation !== undefined ? (
            <button
              type="button"
              className="lk-btn lk-btn-ghost lk-btn-lg"
              onClick={onOpenConsolidation}
            >
              Consolidation
            </button>
          ) : (
            <Link href="/memoriaviva/consolidation" className="lk-btn lk-btn-ghost lk-btn-lg">
              Consolidation
            </Link>
          )}
          {onOpenReviewQueue !== undefined ? (
            <button
              type="button"
              className="lk-btn lk-btn-ghost lk-btn-lg mc-queue-link"
              onClick={onOpenReviewQueue}
            >
              Review queue
            </button>
          ) : (
            <Link
              href="/memoriaviva/review-queue"
              className="lk-btn lk-btn-ghost lk-btn-lg mc-queue-link"
            >
              Review queue
            </Link>
          )}
        </div>
      </header>

      {settingsSlot}

      <MemoryFilters filters={filters} onChange={onFilterChange} />

      {/* Compact live region instead of aria-live on the whole list section —
          announcing every inserted row flooded screen readers after each
          filter change (uiux-fix F035). */}
      <p role="status" className="visually-hidden">
        {!loading && error === null
          ? `${memories.length.toString()} ${memories.length === 1 ? "memory" : "memories"} found`
          : null}
      </p>

      <section
        aria-label="Memory records"
        aria-busy={loading}
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
      >
        {loading && memories.length === 0 ? (
          <p role="status" aria-live="polite" className="lk-loading">
            Loading memories…
          </p>
        ) : error !== null ? (
          <div role="alert" aria-live="assertive" className="lk-alert">
            {error}
            <button
              type="button"
              className="lk-alert-retry"
              onClick={() => {
                void load(filters);
              }}
            >
              Retry
            </button>
          </div>
        ) : memories.length === 0 ? (
          <EmptyState hasFilters={hasFilters} />
        ) : (
          <ul
            aria-label="Memory list"
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              // Stale-while-revalidate: keep the previous results visible
              // (dimmed) during a refetch instead of collapsing the list to a
              // one-line loading message on every filter click (uiux-fix F035).
              opacity: loading ? 0.6 : 1,
              transition: "opacity 0.15s ease",
            }}
          >
            {memories.map((record) => (
              <MemoryRow key={record.id} record={record} onOpenDetail={onOpenDetail} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
