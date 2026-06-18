"use client";

import type { ReactNode } from "react";
import { Icons } from "./Icons";

interface RightRailProps {
  openTools: ReadonlySet<string>;
  onTool: (id: string) => void;
  outlineOpen?: boolean;
  onToggleOutline?: () => void;
}

export function RightRail({
  outlineOpen = false,
  onToggleOutline = () => undefined,
}: RightRailProps): ReactNode {
  return (
    <aside className="rail rail-right" aria-label="Workspace utilities">
      <div className="rail-group">
        <button
          type="button"
          className="rail-btn"
          data-side="right"
          data-active={outlineOpen ? "true" : "false"}
          aria-label="Workspace outline"
          aria-pressed={outlineOpen}
          aria-controls="workspace-outline"
          data-tip="Workspace outline"
          onClick={onToggleOutline}
        >
          <Icons.panelRight size={19} />
        </button>
      </div>
      <span className="spacer" />
    </aside>
  );
}
