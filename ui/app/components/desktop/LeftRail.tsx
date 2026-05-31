"use client";

import type { ReactNode } from "react";
import { Icons } from "./Icons";
import type { IconName } from "./Icons";
import type { Theme } from "./hooks/useTheme";

interface RailTool {
  id: string;
  label: string;
  icon: IconName;
}

const PRIMARY_TOOLS: readonly RailTool[] = [
  { id: "keiko", label: "Keiko", icon: "spark" },
  { id: "project", label: "Project", icon: "folder" },
  { id: "search", label: "Search", icon: "search" },
  { id: "plugins", label: "Plugins", icon: "plugins" },
];

const SECONDARY_TOOLS: readonly RailTool[] = [
  { id: "automations", label: "Automations", icon: "automations" },
  { id: "mobile", label: "Keiko mobile", icon: "mobile" },
];

interface RailBtnProps {
  tool: RailTool;
  active: boolean;
  onClick: () => void;
}

function RailBtn({ tool, active, onClick }: RailBtnProps): ReactNode {
  const Icon = Icons[tool.icon];
  return (
    <button
      type="button"
      className="rail-btn"
      data-active={active}
      data-side="left"
      data-tip={tool.label}
      aria-label={tool.label}
      onClick={onClick}
    >
      <Icon size={19} />
    </button>
  );
}

interface LeftRailProps {
  openTools: ReadonlySet<string>;
  onTool: (id: string) => void;
  onNewChat: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}

export function LeftRail({
  openTools,
  onTool,
  onNewChat,
  theme,
  onToggleTheme,
}: LeftRailProps): ReactNode {
  const themeLabel = theme === "light" ? "Dark mode" : "Light mode";
  return (
    <div className="rail rail-left">
      <button
        type="button"
        className="rail-new"
        onClick={onNewChat}
        data-tip="New chat"
        data-side="left"
        aria-label="New chat"
      >
        <Icons.newChat size={18} />
      </button>
      <div className="rail-div" />
      <div className="rail-group">
        {PRIMARY_TOOLS.map((tool) => (
          <RailBtn
            key={tool.id}
            tool={tool}
            active={openTools.has(tool.id)}
            onClick={() => onTool(tool.id)}
          />
        ))}
      </div>
      <span className="spacer" />
      <div className="rail-group">
        {SECONDARY_TOOLS.map((tool) => (
          <RailBtn
            key={tool.id}
            tool={tool}
            active={openTools.has(tool.id)}
            onClick={() => onTool(tool.id)}
          />
        ))}
      </div>
      <div className="rail-div" />
      <button
        type="button"
        className="rail-btn"
        data-side="left"
        data-tip={themeLabel}
        aria-label="Toggle theme"
        onClick={onToggleTheme}
      >
        {theme === "light" ? <Icons.moon size={19} /> : <Icons.sun size={19} />}
      </button>
      <button
        type="button"
        className="rail-btn"
        data-side="left"
        data-active={openTools.has("settings")}
        data-tip="Settings"
        aria-label="Settings"
        onClick={() => onTool("settings")}
      >
        <Icons.settings size={19} />
      </button>
      <button
        type="button"
        className="rail-avatar"
        data-side="left"
        data-tip="Account"
        aria-label="Account"
      >
        M
      </button>
    </div>
  );
}
