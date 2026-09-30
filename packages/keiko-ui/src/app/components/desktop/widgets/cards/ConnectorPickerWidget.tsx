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

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import styles from "./ConnectorPickerWidget.module.css";
import {
  capsulesForKnowledgePodUi,
  capsuleSetsForKnowledgePodUi,
  fetchCapsules,
  fetchCapsuleSets,
  type CapsuleListEntry,
  type CapsuleSetListEntry,
} from "@/lib/local-knowledge-api";
import { ApiError } from "@/lib/api";
import { useTranslate } from "@/lib/i18n";
import {
  knowledgePodGuidanceText,
  readinessLabelText,
  useLocalKnowledgeTranslate,
  type I18nTranslate as LocalKnowledgeTranslate,
  type LocalKnowledgeMessageKey,
} from "@/app/local-knowledge/local-knowledge-i18n";
import { STATUS_LABEL_KEYS } from "@/app/local-knowledge/connector-graph-types";
import { Icons } from "../../Icons";
import KeikoSelect from "../../KeikoSelect";
import { NATIVE_BLOCK_STYLE } from "../../native-element-styles";
import { useKnowledgeCatalog } from "../../knowledge-catalog";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const ServerIcon = Icons.server;

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

function lifecycleLabel(
  t: LocalKnowledgeTranslate,
  state: CapsuleListEntry["lifecycleState"],
): string {
  switch (state) {
    case "ready":
      return t("localKnowledge.picker.state.ready");
    case "indexing":
      return t("localKnowledge.picker.state.indexing");
    case "error":
      return t("localKnowledge.picker.state.error");
    default:
      return state;
  }
}

// ─── Grounding readiness (0.3.0 audit) ────────────────────────────────────────
//
// ONE rule, applied to both kinds of grounding source. A Knowledge Pod is offered only when its own
// lifecycle is `ready`: a draft, indexing, stale, or failed pod cannot ground an answer. A Knowledge
// Pod Set is offered only when the SAME rule holds for its members — the pod-set readiness projection
// (keiko-local-knowledge `setReadiness`) is `ready`/`degraded` exactly when every member is itself
// ready, and `draft`/`indexing`/`stale`/`error`/`unavailable` otherwise, with a member-less set
// projecting `unavailable`.
//
// Sets used to be passed through unfiltered, so a failed set — or one whose members had all been
// deleted — was offered in the picker as a usable grounding source.
const SELECTABLE_SET_READINESS: ReadonlySet<string> = new Set(["ready", "degraded"]);

function isSelectableKnowledgePod(capsule: CapsuleListEntry): boolean {
  return capsule.lifecycleState === "ready";
}

function isSelectableKnowledgePodSet(set: CapsuleSetListEntry): boolean {
  if (set.capsuleCount <= 0) return false;
  const readiness = set.knowledgePod?.readiness;
  // No Knowledge Pod summary echoed by the server: the member count above is the only readiness
  // signal available, and withholding every set on a missing-metadata response would hide sets that
  // are in fact usable. The zero-member case — the one unusable state visible without a summary — is
  // already excluded.
  return readiness === undefined || SELECTABLE_SET_READINESS.has(readiness);
}

// A load failure keeps the server's message; without one, ErrorState states the failure in the
// user's language.
interface LoadFailure {
  readonly message: string | undefined;
}

