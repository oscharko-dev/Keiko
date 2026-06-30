"use client";

// Issue #211 — MemoriaViva filter chips.
// Each axis (scope / type / status / sensitivity) renders as a row of toggle buttons.
// Active filters are pushed to URL search params so the view is deep-linkable.
//
// WCAG: aria-pressed on every toggle (not role="radio" — avoids roving-tabindex trap
// from issue #65). focus-visible ring. min 24×24 target per WCAG 2.5.8.

import type { ReactNode } from "react";
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
import { useI18n, type I18nTranslate } from "@/lib/i18n";

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
  const { t } = useI18n();
  const scopeText = t("memoria.scope");
  const typeText = t("memoria.type");
  const statusText = t("memoria.status");
  const sensitivityText = t("memoria.sensitivity");
  return (
    <section className="mc-filters" aria-label={t("memoria.filters")}>
      <label className="mc-filter-search">
        <span className="mc-filter-label">{t("memoria.search")}</span>
        <input
          type="search"
          value={filters.query}
          placeholder={t("memoria.searchPlaceholder")}
          onChange={(event) => {
            onChange({ ...filters, query: event.currentTarget.value });
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
          onChange({ ...filters, scope: toggle(filters.scope, item) });
        }}
      />
      <ChipGroup
        label={typeText}
        ariaLabel={t("memoria.filterBy", { label: typeText })}
        items={MEMORY_TYPES}
        labelFor={(item) => typeLabel(item, t)}
        active={filters.type}
        onToggle={(item) => {
          onChange({ ...filters, type: toggle(filters.type, item) });
        }}
      />
      <ChipGroup
        label={statusText}
        ariaLabel={t("memoria.filterBy", { label: statusText })}
        items={MEMORY_STATUSES}
        labelFor={(item) => statusLabel(item, t)}
        active={filters.status}
        onToggle={(item) => {
          onChange({ ...filters, status: toggle(filters.status, item) });
        }}
      />
      <ChipGroup
        label={sensitivityText}
        ariaLabel={t("memoria.filterBy", { label: sensitivityText })}
        items={MEMORY_SENSITIVITIES}
        labelFor={(item) => sensitivityLabel(item, t)}
        active={filters.sensitivity}
        onToggle={(item) => {
          onChange({ ...filters, sensitivity: toggle(filters.sensitivity, item) });
        }}
      />
    </section>
  );
}
