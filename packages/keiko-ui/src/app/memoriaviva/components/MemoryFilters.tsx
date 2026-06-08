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

export interface MemoryFilterState {
  readonly scope: readonly MemoryScopeKind[];
  readonly type: readonly MemoryType[];
  readonly status: readonly MemoryStatus[];
  readonly sensitivity: readonly MemorySensitivity[];
}

export const EMPTY_FILTERS: MemoryFilterState = {
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

const SCOPE_LABELS: Readonly<Record<MemoryScopeKind, string>> = {
  user: "User",
  workspace: "Workspace",
  project: "Project",
  workflow: "Workflow",
  global: "Global",
};

const TYPE_LABELS: Readonly<Record<MemoryType, string>> = {
  episodic: "Episodic",
  "semantic-fact": "Fact",
  procedural: "Procedural",
  preference: "Preference",
  correction: "Correction",
  decision: "Decision",
  negative: "Negative",
  pinned: "Pinned",
};

const STATUS_LABELS: Readonly<Record<MemoryStatus, string>> = {
  proposed: "Proposed",
  accepted: "Accepted",
  rejected: "Rejected",
  superseded: "Superseded",
  archived: "Archived",
  forgotten: "Forgotten",
  conflicted: "Conflicted",
  expired: "Expired",
};

const SENSITIVITY_LABELS: Readonly<Record<MemorySensitivity, string>> = {
  public: "Public",
  confidential: "Confidential",
  restricted: "Restricted",
};

// ---------------------------------------------------------------------------
// ChipGroup
// ---------------------------------------------------------------------------

function toggle<T>(list: readonly T[], item: T): readonly T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

function ChipGroup<T extends string>({
  label,
  items,
  labels,
  active,
  onToggle,
}: {
  readonly label: string;
  readonly items: readonly T[];
  readonly labels: Readonly<Record<T, string>>;
  readonly active: readonly T[];
  readonly onToggle: (item: T) => void;
}): ReactNode {
  return (
    <div className="mc-filter-row" role="group" aria-label={`Filter by ${label}`}>
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
              {labels[item]}
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
  return (
    <section className="mc-filters" aria-label="Memory filters">
      <ChipGroup
        label="Scope"
        items={MEMORY_SCOPE_KINDS}
        labels={SCOPE_LABELS}
        active={filters.scope}
        onToggle={(item) => {
          onChange({ ...filters, scope: toggle(filters.scope, item) });
        }}
      />
      <ChipGroup
        label="Type"
        items={MEMORY_TYPES}
        labels={TYPE_LABELS}
        active={filters.type}
        onToggle={(item) => {
          onChange({ ...filters, type: toggle(filters.type, item) });
        }}
      />
      <ChipGroup
        label="Status"
        items={MEMORY_STATUSES}
        labels={STATUS_LABELS}
        active={filters.status}
        onToggle={(item) => {
          onChange({ ...filters, status: toggle(filters.status, item) });
        }}
      />
      <ChipGroup
        label="Sensitivity"
        items={MEMORY_SENSITIVITIES}
        labels={SENSITIVITY_LABELS}
        active={filters.sensitivity}
        onToggle={(item) => {
          onChange({ ...filters, sensitivity: toggle(filters.sensitivity, item) });
        }}
      />
    </section>
  );
}
