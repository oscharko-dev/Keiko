"use client";

import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import type { TwinMode } from "./hooks/useTwinMode";

interface ModeSwitchProps {
  mode: TwinMode;
  onChange: (next: TwinMode) => void;
}

export function ModeSwitch({ mode, onChange }: ModeSwitchProps): ReactNode {
  const { t } = useI18n();
  return (
    <div className="modesw" data-mode={mode} role="group" aria-label={t("mode.group")}>
      <button
        type="button"
        className="modesw-opt"
        data-on={mode === "manual"}
        aria-pressed={mode === "manual"}
        onClick={() => onChange("manual")}
        title={t("mode.manual.title")}
      >
        <span className="modesw-av" aria-hidden="true">
          M
        </span>{" "}
        {t("mode.manual.label")}
        {mode === "manual" && (
          <span className="modesw-active-cue" aria-hidden="true">
            ✓
          </span>
        )}
      </button>
      <button
        type="button"
        className="modesw-opt"
        data-on={mode === "autonomous"}
        aria-pressed={mode === "autonomous"}
        onClick={() => onChange("autonomous")}
        title={t("mode.autonomous.title")}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- design CSS sizes the raw SVG via .modesw-orca; next/image overlays a wrapper that breaks the segmented control. */}
        <img className="modesw-orca" src="/assets/keiko-logo.svg" alt="" /> Keiko
        {mode === "autonomous" && (
          <span className="modesw-active-cue" aria-hidden="true">
            ✓
          </span>
        )}
      </button>
    </div>
  );
}
