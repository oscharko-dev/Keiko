"use client";

// Epic #189 Slice 3 M2 — compact connector picker window.
//
// The user selects a ready capsule or capsule-set from a live list fetched from the BFF.
// The selection is persisted into the window's cfg via updateCfg so the relationship-edge
// binding can read `cfg.selectedKind` and `cfg.selectedId`. A "Create connector" link
// navigates to the existing /local-knowledge create flow.
//
// Accessibility: the picker is a <select> with a visible <label>; the selected item is
// announced via role="status"; the "Create connector" affordance is a real <a> so keyboard
// users can reach it with Tab/Enter. All interactive targets are ≥24×24 px (WCAG 2.5.8).
// Color contrast follows the design system tokens (ink on surface — all ≥4.5:1).

import { useEffect, useState, type ReactNode } from "react";
import {
  fetchCapsules,
  fetchCapsuleSets,
  type CapsuleListEntry,
  type CapsuleSetListEntry,
} from "@/lib/local-knowledge-api";
import { ApiError } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConnectorPickerCfg {
  readonly selectedKind?: string;
  readonly selectedId?: string;
}

export interface ConnectorPickerWidgetProps {
  /** Current cfg from the window (may be undefined on first render). */
  readonly selectedKind?: string | undefined;
  readonly selectedId?: string | undefined;
  /** Called with the updated cfg fields when the user makes a selection. */
  readonly onSelect: (patch: { selectedKind: string; selectedId: string }) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lifecycleLabel(state: CapsuleListEntry["lifecycleState"]): string {
  switch (state) {
    case "ready":
      return "Ready";
    case "indexing":
      return "Indexing…";
    case "error":
      return "Failed";
    default:
      return state;
  }
}

function formatLoadError(error: unknown): string {
  // uiux-fix F018 C124: lead with the human message; the machine code follows as a
  // parenthesised detail instead of a bold "INTERNAL:" prefix.
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  if (error instanceof Error) return error.message;
  return "Failed to load connectors.";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function LoadingState(): ReactNode {
  return (
    <div className="connector-picker-status" role="status" aria-live="polite">
      Loading connectors…
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <div className="connector-picker-error" role="alert">
      <p>{message}</p>
      <button type="button" className="connector-picker-retry" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function EmptyState(): ReactNode {
  return (
    <div className="connector-picker-empty">
      <p>No ready connectors found.</p>
      <a href="/local-knowledge" className="connector-picker-create-link">
        Create a connector
      </a>
    </div>
  );
}

interface SelectedBadgeProps {
  readonly capsules: readonly CapsuleListEntry[];
  readonly capsuleSets: readonly CapsuleSetListEntry[];
  readonly selectedKind: string | undefined;
  readonly selectedId: string | undefined;
}

function selectedLabel(
  capsules: readonly CapsuleListEntry[],
  capsuleSets: readonly CapsuleSetListEntry[],
  kind: string | undefined,
  id: string | undefined,
): string | null {
  if (kind === undefined || id === undefined || id.length === 0) return null;
  if (kind === "capsule") {
    const cap = capsules.find((c) => c.id === id);
    return cap !== undefined ? cap.displayName : `Capsule ${id}`;
  }
  if (kind === "capsule-set") {
    const set = capsuleSets.find((s) => s.id === id);
    return set !== undefined ? set.displayName : `Set ${id}`;
  }
  return null;
}

function SelectedBadge({
  capsules,
  capsuleSets,
  selectedKind,
  selectedId,
}: SelectedBadgeProps): ReactNode {
  const label = selectedLabel(capsules, capsuleSets, selectedKind, selectedId);
  if (label === null) return null;
  return (
    <div className="connector-picker-selected" role="status" aria-live="polite">
      <span aria-hidden="true">●</span>
      <span>{label}</span>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ConnectorPickerWidget({
  selectedKind,
  selectedId,
  onSelect,
}: ConnectorPickerWidgetProps): ReactNode {
  const [capsules, setCapsules] = useState<readonly CapsuleListEntry[]>([]);
  const [capsuleSets, setCapsuleSets] = useState<readonly CapsuleSetListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // C263 — a failed capsule-set fetch must not be swallowed silently: surface it
  // as a non-blocking notice while the capsule picker keeps working.
  const [setsFailed, setSetsFailed] = useState(false);
  // C263 — bumping this token re-runs the load effect ("Try again" in ErrorState).
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      setLoading(true);
      setError(null);
      setSetsFailed(false);
      try {
        const [capsuleResult, capsuleSetResult] = await Promise.allSettled([
          fetchCapsules(),
          fetchCapsuleSets(),
        ]);
        if (cancelled) return;
        if (capsuleResult.status === "fulfilled") {
          setCapsules(capsuleResult.value.capsules.filter((c) => c.lifecycleState === "ready"));
        } else {
          setError(formatLoadError(capsuleResult.reason));
        }
        if (capsuleSetResult.status === "fulfilled") {
          setCapsuleSets(capsuleSetResult.value.capsuleSets);
        } else {
          setSetsFailed(true);
        }
      } catch (caught) {
        if (!cancelled) setError(formatLoadError(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  if (loading) return <LoadingState />;
  if (error !== null) {
    return (
      <ErrorState
        message={error}
        onRetry={() => {
          setReloadToken((t) => t + 1);
        }}
      />
    );
  }

  const hasCapsules = capsules.length > 0;
  const hasSets = capsuleSets.length > 0;
  if (!hasCapsules && !hasSets) return <EmptyState />;

  const currentValue =
    selectedKind !== undefined && selectedId !== undefined && selectedId.length > 0
      ? `${selectedKind}:${selectedId}`
      : "";

  function handleChange(value: string): void {
    if (value === "") return;
    const colonIdx = value.indexOf(":");
    if (colonIdx === -1) return;
    const kind = value.slice(0, colonIdx);
    const id = value.slice(colonIdx + 1);
    if (id.length === 0) return;
    onSelect({ selectedKind: kind, selectedId: id });
  }

  return (
    <div className="connector-picker">
      <SelectedBadge
        capsules={capsules}
        capsuleSets={capsuleSets}
        selectedKind={selectedKind}
        selectedId={selectedId}
      />

      <label className="connector-picker-label" htmlFor="connector-picker-select">
        Select a connector
      </label>
      <select
        id="connector-picker-select"
        className="connector-picker-select"
        value={currentValue}
        onChange={(e) => {
          handleChange(e.target.value);
        }}
      >
        <option value="" disabled>
          — choose a connector —
        </option>
        {hasCapsules && (
          <optgroup label="Capsules">
            {capsules.map((cap) => (
              <option key={`capsule:${cap.id}`} value={`capsule:${cap.id}`}>
                {`${cap.displayName} (${lifecycleLabel(cap.lifecycleState)})`}
              </option>
            ))}
          </optgroup>
        )}
        {hasSets && (
          <optgroup label="Capsule sets">
            {capsuleSets.map((set) => (
              <option key={`capsule-set:${set.id}`} value={`capsule-set:${set.id}`}>
                {`${set.displayName} (${String(set.capsuleCount)} capsules)`}
              </option>
            ))}
          </optgroup>
        )}
      </select>

      {setsFailed ? (
        <p className="connector-picker-notice" role="status">
          Capsule sets could not be loaded.
        </p>
      ) : null}

      <div className="connector-picker-footer">
        <a href="/local-knowledge" className="connector-picker-create-link">
          Create or manage connectors
        </a>
      </div>
    </div>
  );
}
