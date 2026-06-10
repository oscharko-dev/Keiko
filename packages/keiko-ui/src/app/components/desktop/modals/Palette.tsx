"use client";

import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Icons } from "../Icons";
import { type WIN_TYPES as WinTypes, type WindowType } from "../windows/WindowsRegistry";

interface PaletteProps {
  readonly types: typeof WinTypes;
  readonly order: readonly WindowType[];
  readonly onAdd: (type: WindowType) => void;
  readonly onClose: () => void;
}

// .palette-grid is a fixed two-column grid (globals.css grid-template-columns:
// 1fr 1fr) — vertical arrow steps move by one row, i.e. two cards (audit C363).
const GRID_COLUMNS = 2;

const ARROW_DELTAS: ReadonlyMap<string, number> = new Map([
  ["ArrowRight", 1],
  ["ArrowLeft", -1],
  ["ArrowDown", GRID_COLUMNS],
  ["ArrowUp", -GRID_COLUMNS],
]);

/** APG-grid-style roving focus target; null when the key is not a grid key. */
function nextCardIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const delta = ARROW_DELTAS.get(key);
  if (delta === undefined) return null;
  return Math.max(0, Math.min(count - 1, current + delta));
}

export function Palette({ types, order, onAdd, onClose }: PaletteProps): ReactNode {
  // Match design palette.jsx behaviour: focus the first card on mount and
  // allow Escape to close (the design relies on it; the prior impl had no
  // keyboard handler at all).
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  // Roving tabindex over the cards (audit C363): exactly one card is a Tab
  // stop; arrows move within the grid. onFocus keeps the index in sync when
  // focus arrives by click or Shift+Tab from the close button.
  const [activeIdx, setActiveIdx] = useState(0);
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
      return;
    }
    // Arrow-key navigation over the card grid with a roving tabindex (audit
    // C363, APG grid pattern). Only when a card is the event target — the
    // close button keeps its plain Tab behaviour.
    if (!(e.target instanceof HTMLElement) || !e.target.classList.contains("pal-card")) return;
    const cards = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(".pal-card") ?? []);
    const next = nextCardIndex(e.key, cards.indexOf(e.target as HTMLButtonElement), cards.length);
    if (next === null) return;
    e.preventDefault();
    setActiveIdx(next);
    cards[next]?.focus();
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
      // tabIndex -1: a click on non-focusable palette chrome keeps focus inside,
      // so the Escape handler stays reachable and onBlur does not misfire (audit C007).
      tabIndex={-1}
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
          aria-label="Close"
          title="Close"
        >
          <Icons.close size={16} />
        </button>
      </div>
      <div className="palette-grid">
        {order.map((k, i) => {
          const t = types[k];
          const Icon = Icons[t.icon];
          return (
            <button
              type="button"
              className="pal-card pal-main"
              key={k}
              tabIndex={i === activeIdx ? 0 : -1}
              onFocus={() => setActiveIdx(i)}
              onClick={() => onAdd(k)}
            >
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
