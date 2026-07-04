"use client";

// Issue #211 — MemoriaViva filter chips.
// Each axis (scope / type / status / sensitivity) renders as a row of toggle buttons.
// Active filters are pushed to URL search params so the view is deep-linkable.
//
// WCAG: aria-pressed on every toggle (not role="radio" — avoids roving-tabindex trap
// from issue #65). focus-visible ring. min 24×24 target per WCAG 2.5.8.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
import { useTranslate, type I18nTranslate } from "@/lib/i18n";

export interface MemoryFilterState {
  readonly query: string;
  readonly scope: readonly MemoryScopeKind[];
  readonly type: readonly MemoryType[];
  readonly status: readonly MemoryStatus[];
  readonly sensitivity: readonly MemorySensitivity[];
}

export const EMPTY_FILTERS: MemoryFilterState = {
  query: "",
  scope: [],
  type: [],
  status: [],
  sensitivity: [],
};

interface MemoryFiltersProps {
  readonly filters: MemoryFilterState;
  readonly onChange: (next: MemoryFilterState) => void;
}

// GEN-PERF-WIDGET-003 — the free-text query field drives a full-list fetch (server-side
// list assembly + per-item vault decrypt) per keystroke. Debounce the query trailing edge
// so a burst of keystrokes collapses to a single downstream onChange. Chip toggles stay
// immediate. The pending query is flushed on unmount and before any chip toggle so the
// committed filter state never loses the last-typed characters.
export const MEMORY_QUERY_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Label maps
// ---------------------------------------------------------------------------

export function scopeLabel(scope: MemoryScopeKind, t: I18nTranslate): string {
  switch (scope) {
    case "user":
      return t("memoria.scope.user");
    case "workspace":
      return t("memoria.scope.workspace");
    case "project":
      return t("memoria.scope.project");
    case "workflow":
      return t("memoria.scope.workflow");
    case "global":
      return t("memoria.scope.global");
  }
}

export function typeLabel(type: MemoryType, t: I18nTranslate): string {
  switch (type) {
    case "episodic":
      return t("memoria.type.episodic");
    case "semantic-fact":
      return t("memoria.type.semanticFact");
    case "procedural":
      return t("memoria.type.procedural");
    case "preference":
      return t("memoria.type.preference");
    case "correction":
      return t("memoria.type.correction");
    case "decision":
      return t("memoria.type.decision");
    case "negative":
      return t("memoria.type.negative");
    case "pinned":
      return t("memoria.type.pinned");
  }
}

export function statusLabel(status: MemoryStatus, t: I18nTranslate): string {
  switch (status) {
    case "proposed":
      return t("memoria.status.proposed");
    case "accepted":
      return t("memoria.status.accepted");
    case "rejected":
      return t("memoria.status.rejected");
    case "superseded":
      return t("memoria.status.superseded");
    case "archived":
      return t("memoria.status.archived");
    case "forgotten":
      return t("memoria.status.forgotten");
    case "conflicted":
      return t("memoria.status.conflicted");
    case "expired":
      return t("memoria.status.expired");
  }
}

export function sensitivityLabel(sensitivity: MemorySensitivity, t: I18nTranslate): string {
  switch (sensitivity) {
    case "public":
      return t("memoria.sensitivity.public");
    case "confidential":
      return t("memoria.sensitivity.confidential");
    case "restricted":
      return t("memoria.sensitivity.restricted");
  }
}

// ---------------------------------------------------------------------------
// ChipGroup
// ---------------------------------------------------------------------------

function toggle<T>(list: readonly T[], item: T): readonly T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

