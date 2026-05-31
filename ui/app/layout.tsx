import type { Metadata } from "next";
import type { ReactNode } from "react";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

// JetBrains Mono is the canvas-UI monospace face (Claude-Design handoff). The design's
// --font-mono token in globals.css already lists "JetBrains Mono" first in its stack,
// so once next/font loads the file the cascade picks it up — no extra CSS wiring.
const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono-loaded",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Keiko",
  description: "Keiko local developer-assist workspace.",
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en" className={jetBrainsMono.variable}>
      <body>{children}</body>
    </html>
  );
}
