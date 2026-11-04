"use client";

import { useTranslate } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";

import type { ReactNode } from "react";

type Translate = ReturnType<typeof useTranslate>;

export type CfgValue = string | number | boolean | readonly string[] | undefined;
export type Cfg = Record<string, CfgValue>;
type AccessMode = "ask" | "full";

interface PermControlProps {
  readonly cfg: Cfg;
  readonly set: (key: string, value: CfgValue) => void;
}

const LEGACY_OPTIONS: readonly (readonly [AccessMode, MessageKey])[] = [
  ["ask", "permControl.askEveryAction"],
  ["full", "permControl.fullAccess"],
];

function resolveAccessNote(keiko: boolean, access: AccessMode, t: Translate): string {
  if (keiko) return t("permControl.noteKeiko");
  return t(access === "full" ? "permControl.noteLegacyFull" : "permControl.noteLegacyAsk");
}

export function PermControl({ cfg, set }: PermControlProps): ReactNode {
  const tUi = useTranslate();
  const keiko = cfg["keikoMode"] !== false;
  const access: AccessMode = cfg["access"] === "full" ? "full" : "ask";
  const note = resolveAccessNote(keiko, access, tUi);
  return (
    <div className="permctl">
      <button
        type="button"
        className="perm-toggle"
        data-on={keiko}
        // A binary on/off master control is a switch, not a toggle button
        // (GEN-UI-A11Y-021): role="switch" + aria-checked conveys the on/off state,
        // where aria-pressed only conveys "activated".
        role="switch"
        aria-checked={keiko}
        onClick={() => set("keikoMode", !keiko)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- raw SVG sized by .perm-orca */}
        <img className="perm-orca" src="/keiko-logo.svg" alt="" />
        <span className="perm-tt">
          <span className="perm-name">{tUi("permControl.keikoMode")}</span>
          <span className="perm-desc">{tUi("permControl.zeroStandingRights")}</span>
        </span>
        <span className={"perm-sw" + (keiko ? " on" : "")}>
          <span />
        </span>
      </button>
      {!keiko && (
        // Two mutually-exclusive access modes are a single-select radio group, not two
        // independent toggle buttons (GEN-UI-A11Y-021): role="radiogroup" + labelled,
        // children role="radio" + aria-checked.
        <div
          className="perm-legacy"
          role="radiogroup"
          aria-label={tUi("permControl.legacyAccessMode")}
        >
          {LEGACY_OPTIONS.map(([a, lbl]) => (
            <button
              type="button"
              key={a}
              className="perm-opt"
              data-on={access === a}
              role="radio"
              aria-checked={access === a}
              onClick={() => set("access", a)}
            >
              {tUi(lbl)}
            </button>
          ))}
        </div>
      )}
      <div className="perm-note">{note}</div>
    </div>
  );
}
