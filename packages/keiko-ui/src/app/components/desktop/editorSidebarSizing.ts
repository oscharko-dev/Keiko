export const EDITOR_SIDEBAR_DEFAULT_WIDTH = 260;
export const EDITOR_SIDEBAR_MIN_WIDTH = 48;
export const EDITOR_SIDEBAR_PERSISTED_MAX_WIDTH = 32_768;

const EDITOR_SIDEBAR_MAX_WORKSPACE_PERCENT = 95;
const EDITOR_MAIN_MIN_WIDTH = 48;

export interface EditorSidebarBounds {
  readonly min: number;
  readonly max: number;
}

interface EditorSidebarPointerInput {
  readonly clientX: number;
  readonly rectLeft: number;
  readonly rectWidth: number;
  readonly logicalWorkspaceWidth: number;
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function editorSidebarBounds(logicalWorkspaceWidth: number): EditorSidebarBounds {
  const workspaceWidth = Math.min(
    EDITOR_SIDEBAR_PERSISTED_MAX_WIDTH,
    finitePositive(logicalWorkspaceWidth, EDITOR_SIDEBAR_DEFAULT_WIDTH + EDITOR_MAIN_MIN_WIDTH),
  );
  const ratioMax = Math.floor(workspaceWidth * (EDITOR_SIDEBAR_MAX_WORKSPACE_PERCENT / 100));
  const remainderMax = Math.floor(workspaceWidth - EDITOR_MAIN_MIN_WIDTH);
  return {
    min: EDITOR_SIDEBAR_MIN_WIDTH,
    max: Math.max(
      EDITOR_SIDEBAR_MIN_WIDTH,
      Math.min(EDITOR_SIDEBAR_PERSISTED_MAX_WIDTH, ratioMax, remainderMax),
    ),
  };
}

export function editorSidebarTrackWidth(sidebarWidth: number): string {
  const persistedWidth = Math.min(
    EDITOR_SIDEBAR_PERSISTED_MAX_WIDTH,
    Math.max(EDITOR_SIDEBAR_MIN_WIDTH, finitePositive(sidebarWidth, EDITOR_SIDEBAR_DEFAULT_WIDTH)),
  );
  return `max(${String(EDITOR_SIDEBAR_MIN_WIDTH)}px, min(${String(persistedWidth)}px, ${String(EDITOR_SIDEBAR_MAX_WORKSPACE_PERCENT)}%, calc(100% - ${String(EDITOR_MAIN_MIN_WIDTH)}px)))`;
}

export function editorWorkspaceLogicalWidth(
  node: HTMLElement,
  rect: DOMRect = node.getBoundingClientRect(),
): number {
  return finitePositive(node.offsetWidth, finitePositive(rect.width, EDITOR_SIDEBAR_DEFAULT_WIDTH));
}

export function editorSidebarWidthFromPointer(input: EditorSidebarPointerInput): number {
  const logicalWorkspaceWidth = finitePositive(
    input.logicalWorkspaceWidth,
    EDITOR_SIDEBAR_DEFAULT_WIDTH,
  );
  const rectWidth = finitePositive(input.rectWidth, logicalWorkspaceWidth);
  const screenToLogicalScale = rectWidth / logicalWorkspaceWidth;
  const rawWidth = (input.clientX - input.rectLeft) / screenToLogicalScale;
  const bounds = editorSidebarBounds(logicalWorkspaceWidth);
  return Math.min(bounds.max, Math.max(bounds.min, rawWidth));
}
