// Issue #2245 (Epic #2238) — /atlassian-connectors route. A thin server entry that renders the
// standalone client app; the connector surfaces live in the shared desktop widget module and are
// reused here so the route adds no parallel UI.

import type { ReactNode } from "react";
import AtlassianConnectorsApp from "./AtlassianConnectorsApp";

export const metadata = {
  title: "Keiko | Atlassian connectors",
};

export default function AtlassianConnectorsPage(): ReactNode {
  return <AtlassianConnectorsApp />;
}
