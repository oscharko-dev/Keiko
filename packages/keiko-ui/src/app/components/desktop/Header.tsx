"use client";

import type { ReactNode } from "react";
import { Icons } from "./Icons";

export type HeaderStatusTone = "ok" | "warn" | "danger";

interface HeaderProps {
  readonly openPalette: () => void;
  // uiux-fix F039 C223 — visible entry point for the command palette; the Cmd/Ctrl+K
  // chord alone was undiscoverable (no on-screen hint anywhere in the chrome).
  readonly openCommandPalette: () => void;
  readonly onTileAll: () => void;
  readonly onSplitFront: () => void;
  readonly onCascade: () => void;
}

export function Header({
  openPalette,
  openCommandPalette,
  onTileAll,
  onSplitFront,
  onCascade,
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

    </header>
  );
}
