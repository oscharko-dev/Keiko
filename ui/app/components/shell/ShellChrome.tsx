"use client";

import { Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ShellHeader } from "./ShellHeader";
import { Sidebar } from "./Sidebar";
import { ToolRail } from "./ToolRail";

// ---------------------------------------------------------------------------
// useMatchMedia hook — SSR-safe, DOM-only after mount
// ---------------------------------------------------------------------------

function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const handler = (e: MediaQueryListEvent): void => { setMatches(e.matches); };
    mq.addEventListener("change", handler);
    return () => { mq.removeEventListener("change", handler); };
  }, [query]);
  return matches;
}

// ---------------------------------------------------------------------------
// ShellChrome
// ---------------------------------------------------------------------------

interface ShellChromeProps {
  children: ReactNode;
}

const STORAGE_KEY = "keiko.shell.sidebarCollapsed";

/**
 * Top-level client shell wrapper. Owns sidebar collapsed state, reads/writes it to localStorage
 * in a mount-only effect to avoid hydration mismatch (ADR-0014 D3).
 *
 * Three-zone CSS Grid: header top bar, then [sidebar | main | tool-rail].
 * ToolRail is omitted from the DOM on mobile (< 640 px) per ADR-0014 D8.
 */
export function ShellChrome({ children }: ShellChromeProps): ReactNode {
  // SSR-safe: render default state on first paint; correct via mount effect.
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Read persisted state once on mount (client-only).
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      setCollapsed(stored === "true");
    } else {
      // Default: collapse sidebar on narrow screens.
      setCollapsed(window.innerWidth < 1024);
    }
    setMounted(true);
  }, []);

  // Persist whenever collapsed changes, but only after initial mount.
  useEffect(() => {
    if (!mounted) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsed));
  }, [collapsed, mounted]);

  const isAboveMobile = useMatchMedia("(min-width: 640px)");

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
        <div className="flex min-h-0 overflow-hidden">
          {/*
           * Suspense boundary required because Sidebar calls useSearchParams().
           * In Next.js 15 App Router static export, useSearchParams() must be
           * inside a Suspense boundary to avoid the build-time bail-out.
           */}
          <Suspense
            fallback={
              <nav
                aria-label="Project navigation"
                className={`flex flex-col overflow-hidden bg-chrome ${collapsed ? "w-12" : "w-60"}`}
              />
            }
          >
            <Sidebar collapsed={collapsed} />
          </Suspense>

          <main
            id="main-content"
            tabIndex={-1}
            className="flex-1 overflow-y-auto bg-canvas px-gutter py-section
              focus:outline-none"
          >
            {children}
          </main>

          {/* Tool rail — omitted from DOM on mobile (ADR-0014 D8) */}
          {isAboveMobile && <ToolRail />}
        </div>
      </div>
    </>
  );
}

export default ShellChrome;
