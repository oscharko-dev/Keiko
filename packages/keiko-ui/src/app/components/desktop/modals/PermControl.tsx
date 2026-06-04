"use client";

import type { ReactNode } from "react";

export type CfgValue = string | number | boolean | undefined;
export type Cfg = Record<string, CfgValue>;
export type AccessMode = "ask" | "full";

interface PermControlProps {
  readonly cfg: Cfg;
  readonly set: (key: string, value: CfgValue) => void;
}

const LEGACY_OPTIONS: readonly (readonly [AccessMode, string])[] = [
  ["ask", "Ask every action"],
  ["full", "Full access"],
];

export function PermControl({ cfg, set }: PermControlProps): ReactNode {
  const keiko = cfg["keikoMode"] !== false;
  const rawAccess = cfg["access"];
  const access: AccessMode = rawAccess === "full" ? "full" : "ask";
  const note = keiko
    ? "No rights by default. You approve while manual; Keiko governs per policy when autonomous."
    : access === "full"
      ? "Legacy: agent acts without prompts."
      : "Legacy: you approve each privileged action.";
  return (
    <div className="permctl">
      <button
        type="button"
        className="perm-toggle"
        data-on={keiko}
        aria-pressed={keiko}
        onClick={() => set("keikoMode", !keiko)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- raw SVG sized by .perm-orca */}
        <img className="perm-orca" src="/assets/keiko-logo.svg" alt="" />
        <span className="perm-tt">
          <span className="perm-name">Keiko-Mode</span>
          <span className="perm-desc">Zero standing rights · Keiko governs</span>
        </span>
        <span className={"perm-sw" + (keiko ? " on" : "")}>
          <span />
        </span>
      </button>
      {!keiko && (
        <div className="perm-legacy">
          {LEGACY_OPTIONS.map(([a, lbl]) => (
            <button
              type="button"
              key={a}
              className="perm-opt"
              data-on={access === a}
              aria-pressed={access === a}
              onClick={() => set("access", a)}
            >
              {lbl}
            </button>
          ))}
        </div>
      )}
      <div className="perm-note">{note}</div>
    </div>
  );
}
