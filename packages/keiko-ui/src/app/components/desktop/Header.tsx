"use client";

import type { ReactNode } from "react";
import { Icons } from "./Icons";
import { EditorMenu } from "./EditorMenu";
import { ModeSwitch } from "./ModeSwitch";
import type { TwinMode } from "./hooks/useTwinMode";

interface HeaderProps {
  mode: TwinMode;
  onModeChange: (next: TwinMode) => void;
  openPalette: () => void;
  onTileAll: () => void;
  onSplitFront: () => void;
  onCascade: () => void;
}

export function Header({
  mode,
  onModeChange,
  openPalette,
  onTileAll,
  onSplitFront,
  onCascade,
}: HeaderProps): ReactNode {
  return (
    <header className="header">
      <div className="hd-brand">
        {/* eslint-disable-next-line @next/next/no-img-element -- design CSS sizes the raw SVG; next/image would inject a wrapper that breaks .hd-logo */}
        <img className="hd-logo" src="/assets/keiko-logo.svg" alt="Keiko" />
        <span className="hd-wordmark">Keiko</span>
      </div>

      <div className="tb-tabs">
        <div className="tb-tab" data-active="true">
          <span>example-workspace</span>
          <Icons.chevron size={13} style={{ color: "var(--fg-faint)" }} />
        </div>
        <button type="button" className="tb-newtab" aria-label="New tab">
          <Icons.plus size={15} />
        </button>
      </div>

      <span className="spacer" />

      <div className="hd-tools">
        <button
          type="button"
          className="hd-tool hd-tool-cta"
          onClick={openPalette}
          title="New window"
        >
          <Icons.add size={16} />
          <span>New</span>
        </button>
        <span className="hd-div" />
        <EditorMenu project="example-workspace" />
        <span className="hd-div" />
        <button type="button" className="hd-tool" onClick={onTileAll} title="Tile all windows">
          <Icons.tile size={16} />
        </button>
        <button
          type="button"
          className="hd-tool"
          onClick={onSplitFront}
          title="Split the two front windows"
        >
          <Icons.split size={16} />
        </button>
        <button type="button" className="hd-tool" onClick={onCascade} title="Cascade windows">
          <Icons.cascade size={16} />
        </button>
      </div>

      <span className="hd-div" />
      <ModeSwitch mode={mode} onChange={onModeChange} />
      <div className="tb-status mono">
        <span className="dot" style={{ background: "var(--ok)" }} /> connected
      </div>
      <button type="button" className="tb-btn" aria-label="Expand window">
        <Icons.expand size={15} />
      </button>
      <button type="button" className="tb-btn" aria-label="Minimize window">
        <Icons.minimize size={16} />
      </button>
    </header>
  );
}
