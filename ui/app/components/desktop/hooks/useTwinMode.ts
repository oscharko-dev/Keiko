"use client";

import { useCallback, useEffect, useState } from "react";

export type TwinMode = "manual" | "autonomous";

const STORAGE_KEY = "keiko.twin.mode";
const DEFAULT_MODE: TwinMode = "manual";

function readStoredMode(): TwinMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "manual" || raw === "autonomous" ? raw : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export interface UseTwinModeResult {
  mode: TwinMode;
  setMode: (next: TwinMode) => void;
  toggle: () => void;
}

export function useTwinMode(): UseTwinModeResult {
  const [mode, setModeState] = useState<TwinMode>(readStoredMode);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* localStorage may be unavailable; mode is still applied in-memory. */
    }
  }, [mode]);

  const setMode = useCallback((next: TwinMode) => setModeState(next), []);
  const toggle = useCallback(() => {
    setModeState((current) => (current === "manual" ? "autonomous" : "manual"));
  }, []);

  return { mode, setMode, toggle };
}
