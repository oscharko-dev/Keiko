import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ShellChrome } from "@/app/components/shell/ShellChrome";
import "./globals.css";

export const metadata: Metadata = {
  title: "Keiko",
  description: "Keiko local developer-assist workspace.",
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas text-ink">
        <ShellChrome>{children}</ShellChrome>
      </body>
    </html>
  );
}
