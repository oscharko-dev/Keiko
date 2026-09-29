/** Shared viewport geometry for portaled composer controls, independent of canvas transforms. */
export interface OverlayAnchor {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
}

export interface OverlayPosition {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly maxHeight: number;
  readonly openUp: boolean;
}

export function viewportOverlayPosition(input: {
  readonly anchor: OverlayAnchor;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly gap: number;
  readonly preferUp: boolean;
}): OverlayPosition {
  const edge = 16;
  const width = Math.max(0, Math.min(input.width, input.viewportWidth - edge * 2));
  const above = Math.max(0, input.anchor.top - edge - input.gap);
  const below = Math.max(0, input.viewportHeight - input.anchor.bottom - edge - input.gap);
  const openUp = input.preferUp
    ? above >= Math.min(input.height, 96) || above >= below
    : below < input.height && above > below;
  const maxHeight = Math.max(
    0,
    Math.min(input.height, openUp ? above : below, input.viewportHeight - edge * 2),
  );
  return {
    left: Math.max(edge, Math.min(input.anchor.left, input.viewportWidth - width - edge)),
    top: Math.max(
      edge,
      Math.min(
        openUp ? input.anchor.top - input.gap - maxHeight : input.anchor.bottom + input.gap,
        input.viewportHeight - edge - maxHeight,
      ),
    ),
    width,
    maxHeight,
    openUp,
  };
}
