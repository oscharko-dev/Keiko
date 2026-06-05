"use client";

// Issue #211 — Memory Center list with URL-state filter sync.
// Uses useSearchParams (wrapped in Suspense by the parent page) to keep filters
// deep-linkable. Filter state is read from / written to URL query params.
//
// WCAG: focus-visible rings, aria-live on status regions, role="status" on counters.
// Static export: useSearchParams requires Suspense wrapper (applied in page.tsx).
// URL encoding: URLSearchParams.set already encodes; useSearchParams.get already decodes
// — no double encode/decode (#64 lesson).

import { useCallback, useEffect, useState, useTransition } from "react";
import type { ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { MemoryRecord, MemoryId } from "@oscharko-dev/keiko-contracts";
import { fetchMemories, type MemoryListFilters, type MemoryListResponse } from "@/lib/memory-api";
import { ApiError } from "@/lib/api";
import { MemoryFilters, type MemoryFilterState, EMPTY_FILTERS } from "./MemoryFilters";
import type {
  MemoryScopeKind,
  MemorySensitivity,
  MemoryStatus,
  MemoryType,
} from "@oscharko-dev/keiko-contracts";
import {
  MEMORY_SCOPE_KINDS,
  MEMORY_TYPES,
  MEMORY_STATUSES,
  MEMORY_SENSITIVITIES,
} from "@oscharko-dev/keiko-contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return "An unexpected error occurred.";
}

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

function StatusBadge({ status }: { readonly status: string }): ReactNode {
  const cls = STATUS_COLORS[status] ?? "mc-badge-default";
  return (
    <span role="status" aria-label={`Status: ${status}`} className={`mc-badge ${cls}`}>
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// MemoryRow
// ---------------------------------------------------------------------------

function MemoryRow({ record }: { readonly record: MemoryRecord }): ReactNode {
  return (
    <li>
      <Link
        href={`/memory/detail?id=${encodeURIComponent(record.id)}`}
        className="mc-row"
        aria-label={`Memory: ${record.body.slice(0, 60)}`}
      >
        <div className="mc-row-main">
          <span className="mc-row-body">{record.body}</span>
          <div className="mc-row-meta">
            <span className="mc-row-type">{record.type}</span>
            <span className="mc-row-scope">{record.scope.kind}</span>
            {record.pinned ? (
              <span className="mc-row-pinned" aria-label="Pinned">
                P
              </span>
            ) : null}
          </div>
        </div>
        <StatusBadge status={record.status} />
      </Link>
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

  const [memories, setMemories] = useState<readonly MemoryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const filters = filtersFromParams(searchParams);

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
        setTotal(res.total);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filters derived from searchParams, re-run on param change
  }, [searchParams]);

  const handleFilterChange = useCallback(
    (next: MemoryFilterState): void => {
      const qs = filtersToParams(next).toString();
      startTransition(() => {
        router.push(`/memory${qs.length > 0 ? `?${qs}` : ""}`);
      });
    },
    [router],
  );

  return (
    <>
      <header className="lk-header">
        <h1 className="lk-title">Memory Center</h1>
        <Link href="/memory/review-queue" className="lk-btn lk-btn-ghost lk-btn-lg mc-queue-link">
          Review queue
          {total > 0 ? (
            <span
              role="status"
              aria-label={`${total.toString()} memories`}
              className="mc-badge-count"
            >
              {total}
            </span>
          ) : null}
        </Link>
      </header>

      <MemoryFilters filters={filters} onChange={handleFilterChange} />

      <section
        aria-label="Memory records"
        aria-live="polite"
        aria-busy={loading}
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
      >
        {loading ? (
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
            }}
          >
            {memories.map((record) => (
              <MemoryRow key={record.id} record={record} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
