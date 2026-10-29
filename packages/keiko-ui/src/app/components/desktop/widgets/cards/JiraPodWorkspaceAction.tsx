"use client";
import type { ReactNode } from "react";
import type { AtlassianConnectorMetadata } from "@/lib/atlassian-connectors-api";
import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import {
  LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE,
  dispatchConnectorDrop,
  getWorkspaceCenter,
  serializeLocalKnowledgeConnectorDrag,
  type LocalKnowledgeConnectorDragPayload,
} from "@/app/local-knowledge/connector-drag";

export function JiraPodWorkspaceAction({
  connector,
  disabled = false,
}: {
  readonly connector: AtlassianConnectorMetadata;
  readonly disabled?: boolean;
}): ReactNode {
  const t = useOptionalWidgetTranslate();
  if (connector.deployment !== "data-center" || connector.livePod === undefined) return null;
  const payload: LocalKnowledgeConnectorDragPayload = {
    kind: "jira-live",
    id: connector.livePod.podId,
    label: connector.displayName,
  };
  return (
    <button
      type="button"
      className="lk-btn"
      disabled={disabled}
      draggable={!disabled}
      title={t("chat.jira.workspaceHint")}
      onDragStart={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(
          LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE,
          serializeLocalKnowledgeConnectorDrag(payload),
        );
      }}
      onClick={() => {
        const center = getWorkspaceCenter();
        if (!disabled && center !== null) dispatchConnectorDrop(payload, center);
      }}
    >
      {t("chat.jira.addToWorkspace")}
    </button>
  );
}
