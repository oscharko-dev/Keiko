"use client";
// One Jira Pod (owner decision 2026-11-02): its name, base URL and a status chip in one row, one
// visible primary action, and the secondary actions behind a single "…" menu. A healthy Pod shows
// no explanatory text; a Pod that needs attention shows one remediation line and the action that
// resolves it. The embedded Knowledge Pods overview keeps only the name and actions when healthy
// (owner decision 2026-11-04); standalone connector settings retain the address and health chip.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { PodDragHandle } from "@/app/local-knowledge/pod-drag-handle";
import { PodIcon } from "@/app/local-knowledge/pod-icon";
import { useLocalKnowledgeTranslate } from "@/app/local-knowledge/local-knowledge-i18n";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import type {
  AtlassianConnectorMetadata,
  AtlassianConnectorVerifyStatus,
} from "@/lib/atlassian-connectors-api";
import { JiraPodWorkspaceAction } from "../cards/JiraPodWorkspaceAction";
import { verifyStatusCopyKey, verifyStatusLabelKey, verifyStatusTone } from "./connector-labels";
import { PodActionsMenu, type PodMenuItem } from "./PodActionsMenu";
import type { CardController } from "./useConnectorCard";
import styles from "./connectors.module.css";

/** The one state the chip names; it also decides which repair action is shown outside the menu. */
export type LivePodState =
  | { readonly kind: "verifying" }
  | { readonly kind: "unknown" }
  | { readonly kind: "unverified" }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly status: AtlassianConnectorVerifyStatus };

export function livePodState(
  verifying: boolean,
  unconfirmed: boolean,
  status: AtlassianConnectorVerifyStatus | undefined,
): LivePodState {
  if (verifying) return { kind: "verifying" };
  if (unconfirmed) return { kind: "unknown" };
  if (status === undefined) return { kind: "unverified" };
  return status === "ok" ? { kind: "ready" } : { kind: "failed", status };
}

function StatusChip({ state }: { readonly state: LivePodState }): ReactNode {
  const t = useTranslate();
  const view = {
    verifying: { badge: "indexing", label: t("atlassianConnectors.verify.verifying") },
    unknown: { badge: "stale", label: t("atlassianConnectors.live.state.unknown") },
    unverified: { badge: "draft", label: t("atlassianConnectors.list.healthUnknown") },
    ready: { badge: "ready", label: t("atlassianConnectors.live.state.ready") },
    failed: {
      badge:
        state.kind === "failed" && verifyStatusTone(state.status) === "warning" ? "stale" : "error",
      label: state.kind === "failed" ? t(verifyStatusLabelKey(state.status)) : "",
    },
  }[state.kind];
  return (
    <span
      className={`lk-badge ${styles.cmpPodChip}`}
      data-state={view.badge}
      data-testid="acx-pod-state"
    >
      {view.label}
    </span>
  );
}

function StatusHint({ state }: { readonly state: LivePodState }): ReactNode {
  const t = useTranslate();
  if (state.kind === "failed") {
    return (
      <p className="acx-hint" aria-hidden="true">
        {t(verifyStatusCopyKey(state.status))}
      </p>
    );
  }
  if (state.kind === "unknown") {
    return <p className="acx-hint">{t("atlassianConnectors.live.refreshRequired")}</p>;
  }
  if (state.kind === "unverified") {
    return <p className="acx-hint">{t("atlassianConnectors.live.verifyRequired")}</p>;
  }
  return null;
}

function verifiedStatus(state: LivePodState): AtlassianConnectorVerifyStatus | undefined {
  if (state.kind === "ready") return "ok";
  return state.kind === "failed" ? state.status : undefined;
}

// The outcome of a check run in this view; a state loaded with the card is not news.
function useCheckedStatus(state: LivePodState): AtlassianConnectorVerifyStatus | undefined {
  const [checked, setChecked] = useState<AtlassianConnectorVerifyStatus>();
  const previous = useRef(state.kind);
  const status = verifiedStatus(state);
  useEffect(() => {
    if (state.kind === "verifying") setChecked(undefined);
    else if (previous.current === "verifying") setChecked(status);
    previous.current = state.kind;
  }, [state.kind, status]);
  return checked;
}

// The one live region of the card: a check's outcome is announced as its label and guidance,
// also when it succeeded, while the visible card keeps only the chip and, on failure, one line.
function VerifyAnnouncement({ state }: { readonly state: LivePodState }): ReactNode {
  const t = useTranslate();
  const status = useCheckedStatus(state);
  return (
    <output className="sr-only" data-status={status} data-testid="acx-verify-status">
      {status === undefined
        ? null
        : `${t(verifyStatusLabelKey(status))}. ${t(verifyStatusCopyKey(status))}`}
    </output>
  );
}

