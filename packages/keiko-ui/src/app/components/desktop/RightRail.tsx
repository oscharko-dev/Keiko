"use client";

import type { ReactNode } from "react";

interface RightRailProps {
  openTools: ReadonlySet<string>;
  onTool: (id: string) => void;
}

export function RightRail(_props: RightRailProps): ReactNode {
  return (
    <aside className="rail rail-right" aria-label="Workspace utilities">
      <span className="spacer" />
    </aside>
  );
}
