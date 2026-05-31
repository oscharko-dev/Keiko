"use client";

import { Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ShellHeader } from "./ShellHeader";
import { Sidebar } from "./Sidebar";
import { ToolRail } from "./ToolRail";

// ---------------------------------------------------------------------------
// Persisted sidebar preference helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = "keiko.shell.sidebarCollapsed";

function readStoredCollapsed(): boolean | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
    return null;
  } catch {
    return null;
  }
}

function readViewportDefaultCollapsed(): boolean {
  try {
    return window.innerWidth < 1024;
  } catch {
    return false;
  }
}

function persistCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsed));
  } catch {
    // Storage can be unavailable in restricted/private contexts. The shell remains usable.
  }
}

// ---------------------------------------------------------------------------
// ShellChrome
// ---------------------------------------------------------------------------

interface ShellChromeProps {
  children: ReactNode;
}

/**
 * Top-level client shell wrapper. Owns sidebar collapsed state, reads/writes it to localStorage
 * in a mount-only effect to avoid hydration mismatch (ADR-0014 D3).
 *
 * Three-zone shell: header top bar, then [sidebar | main | tool-rail].
 * ToolRail is CSS-hidden below mobile breakpoints per ADR-0014 D8.
 */
export function ShellChrome({ children }: ShellChromeProps): ReactNode {
  // SSR-safe: render default state on first paint; correct via mount effect.
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Read persisted state once on mount (client-only).
  useEffect(() => {
    setCollapsed(readStoredCollapsed() ?? readViewportDefaultCollapsed());
    setMounted(true);
  }, []);

  // Persist whenever collapsed changes, but only after initial mount.
  useEffect(() => {
    if (!mounted) return;
    persistCollapsed(collapsed);
  }, [collapsed, mounted]);

  const sidebarWidthClass = mounted
    ? collapsed
      ? "w-12"
      : "w-60"
    : "w-12 lg:w-60";

  function handleToggle(): void {
    setCollapsed((c) => !c);
  }

  return (
    <>
      {/* Skip link — moves to just before the <header> so it's the first focusable element */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4
          focus:z-50 focus:rounded focus:bg-accent focus:px-4 focus:py-2 focus:text-ink-inverse"
      >
        Skip to main content
      </a>

      {/* Three-zone grid: rows = [header, content-area] */}
      <div className="grid h-screen grid-rows-[auto_1fr] overflow-hidden">

        {/* Header row — spans all columns */}
        <header role="banner">
          <ShellHeader collapsed={collapsed} onToggle={handleToggle} />
        </header>

        {/* Content row: [sidebar | main | tool-rail] */}
        <div className="flex min-h-0 min-w-0 overflow-hidden">
          {/*
           * Suspense boundary required because Sidebar calls useSearchParams().
           * In Next.js 15 App Router static export, useSearchParams() must be
           * inside a Suspense boundary to avoid the build-time bail-out.
           */}
          <Suspense
            fallback={
              <nav
                aria-label="Project navigation"
                className={`flex flex-col overflow-hidden bg-chrome ${sidebarWidthClass}`}
              />
            }
          >
            <Sidebar collapsed={collapsed} widthClass={sidebarWidthClass} />
          </Suspense>

          <main
            id="main-content"
            tabIndex={-1}
            className="min-w-0 flex-1 overflow-y-auto bg-canvas px-gutter py-section
              focus:outline-none"
          >
            {children}
          </main>

          {/* Tool rail — CSS-hidden below sm so desktop first paint keeps stable geometry.
           * Suspense required because ToolRail calls useSearchParams() and useRouter(). */}
          <div className="hidden sm:flex">
            <Suspense
              fallback={
                <aside
                  aria-label="Workspace tools"
                  className="w-14 bg-chrome"
                />
              }
            >
              <ToolRail />
            </Suspense>
          </div>
        </div>
      </div>
    </>
  );
}

export default ShellChrome;
