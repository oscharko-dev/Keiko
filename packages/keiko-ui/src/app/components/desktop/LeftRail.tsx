"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Icons, type IconName } from "./Icons";
import type { Theme } from "./hooks/useTheme";

interface RailTool {
  readonly id: string;
  readonly icon: IconName;
  readonly label: string;
  readonly img?: string;
}

const PRIMARY: readonly RailTool[] = [
  { id: "keiko", icon: "spark", label: "Keiko", img: "/assets/keiko-logo.svg" },
  { id: "chatHistory", icon: "archive", label: "Chat History" },
  { id: "project", icon: "folder", label: "Project" },
  { id: "search", icon: "search", label: "Search" },
  { id: "plugins", icon: "plugins", label: "Plugins" },
];

const SECONDARY: readonly RailTool[] = [
  { id: "automations", icon: "automations", label: "Automations" },
  { id: "mobile", icon: "mobile", label: "Keiko Mobile" },
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
        {SECONDARY.map((tool) => (
          <RailButton
            key={tool.id}
            tool={tool}
            active={openTools.has(tool.id)}
            onClick={() => onTool(tool.id)}
          />
        ))}
        {/* Issue #211 — MemoriaViva is a page route, not a window tool. */}
        <Link
          href="/memoriaviva"
          className="rail-btn"
          data-active="false"
          data-side="left"
          aria-label="MemoriaViva"
          data-tip="MemoriaViva"
        >
          <Icons.brain size={19} />
        </Link>
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
        {/* Epic #532 — Relationships opens as a singleton Workspace window (not a page route). */}
        <button
          type="button"
          className="rail-btn"
          data-side="left"
          data-active={openTools.has("relationships") ? "true" : "false"}
          aria-label="Relationships"
          aria-pressed={openTools.has("relationships")}
          data-tip="Relationships"
          onClick={() => onTool("relationships")}
        >
          <Icons.branch size={19} />
        </button>
      </div>
      <div className="rail-div" />
      <button
        type="button"
        className="rail-btn"
        data-side="left"
        aria-label={theme === "light" ? "Dark mode" : "Light mode"}
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
      {/* uiux-fix F011 C293: generic person glyph instead of a hardcoded "M" initial
          (wrong for any real user), and the button now performs an action — it opens
          Settings, the closest account surface — instead of being a dead control. */}
      <button
        type="button"
        className="rail-avatar"
        data-side="left"
        aria-label="Account"
        data-tip="Account"
        onClick={() => onTool("settings")}
      >
        <Icons.user size={15} />
      </button>
    </nav>
  );
}
