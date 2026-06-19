"use client";

import type { ReactNode } from "react";
import { Icons, type IconName } from "./Icons";
import type { Theme } from "./hooks/useTheme";

interface RailTool {
  readonly id: string;
  readonly icon: IconName;
  readonly label: string;
  readonly img?: string;
}

const PRIMARY: readonly RailTool[] = [
  { id: "chatHistory", icon: "archive", label: "Chat History" },
];

function RailButton({
  tool,
  active,
  onClick,
}: {
  readonly tool: RailTool;
  readonly active: boolean;
  readonly onClick: () => void;
}): ReactNode {
  const Icon = Icons[tool.icon];
  return (
    <button
      type="button"
      className="rail-btn"
      data-active={active ? "true" : "false"}
      data-side="left"
      aria-label={tool.label}
      aria-pressed={active}
      data-tip={tool.label}
      onClick={onClick}
    >
      {tool.img !== undefined ? (
        // eslint-disable-next-line @next/next/no-img-element -- design CSS sizes the raw SVG via .rail-img
        <img className="rail-img" src={tool.img} alt="" />
      ) : (
        <Icon size={19} />
      )}
    </button>
  );
}

export function LeftRail({
  openTools,
  onTool,
  onNewChat,
  theme,
  onToggleTheme,
}: {
  readonly openTools: ReadonlySet<string>;
  readonly onTool: (id: string) => void;
  readonly onNewChat: () => void;
  readonly theme: Theme;
  readonly onToggleTheme: () => void;
}): ReactNode {
  return (
    <nav className="rail rail-left" aria-label="Primary workspace navigation">
      <button
        type="button"
        className="rail-new"
        onClick={onNewChat}
        data-side="left"
        aria-label="New chat"
        data-tip="New chat"
      >
        <Icons.newChat size={18} />
      </button>
      <div className="rail-div" />
      <div className="rail-group">
        {PRIMARY.map((tool) => (
          <RailButton
            key={tool.id}
            tool={tool}
            active={openTools.has(tool.id)}
            onClick={() => onTool(tool.id)}
          />
        ))}
      </div>
      <span className="spacer" />
      <div className="rail-group">
        <button
          type="button"
          className="rail-btn"
          data-active={openTools.has("memoria") ? "true" : "false"}
          data-side="left"
          aria-label="MemoriaViva"
          aria-pressed={openTools.has("memoria")}
          data-tip="MemoriaViva"
          onClick={() => onTool("memoria")}
        >
          <Icons.brain size={19} />
        </button>
        {/* Epic #270 — Quality Intelligence opens as a singleton Workspace window (not a page route). */}
        <button
          type="button"
          className="rail-btn"
          data-side="left"
          data-active={openTools.has("quality") ? "true" : "false"}
          aria-label="Quality Intelligence"
          aria-pressed={openTools.has("quality")}
          data-tip="Quality Intelligence"
          onClick={() => onTool("quality")}
        >
          <Icons.check size={19} />
        </button>
        <button
          type="button"
          className="rail-btn"
          data-side="left"
          data-active={openTools.has("localKnowledge") ? "true" : "false"}
          aria-label="Local Knowledge"
          aria-pressed={openTools.has("localKnowledge")}
          data-tip="Local Knowledge"
          onClick={() => onTool("localKnowledge")}
        >
          <Icons.localKnowledge size={19} />
        </button>
        <button
          type="button"
          className="rail-btn"
          data-side="left"
          data-active={openTools.has("figma") ? "true" : "false"}
          aria-label="Figma Snapshot"
          aria-pressed={openTools.has("figma")}
          data-tip="Figma Snapshot"
          onClick={() => onTool("figma")}
        >
          <Icons.layers size={19} />
        </button>
      </div>
      <div className="rail-div" />
      {/* SH-01: aria-pressed reflects current state (true = light theme is active);
          the action label describes the next state — "Dark mode" when light, "Light
          mode" when dark — which is the standard WAI-ARIA APG toggle-button pattern. */}
      <button
        type="button"
        className="rail-btn"
        data-side="left"
        aria-label={theme === "light" ? "Dark mode" : "Light mode"}
        aria-pressed={theme === "light"}
        data-tip={theme === "light" ? "Dark mode" : "Light mode"}
        onClick={onToggleTheme}
      >
        {theme === "light" ? <Icons.moon size={19} /> : <Icons.sun size={19} />}
      </button>
      <button
        type="button"
        className="rail-btn"
        data-side="left"
        data-active={openTools.has("settings") ? "true" : "false"}
        aria-label="Settings"
        aria-pressed={openTools.has("settings")}
        data-tip="Settings"
        onClick={() => onTool("settings")}
      >
        <Icons.settings size={19} />
      </button>
    </nav>
  );
}
