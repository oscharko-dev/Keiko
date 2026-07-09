"use client";

export const WINDOW_RECOVERY_VISIBLE_WIDTH_PX = 120;
export const WINDOW_RECOVERY_TITLEBAR_HEIGHT_PX = 38;

export interface WorkspaceRecoveryViewport {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface WorkspaceRecoveryBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function clampOriginX(x: number, width: number, viewport: WorkspaceRecoveryViewport): number {
  return Math.max(
    viewport.x - (width - WINDOW_RECOVERY_VISIBLE_WIDTH_PX),
    Math.min(viewport.x + viewport.w - WINDOW_RECOVERY_VISIBLE_WIDTH_PX, x),
  );
}

function clampOriginY(y: number, viewport: WorkspaceRecoveryViewport): number {
  return Math.max(
    viewport.y,
    Math.min(viewport.y + viewport.h - WINDOW_RECOVERY_TITLEBAR_HEIGHT_PX, y),
  );
}

export function clampWorkspaceWindowOrigin(
  origin: { readonly x: number; readonly y: number; readonly w: number },
  viewport: WorkspaceRecoveryViewport,
): { readonly x: number; readonly y: number } {
  return {
    x: clampOriginX(origin.x, origin.w, viewport),
    y: clampOriginY(origin.y, viewport),
  };
}

export function clampWorkspaceGroupOrigin(
  bounds: WorkspaceRecoveryBounds,
  viewport: WorkspaceRecoveryViewport,
): { readonly x: number; readonly y: number } {
  return {
    x: clampOriginX(bounds.minX, bounds.maxX - bounds.minX, viewport),
    y: clampOriginY(bounds.minY, viewport),
  };
}
