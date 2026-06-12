export const LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE =
  "application/x-keiko-local-knowledge-connector";
export const LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT = "keiko:local-knowledge-connector-drop";

export interface LocalKnowledgeConnectorDragPayload {
  readonly kind: "capsule";
  readonly id: string;
  readonly label?: string;
  readonly lifecycleState?: string;
}

export interface DragDataTransferReader {
  readonly types: readonly string[];
  readonly getData: (format: string) => string;
}

export interface LocalKnowledgeConnectorDropDetail {
  readonly payload: LocalKnowledgeConnectorDragPayload;
  readonly clientX: number;
  readonly clientY: number;
}

export function serializeLocalKnowledgeConnectorDrag(
  payload: LocalKnowledgeConnectorDragPayload,
): string {
  return JSON.stringify(payload);
}

export function parseLocalKnowledgeConnectorDrag(
  dataTransfer: DragDataTransferReader,
): LocalKnowledgeConnectorDragPayload | null {
  if (!Array.from(dataTransfer.types).includes(LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE)) return null;
  try {
    const parsed: unknown = JSON.parse(dataTransfer.getData(LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record["kind"] !== "capsule") return null;
    if (typeof record["id"] !== "string" || record["id"].trim().length === 0) return null;
    const label = typeof record["label"] === "string" ? record["label"].trim() : "";
    const lifecycleState =
      typeof record["lifecycleState"] === "string" ? record["lifecycleState"].trim() : "";
    return {
      kind: "capsule",
      id: record["id"].trim(),
      ...(label.length > 0 ? { label } : {}),
      ...(lifecycleState.length > 0 ? { lifecycleState } : {}),
    };
  } catch {
    return null;
  }
}
