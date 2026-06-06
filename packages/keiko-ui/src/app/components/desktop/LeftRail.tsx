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
  { id: "project", icon: "folder", label: "Project" },
  { id: "search", icon: "search", label: "Search" },
  { id: "plugins", icon: "plugins", label: "Plugins" },
];

const SECONDARY: readonly RailTool[] = [
  { id: "automations", icon: "automations", label: "Automations" },
  { id: "mobile", icon: "mobile", label: "Keiko mobile" },
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
      title={tool.label}
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
        title="New chat"
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
        {/* Issue #211 — Memory Center is a page route, not a window tool */}
        <Link
          href="/memory"
          className="rail-btn"
          data-active="false"
          data-side="left"
          aria-label="Memory Center"
          title="Memory Center"
        >
          <Icons.pin size={19} />
        </Link>
        {/* Issue #280 (Epic #270) — Quality Intelligence is a page route, not a window tool */}
        <Link
          href="/quality-intelligence"
          className="rail-btn"
          data-active="false"
          data-side="left"
          aria-label="Quality Intelligence"
          title="Quality Intelligence"
        >
          <Icons.review size={19} />
        </Link>
        {/* Issue #189 — Local Knowledge is a page route, not a window tool */}
        <Link
          href="/local-knowledge"
          className="rail-btn"
          data-active="false"
          data-side="left"
          aria-label="Local Knowledge"
          title="Local Knowledge"
        >
          <Icons.localKnowledge size={19} />
        </Link>
      </div>
      <div className="rail-div" />
      <button
        type="button"
        className="rail-btn"
        data-side="left"
        aria-label={theme === "light" ? "Dark mode" : "Light mode"}
        title={theme === "light" ? "Dark mode" : "Light mode"}
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
        title="Settings"
        onClick={() => onTool("settings")}
      >
        <Icons.settings size={19} />
      </button>
      <button
        type="button"
        className="rail-avatar"
        data-side="left"
        aria-label="Account"
        title="Account"
      >
        M
      </button>
    </nav>
  );
}
