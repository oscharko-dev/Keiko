export const LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE = "application/x-keiko-local-knowledge-connector";
export const LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT = "keiko:local-knowledge-connector-drop";

export interface LocalKnowledgeConnectorDragPayload {
  readonly kind: "capsule" | "capsule-set" | "jira-live";
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

const CONNECTOR_KINDS: ReadonlySet<string> = new Set(["capsule", "capsule-set", "jira-live"]);
export function isLocalKnowledgeConnectorDragPayload(
  value: unknown,
): value is LocalKnowledgeConnectorDragPayload {
  if (typeof value !== "object" || value === null) return false;
  if (!("kind" in value) || typeof value.kind !== "string" || !CONNECTOR_KINDS.has(value.kind))
    return false;
  return "id" in value && typeof value.id === "string" && value.id.trim().length > 0;
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
    const kind = record["kind"];
    if (kind !== "capsule" && kind !== "capsule-set" && kind !== "jira-live") return null;
    if (typeof record["id"] !== "string" || record["id"].trim().length === 0) return null;
    const label = typeof record["label"] === "string" ? record["label"].trim() : "";
    const lifecycleState =
      typeof record["lifecycleState"] === "string" ? record["lifecycleState"].trim() : "";
    return {
      kind,
      id: record["id"].trim(),
      ...(label.length > 0 ? { label } : {}),
      ...(lifecycleState.length > 0 ? { lifecycleState } : {}),
    };
  } catch {
    return null;
  }
}

export function getWorkspaceCenter(): {
  readonly clientX: number;
  readonly clientY: number;
} | null {
  const ws = document.querySelector("main.workspace");
  if (!(ws instanceof HTMLElement)) return null;
  const rect = ws.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    clientX: Math.round(rect.left + rect.width / 2),
    clientY: Math.round(rect.top + rect.height / 2),
  };
}

export function isWorkspaceDropTarget(clientX: number, clientY: number): boolean {
  const target = document.elementFromPoint(clientX, clientY);
  if (!(target instanceof Element)) return false;
  return target.closest("main.workspace") !== null && target.closest(".window") === null;
}

export function dispatchConnectorDrop(
  payload: LocalKnowledgeConnectorDragPayload,
  event: { readonly clientX: number; readonly clientY: number },
): void {
  const detail: LocalKnowledgeConnectorDropDetail = {
    payload,
    clientX: event.clientX,
    clientY: event.clientY,
  };
  window.dispatchEvent(new CustomEvent(LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT, { detail }));
}