function ChipGroup<T extends string>({
  label,
  ariaLabel,
  items,
  labelFor,
  active,
  onToggle,
}: {
  readonly label: string;
  readonly ariaLabel: string;
  readonly items: readonly T[];
  readonly labelFor: (item: T) => string;
  readonly active: readonly T[];
  readonly onToggle: (item: T) => void;
}): ReactNode {
  return (
    <div className="mc-filter-row" role="group" aria-label={ariaLabel}>
      <span className="mc-filter-label">{label}</span>
      <div className="mc-filter-chips">
        {items.map((item) => {
          const isActive = active.includes(item);
          return (
            <button
              key={item}
              type="button"
              className="mc-chip"
              data-active={String(isActive)}
              aria-pressed={isActive}
              onClick={() => {
                onToggle(item);
              }}
            >
              {labelFor(item)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MemoryFilters
// ---------------------------------------------------------------------------

export function MemoryFilters({ filters, onChange }: MemoryFiltersProps): ReactNode {
  const t = useTranslate();
  const scopeText = t("memoria.scope");
  const typeText = t("memoria.type");
  const statusText = t("memoria.status");
  const sensitivityText = t("memoria.sensitivity");

  // Local, immediate text state so typing stays responsive while the downstream
  // onChange (which triggers the fetch) is debounced.
  const [queryDraft, setQueryDraft] = useState(filters.query);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the latest committed filters/onChange reachable from the timer without
  // re-arming the debounce on every parent render.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Reflect external filter resets (e.g. "clear filters") into the draft, but only
  // when the query genuinely diverges from what we last committed, so an in-flight
  // debounce is not clobbered by the parent echoing our own value back.
  const lastCommittedQueryRef = useRef(filters.query);
  useEffect(() => {
    if (filters.query !== lastCommittedQueryRef.current) {
      lastCommittedQueryRef.current = filters.query;
      setQueryDraft(filters.query);
    }
  }, [filters.query]);

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Immediately commit a filter change, cancelling any pending query debounce and
  // folding the current query draft in so chip toggles never drop typed characters.
  const commitImmediate = useCallback(
    (patch: Partial<MemoryFilterState>): void => {
      clearTimer();
      lastCommittedQueryRef.current = queryDraft;
      onChangeRef.current({ ...filtersRef.current, query: queryDraft, ...patch });
    },
    [clearTimer, queryDraft],
  );

  const handleQueryChange = useCallback(
    (value: string): void => {
      setQueryDraft(value);
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        lastCommittedQueryRef.current = value;
        onChangeRef.current({ ...filtersRef.current, query: value });
      }, MEMORY_QUERY_DEBOUNCE_MS);
    },
    [clearTimer],
  );

  // Flush any pending debounced query on unmount so the final keystroke is not lost.
  useEffect(
    () => (): void => {
      clearTimer();
    },
    [clearTimer],
  );

  return (
    <section className="mc-filters" aria-label={t("memoria.filters")}>
      <label className="mc-filter-search">
        <span className="mc-filter-label">{t("memoria.search")}</span>
        <input
          type="search"
          value={queryDraft}
          placeholder={t("memoria.searchPlaceholder")}
          onChange={(event) => {
            handleQueryChange(event.currentTarget.value);
          }}
        />
      </label>
      <ChipGroup
        label={scopeText}
        ariaLabel={t("memoria.filterBy", { label: scopeText })}
        items={MEMORY_SCOPE_KINDS}
        labelFor={(item) => scopeLabel(item, t)}
        active={filters.scope}
        onToggle={(item) => {
          commitImmediate({ scope: toggle(filters.scope, item) });
        }}
      />
      <ChipGroup
        label={typeText}
        ariaLabel={t("memoria.filterBy", { label: typeText })}
        items={MEMORY_TYPES}
        labelFor={(item) => typeLabel(item, t)}
        active={filters.type}
        onToggle={(item) => {
          commitImmediate({ type: toggle(filters.type, item) });
        }}
      />
      <ChipGroup
        label={statusText}
        ariaLabel={t("memoria.filterBy", { label: statusText })}
        items={MEMORY_STATUSES}
        labelFor={(item) => statusLabel(item, t)}
        active={filters.status}
        onToggle={(item) => {
          commitImmediate({ status: toggle(filters.status, item) });
        }}
      />
      <ChipGroup
        label={sensitivityText}
        ariaLabel={t("memoria.filterBy", { label: sensitivityText })}
        items={MEMORY_SENSITIVITIES}
        labelFor={(item) => sensitivityLabel(item, t)}
        active={filters.sensitivity}
        onToggle={(item) => {
          commitImmediate({ sensitivity: toggle(filters.sensitivity, item) });
        }}
      />
    </section>
  );
}
