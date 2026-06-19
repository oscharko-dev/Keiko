export const WALLPAPER_ENABLED_KEY = "keiko.wallpaper.enabled";
export const WALLPAPER_OPACITY_KEY = "keiko.wallpaper.opacity";
export const WORKSPACE_BACKGROUND_BRIGHTNESS_KEY = "keiko.workspace.background.brightness";
export const WORKSPACE_GRID_STRENGTH_KEY = "keiko.workspace.grid.strength";
export const FRAME_BORDER_STRENGTH_KEY = "keiko.frame.border.strength";
export const FRAME_INNER_GLOW_STRENGTH_KEY = "keiko.frame.inner.glow.strength";

export const DEFAULT_WALLPAPER_ENABLED = false;

export const WALLPAPER_ENABLED_EVENT = "keiko:wallpaper-enabled";
export const WALLPAPER_OPACITY_EVENT = "keiko:wallpaper-opacity";
export const WORKSPACE_BACKGROUND_BRIGHTNESS_EVENT = "keiko:workspace-background-brightness";
export const WORKSPACE_GRID_STRENGTH_EVENT = "keiko:workspace-grid-strength";
export const FRAME_BORDER_STRENGTH_EVENT = "keiko:frame-border-strength";
export const FRAME_INNER_GLOW_STRENGTH_EVENT = "keiko:frame-inner-glow-strength";

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function readWallpaperEnabled(): boolean {
  if (typeof window === "undefined") return DEFAULT_WALLPAPER_ENABLED;
  try {
    if (typeof window.localStorage?.getItem !== "function") return DEFAULT_WALLPAPER_ENABLED;
    return window.localStorage.getItem(WALLPAPER_ENABLED_KEY) === "true";
  } catch {
    return DEFAULT_WALLPAPER_ENABLED;
  }
}

export function readWallpaperOpacity(): number {
  if (typeof window === "undefined") return 100;
  try {
    if (typeof window.localStorage?.getItem !== "function") return 100;
    const raw = window.localStorage.getItem(WALLPAPER_OPACITY_KEY);
    if (raw === null) return 100;
    return clampPercent(Number.parseInt(raw, 10));
  } catch {
    return 100;
  }
}

export function readWorkspaceBackgroundBrightness(): number {
  if (typeof window === "undefined") return 0;
  try {
    if (typeof window.localStorage?.getItem !== "function") return 0;
    const raw = window.localStorage.getItem(WORKSPACE_BACKGROUND_BRIGHTNESS_KEY);
    if (raw === null) return 0;
    return clampPercent(Number.parseInt(raw, 10));
  } catch {
    return 0;
  }
}

export function readWorkspaceGridStrength(): number {
  if (typeof window === "undefined") return 28;
  try {
    if (typeof window.localStorage?.getItem !== "function") return 28;
    const raw = window.localStorage.getItem(WORKSPACE_GRID_STRENGTH_KEY);
    if (raw === null) return 28;
    return clampPercent(Number.parseInt(raw, 10));
  } catch {
    return 28;
  }
}

export function readFrameBorderStrength(): number {
  if (typeof window === "undefined") return 42;
  try {
    if (typeof window.localStorage?.getItem !== "function") return 42;
    const raw = window.localStorage.getItem(FRAME_BORDER_STRENGTH_KEY);
    if (raw === null) return 42;
    return clampPercent(Number.parseInt(raw, 10));
  } catch {
    return 42;
  }
}

export function readFrameInnerGlowStrength(): number {
  if (typeof window === "undefined") return 0;
  try {
    if (typeof window.localStorage?.getItem !== "function") return 0;
    const raw = window.localStorage.getItem(FRAME_INNER_GLOW_STRENGTH_KEY);
    if (raw === null) return 0;
    return clampPercent(Number.parseInt(raw, 10));
  } catch {
    return 0;
  }
}

export function applyWorkspaceBackgroundBrightness(value: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    "--workspace-bg-brightness",
    `${clampPercent(value)}%`,
  );
}

export function applyWorkspaceGridStrength(value: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    "--workspace-grid-strength",
    `${clampPercent(value)}%`,
  );
}

export function applyFrameBorderStrength(value: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--frame-border-strength", `${clampPercent(value)}%`);
}

export function applyFrameInnerGlowStrength(value: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    "--frame-inner-glow-strength",
    `${clampPercent(value)}%`,
  );
}
