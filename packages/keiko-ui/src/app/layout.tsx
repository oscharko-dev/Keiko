import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Keiko",
  description: "Keiko local developer-assist workspace.",
};

// Emits <meta name="color-scheme" content="dark light"> so the browser uses a
// dark canvas during F5 reloads instead of flashing white before CSS variables
// resolve (#302). The light theme opts back into a light UA canvas via the
// `color-scheme: light` declaration scoped to `[data-theme="light"]`.
export const viewport: Viewport = {
  colorScheme: "dark light",
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
