"use client";

import type { ReactNode } from "react";
import { Icons } from "./Icons";
import { EditorMenu } from "./EditorMenu";
import { ModeSwitch } from "./ModeSwitch";
import type { TwinMode } from "./hooks/useTwinMode";

export type HeaderStatusTone = "ok" | "warn" | "danger";

interface HeaderProps {
  readonly mode: TwinMode;
  readonly projectName: string;
  // Real shell connection state for the status pill — previously a hardcoded
  // "connected" literal that contradicted the footer during outages.
  readonly statusLabel: string;
  readonly statusTone: HeaderStatusTone;
  readonly onModeChange: (next: TwinMode) => void;
  readonly openPalette: () => void;
  // uiux-fix F039 C223 — visible entry point for the command palette; the Cmd/Ctrl+K
  // chord alone was undiscoverable (no on-screen hint anywhere in the chrome).
  readonly openCommandPalette: () => void;
  readonly onTileAll: () => void;
  readonly onSplitFront: () => void;
  readonly onCascade: () => void;
  // uiux-fix F013 C023 — the two window buttons on the right used to render
  // without any handler (dead controls with full hover/focus affordance).
  // They now maximize/restore the front window via the existing workspace API.
  readonly onExpandFront: () => void;
  readonly onRestoreFront: () => void;
}

export function Header({
  mode,
  projectName,
  statusLabel,
  statusTone,
  onModeChange,
  openPalette,
  openCommandPalette,
  onTileAll,
  onSplitFront,
  onCascade,
  onExpandFront,
  onRestoreFront,
}: HeaderProps): ReactNode {
  return (
    <header className="header">
      <div className="hd-brand">
        {/* uiux-fix F013 C399 — alt="" : the visible wordmark right next to it already
            names the brand; alt="Keiko" made screen readers announce "Keiko Keiko"
            (same treatment as the footer logo). */}
        {/* eslint-disable-next-line @next/next/no-img-element -- design CSS sizes the raw SVG; next/image would inject a wrapper that breaks .hd-logo */}
        <img className="hd-logo" src="/assets/keiko-logo.svg" alt="" />
        <span className="hd-wordmark">Keiko</span>
      </div>

      {/* uiux-fix F013 C059/C291 — removed the dead "New tab" button and the dropdown
          chevron: no tab model exists, both promised interactivity they did not have.
          title carries the full project name once the span truncates (C157/C225). */}
      <div className="tb-tabs">
        <div className="tb-tab" data-active="true" title={projectName}>
          <span>{projectName}</span>
        </div>
      </div>

      <span className="spacer" />

      <div className="hd-tools">
        <button
          type="button"
          className="hd-tool hd-tool-cta"
          onClick={openPalette}
          title="New window — press Ctrl/⌘K for all commands"
        >
          <Icons.add size={16} />
          <span>New</span>
        </button>
        {/* uiux-fix F039 C223 — clickable ⌘K chip (reuses the shared .kbd optic from the
            CommandPalette) so the palette has a discoverable on-screen entry point. */}
        <button
          type="button"
          className="hd-tool hd-tool-kbd"
          onClick={openCommandPalette}
          title="Open the command palette (Ctrl/⌘K)"
          aria-label="Open the command palette (Ctrl/⌘K)"
        >
          <span className="kbd" aria-hidden="true">
            ⌘K
          </span>
        </button>
        <span className="hd-div" />
        <EditorMenu project={projectName} />
        <span className="hd-div" />
        <button
          type="button"
          className="hd-tool"
          onClick={onTileAll}
          title="Tile all windows"
          aria-label="Tile all windows"
        >
          <Icons.tile size={16} />
        </button>
        {/* uiux-fix F039 C401 — same wording as the CommandPalette command ("Split front
            windows") so the action is recognizable across tooltip and palette. */}
        <button
          type="button"
          className="hd-tool"
          onClick={onSplitFront}
          title="Split front windows"
          aria-label="Split front windows"
        >
          <Icons.split size={16} />
        </button>
        <button
          type="button"
          className="hd-tool"
          onClick={onCascade}
          title="Cascade windows"
          aria-label="Cascade windows"
        >
          <Icons.cascade size={16} />
        </button>
      </div>

      <span className="hd-div" />
      <ModeSwitch mode={mode} onChange={onModeChange} />
      <div className="tb-status mono" role="status">
        <span className="dot" data-tone={statusTone} /> {statusLabel}
      </div>
      {/* uiux-fix F013 C023/C405 — wired to the workspace API (maximize/restore the
          front window; no-op without open windows). The window model has no minimize
          state (AppWindow only tracks max), so the second button is labelled
          "Restore window". Icon sizes normalized to 16 to match the hd-tools row. */}
      <button
        type="button"
        className="tb-btn"
        onClick={onExpandFront}
        title="Expand the front window"
        aria-label="Expand window"
      >
        <Icons.expand size={16} />
      </button>
      <button
        type="button"
        className="tb-btn"
        onClick={onRestoreFront}
        title="Restore the front window"
        aria-label="Restore window"
      >
        <Icons.minimize size={16} />
      </button>
    </header>
  );
}
