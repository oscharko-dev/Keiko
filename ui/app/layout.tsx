import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Keiko",
  description: "Keiko local developer-assist UI.",
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body className="min-h-screen bg-surface text-ink">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-accent focus:px-4 focus:py-2 focus:text-ink-inverse"
        >
          Skip to main content
        </a>
        <header className="border-b border-ink/10 bg-surface-subtle">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-gutter py-4">
            <Link
              href="/"
              className="font-mono text-subheading text-accent-strong"
              aria-label="Keiko home"
            >
              Keiko
            </Link>
            <nav aria-label="Primary navigation">
              <ul className="flex gap-6 text-sm">
                <li>
                  <Link
                    href="/launch"
                    className="text-ink-muted hover:text-ink"
                  >
                    Launch
                  </Link>
                </li>
                <li>
                  <Link
                    href="/evidence"
                    className="text-ink-muted hover:text-ink"
                  >
                    Evidence
                  </Link>
                </li>
                <li>
                  <Link
                    href="/config"
                    className="text-ink-muted hover:text-ink"
                  >
                    Config
                  </Link>
                </li>
              </ul>
            </nav>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="mx-auto max-w-5xl px-gutter py-section">
          {children}
        </main>
      </body>
    </html>
  );
}
