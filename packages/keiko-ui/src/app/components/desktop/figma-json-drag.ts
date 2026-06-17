export const FIGMA_JSON_DRAG_TYPE = "application/x-keiko-figma-json";
export const FIGMA_JSON_DROP_EVENT = "keiko:figma-json-drop";

export interface FigmaJsonDragPayload {
  readonly snapshotRunId: string;
  readonly screenId: string;
  readonly name: string;
  readonly sourceWindowId?: string | undefined;
}

export interface DragDataTransferReader {
  readonly types: readonly string[];
  readonly getData: (format: string) => string;
}

export interface FigmaJsonDropDetail {
  readonly payload: FigmaJsonDragPayload;
  readonly clientX: number;
  readonly clientY: number;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function serializeFigmaJsonDrag(payload: FigmaJsonDragPayload): string {
  return JSON.stringify(payload);
}

export function parseFigmaJsonDrag(
  dataTransfer: DragDataTransferReader,
): FigmaJsonDragPayload | null {
  if (!Array.from(dataTransfer.types).includes(FIGMA_JSON_DRAG_TYPE)) return null;
  try {
    const parsed: unknown = JSON.parse(dataTransfer.getData(FIGMA_JSON_DRAG_TYPE));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const snapshotRunId = cleanString(record["snapshotRunId"]);
    const screenId = cleanString(record["screenId"]);
    const name = cleanString(record["name"]);
    if (snapshotRunId === null || screenId === null || name === null) return null;
    const sourceWindowId = cleanString(record["sourceWindowId"]);
    return {
      snapshotRunId,
      screenId,
      name,
      ...(sourceWindowId !== null ? { sourceWindowId } : {}),
    };
  } catch {
    return null;
  }
}
