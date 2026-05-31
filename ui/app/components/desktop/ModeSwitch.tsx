"use client";

import type { ReactNode } from "react";
import type { TwinMode } from "./hooks/useTwinMode";

interface ModeSwitchProps {
  mode: TwinMode;
  onChange: (next: TwinMode) => void;
}

export function ModeSwitch({ mode, onChange }: ModeSwitchProps): ReactNode {
  return (
    <div className="modesw" data-mode={mode}>
      <button
        type="button"
        className="modesw-opt"
        data-on={mode === "manual"}
        onClick={() => onChange("manual")}
        title="You approve every privileged action"
      >
        <span className="modesw-av">M</span> You
      </button>
      <button
        type="button"
        className="modesw-opt"
        data-on={mode === "autonomous"}
        onClick={() => onChange("autonomous")}
        title="Keiko governs agents per your policy"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- design CSS sizes the raw SVG via .modesw-orca; next/image overlays a wrapper that breaks the segmented control. */}
        <img className="modesw-orca" src="/assets/keiko-logo.svg" alt="" /> Keiko
      </button>
    </div>
  );
}
