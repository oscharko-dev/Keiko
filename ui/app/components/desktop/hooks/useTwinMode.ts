"use client";

import { useCallback } from "react";
import { useTwin, type TwinMode } from "../context/TwinContext";

export type { TwinMode };

export interface UseTwinModeResult {
  readonly mode: TwinMode;
  readonly setMode: (next: TwinMode) => void;
  readonly toggle: () => void;
}

// Welle 5: governance state moved into TwinProvider. This hook is now a
// thin slice over useTwin() so existing callers (AppShell/ModeSwitch wiring)
// keep working unchanged.
export function useTwinMode(): UseTwinModeResult {
  const twin = useTwin();
  const toggle = useCallback(
    () => twin.setMode(twin.mode === "manual" ? "autonomous" : "manual"),
    [twin],
  );
  return { mode: twin.mode, setMode: twin.setMode, toggle };
}
