"use client";

import type { ReactNode } from "react";
import { useTranslate } from "@/lib/i18n";
import { Icons } from "../../Icons";
import type { IconName } from "../../Icons";
import styles from "./PluginsPanel.module.css";

// KEIKO-0160: brands whose SVG ships white-on-transparent (invisible on light theme) need a
// theme-aware invert applied only in the light theme so they stay visible on both backgrounds.
const BRAND_INVERT_ON_LIGHT: ReadonlySet<string> = new Set(["notion", "openai"]);

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const CheckIcon = Icons.check;
const PlusIcon = Icons.plus;

interface McpEntry {
  name: string;
  img?: string;
  icon?: IconName;
  desc: string;
  on: boolean;
}

interface ConnEntry {
  name: string;
  img: string;
  on: boolean;
}

const MCP_SERVERS: McpEntry[] = [
  { name: "Context7", img: "upstash", desc: "Up-to-date library docs", on: true },
  { name: "Sequential Thinking", icon: "layers", desc: "Step-by-step reasoning", on: true },
  { name: "Filesystem", icon: "files", desc: "Local file access", on: true },
  { name: "GitHub", img: "github", desc: "Repos · PRs · issues", on: true },
  { name: "Playwright", img: "playwright", desc: "Browser automation", on: false },
  { name: "Brave Search", img: "brave", desc: "Web search", on: false },
  { name: "MemoriaViva", icon: "cube", desc: "Knowledge graph", on: true },
];

const CONNECTORS: ConnEntry[] = [
  { name: "GitHub", img: "github", on: true },
  { name: "Linear", img: "linear", on: true },
  { name: "PostgreSQL", img: "postgresql", on: true },
  { name: "Sentry", img: "sentry", on: false },
  { name: "Slack", img: "slack", on: false },
  { name: "Notion", img: "notion", on: false },
];

interface PlugIconProps {
  readonly img?: string | undefined;
  readonly icon?: IconName | undefined;
  readonly glyph?: string | undefined;
}

function PlugIcon({ img, icon, glyph }: PlugIconProps): ReactNode {
  if (img !== undefined) {
    const cls = BRAND_INVERT_ON_LIGHT.has(img) ? `pl-img ${styles.brandOnLight}` : "pl-img";
    return (
      // eslint-disable-next-line @next/next/no-img-element -- design CSS sizes raw SVG via .pl-img; next/image breaks sizing
      <img className={cls} src={`/assets/icons/${img}.svg`} width="20" height="20" alt="" />
    );
  }
  if (icon !== undefined) {
    const IconComp = Icons[icon];
    return (
      <span className="pl-line">
        <IconComp size={18} />
      </span>
    );
  }
  return <span className="mono pl-glyph">{glyph}</span>;
}

export function PluginsPanel(): ReactNode {
  const t = useTranslate();
  return (
    <div className="plg">
      <div className="plg-sec">
        <span className="plg-sec-t">MCP Servers</span>
        <span className="plg-sec-c mono">{t("plugins.mcp.previewHeader")}</span>
      </div>
      {MCP_SERVERS.map((m) => (
        // GEN-UI-INTERACTION-003 (KEIKO-0158): MCP servers are placeholders — no process
        // actually runs behind any row. Render as non-interactive rows and label each with
        // "Preview" so sighted users see the row is not live; previously the fake
        // Running/Stopped copy misled readers into believing a process existed (Codex
        // review on PR #3089).
        <div className="plg-row" key={m.name} data-state="preview">
          <span className="plg-ico">
            <PlugIcon img={m.img} icon={m.icon} />
          </span>
          <span className="plg-text">
            <span className="plg-name">{m.name}</span>
            <span className="plg-desc">{m.desc}</span>
          </span>
          <span className="plg-dot" aria-hidden="true" />
          <span className="plg-desc mono">{t("plugins.mcp.rowStatusPreview")}</span>
        </div>
      ))}
      <div className="plg-sec plg-sec2">
        <span className="plg-sec-t">Connectors</span>
      </div>
      {CONNECTORS.map((c) => (
        // GEN-UI-INTERACTION-001: these connectors are placeholders (not wired to
        // any action). Render them as non-interactive rows so they are NOT tab
        // stops and do not advertise a button role — the "Connected/Not connected"
        // copy carries the status. Visual look is preserved via the same classes.
        <div className="plg-row plg-conn" key={c.name} data-on={c.on}>
          <span className="plg-ico">
            <PlugIcon img={c.img} />
          </span>
          <span className="plg-text">
            <span className="plg-name">{c.name}</span>
            <span className="plg-desc">{c.on ? "Connected" : "Not connected"}</span>
          </span>
          {c.on ? (
            <span className="integ-on">
              <CheckIcon size={13} />
            </span>
          ) : (
            <span className="integ-add">
              <PlusIcon size={14} />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
