"use client";

import { useContext } from "react";
import type { ReactNode } from "react";
import { WsContext } from "../../context/WsContext";
import { WIN_TYPES } from "../../windows/WindowsRegistry";
import { WIN_META } from "../../windows/descriptor-meta";
import { Icons } from "../../Icons";
import type { IconName } from "../../Icons";

export function InspectorPanel(): ReactNode {
  const { wins, active, winCount } = useContext(WsContext);
  void wins; // available for future use

  const t = active !== null ? WIN_TYPES[active.type] : null;
  const cfgRows =
    active !== null
      ? Object.entries(active.cfg).filter(([, v]) => v !== "" && v !== undefined && v !== null)
      : [];

  return (
    <div className="tw-pad">
      <div className="rb-section-label" style={{ marginTop: 0 }}>
        Active window
      </div>
      {active !== null && t !== null ? (
        <>
          <div className="insp-top">
            <span
              className="insp-ico"
              style={{ color: t.accent === true ? "var(--accent)" : "var(--fg-muted)" }}
            >
              {renderIcon(t.icon, 16)}
            </span>
            <span className="insp-title">{t.title}</span>
          </div>
          <div className="rb-rows">
            <div className="rb-row">
              <span className="rb-row-k">Size</span>
              <span className="rb-row-v mono">
                {Math.round(active.w)} × {Math.round(active.h)}
              </span>
            </div>
            <div className="rb-row">
              <span className="rb-row-k">Position</span>
              <span className="rb-row-v mono">
                {Math.round(active.x)}, {Math.round(active.y)}
              </span>
            </div>
            <div className="rb-row">
              <span className="rb-row-k">State</span>
              <span className="rb-row-v mono">{active.max ? "maximized" : "floating"}</span>
            </div>
          </div>
          {cfgRows.length > 0 && (
            <>
              <div className="rb-section-label">Configuration</div>
              <div className="rb-rows">
                {cfgRows.map(([k, v]) => (
                  <div className="rb-row" key={k}>
                    <span className="rb-row-k">{k}</span>
                    <span className="rb-row-v mono">{String(v).slice(0, 20) || "—"}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="rb-section-label insp-governance">Governance</div>
          <div className="rb-rows insp-governance" data-testid="insp-governance">
            <div className="rb-row">
              <span className="rb-row-k">Authority</span>
              <span className="rb-row-v mono">{WIN_META[active.type].authority}</span>
            </div>
            <div className="rb-row">
              <span className="rb-row-k">Persistence</span>
              <span className="rb-row-v mono">{WIN_META[active.type].persistence}</span>
            </div>
            <div className="rb-row">
              <span className="rb-row-k">Trust</span>
              <span className="rb-row-v mono">
                {WIN_META[active.type].trustBoundary.join(", ")}
              </span>
            </div>
            <div className="rb-row">
              <span className="rb-row-k">Lifecycle</span>
              <span className="rb-row-v mono">{WIN_META[active.type].lifecycle.join(" → ")}</span>
            </div>
          </div>
        </>
      ) : (
        <div className="insp-empty">No window focused</div>
      )}
      <div className="rb-section-label">Workspace</div>
      <div className="rb-rows">
        <div className="rb-row">
          <span className="rb-row-k">Open windows</span>
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
