"use client";

import type { ReactNode } from "react";
import { memo } from "react";
import { useTranslate } from "@/lib/i18n";
import { Icons } from "./Icons";
import styles from "./Header.module.css";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const TileIcon = Icons.tile;
const SplitIcon = Icons.split;
const CascadeIcon = Icons.cascade;
const LockIcon = Icons.lock;
const UnlockIcon = Icons.unlock;

export type HeaderStatusTone = "ok" | "warn" | "danger";

interface HeaderProps {
  readonly layoutLocked: boolean;
  readonly onToggleLayoutLock: () => void;
  readonly onTileAll: () => void;
  readonly onSplitFront: () => void;
  readonly onCascade: () => void;
}

interface LayoutButtonProps {
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly label: string;
  readonly icon: typeof TileIcon;
}

function LayoutButton({ disabled, onClick, label, icon: Icon }: LayoutButtonProps): ReactNode {
  return (
    <button
      type="button"
      className="hd-tool ui-tip"
      disabled={disabled}
      onClick={onClick}
      data-tip={label}
      aria-label={label}
    >
      <Icon size={16} />
    </button>
  );
}

function HeaderTools({
  layoutLocked,
  onToggleLayoutLock,
  onTileAll,
  onSplitFront,
  onCascade,
}: HeaderProps): ReactNode {
  const t = useTranslate();
  const label = t(layoutLocked ? "header.unlockLayout" : "header.lockLayout");
  const LayoutLockIcon = layoutLocked ? LockIcon : UnlockIcon;
  return (
    <div className="hd-tools">
      <button
        type="button"
        className={`hd-tool ui-tip ${styles.layoutLock}`}
        onClick={onToggleLayoutLock}
        aria-pressed={layoutLocked}
        aria-label={label}
        data-tip={label}
      >
        <LayoutLockIcon size={16} />
      </button>
      <LayoutButton
        disabled={layoutLocked}
        onClick={onTileAll}
        label={t("header.tileAll")}
        icon={TileIcon}
      />
      <LayoutButton
        disabled={layoutLocked}
        onClick={onSplitFront}
        label={t("header.splitFront")}
        icon={SplitIcon}
      />
      <LayoutButton
        disabled={layoutLocked}
        onClick={onCascade}
        label={t("header.cascade")}
        icon={CascadeIcon}
      />
    </div>
  );
}

function HeaderImpl(props: HeaderProps): ReactNode {
  return (
    <header className="header">
      <div className="hd-brand">
        {/* uiux-fix F013 C399 — alt="" : the visible wordmark right next to it already
            names the brand; alt="Keiko" made screen readers announce "Keiko Keiko"
            (same treatment as the footer logo). */}
        {/* eslint-disable-next-line @next/next/no-img-element -- design CSS sizes the raw SVG; next/image would inject a wrapper that breaks .hd-logo */}
        <img className="hd-logo" src="/keiko-logo.svg" alt="" />
        <span className="hd-wordmark">Keiko</span>
      </div>

      <span className="spacer" />

      <HeaderTools {...props} />
    </header>
  );
}

export const Header = memo(HeaderImpl);
