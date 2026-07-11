// Issue #2245 (Epic #2238) — standalone client mount for the Atlassian connector surfaces.
//
// The connector management surface renders on its own route so it is reachable for the focused
// connector-setup smoke without the full desktop shell. It provides its own I18nProvider (the shell
// mounts one deeper in AppShell) and binds the default same-origin BFF client.

"use client";

import type { ReactNode } from "react";
import { I18nProvider } from "@/lib/i18n";
import { AtlassianConnectorsPanel } from "@/app/components/desktop/widgets/connectors/AtlassianConnectorsPanel";

export default function AtlassianConnectorsApp(): ReactNode {
  return (
    <I18nProvider>
      <main style={{ height: "100vh" }}>
        <AtlassianConnectorsPanel />
      </main>
    </I18nProvider>
  );
}
