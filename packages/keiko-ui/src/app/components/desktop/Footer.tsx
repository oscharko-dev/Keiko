"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Icons } from "./Icons";
import type { TwinMode } from "./hooks/useTwinMode";
import { WIN_TYPES } from "./windows/WindowsRegistry";
import { subText } from "./windows/connectionUtils";
import type { AppWindow } from "./windows/types";

interface FooterProps {
  readonly winCount: number;
  readonly windows: readonly AppWindow[];
  readonly windowPaletteOpen: boolean;
  readonly onToggleWindowPalette: () => void;
  readonly onSelectWindow: (id: string) => void;
  readonly onCloseWindowPalette: () => void;
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
  windows,
  windowPaletteOpen,
  onToggleWindowPalette,
  onSelectWindow,
  onCloseWindowPalette,
  mode,
  selectedModel,
  projectName,
  branchLabel,
  shellStatusLabel,
  evidenceStatusLabel,
  statusRef,
}: FooterProps): ReactNode {
  const windowPaletteRef = useRef<HTMLSpanElement | null>(null);
  const modelLabel = selectedModel ?? "No model selected";
  const windowLabel = `${String(winCount)} ${winCount === 1 ? "window" : "windows"}`;
  const sortedWindows = [...windows].sort((a, b) => b.z - a.z);

  useEffect(() => {
    if (!windowPaletteOpen) return;
    if (winCount === 0) {
      onCloseWindowPalette();
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (
        target instanceof Node &&
        windowPaletteRef.current !== null &&
        !windowPaletteRef.current.contains(target)
      ) {
        onCloseWindowPalette();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCloseWindowPalette();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onCloseWindowPalette, winCount, windowPaletteOpen]);

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
      <span className="ft-window-wrap" ref={windowPaletteRef}>
        <button
          type="button"
          className="ft-seg ft-accent ft-window-trigger"
          aria-atomic="true"
          aria-expanded={windowPaletteOpen}
          aria-controls="footer-window-palette"
          disabled={winCount === 0}
          title="Open windows in the workspace"
          onClick={onToggleWindowPalette}
        >
          <Icons.tile size={13} /> {windowLabel}
        </button>
        {windowPaletteOpen && winCount > 0 ? (
          <div
            id="footer-window-palette"
            className="ft-window-palette"
            role="menu"
            aria-label="Open windows"
          >
            <div className="ft-window-palette-head">Open windows</div>
            <div className="ft-window-list">
              {sortedWindows.map((win) => {
                const def = WIN_TYPES[win.type];
                const Icon = Icons[def.icon];
                const sub = subText(win.type, win.cfg);
                const stateLabel =
                  win.minimized === true ? "Minimized" : win.max ? "Fullscreen" : "Visible";
                const actionLabel = win.minimized === true ? "Restore" : "Focus";
                return (
                  <button
                    key={win.id}
                    type="button"
                    className="ft-window-card"
                    role="menuitem"
                    data-minimized={win.minimized === true ? "true" : "false"}
                    aria-label={`${actionLabel} ${def.title} window${sub !== null ? ` - ${sub}` : ""}`}
                    onClick={() => onSelectWindow(win.id)}
                  >
                    <span
                      className="ft-window-icon"
                      style={{ color: def.accent === true ? "var(--accent)" : undefined }}
                    >
                      <Icon size={14} />
                    </span>
                    <span className="ft-window-copy">
                      <span className="ft-window-title">{def.title}</span>
                      <span className="ft-window-sub" title={sub ?? stateLabel}>
                        {sub ?? stateLabel}
                      </span>
                    </span>
                    <span className="ft-window-state">{stateLabel}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
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
