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
  // Each pill carries a title (uiux-fix F011 C360) so meaning and any truncated
  // value (C158) stay reachable, and aria-atomic so live updates are announced
  // as the whole pill instead of a context-free fragment (C400).
  const govTitle =
    mode === "autonomous"
      ? "Governance mode: Keiko governs agents per your policy"
      : "Governance mode: you approve every privileged action";
  return (
    <footer
      ref={statusRef}
      className="footer mono"
      tabIndex={-1}
      aria-label="Workspace status"
      aria-live="polite"
    >
      <span className="ft-seg ft-gov" data-mode={mode} aria-atomic="true" title={govTitle}>
        {mode === "autonomous" ? (
          // eslint-disable-next-line @next/next/no-img-element -- design CSS sizes the raw SVG via .ft-orca
          <img className="ft-orca" src="/assets/keiko-logo.svg" alt="" />
        ) : (
          /* decorative person glyph; the adjacent text carries the information (C128/C293) */
          <span className="ft-you" aria-hidden="true">
            <Icons.user size={10} />
          </span>
        )}
        {mode === "autonomous" ? "Keiko governing" : "You · manual"}
      </span>
      <span className="ft-seg ft-opt2" aria-atomic="true" title={`Active project: ${projectName}`}>
        <Icons.folder size={13} />
        <span className="ft-val">{projectName}</span>
      </span>
      <span className="ft-seg ft-opt1" aria-atomic="true" title={`Git branch: ${branchLabel}`}>
        <Icons.branch size={13} />
        <span className="ft-val">{branchLabel}</span>
      </span>
      <span
        className="ft-seg ft-opt2"
        aria-atomic="true"
        title={`Shell status: ${shellStatusLabel}`}
      >
        <Icons.cube size={13} /> {shellStatusLabel}
      </span>
      <span className="spacer" />
      <span className="ft-seg ft-accent" aria-atomic="true" title="Open windows in the workspace">
        <Icons.tile size={13} /> {winCount} {winCount === 1 ? "window" : "windows"}
      </span>
      <span className="ft-seg ft-opt2" aria-atomic="true" title={`Selected model: ${modelLabel}`}>
        {/* --accent-text keeps AA contrast on the light surface (C073); dark is identical to --accent */}
        <Icons.bolt size={13} style={{ color: "var(--accent-text)" }} />
        <span className="ft-val">{modelLabel}</span>
      </span>
      <span
        className="ft-seg ft-accent"
        aria-atomic="true"
        title={`Review evidence status: ${evidenceStatusLabel}`}
      >
        <Icons.review size={13} /> {evidenceStatusLabel}
      </span>
    </footer>
  );
}
