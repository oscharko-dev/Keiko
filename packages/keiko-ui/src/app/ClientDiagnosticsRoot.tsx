"use client";

// Installs client diagnostics on EVERY route (#3532). The transport used to be installed only by
// the desktop shell, so the standalone routes (/atlassian-connectors, /local-knowledge/capsule)
// buffered their diagnostics until the pre-transport buffer evicted them. The root layout renders
// this component once: it installs the transport (a module-scope side effect, so boot diagnostics
// are delivered too) and the page-wide listeners for unhandled rejections and uncaught `window`
// errors. It renders nothing.

import "@/lib/install-client-diagnostics";
import type { ReactNode } from "react";
import { useUnhandledRejectionLog } from "./components/desktop/hooks/useUnhandledRejectionLog";
import { useWindowErrorLog } from "./components/desktop/hooks/useWindowErrorLog";

export function ClientDiagnosticsRoot(): ReactNode {
  useUnhandledRejectionLog();
  useWindowErrorLog();
  return null;
}
