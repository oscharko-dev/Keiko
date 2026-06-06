"use client";

import type { ReactNode } from "react";
import { Icons } from "./Icons";
import type { TwinMode } from "./hooks/useTwinMode";

interface FooterProps {
  readonly winCount: number;
  readonly mode: TwinMode;
  // AC #4: the currently selected model id, undefined when no eligible model is
  // configured. Passed by value from AppShell so no Context provider is needed.
  readonly selectedModel: string | undefined;
  readonly projectName: string;
  readonly branchLabel: string;
  readonly shellStatusLabel: string;
  readonly evidenceStatusLabel: string;
  readonly statusRef?: (node: HTMLElement | null) => void;
}

export function Footer({
  winCount,
  mode,
  selectedModel,
  projectName,
  branchLabel,
  shellStatusLabel,
  evidenceStatusLabel,
  statusRef,
}: FooterProps): ReactNode {
  const modelLabel = selectedModel ?? "No model selected";
  return (
    <footer ref={statusRef} className="footer mono" tabIndex={-1} aria-label="Workspace status" aria-live="polite">
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
        <Icons.folder size={13} /> {projectName}
      </span>
      <span className="ft-seg">
        <Icons.branch size={13} /> {branchLabel}
      </span>
      <span className="ft-seg ft-opt2">
        <Icons.cube size={13} /> {shellStatusLabel}
      </span>
      <span className="spacer" />
      <span className="ft-seg ft-accent">
        <Icons.tile size={13} /> {winCount} {winCount === 1 ? "window" : "windows"}
      </span>
      <span className="ft-seg ft-opt2">
        <Icons.bolt size={13} style={{ color: "var(--accent)" }} /> {modelLabel}
      </span>
      <span className="ft-seg ft-accent">
        <Icons.review size={13} /> {evidenceStatusLabel}
      </span>
    </footer>
  );
}
