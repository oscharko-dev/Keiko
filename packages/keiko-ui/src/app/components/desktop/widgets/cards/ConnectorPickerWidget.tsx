"use client";

// Epic #189 Slice 3 M2 — compact connector picker window.
//
// The user selects a ready capsule or capsule-set from a live list fetched from the BFF.
// The selection is persisted into the window's cfg via updateCfg so the relationship-edge
// binding can read `cfg.selectedKind` and `cfg.selectedId`. The manage action opens the singleton
// Local Knowledge Workspace window instead of navigating away.
//
// Accessibility: the picker is a <select> with a visible <label>; the selected item is
// announced via role="status"; the manage affordance is a real button so keyboard users can reach
// it with Tab/Enter. All interactive targets are ≥24×24 px (WCAG 2.5.8).
// Color contrast follows the design system tokens (ink on surface — all ≥4.5:1).

import { useEffect, useState, type ReactNode } from "react";
import styles from "./ConnectorPickerWidget.module.css";
import {
  capsulesForKnowledgePodUi,
  capsuleSetsForKnowledgePodUi,
  fetchCapsules,
  fetchCapsuleSets,
  type CapsuleListEntry,
  type CapsuleSetListEntry,
  type KnowledgePodUiGuidance,
} from "@/lib/local-knowledge-api";
import { formatError } from "@/app/local-knowledge/format-error";
import { Icons } from "../../Icons";
import KeikoSelect from "../../KeikoSelect";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConnectorPickerCfg {
  readonly selectedKind?: string;
  readonly selectedId?: string;
}

