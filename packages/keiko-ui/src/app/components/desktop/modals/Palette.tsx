"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Icons } from "../Icons";
import {
  localizedWindowDesc,
  localizedWindowTitle,
  type WIN_TYPES as WinTypes,
  type WindowType,
} from "../windows/WindowsRegistry";
import { useTranslate } from "@/lib/i18n";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const AddIcon = Icons.add;
const CloseIcon = Icons.close;
const PlusIcon = Icons.plus;

// KEIKO-0349: styled inline to avoid touching globals.css (SHA-pinned visual-proof gate, #1300).
const PLACEHOLDER_BADGE_STYLE: CSSProperties = {
  position: "absolute",
  top: "6px",
  right: "6px",
  padding: "2px 6px",
  fontSize: "10px",
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--text-secondary)",
  background: "var(--surface-muted, rgba(255,255,255,0.08))",
  border: "1px solid var(--border-subtle, rgba(0,0,0,0.1))",
  borderRadius: "4px",
  pointerEvents: "none",
};

const PLACEHOLDER_CARD_STYLE: CSSProperties = { position: "relative" };

interface PaletteProps {
  readonly types: typeof WinTypes;
  readonly order: readonly WindowType[];
  readonly onAdd: (type: WindowType) => void;
  readonly onClose: () => void;
}

function paletteGridColumns(count: number): 2 | 3 {
  return count <= 4 ? 2 : 3;
}

/** APG-grid-style roving focus target; null when the key is not a grid key. */
function nextCardIndex(key: string, current: number, count: number, columns: 2 | 3): number | null {
  if (count === 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  let delta: number;
  if (key === "ArrowRight") delta = 1;
  else if (key === "ArrowLeft") delta = -1;
  else if (key === "ArrowDown") delta = columns;
  else if (key === "ArrowUp") delta = -columns;
  else return null;
  return Math.max(0, Math.min(count - 1, current + delta));
}

export function Palette({ types, order, onAdd, onClose }: PaletteProps): ReactNode {
  const t = useTranslate();
  const columns = paletteGridColumns(order.length);
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
    const next = nextCardIndex(
      e.key,
      cards.indexOf(e.target as HTMLButtonElement),
      cards.length,
      columns,
    );
    if (next === null) return;
    e.preventDefault();
    setActiveIdx(next);
    cards[next]?.focus();
  };

  const onBlur = (e: FocusEvent<HTMLDivElement>): void => {
    // Outside-the-palette focus move: relatedTarget is a Node that is not inside the dialog.
    if (e.relatedTarget instanceof Node && ref.current?.contains(e.relatedTarget) !== true) {
      onClose();
      return;
    }
    // Window/tab blur signature: relatedTarget === null AND the document itself has lost focus.
    // The KEIKO-0757 sibling fix on KeyboardShortcutsPanel established this shape; without it a
    // window blur left the palette dialog open (no relatedTarget Node to distinguish "focus moved
    // to a real element outside the palette" from "focus left the tab entirely"). A benign
    // null-relatedTarget blur while the document still has focus (e.g. focus moved to a native
    // dialog owned by the same document) must NOT close the palette.
    if (e.relatedTarget === null && !document.hasFocus()) {
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
      style={{ cursor: "default" }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      data-columns={columns}
    >
      <div className="palette-head">
        <span className="palette-badge">
          <AddIcon size={17} />
        </span>
        <div className="palette-htext">
          <span id="palette-title" className="palette-title">
            {t("workspace.newWindow")}
          </span>
          <span id="palette-desc" className="palette-sub">
            {t("palette.description")}
          </span>
        </div>
        <span className="spacer" />
        <button
          type="button"
          className="palette-x"
          onClick={onClose}
          aria-label={t("common.close")}
          title={t("common.close")}
        >
          <CloseIcon size={16} />
        </button>
      </div>
      <div className="palette-grid">
        {order.map((k, i) => {
          const def = types[k];
          const Icon = Icons[def.icon];
          const isPlaceholder = def.status === "placeholder";
          const cardStyle = isPlaceholder ? PLACEHOLDER_CARD_STYLE : undefined;
          return (
            <button
              type="button"
              className="pal-card pal-main"
              key={k}
              tabIndex={i === activeIdx ? 0 : -1}
              onFocus={() => setActiveIdx(i)}
              onClick={() => onAdd(k)}
              {...(cardStyle === undefined ? {} : { style: cardStyle })}
              {...(isPlaceholder ? { "data-window-status": "placeholder" } : {})}
            >
              {isPlaceholder ? (
                <span
                  className="pal-status"
                  style={PLACEHOLDER_BADGE_STYLE}
                  data-testid="pal-status-placeholder"
                  aria-label={t("palette.placeholderLabel")}
                >
                  {t("palette.placeholder")}
                </span>
              ) : null}
              <span className="pal-ico">
                <Icon size={18} />
              </span>
              <span className="pal-name">{localizedWindowTitle(t, k)}</span>
              <span className="pal-desc">{localizedWindowDesc(t, k)}</span>
              <span className="pal-add" aria-hidden="true">
                <PlusIcon size={15} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
