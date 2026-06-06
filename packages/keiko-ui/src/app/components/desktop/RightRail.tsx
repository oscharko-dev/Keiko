"use client";

import type { ReactNode } from "react";
import { Icons } from "./Icons";
import type { IconName } from "./Icons";

interface RailTool {
  id: string;
  label: string;
  icon: IconName;
}

const RIGHT_TOOLS: readonly RailTool[] = [
  { id: "inspector", label: "Inspector", icon: "layers" },
  { id: "activity", label: "Activity", icon: "activity" },
  { id: "notifications", label: "Notifications", icon: "bell" },
  { id: "resources", label: "Resources", icon: "cube" },
];

interface RightRailProps {
  openTools: ReadonlySet<string>;
  onTool: (id: string) => void;
}

export function RightRail({ openTools, onTool }: RightRailProps): ReactNode {
  return (
    <aside className="rail rail-right" aria-label="Workspace utilities">
      <div className="rail-group">
        {RIGHT_TOOLS.map((tool) => {
          const Icon = Icons[tool.icon];
          return (
            <button
              key={tool.id}
              type="button"
              className="rail-btn"
              data-active={openTools.has(tool.id)}
              data-side="right"
              data-tip={tool.label}
              aria-label={tool.label}
              onClick={() => onTool(tool.id)}
            >
              <Icon size={19} />
            </button>
          );
        })}
      </div>
    </aside>
  );
}