export interface ConnectorPickerWidgetProps {
  /** Current cfg from the window (may be undefined on first render). */
  readonly selectedKind?: string | undefined;
  readonly selectedId?: string | undefined;
  readonly selectedLabel?: string | undefined;
  readonly selectedState?: string | undefined;
  readonly presentation?: string | undefined;
  /** Called with the updated cfg fields when the user makes a selection. */
  readonly onSelect: (patch: { selectedKind: string; selectedId: string }) => void;
  /** Opens the singleton Local Knowledge management window. */
  readonly onManageConnectors?: () => void;
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

// ─── Sub-components ───────────────────────────────────────────────────────────

function LoadingState(): ReactNode {
  return (
    <div className="connector-picker-status" role="status" aria-live="polite">
      Loading Knowledge Pods…
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

function EmptyState({
  onManageConnectors,
}: {
  readonly onManageConnectors: () => void;
}): ReactNode {
  return (
    <div className="connector-picker-empty">
      <button
        type="button"
        className="lk-btn lk-btn-primary connector-picker-create-link"
        onClick={onManageConnectors}
      >
        Create a Knowledge Pod
      </button>
    </div>
  );
}

interface SelectedBadgeProps {
  readonly capsules: readonly CapsuleListEntry[];
  readonly capsuleSets: readonly CapsuleSetListEntry[];
  readonly selectedKind: string | undefined;
  readonly selectedId: string | undefined;
}

type KnowledgePodPickerEntry = CapsuleListEntry | CapsuleSetListEntry;

function selectedEntry(
  capsules: readonly CapsuleListEntry[],
  capsuleSets: readonly CapsuleSetListEntry[],
  kind: string | undefined,
  id: string | undefined,
): KnowledgePodPickerEntry | null {
  if (kind === undefined || id === undefined || id.length === 0) return null;
  if (kind === "capsule") {
    return capsules.find((c) => c.id === id) ?? null;
  }
  if (kind === "capsule-set") {
    return capsuleSets.find((s) => s.id === id) ?? null;
  }
  return null;
}

function selectedLabel(
  capsules: readonly CapsuleListEntry[],
  capsuleSets: readonly CapsuleSetListEntry[],
  kind: string | undefined,
  id: string | undefined,
): string | null {
  const entry = selectedEntry(capsules, capsuleSets, kind, id);
  if (entry !== null) return entry.displayName;
  if (kind === undefined || id === undefined || id.length === 0) return null;
  if (kind === "capsule") return `Knowledge Pod ${id}`;
  if (kind === "capsule-set") return `Knowledge Pod Set ${id}`;
  return null;
}

function guidanceForEntry(
  entry: KnowledgePodPickerEntry | null,
): KnowledgePodUiGuidance | undefined {
  return entry?.knowledgePod?.guidance;
}

function SelectedBadge({
  capsules,
  capsuleSets,
  selectedKind,
  selectedId,
}: SelectedBadgeProps): ReactNode {
  const label = selectedLabel(capsules, capsuleSets, selectedKind, selectedId);
  const guidance = guidanceForEntry(selectedEntry(capsules, capsuleSets, selectedKind, selectedId));
  if (label === null) return null;
  return (
    <>
      <div className="connector-picker-selected" role="status" aria-live="polite">
        <span aria-hidden="true">●</span>
        <span>{label}</span>
        {guidance !== undefined ? (
          <span className="connector-picker-guidance" data-tone={guidance.tone}>
            {guidance.label}
          </span>
        ) : null}
      </div>
      {guidance !== undefined ? (
        <p className="connector-picker-notice" data-tone={guidance.tone}>
          {guidance.description}
        </p>
      ) : null}
    </>
  );
}

function pickerOptionGuidance(entry: KnowledgePodPickerEntry): {
  readonly description?: string;
  readonly badge?: string;
} {
  const guidance = entry.knowledgePod?.guidance;
  if (guidance === undefined) return {};
  return {
    description: guidance.description,
    badge: guidance.label,
  };
}

function connectorNodeStateLabel(state: string | undefined): string {
  switch (state) {
    case "ready":
      return "Indexed";
    case "draft":
      return "Draft";
    case "indexing":
      return "Indexing";
    case "stale":
      return "Stale";
    case "error":
      return "Failed";
    default:
      return "Local Knowledge";
  }
}

function KnowledgeConnectorNode({
  selectedLabel,
  selectedState,
  onManageConnectors,
}: {
  readonly selectedLabel: string | undefined;
  readonly selectedState: string | undefined;
  readonly onManageConnectors: () => void;
}): ReactNode {
  const label =
    selectedLabel !== undefined && selectedLabel.trim().length > 0
      ? selectedLabel.trim()
      : "Knowledge Pod";
  return (
    <div className="connector-node" data-testid="knowledge-connector-node">
      <div className="connector-node-icon" aria-hidden="true">
        <Icons.server size={42} />
      </div>
      <div className="connector-node-copy">
        <p className="connector-node-kicker">{connectorNodeStateLabel(selectedState)}</p>
        {/* Non-heading element: this compact Knowledge Pod node is a leaf card with no
            sectioning context, so a real <h2> was an orphan heading (GEN-UI-A11Y-018). */}
        <p className="connector-node-title" title={label}>
          {label}
        </p>
        <p className="connector-node-meta">Local Knowledge Pod</p>
      </div>
      <button type="button" className="connector-node-manage" onClick={onManageConnectors}>
        Manage
      </button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ConnectorPickerWidget({
  selectedKind,
  selectedId,
  selectedLabel,
  selectedState,
  presentation,
  onSelect,
  onManageConnectors = () => undefined,
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
  const isConnectorNode =
    presentation === "node" &&
    selectedKind === "capsule" &&
    selectedId !== undefined &&
    selectedId.length > 0;

  useEffect(() => {
    if (isConnectorNode) return undefined;
    let cancelled = false;
    async function load(): Promise<void> {
      setLoading(true);
      setError(null);
      setSetsFailed(false);
      try {
        const [capsuleResult, capsuleSetResult] = await Promise.allSettled([
          fetchCapsules({ includeKnowledgePods: true }),
          fetchCapsuleSets({ includeKnowledgePods: true }),
        ]);
        if (cancelled) return;
        if (capsuleResult.status === "fulfilled") {
          setCapsules(
            capsulesForKnowledgePodUi(capsuleResult.value).filter(
              (capsule) => capsule.lifecycleState === "ready",
            ),
          );
        } else {
          setError(formatError(capsuleResult.reason));
        }
        if (capsuleSetResult.status === "fulfilled") {
          setCapsuleSets(capsuleSetsForKnowledgePodUi(capsuleSetResult.value));
        } else {
          setSetsFailed(true);
        }
      } catch (caught) {
        if (!cancelled) setError(formatError(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [isConnectorNode, reloadToken]);

  if (isConnectorNode) {
    return (
      <KnowledgeConnectorNode
        selectedLabel={selectedLabel}
        selectedState={selectedState}
        onManageConnectors={onManageConnectors}
      />
    );
  }

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
  if (!hasCapsules && !hasSets) return <EmptyState onManageConnectors={onManageConnectors} />;

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
    <div className={`connector-picker ${styles.lazyWidgetScope}`}>
      <SelectedBadge
        capsules={capsules}
        capsuleSets={capsuleSets}
        selectedKind={selectedKind}
        selectedId={selectedId}
      />

      <div className="connector-picker-label">Select Knowledge Pod source</div>
      <KeikoSelect
        triggerClassName="connector-picker-select"
        value={currentValue}
        ariaLabel="Select Knowledge Pod source"
        placeholder="— choose a Knowledge Pod source —"
        menuTitle="Available Knowledge Pod sources"
        sections={[
          ...(hasCapsules
            ? [
                {
                  label: "Knowledge Pods",
                  options: capsules.map((cap) => ({
                    value: `capsule:${cap.id}`,
                    label: `${cap.displayName} (${lifecycleLabel(cap.lifecycleState)})`,
                    ...pickerOptionGuidance(cap),
                  })),
                },
              ]
            : []),
          ...(hasSets
            ? [
                {
                  label: "Knowledge Pod Sets",
                  options: capsuleSets.map((set) => ({
                    value: `capsule-set:${set.id}`,
                    label: `${set.displayName} (${String(set.capsuleCount)} pods)`,
                    ...pickerOptionGuidance(set),
                  })),
                },
              ]
            : []),
        ]}
        onValueChange={(next) => {
          handleChange(next);
        }}
      />

      {setsFailed ? (
        <p className="connector-picker-notice" role="status">
          Knowledge Pod Sets could not be loaded.
        </p>
      ) : null}

      <div className="connector-picker-footer">
        <button type="button" className="connector-picker-create-link" onClick={onManageConnectors}>
          Create or manage Knowledge Pods
        </button>
      </div>
    </div>
  );
}
