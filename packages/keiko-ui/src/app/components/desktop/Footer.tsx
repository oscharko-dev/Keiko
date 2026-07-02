"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { fetchHealth } from "@/lib/api";
import { useTranslate } from "@/lib/i18n";
import { Icons } from "./Icons";
import type { TwinMode } from "./hooks/useTwinMode";
import { WIN_TYPES } from "./windows/WindowsRegistry";
import { subText } from "./windows/connectionUtils";
import type { AppWindow } from "./windows/types";

interface FooterProps {
  readonly winCount: number;
  readonly windows: readonly AppWindow[];
  readonly windowPaletteOpen: boolean;
  readonly onToggleWindowPalette: () => void;
  readonly onSelectWindow: (id: string) => void;
  readonly onCloseWindowPalette: () => void;
  readonly mode: TwinMode;
  // AC #4: the currently selected model id, undefined when no eligible model is
  // configured. Passed by value from AppShell so no Context provider is needed.
  readonly selectedModel: string | undefined;
  readonly projectName: string;
  readonly branchLabel: string;
  readonly shellStatusLabel: string;
  readonly evidenceStatusLabel: string;
  readonly statusRef?: (node: HTMLElement | null) => void;
}

function FooterImpl({
  winCount,
  windows,
  windowPaletteOpen,
  onToggleWindowPalette,
  onSelectWindow,
  onCloseWindowPalette,
  statusRef,
}: FooterProps): ReactNode {
  const t = useTranslate();
  const windowPaletteRef = useRef<HTMLSpanElement | null>(null);
  const [installedVersion, setInstalledVersion] = useState(t("footer.versionLoading"));
  const windowLabel =
    winCount === 1
      ? t("footer.windowSingular", { count: winCount })
      : t("footer.windowPlural", { count: winCount });
  const sortedWindows = useMemo(() => [...windows].sort((a, b) => b.z - a.z), [windows]);

  useEffect(() => {
    let cancelled = false;
    async function loadInstalledVersion(): Promise<void> {
      try {
        const health = await fetchHealth();
        if (!cancelled) setInstalledVersion(health.version);
      } catch {
        if (!cancelled) setInstalledVersion(t("footer.versionUnavailable"));
      }
    }
    void loadInstalledVersion();
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    if (!windowPaletteOpen) return;
    if (winCount === 0) {
      onCloseWindowPalette();
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (
        target instanceof Node &&
        windowPaletteRef.current !== null &&
        !windowPaletteRef.current.contains(target)
      ) {
        onCloseWindowPalette();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCloseWindowPalette();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onCloseWindowPalette, winCount, windowPaletteOpen]);

  return (
    // SH-02: tabIndex={-1} is intentional — this footer is a programmatic focus target
    // for the Alt+S "jump to status region" shortcut (AppShell dispatchShortcut
    // "focus-status"). It must NOT be in the natural tab order; tabIndex={-1} is correct.
    // A :focus-visible indicator is provided via CSS (see CSS_NEEDED in the a11y audit).
    <footer
      ref={statusRef}
      className="footer mono"
      tabIndex={-1}
      aria-label={t("footer.status")}
      aria-live="polite"
    >
      <span className="spacer" />
      <span className="ft-brand" aria-label={t("footer.version", { version: installedVersion })}>
        Keiko | {installedVersion}
      </span>
      <span className="ft-window-wrap" ref={windowPaletteRef}>
        <button
          type="button"
          className="ft-seg ft-accent ft-window-trigger"
          aria-atomic="true"
          aria-expanded={windowPaletteOpen}
          aria-controls="footer-window-palette"
          disabled={winCount === 0}
          onClick={onToggleWindowPalette}
        >
          <Icons.tile size={13} /> {windowLabel}
        </button>
        {windowPaletteOpen && winCount > 0 ? (
          <div
            id="footer-window-palette"
            className="ft-window-palette"
            role="group"
            aria-label={t("footer.openWindows")}
          >
            <div className="ft-window-palette-head">{t("footer.openWindows")}</div>
            <div className="ft-window-list">
              {sortedWindows.map((win) => {
                const def = WIN_TYPES[win.type];
                const Icon = Icons[def.icon];
                const sub = subText(win.type, win.cfg);
                const stateLabel =
                  win.minimized === true
                    ? t("footer.minimized")
                    : win.max
                      ? t("footer.fullscreen")
                      : t("footer.visible");
                const actionLabel =
                  win.minimized === true ? t("footer.restore") : t("footer.focus");
                const actionSuffix = sub !== null ? ` - ${sub}` : "";
                return (
                  <button
                    key={win.id}
                    type="button"
                    className="ft-window-card"
                    data-minimized={win.minimized === true ? "true" : "false"}
                    aria-label={t("footer.windowAction", {
                      action: actionLabel,
                      title: def.title,
                      suffix: actionSuffix,
                    })}
                    onClick={() => onSelectWindow(win.id)}
                  >
                    <span
                      className="ft-window-icon"
                      style={{ color: def.accent === true ? "var(--accent)" : undefined }}
                    >
                      <Icon size={14} />
                    </span>
                    <span className="ft-window-copy">
                      <span className="ft-window-title">{def.title}</span>
                      <span className="ft-window-sub" title={sub ?? stateLabel}>
                        {sub ?? stateLabel}
                      </span>
                    </span>
                    <span className="ft-window-state">{stateLabel}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </span>
    </footer>
  );
}

export const Footer = memo(FooterImpl);
