"use client";

import { useEffect, useRef, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { Icons } from "../Icons";
import { type WIN_TYPES as WinTypes, type WindowType } from "../windows/WindowsRegistry";

interface PaletteProps {
  readonly types: typeof WinTypes;
  readonly order: readonly WindowType[];
  readonly onAdd: (type: WindowType) => void;
  readonly onClose: () => void;
}

export function Palette({ types, order, onAdd, onClose }: PaletteProps): ReactNode {
  // Match design palette.jsx behaviour: focus the first card on mount and
  // allow Escape to close (the design relies on it; the prior impl had no
  // keyboard handler at all).
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLButtonElement>(".pal-card");
    first?.focus();
    return () => {
      // Restore focus to the trigger only when closing would otherwise drop it
      // (Escape / close button — focus was inside the palette and falls back to
      // <body> on unmount). When the user already moved focus elsewhere (click
      // or Tab outside), leave it where they put it.
      const active = document.activeElement;
      if (active === null || active === document.body) triggerRef.current?.focus?.();
    };
  }, []);

  // The palette is an anchored popover next to the FAB and the workspace
  // behind it stays fully interactive — so it must not claim aria-modal or
  // hard-trap Tab (audit C187). Non-modal dismissal instead: pointerdown
  // outside closes (parity with CommandPalette/NewWindowDialog), and focus
  // leaving the palette closes it without stealing focus back.
  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent): void => {
      if (ref.current !== null && e.target instanceof Node && !ref.current.contains(e.target)) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
    };
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const onBlur = (e: FocusEvent<HTMLDivElement>): void => {
    if (e.relatedTarget instanceof Node && ref.current?.contains(e.relatedTarget) !== true) {
      onClose();
    }
  };

  return (
    // The role="dialog" container needs keyboard listeners for the Escape-close
    // contract; same pattern is already used by NewWindowDialog and CommandPalette
    // (see project convention).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={ref}
      className="palette"
      role="dialog"
      aria-labelledby="palette-title"
      aria-describedby="palette-desc"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <div className="palette-head">
        <span className="palette-badge">
          <Icons.add size={17} />
        </span>
        <div className="palette-htext">
          <span id="palette-title" className="palette-title">
            New window
          </span>
          <span id="palette-desc" className="palette-sub">
            Pick a card to add to your workspace
          </span>
        </div>
        <span className="spacer" />
        <button
          type="button"
          className="palette-x"
          onClick={onClose}
          aria-label="Close window picker"
          title="Close"
        >
          <Icons.close size={16} />
        </button>
      </div>
      <div className="palette-grid">
        {order.map((k) => {
          const t = types[k];
          const Icon = Icons[t.icon];
          return (
            <button type="button" className="pal-card pal-main" key={k} onClick={() => onAdd(k)}>
              <span className="pal-ico">
                <Icon size={18} />
              </span>
              <span className="pal-name">{t.title}</span>
              <span className="pal-desc">{t.desc}</span>
              <span className="pal-add">
                <Icons.plus size={15} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
