"use client";

import type { ReactNode } from "react";
import { Icons } from "./Icons";
import type { TwinMode } from "./hooks/useTwinMode";

interface FooterProps {
  winCount: number;
  mode: TwinMode;
  // AC #4: the currently selected model id, undefined when no eligible model is
  // configured. Passed by value from AppShell so no Context provider is needed.
  selectedModel: string | undefined;
}

export function Footer({ winCount, mode, selectedModel }: FooterProps): ReactNode {
  const modelLabel = selectedModel ?? "No model selected";
  return (
    <footer className="footer mono">
      <span className="ft-seg ft-gov" data-mode={mode}>
        {mode === "autonomous" ? (
          // eslint-disable-next-line @next/next/no-img-element -- design CSS sizes the raw SVG via .ft-orca
          <img className="ft-orca" src="/assets/keiko-logo.svg" alt="" />
        ) : (
          <span className="ft-you">M</span>
        )}
        {mode === "autonomous" ? "Keiko governing" : "You · manual"}
      </span>
      <span className="ft-seg ft-opt2">
        <Icons.folder size={13} /> example-workspace
      </span>
      <span className="ft-seg">
        <Icons.branch size={13} /> keiko/issue-51
      </span>
      <span className="ft-seg ft-opt2">
        <Icons.cube size={13} /> Work locally
      </span>
      <span className="spacer" />
      <span className="ft-seg ft-accent">
        <Icons.tile size={13} /> {winCount} {winCount === 1 ? "window" : "windows"}
      </span>
      <span className="ft-seg ft-opt2">
        <Icons.bolt size={13} style={{ color: "var(--accent)" }} /> {modelLabel}
      </span>
      <span className="ft-seg ft-opt1">
        <Icons.tokens size={13} /> 12.4k tokens
      </span>
      <span className="ft-seg ft-dim ft-opt1">241 ms</span>
      <span className="ft-seg ft-accent">
        <span className="dot" style={{ background: "var(--accent)" }} /> autosaved
      </span>
    </footer>
  );
}
