"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { Icons } from "../../Icons";
import type { IconName } from "../../Icons";

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
  { name: "Memory", icon: "cube", desc: "Knowledge graph", on: true },
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
  img?: string | undefined;
  icon?: IconName | undefined;
  glyph?: string | undefined;
}

function PlugIcon({ img, icon, glyph }: PlugIconProps): ReactNode {
  if (img !== undefined) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- design CSS sizes raw SVG via .pl-img; next/image breaks sizing
      <img className="pl-img" src={`/assets/icons/${img}.svg`} width="20" height="20" alt="" />
    );
  }
  if (icon !== undefined) {
    const IconComp = Icons[icon];
    return <span className="pl-line"><IconComp size={18} /></span>;
  }
  return <span className="mono pl-glyph">{glyph}</span>;
}

export function PluginsPanel(): ReactNode {
  const [mcpState, setMcpState] = useState<boolean[]>(MCP_SERVERS.map((m) => m.on));
  const activeCount = mcpState.filter(Boolean).length;

  return (
    <div className="plg">
      <div className="plg-sec">
        <span className="plg-sec-t">MCP Servers</span>
        <span className="plg-sec-c mono">
          {activeCount}/{MCP_SERVERS.length} active
        </span>
      </div>
      {MCP_SERVERS.map((m, i) => {
        const on = mcpState[i] ?? false;
        return (
          <div className="plg-row" key={m.name}>
            <span className="plg-ico">
              <PlugIcon img={m.img} icon={m.icon} />
            </span>
            <span className="plg-text">
              <span className="plg-name">{m.name}</span>
              <span className="plg-desc">{m.desc}</span>
            </span>
            <button
              className={`plg-dot${on ? " on" : ""}`}
              title={on ? "Running" : "Stopped"}
              aria-label={`${m.name}: ${on ? "running" : "stopped"}`}
              onClick={() => {
                setMcpState((prev) => {
                  const next = [...prev];
                  next[i] = !(next[i] ?? false);
                  return next;
                });
              }}
            />
          </div>
        );
      })}
      <div className="plg-sec plg-sec2">
        <span className="plg-sec-t">Connectors</span>
      </div>
      {CONNECTORS.map((c) => (
        <button className="plg-row plg-conn" key={c.name} data-on={c.on}>
          <span className="plg-ico">
            <PlugIcon img={c.img} />
          </span>
          <span className="plg-text">
            <span className="plg-name">{c.name}</span>
            <span className="plg-desc">{c.on ? "Connected" : "Not connected"}</span>
          </span>
          {c.on ? (
            <span className="integ-on">
              <Icons.check size={13} />
            </span>
          ) : (
            <span className="integ-add">
              <Icons.plus size={14} />
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
