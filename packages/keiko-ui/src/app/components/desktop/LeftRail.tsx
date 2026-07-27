"use client";

import type { ReactNode } from "react";
import { memo } from "react";
import { useTranslate } from "@/lib/i18n";
import { Icons, type IconName } from "./Icons";
import type { Theme } from "./hooks/useTheme";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const NewChatIcon = Icons.newChat;
const BrainIcon = Icons.brain;
const CheckIcon = Icons.check;
const SparkIcon = Icons.spark;
const CodeIcon = Icons.code;
const GitIcon = Icons.git;
const EditorIcon = Icons.editor;
const LocalKnowledgeIcon = Icons.localKnowledge;
const LayersIcon = Icons.layers;
const MoonIcon = Icons.moon;
const SunIcon = Icons.sun;
const SettingsIcon = Icons.settings;

interface RailTool {
  readonly id: string;
  readonly icon: IconName;
  readonly img?: string;
}

const PRIMARY: readonly RailTool[] = [{ id: "chatHistory", icon: "archive" }];

function RailButton({
  tool,
  label,
  active,
  onClick,
}: {
  readonly tool: RailTool;
  readonly label: string;
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
      aria-label={label}
      aria-pressed={active}
      data-tip={label}
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

function LeftRailImpl({
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
  const t = useTranslate();
  const themeLabel = theme === "light" ? t("rail.darkMode") : t("rail.lightMode");

  return (
    <nav className="rail rail-left" aria-label={t("rail.primaryNavigation")}>
      <button
        type="button"
        className="rail-new"
        onClick={onNewChat}
        data-side="left"
        aria-label={t("rail.newChat")}
        data-tip={t("rail.newChat")}
      >
        <NewChatIcon size={18} />
      </button>
      <div className="rail-div" />
      <div className="rail-group">
        {PRIMARY.map((tool) => (
          <RailButton
            key={tool.id}
            tool={tool}
            label={t("rail.chatHistory")}
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
          aria-label={t("rail.memoria")}
          aria-pressed={openTools.has("memoria")}
          data-tip={t("rail.memoria")}
          onClick={() => onTool("memoria")}
        >
          <BrainIcon size={19} />
        </button>
        {/* Epic #270 — Quality Intelligence opens as a singleton Workspace window (not a page route). */}
        <button
          type="button"
          className="rail-btn"
          data-side="left"
          data-active={openTools.has("quality") ? "true" : "false"}
          aria-label={t("rail.quality")}
          aria-pressed={openTools.has("quality")}
          data-tip={t("rail.quality")}
          onClick={() => onTool("quality")}
        >
          <CheckIcon size={19} />
        </button>
        {/* Epic #1307, Issue #1314 — Prompt Enhancer opens as a singleton Workspace tool window. */}
        <button
          type="button"
          className="rail-btn"
          data-side="left"
          data-active={openTools.has("promptEnhancer") ? "true" : "false"}
          aria-label={t("rail.promptEnhancer")}
          aria-pressed={openTools.has("promptEnhancer")}
          data-tip={t("rail.promptEnhancer")}
          onClick={() => onTool("promptEnhancer")}
        >
          <SparkIcon size={19} />
        </button>
        <button
          type="button"
          className="rail-btn"
          data-side="left"
          data-active={openTools.has("coding") ? "true" : "false"}
          aria-label={t("rail.coding")}
          aria-pressed={openTools.has("coding")}
          data-tip={t("rail.coding")}
          onClick={() => onTool("coding")}
        >
          <CodeIcon size={19} />
        </button>
        <button
          type="button"
          className="rail-btn"
          data-side="left"
          data-active={openTools.has("governedGit") ? "true" : "false"}
          aria-label="Git"
          aria-pressed={openTools.has("governedGit")}
          data-tip="Git"
          onClick={() => onTool("governedGit")}
        >
          <GitIcon size={19} />
        </button>
        <button
          type="button"
          className="rail-btn"
          data-side="left"
          data-active={openTools.has("editor") ? "true" : "false"}
          aria-label={t("rail.editor")}
          aria-pressed={openTools.has("editor")}
          data-tip={t("rail.editor")}
          onClick={() => onTool("editor")}
        >
          <EditorIcon size={19} />
        </button>
        <button
          type="button"
          className="rail-btn"
          data-side="left"
          data-active={openTools.has("localKnowledge") ? "true" : "false"}
          aria-label={t("rail.localKnowledge")}
          aria-pressed={openTools.has("localKnowledge")}
          data-tip={t("rail.localKnowledge")}
          onClick={() => onTool("localKnowledge")}
        >
          <LocalKnowledgeIcon size={19} />
        </button>
        <button
          type="button"
          className="rail-btn"
          data-side="left"
          data-active={openTools.has("figma") ? "true" : "false"}
          aria-label={t("rail.figma")}
          aria-pressed={openTools.has("figma")}
          data-tip={t("rail.figma")}
          onClick={() => onTool("figma")}
        >
          <LayersIcon size={19} />
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
        aria-label={themeLabel}
        aria-pressed={theme === "light"}
        data-tip={themeLabel}
        onClick={onToggleTheme}
      >
        {theme === "light" ? <MoonIcon size={19} /> : <SunIcon size={19} />}
      </button>
      <button
        type="button"
        className="rail-btn"
        data-side="left"
        data-active={openTools.has("settings") ? "true" : "false"}
        aria-label={t("rail.settings")}
        aria-pressed={openTools.has("settings")}
        data-tip={t("rail.settings")}
        onClick={() => onTool("settings")}
      >
        <SettingsIcon size={19} />
      </button>
    </nav>
  );
}

export const LeftRail = memo(LeftRailImpl);
