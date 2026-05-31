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

function readCompactViewport(): boolean {
  try {
    return window.innerWidth < 640;
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
 */
export function ShellChrome({ children }: ShellChromeProps): ReactNode {
  // SSR-safe: render default state on first paint; correct via mount effect.
  const [collapsed, setCollapsed] = useState(false);
  const [compactViewport, setCompactViewport] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Read persisted state once on mount (client-only).
  useEffect(() => {
    setCompactViewport(readCompactViewport());
    setCollapsed(readStoredCollapsed() ?? readViewportDefaultCollapsed());
    setMounted(true);

    function handleResize(): void {
      const nextCompact = readCompactViewport();
      setCompactViewport(nextCompact);
      if (nextCompact) {
        setCompactOpen(false);
      }
    }

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  // Persist whenever collapsed changes, but only after initial mount.
  useEffect(() => {
    if (!mounted || compactViewport) return;
    persistCollapsed(collapsed);
  }, [collapsed, compactViewport, mounted]);

  const sidebarCollapsed = compactViewport ? !compactOpen : collapsed;
  const sidebarWidthClass = mounted
    ? compactViewport
      ? compactOpen
        ? "fixed bottom-20 left-0 top-12 z-40 w-60 shadow-[12px_0_32px_rgba(0,0,0,0.35)]"
        : "w-12"
      : collapsed
        ? "w-12"
        : "w-60"
    : "w-12 lg:w-60";

  function handleToggle(): void {
    if (compactViewport) {
      setCompactOpen((open) => !open);
      return;
    }
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
          <ShellHeader collapsed={sidebarCollapsed} onToggle={handleToggle} />
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
            <Sidebar collapsed={sidebarCollapsed} widthClass={sidebarWidthClass} />
          </Suspense>

          <main
            id="main-content"
            tabIndex={-1}
            className="min-w-0 flex-1 overflow-y-auto bg-canvas px-gutter py-section
              pb-24 focus:outline-none sm:pb-section"
          >
            {children}
          </main>

          {/* Tool rail — Suspense required because ToolRail calls useSearchParams() and useRouter(). */}
          <Suspense
            fallback={
              <aside
                aria-label="Workspace tools"
                className="fixed inset-x-0 bottom-0 z-30 w-full border-t border-ink/10 bg-chrome sm:static sm:z-auto sm:w-auto sm:border-t-0"
              />
            }
          >
            <ToolRail />
          </Suspense>
        </div>
      </div>
    </>
  );
}

export default ShellChrome;
