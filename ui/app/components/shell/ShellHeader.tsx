"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { KeikoLogo } from "@/app/components/KeikoLogo";

// ---------------------------------------------------------------------------
// Hamburger/chevron icon for the sidebar toggle
// ---------------------------------------------------------------------------

function MenuIcon({ collapsed }: { collapsed: boolean }): ReactNode {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
      {collapsed ? (
        <>
          <line x1="2" y1="4.5" x2="16" y2="4.5" />
          <line x1="2" y1="9" x2="16" y2="9" />
          <line x1="2" y1="13.5" x2="16" y2="13.5" />
        </>
      ) : (
        <>
          <line x1="2" y1="4.5" x2="16" y2="4.5" />
          <line x1="2" y1="9" x2="12" y2="9" />
          <line x1="2" y1="13.5" x2="16" y2="13.5" />
        </>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// ShellHeader props
// ---------------------------------------------------------------------------

interface ShellHeaderProps {
  collapsed: boolean;
  onToggle: () => void;
}

/**
 * Top header bar: toggle button, logo + wordmark, secondary navigation.
 * Rendered inside `<header role="banner">` by ShellChrome.
 */
export function ShellHeader({ collapsed, onToggle }: ShellHeaderProps): ReactNode {
  return (
    <div className="flex h-12 items-center gap-2 border-b border-border bg-chrome px-3">
      {/* Sidebar collapse toggle */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={collapsed ? "false" : "true"}
        aria-controls="shell-sidebar"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className="flex shrink-0 items-center justify-center rounded p-1.5
          text-accent hover:bg-elevated
          focus:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-chrome"
      >
        <MenuIcon collapsed={collapsed} />
      </button>

      {/* Logo + wordmark */}
      <Link
        href="/"
        className="flex items-center gap-2 text-sm font-semibold text-ink
          focus:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-chrome"
        aria-label="Keiko home"
      >
        <KeikoLogo className="h-6 w-6 text-accent" aria-hidden="true" />
        <span>Keiko</span>
      </Link>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Secondary navigation */}
      <nav aria-label="Secondary navigation">
        <ul className="flex gap-1">
          <li>
            <Link
              href="/config"
              className="rounded px-3 py-1.5 text-sm text-ink-muted hover:text-ink
                focus:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-chrome"
            >
              Config
            </Link>
          </li>
          <li>
            <Link
              href="/evidence"
              className="rounded px-3 py-1.5 text-sm text-ink-muted hover:text-ink
                focus:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-chrome"
            >
              Evidence
            </Link>
          </li>
        </ul>
      </nav>
    </div>
  );
}

export default ShellHeader;