function repairAction(state: LivePodState): "verify" | "refresh" | undefined {
  if (state.kind === "unknown") return "refresh";
  if (state.kind === "unverified" || state.kind === "failed") return "verify";
  return undefined;
}

function useMenuItems(
  ctrl: CardController,
  repair: "verify" | "refresh" | undefined,
): PodMenuItem[] {
  const t = useTranslate();
  const items: PodMenuItem[] = [];
  if (repair !== "verify") {
    items.push({
      key: "verify",
      label: t("atlassianConnectors.verify.button"),
      onSelect: ctrl.verify,
    });
  }
  if (repair !== "refresh") {
    items.push({
      key: "refresh",
      label: t("atlassianConnectors.live.refresh"),
      onSelect: ctrl.refresh,
    });
  }
  items.push(
    {
      key: "rename",
      label: t("atlassianConnectors.live.rename"),
      onSelect: () => ctrl.edit("rename"),
    },
    {
      key: "rotate",
      label: t("atlassianConnectors.live.replaceToken"),
      onSelect: () => ctrl.edit("rotate"),
    },
    {
      key: "remove",
      label: t("atlassianConnectors.live.remove"),
      danger: true,
      onSelect: ctrl.askDelete,
    },
  );
  return items;
}

export function LivePodActions({
  connector,
  ctrl,
  state,
  embedded,
}: {
  readonly connector: AtlassianConnectorMetadata;
  readonly ctrl: CardController;
  readonly state: LivePodState;
  readonly embedded: boolean;
}): ReactNode {
  const t = useTranslate();
  const repair = repairAction(state);
  const items = useMenuItems(ctrl, repair);
  return (
    <div className={`acx-actions ${styles.cmpPodActions}`}>
      <JiraPodWorkspaceAction
        connector={connector}
        disabled={ctrl.busy}
        primary={!embedded && repair === undefined}
      />
      {repair === undefined ? null : (
        <button
          type="button"
          className="lk-btn lk-btn-primary"
          disabled={ctrl.busy}
          onClick={repair === "verify" ? ctrl.verify : ctrl.refresh}
        >
          {t(
            repair === "verify"
              ? "atlassianConnectors.verify.button"
              : "atlassianConnectors.live.refresh",
          )}
        </button>
      )}
      <PodActionsMenu
        label={t("atlassianConnectors.live.more", { name: connector.displayName })}
        items={items}
        disabled={ctrl.busy}
      />
    </div>
  );
}

function LivePodIdentity({
  connector,
  embedded,
}: {
  readonly connector: AtlassianConnectorMetadata;
  readonly embedded: boolean;
}): ReactNode {
  const t = useLocalKnowledgeTranslate();
  if (!embedded)
    return (
      <div className={styles.cmpPodIdentity}>
        <p className="acx-card-title">{connector.displayName}</p>
        <p className={`acx-meta ${styles.cmpPodUrl}`} title={connector.baseUrl}>
          {connector.baseUrl}
        </p>
      </div>
    );
  if (connector.deployment === "data-center" && connector.livePod !== undefined)
    return (
      <PodDragHandle
        payload={{ kind: "jira-live", id: connector.livePod.podId, label: connector.displayName }}
        name={connector.displayName}
        label={t("localKnowledge.row.dragJiraPod", { name: connector.displayName })}
      />
    );
  return (
    <div className={`${styles.cmpPodIdentity} ${styles.cmpPodEmbeddedIdentity}`}>
      <span className="lk-capsule-icon">
        <PodIcon kind="jira-live" />
      </span>
      <span className="lk-capsule-name">{connector.displayName}</span>
    </div>
  );
}

export function LivePodHeader({
  connector,
  state,
  actions,
  embedded,
}: {
  readonly connector: AtlassianConnectorMetadata;
  readonly state: LivePodState;
  readonly actions: ReactNode;
  readonly embedded: boolean;
}): ReactNode {
  return (
    <>
      <div className={styles.cmpPodHead}>
        <LivePodIdentity connector={connector} embedded={embedded} />
        {embedded && state.kind === "ready" ? null : <StatusChip state={state} />}
        {actions}
      </div>
      <StatusHint state={state} />
      <VerifyAnnouncement state={state} />
    </>
  );
}
