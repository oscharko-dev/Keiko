import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Keiko | Ex experientia disco",
  // uiux-fix F038 C376: aligned with the official README positioning ("a governed agentic
  // workspace for knowledge work") — "developer-assist" misdescribed the product to the
  // non-developer audiences the install surface reaches.
  description: "Keiko — a governed agentic workspace for knowledge work.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    shortcut: ["/favicon.ico"],
  },
};

// Emits <meta name="color-scheme" content="dark light"> so the browser uses a
// dark canvas during F5 reloads instead of flashing white before CSS variables
// resolve (#302). The light theme opts back into a light UA canvas via the
// `color-scheme: light` declaration scoped to `[data-theme="light"]`.
// `themeColor` (#4EBA87 = --accent) drives the OS task-switcher tile color and the
// PWA window chrome on standalone-display installs (ADR-0024 D4).
export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: "#4EBA87",
};

// Pre-hydration theme bootstrap (audit C219): data-theme was only ever set by the desktop
// shell's useTheme hook, so full-page routes (/memoriaviva, /local-knowledge) ignored the stored
// preference and always rendered the dark :root tokens. This inline script applies the persisted
// "keiko.theme" before first paint on EVERY route; useTheme stays the single toggle-writer.
// Inline scripts are allowed by their SHA-256 hash (extractInlineScriptHashes in keiko-server),
// computed from the exported HTML — no CSP loosening involved.
const THEME_BOOTSTRAP = `try{var t=localStorage.getItem("keiko.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        {children}
      </body>
    </html>
  );
}
