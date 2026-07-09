"use client";

import type { ReactNode } from "react";
import { memo } from "react";
import { useTranslate } from "@/lib/i18n";
import { Icons } from "./Icons";

export type HeaderStatusTone = "ok" | "warn" | "danger";

interface HeaderProps {
  // uiux-fix F039 C223 — visible entry point for the command palette; the Cmd/Ctrl+K
  // chord alone was undiscoverable (no on-screen hint anywhere in the chrome).
  readonly openCommandPalette: () => void;
  readonly onTileAll: () => void;
  readonly onSplitFront: () => void;
  readonly onCascade: () => void;
  readonly contextControl?: ReactNode;
}

function HeaderImpl({
  openCommandPalette,
  onTileAll,
  onSplitFront,
  onCascade,
  contextControl,
}: HeaderProps): ReactNode {
  const t = useTranslate();

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

      {contextControl !== undefined ? <div className="hd-context">{contextControl}</div> : null}

      <span className="spacer" />

      <div className="hd-tools">
        <button
          type="button"
          className="hd-tool ui-tip"
          onClick={openCommandPalette}
          data-tip={t("header.quickAccess")}
          aria-label={t("header.openQuickAccess")}
        >
          <Icons.search size={16} />
        </button>
        <button
          type="button"
          className="hd-tool ui-tip"
          onClick={onTileAll}
          data-tip={t("header.tileAll")}
          aria-label={t("header.tileAll")}
        >
          <Icons.tile size={16} />
        </button>
        {/* uiux-fix F039 C401 — same wording as the CommandPalette command ("Split front
            windows") so the action is recognizable across tooltip and palette. */}
        <button
          type="button"
          className="hd-tool ui-tip"
          onClick={onSplitFront}
          data-tip={t("header.splitFront")}
          aria-label={t("header.splitFront")}
        >
          <Icons.split size={16} />
        </button>
        <button
          type="button"
          className="hd-tool ui-tip"
          onClick={onCascade}
          data-tip={t("header.cascade")}
          aria-label={t("header.cascade")}
        >
          <Icons.cascade size={16} />
        </button>
      </div>
    </header>
  );
}

export const Header = memo(HeaderImpl);
