"use client";

import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";

import { useContext } from "react";
import type { ReactNode } from "react";
import { WsContext } from "../../context/WsContext";
import { localizedWindowTitle, WIN_TYPES } from "../../windows/WindowsRegistry";
import { useTranslate } from "@/lib/i18n";
import { WIN_META } from "../../windows/descriptor-meta";
import { Icons } from "../../Icons";
import type { IconName } from "../../Icons";

export function InspectorPanel(): ReactNode {
  const tUi = useOptionalWidgetTranslate();
  const { active, winCount } = useContext(WsContext);
  const translate = useTranslate();

  const def = active !== null ? WIN_TYPES[active.type] : null;
  const cfgRows =
    active !== null
      ? Object.entries(active.cfg).filter(([, v]) => v !== "" && v !== undefined && v !== null)
      : [];

  return (
    <div className="tw-pad">
      <div className="rb-section-label" style={{ marginTop: 0 }}>
        {tUi("inspectorPanel.ui.activeWindow")}
      </div>
      {active !== null && def !== null ? (
        <>
          <div className="insp-top">
            <span
              className="insp-ico"
              style={{ color: def.accent === true ? "var(--accent)" : "var(--fg-muted)" }}
            >
              {renderIcon(def.icon, 16)}
            </span>
            <span className="insp-title">{localizedWindowTitle(translate, active.type)}</span>
          </div>
          <div className="rb-rows">
            <div className="rb-row">
              <span className="rb-row-k">{tUi("inspectorPanel.ui.size")}</span>
              <span className="rb-row-v mono">
                {Math.round(active.w)} × {Math.round(active.h)}
              </span>
            </div>
            <div className="rb-row">
              <span className="rb-row-k">{tUi("inspectorPanel.ui.position")}</span>
              <span className="rb-row-v mono">
                {Math.round(active.x)}, {Math.round(active.y)}
              </span>
            </div>
            <div className="rb-row">
              <span className="rb-row-k">{tUi("inspectorPanel.ui.state")}</span>
              <span className="rb-row-v mono">{active.max ? "maximized" : "floating"}</span>
            </div>
          </div>
          {cfgRows.length > 0 && (
            <>
              <div className="rb-section-label">{tUi("inspectorPanel.ui.configuration")}</div>
              <div className="rb-rows">
                {cfgRows.map(([k, v]) => {
                  // GEN-UI-VISUAL-004 — surface the full value on hover and to AT via title, and
                  // append an ellipsis when the displayed value is truncated at 20 chars.
                  const full = String(v);
                  const truncated = full.length > 20;
                  const display = truncated ? `${full.slice(0, 20)}…` : full;
                  return (
                    <div className="rb-row" key={k}>
                      <span className="rb-row-k">{k}</span>
                      <span className="rb-row-v mono" title={full}>
                        {display || "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          <div className="rb-section-label insp-governance">
            {tUi("inspectorPanel.ui.governance")}
          </div>
          <div className="rb-rows insp-governance" data-testid="insp-governance">
            <div className="rb-row">
              <span className="rb-row-k">{tUi("inspectorPanel.ui.authority")}</span>
              <span className="rb-row-v mono">{WIN_META[active.type].authority}</span>
            </div>
            <div className="rb-row">
              <span className="rb-row-k">{tUi("inspectorPanel.ui.persistence")}</span>
              <span className="rb-row-v mono">{WIN_META[active.type].persistence}</span>
            </div>
            <div className="rb-row">
              <span className="rb-row-k">{tUi("inspectorPanel.ui.trust")}</span>
              <span className="rb-row-v mono">
                {WIN_META[active.type].trustBoundary.join(", ")}
              </span>
            </div>
            <div className="rb-row">
              <span className="rb-row-k">{tUi("inspectorPanel.ui.lifecycle")}</span>
              <span className="rb-row-v mono">{WIN_META[active.type].lifecycle.join(" → ")}</span>
            </div>
          </div>
        </>
      ) : (
        <div className="insp-empty">{tUi("inspectorPanel.ui.noWindowFocused")}</div>
      )}
      <div className="rb-section-label">{tUi("inspectorPanel.ui.workspace")}</div>
      <div className="rb-rows">
        <div className="rb-row">
          <span className="rb-row-k">{tUi("inspectorPanel.ui.openWindows")}</span>
          <span className="rb-row-v mono">{winCount}</span>
        </div>
      </div>
    </div>
  );
}

function renderIcon(icon: IconName, size: number): ReactNode {
  const IconComp = Icons[icon];
  return <IconComp size={size} />;
}
