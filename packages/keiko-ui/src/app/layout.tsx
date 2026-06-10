import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Keiko",
  description: "Keiko local developer-assist workspace.",
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

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