function loadFailure(error: unknown): LoadFailure {
  // uiux-fix F018 C124: lead with the human message; the machine code follows as a
  // parenthesised detail instead of a bold "INTERNAL:" prefix.
  if (error instanceof ApiError) return { message: `${error.message} (${error.code})` };
  if (error instanceof Error) return { message: error.message };
  return { message: undefined };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function LoadingState(): ReactNode {
  const t = useLocalKnowledgeTranslate();
  return (
    <div className="connector-picker-status" role="status" aria-live="polite">
      {t("localKnowledge.picker.loading")}
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  readonly message: string | undefined;
  readonly onRetry: () => void;
}): ReactNode {
  const t = useLocalKnowledgeTranslate();
  return (
    <div className="connector-picker-error" role="alert">
      <p>{message ?? t("localKnowledge.picker.loadFailed")}</p>
      <button type="button" className="connector-picker-retry" onClick={onRetry}>
        {t("localKnowledge.picker.retry")}
      </button>
    </div>
  );
}

function EmptyState({
  onManageConnectors,
}: {
  readonly onManageConnectors: () => void;
}): ReactNode {
  const t = useLocalKnowledgeTranslate();
  return (
    <div className="connector-picker-empty">
      <button
        type="button"
        className="lk-btn lk-btn-primary connector-picker-create-link"
        onClick={onManageConnectors}
      >
        {t("localKnowledge.picker.create")}
      </button>
    </div>
  );
}

// `capsules` and `capsuleSets` are every listed entry in any state — the picker's own options are
// narrowed to the selectable ones — so a selection that stopped being selectable still names its
// entry and its real state.
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

// The state a listed entry is not offered for, named next to it; `null` for a selectable one.
function withheldStateLabel(
  entry: KnowledgePodPickerEntry,
  t: LocalKnowledgeTranslate,
): string | null {
  if ("lifecycleState" in entry) {
    return isSelectableKnowledgePod(entry) ? null : t(STATUS_LABEL_KEYS[entry.lifecycleState]);
  }
  return isSelectableKnowledgePodSet(entry)
    ? null
    : readinessLabelText(entry.knowledgePod?.readiness, t);
}

// A selection is named by its display name (plus its state while it is not selectable). One the
// catalog does not list at all reads as unavailable; the raw id is never shown.
function selectedLabel(
  capsules: readonly CapsuleListEntry[],
  capsuleSets: readonly CapsuleSetListEntry[],
  kind: string | undefined,
  id: string | undefined,
  t: LocalKnowledgeTranslate,
): string | null {
  const entry = selectedEntry(capsules, capsuleSets, kind, id);
  if (entry !== null) {
    const state = withheldStateLabel(entry, t);
    return state === null
      ? entry.displayName
      : t("localKnowledge.picker.selectedWithState", { name: entry.displayName, state });
  }
  if (kind === undefined || id === undefined || id.length === 0) return null;
  if (kind === "capsule") return t("localKnowledge.picker.unavailablePod");
  if (kind === "capsule-set") return t("localKnowledge.picker.unavailableSet");
  return null;
}

function SelectedBadge({
  capsules,
  capsuleSets,
  selectedKind,
  selectedId,
}: SelectedBadgeProps): ReactNode {
  const t = useLocalKnowledgeTranslate();
  const label = selectedLabel(capsules, capsuleSets, selectedKind, selectedId, t);
  if (label === null) return null;
  const guidance = selectedEntry(capsules, capsuleSets, selectedKind, selectedId)?.knowledgePod
    ?.guidance;
  const guidanceText = guidance === undefined ? undefined : knowledgePodGuidanceText(guidance, t);
  return (
    <>
      <div className="connector-picker-selected" role="status" aria-live="polite">
        <span aria-hidden="true">●</span>
        <span>{label}</span>
        {guidance !== undefined && guidanceText !== undefined ? (
          <span className="connector-picker-guidance" data-tone={guidance.tone}>
            {guidanceText.label}
          </span>
        ) : null}
      </div>
      {guidance !== undefined && guidanceText !== undefined ? (
        <p className="connector-picker-notice" data-tone={guidance.tone}>
          {guidanceText.description}
        </p>
      ) : null}
    </>
  );
}

// Nothing is selectable, yet a selection that is listed (a pod that is indexing again, say) is still
// named with its state, above the way to create or manage pods.
function EmptyPicker({
  capsules,
  capsuleSets,
  selectedKind,
  selectedId,
  onManageConnectors,
}: SelectedBadgeProps & { readonly onManageConnectors: () => void }): ReactNode {
  const listed = selectedEntry(capsules, capsuleSets, selectedKind, selectedId) !== null;
  if (!listed) return <EmptyState onManageConnectors={onManageConnectors} />;
  return (
    <div className={`connector-picker ${styles.lazyWidgetScope}`}>
      <SelectedBadge
        capsules={capsules}
        capsuleSets={capsuleSets}
        selectedKind={selectedKind}
        selectedId={selectedId}
      />
      <EmptyState onManageConnectors={onManageConnectors} />
    </div>
  );
}

function pickerOptionGuidance(
  entry: KnowledgePodPickerEntry,
  t: LocalKnowledgeTranslate,
): {
  readonly description?: string;
  readonly badge?: string;
} {
  const guidance = entry.knowledgePod?.guidance;
  if (guidance === undefined) return {};
  const text = knowledgePodGuidanceText(guidance, t);
  return { description: text.description, badge: text.label };
}

// The node's state when the catalog answered and does not list the pod any more.
const CONNECTOR_NODE_UNAVAILABLE = "unavailable";

// The lifecycle states a connector node names; anything else reads as the unselected node.
const CONNECTOR_NODE_STATE_KEYS: ReadonlyMap<string, LocalKnowledgeMessageKey> = new Map([
  ["ready", STATUS_LABEL_KEYS.ready],
  ["draft", STATUS_LABEL_KEYS.draft],
  ["indexing", STATUS_LABEL_KEYS.indexing],
  ["stale", STATUS_LABEL_KEYS.stale],
  ["error", STATUS_LABEL_KEYS.error],
  ["deleting", STATUS_LABEL_KEYS.deleting],
  [CONNECTOR_NODE_UNAVAILABLE, "localKnowledge.node.unavailable"],
]);

function connectorNodeStateLabel(t: LocalKnowledgeTranslate, state: string | undefined): string {
  const key = state === undefined ? undefined : CONNECTOR_NODE_STATE_KEYS.get(state);
  return t(key ?? "localKnowledge.node.unselected");
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
  const t = useLocalKnowledgeTranslate();
  const label =
    selectedLabel !== undefined && selectedLabel.trim().length > 0
      ? selectedLabel.trim()
      : t("localKnowledge.node.defaultLabel");
  return (
    <div className="connector-node" data-testid="knowledge-connector-node">
      <div className="connector-node-icon" aria-hidden="true">
        <ServerIcon size={42} />
      </div>
      <div className="connector-node-copy">
        <p className="connector-node-kicker">{connectorNodeStateLabel(t, selectedState)}</p>
        {/* Non-heading element: this compact Knowledge Pod node is a leaf card with no
            sectioning context, so a real <h2> was an orphan heading (GEN-UI-A11Y-018). */}
        <p className="connector-node-title" title={label}>
          {label}
        </p>
        <p className="connector-node-meta">{t("localKnowledge.node.meta")}</p>
      </div>
      <button type="button" className="connector-node-manage" onClick={onManageConnectors}>
        {t("localKnowledge.node.manage")}
      </button>
    </div>
  );
}

// The node's name and state come from the shared Knowledge Pod catalog, not from the label and state
// frozen into the window's cfg when the pod was dropped: a pod that was renamed, is re-indexing or
// was deleted since must not keep reading as it did at drop time. The dropped values remain the
// fallback while the catalog loads or cannot be read (an unreadable catalog says nothing about the
// pod), and a catalog that loaded and no longer lists the pod reads as unavailable.
function BoundKnowledgeConnectorNode({
  capsuleId,
  selectedLabel,
  selectedState,
  onManageConnectors,
}: {
  readonly capsuleId: string;
  readonly selectedLabel: string | undefined;
  readonly selectedState: string | undefined;
  readonly onManageConnectors: () => void;
}): ReactNode {
  const boundScopes = useMemo(
    () => [
      { kind: "capsule" as const, capsuleId: capsuleId as KnowledgeCapsuleId, connectedAtMs: 0 },
    ],
    [capsuleId],
  );
  const catalog = useKnowledgeCatalog(boundScopes);
  const entry = catalog.capsules.find((capsule) => String(capsule.id) === capsuleId);
  const catalogAnswered = !catalog.loading && catalog.loadError === null;
  if (entry !== undefined) {
    return (
      <KnowledgeConnectorNode
        selectedLabel={entry.displayName}
        selectedState={entry.lifecycleState}
        onManageConnectors={onManageConnectors}
      />
    );
  }
  return (
    <KnowledgeConnectorNode
      selectedLabel={selectedLabel}
      selectedState={catalogAnswered ? CONNECTOR_NODE_UNAVAILABLE : selectedState}
      onManageConnectors={onManageConnectors}
    />
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
  const t = useTranslate();
  const lkT = useLocalKnowledgeTranslate();
  // Every listed entry, in any state: a selection that is no longer selectable still resolves to its
  // name and state. The selectable subsets below are what the picker offers.
  const [listedCapsules, setListedCapsules] = useState<readonly CapsuleListEntry[]>([]);
  const [listedCapsuleSets, setListedCapsuleSets] = useState<readonly CapsuleSetListEntry[]>([]);
  const capsules = useMemo(() => listedCapsules.filter(isSelectableKnowledgePod), [listedCapsules]);
  const capsuleSets = useMemo(
    () => listedCapsuleSets.filter(isSelectableKnowledgePodSet),
    [listedCapsuleSets],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadFailure | null>(null);
  // Sets that loaded fine but cannot ground an answer. Counted rather than silently dropped: a set
  // the user just composed must not simply disappear from the picker with no explanation.
  const [withheldSetCount, setWithheldSetCount] = useState(0);
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
      setWithheldSetCount(0);
      try {
        const [capsuleResult, capsuleSetResult] = await Promise.allSettled([
          fetchCapsules({ includeKnowledgePods: true }),
          fetchCapsuleSets({ includeKnowledgePods: true }),
        ]);
        if (cancelled) return;
        if (capsuleResult.status === "fulfilled") {
          setListedCapsules(capsulesForKnowledgePodUi(capsuleResult.value));
        } else {
          setError(loadFailure(capsuleResult.reason));
        }
        if (capsuleSetResult.status === "fulfilled") {
          const loaded = capsuleSetsForKnowledgePodUi(capsuleSetResult.value);
          setListedCapsuleSets(loaded);
          setWithheldSetCount(loaded.filter((set) => !isSelectableKnowledgePodSet(set)).length);
        } else {
          setSetsFailed(true);
        }
      } catch (caught) {
        if (!cancelled) setError(loadFailure(caught));
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
      <BoundKnowledgeConnectorNode
        capsuleId={selectedId}
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
        message={error.message}
        onRetry={() => {
          setReloadToken((t) => t + 1);
        }}
      />
    );
  }

  const hasCapsules = capsules.length > 0;
  const hasSets = capsuleSets.length > 0;
  if (!hasCapsules && !hasSets) {
    return (
      <EmptyPicker
        capsules={listedCapsules}
        capsuleSets={listedCapsuleSets}
        selectedKind={selectedKind}
        selectedId={selectedId}
        onManageConnectors={onManageConnectors}
      />
    );
  }

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
        capsules={listedCapsules}
        capsuleSets={listedCapsuleSets}
        selectedKind={selectedKind}
        selectedId={selectedId}
      />

      <div className="connector-picker-label">{lkT("localKnowledge.picker.label")}</div>
      <KeikoSelect
        triggerClassName="connector-picker-select"
        value={currentValue}
        ariaLabel={lkT("localKnowledge.picker.label")}
        placeholder={lkT("localKnowledge.picker.placeholder")}
        menuTitle={lkT("localKnowledge.picker.menuTitle")}
        sections={[
          ...(hasCapsules
            ? [
                {
                  label: lkT("localKnowledge.picker.sectionPods"),
                  options: capsules.map((cap) => ({
                    value: `capsule:${cap.id}`,
                    label: `${cap.displayName} (${lifecycleLabel(lkT, cap.lifecycleState)})`,
                    ...pickerOptionGuidance(cap, lkT),
                  })),
                },
              ]
            : []),
          ...(hasSets
            ? [
                {
                  label: lkT("localKnowledge.picker.sectionSets"),
                  options: capsuleSets.map((set) => ({
                    value: `capsule-set:${set.id}`,
                    label: lkT("localKnowledge.picker.setOption", {
                      name: set.displayName,
                      count: String(set.capsuleCount),
                    }),
                    ...pickerOptionGuidance(set, lkT),
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
        <output className="connector-picker-notice" style={NATIVE_BLOCK_STYLE}>
          {lkT("localKnowledge.picker.setsFailed")}
        </output>
      ) : null}

      {withheldSetCount > 0 ? (
        <output className="connector-picker-notice" style={NATIVE_BLOCK_STYLE}>
          {t("connectorPicker.sets.notReadyNotice", { count: String(withheldSetCount) })}
        </output>
      ) : null}

      <div className="connector-picker-footer">
        <button type="button" className="connector-picker-create-link" onClick={onManageConnectors}>
          {lkT("localKnowledge.picker.manage")}
        </button>
      </div>
    </div>
  );
}
