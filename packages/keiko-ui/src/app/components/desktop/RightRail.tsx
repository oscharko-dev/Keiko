"use client";

import type { ReactNode } from "react";
import { memo } from "react";

interface RightRailProps {
  openTools: ReadonlySet<string>;
  onTool: (id: string) => void;
}

function RightRailImpl(_props: RightRailProps): ReactNode {
  return (
    <aside className="rail rail-right" aria-label="Workspace utilities">
      <span className="spacer" />
    </aside>
  );
}

export const RightRail = memo(RightRailImpl);
