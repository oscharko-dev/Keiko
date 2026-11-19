export const FIGMA_IMAGE_DRAG_TYPE = "application/x-keiko-figma-image";
export const FIGMA_IMAGE_DROP_EVENT = "keiko:figma-image-drop";

export interface FigmaImageDragPayload {
  readonly snapshotRunId: string;
  readonly screenId: string;
  readonly name: string;
  readonly imageSrc: string;
  readonly sourceWindowId?: string | undefined;
}

export interface DragDataTransferReader {
  readonly types: readonly string[];
  readonly getData: (format: string) => string;
}

export interface FigmaImageDropDetail {
  readonly payload: FigmaImageDragPayload;
  readonly clientX: number;
  readonly clientY: number;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isSafeFigmaImageSrc(value: string, snapshotRunId?: string): boolean {
  const match =
    /^\/api\/figma\/snapshots\/([A-Za-z0-9_-][A-Za-z0-9._-]{0,255})\/screens\/(0|[1-9]\d*)\/image$/u.exec(
      value,
    );
  return (
    match?.[0] === value &&
    Number.isSafeInteger(Number(match[2])) &&
    (snapshotRunId === undefined || match[1] === snapshotRunId)
  );
}

export function serializeFigmaImageDrag(payload: FigmaImageDragPayload): string {
  return JSON.stringify(payload);
}

export function parseFigmaImageDrag(
  dataTransfer: DragDataTransferReader,
): FigmaImageDragPayload | null {
  if (!Array.from(dataTransfer.types).includes(FIGMA_IMAGE_DRAG_TYPE)) return null;
  try {
    const parsed: unknown = JSON.parse(dataTransfer.getData(FIGMA_IMAGE_DRAG_TYPE));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const snapshotRunId = cleanString(record["snapshotRunId"]);
    const screenId = cleanString(record["screenId"]);
    const name = cleanString(record["name"]);
    const imageSrc = cleanString(record["imageSrc"]);
    if (
      snapshotRunId === null ||
      screenId === null ||
      name === null ||
      imageSrc === null ||
      !isSafeFigmaImageSrc(imageSrc, snapshotRunId)
    ) {
      return null;
    }
    const sourceWindowId = cleanString(record["sourceWindowId"]);
    return {
      snapshotRunId,
      screenId,
      name,
      imageSrc,
      ...(sourceWindowId !== null ? { sourceWindowId } : {}),
    };
  } catch {
    return null;
  }
}
