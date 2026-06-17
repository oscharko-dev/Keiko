export const FIGMA_VIEW_DRAG_TYPE = "application/x-keiko-figma-view";
export const FIGMA_VIEW_DROP_EVENT = "keiko:figma-view-drop";

export interface FigmaViewDragPayload {
  readonly snapshotRunId: string;
  readonly screenId: string;
  readonly name: string;
}

export interface DragDataTransferReader {
  readonly types: readonly string[];
  readonly getData: (format: string) => string;
}

export interface FigmaViewDropDetail {
  readonly payload: FigmaViewDragPayload;
  readonly clientX: number;
  readonly clientY: number;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function serializeFigmaViewDrag(payload: FigmaViewDragPayload): string {
  return JSON.stringify(payload);
}

export function parseFigmaViewDrag(
  dataTransfer: DragDataTransferReader,
): FigmaViewDragPayload | null {
  if (!Array.from(dataTransfer.types).includes(FIGMA_VIEW_DRAG_TYPE)) return null;
  try {
    const parsed: unknown = JSON.parse(dataTransfer.getData(FIGMA_VIEW_DRAG_TYPE));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const snapshotRunId = cleanString(record["snapshotRunId"]);
    const screenId = cleanString(record["screenId"]);
    const name = cleanString(record["name"]);
    if (snapshotRunId === null || screenId === null || name === null) return null;
    return { snapshotRunId, screenId, name };
  } catch {
    return null;
  }
}
