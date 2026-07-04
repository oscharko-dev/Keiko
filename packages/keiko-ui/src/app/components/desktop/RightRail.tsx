"use client";

import type { ReactNode } from "react";
import { memo } from "react";

interface RightRailProps {
  openTools: ReadonlySet<string>;
  onTool: (id: string) => void;
}

function RightRailImpl(_props: RightRailProps): ReactNode {
  // GEN-UI-A11Y-025 — this is currently an empty layout spacer. Exposing it as a labelled
  // <aside> named landmark ("Workspace utilities") advertised a complementary region with no
  // content, which is noise for AT. Render a plain <div> with no landmark role/name until real
  // utilities live here again.
  return (
    <div className="rail rail-right">
      <span className="spacer" />
    </div>
  );
}

export const RightRail = memo(RightRailImpl);
