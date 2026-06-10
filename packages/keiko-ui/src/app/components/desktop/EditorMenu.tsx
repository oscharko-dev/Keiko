"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { Icons } from "./Icons";

interface Editor {
  id: string;
  name: string;
  img?: string;
  tile?: "finder" | "terminal";
}

const EDITORS: readonly Editor[] = [
  { id: "finder", name: "Finder", tile: "finder" },
  { id: "terminal", name: "Terminal", tile: "terminal" },
  { id: "vscode", name: "VS Code", img: "/assets/editors/vscode.svg" },
  { id: "intellij", name: "IntelliJ IDEA", img: "/assets/editors/intellij.svg" },
  { id: "goland", name: "GoLand", img: "/assets/editors/goland.svg" },
  { id: "rustrover", name: "RustRover", img: "/assets/editors/rustrover.svg" },
  { id: "pycharm", name: "PyCharm", img: "/assets/editors/pycharm.svg" },
  { id: "webstorm", name: "WebStorm", img: "/assets/editors/webstorm.svg" },
];

const STORAGE_KEY = "keiko.editor";
const DEFAULT_EDITOR_ID = "intellij";

function readStoredId(): string {
  if (typeof window === "undefined") return DEFAULT_EDITOR_ID;
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_EDITOR_ID;
  } catch {
    return DEFAULT_EDITOR_ID;
  }
}

function findEditor(id: string): Editor {
  return EDITORS.find((editor) => editor.id === id) ?? EDITORS[3]!;
}

/* APG menu keyboard contract: ArrowDown/ArrowUp cycle, Home/End jump (uiux-fix F011 C168). */
function nextItemIndex(key: string, activeIndex: number, count: number): number {
  if (key === "ArrowDown") return activeIndex < 0 ? 0 : (activeIndex + 1) % count;
  if (key === "ArrowUp") return activeIndex < 0 ? count - 1 : (activeIndex - 1 + count) % count;
  if (key === "Home") return 0;
  return count - 1;
}

interface EditorTileProps {
  ed: Editor;
  size?: number;
}

function EditorTile({ ed, size = 20 }: EditorTileProps): ReactNode {
  if (ed.img !== undefined) {
    // eslint-disable-next-line @next/next/no-img-element -- inline SVG tile in design system; next/image wraps and breaks .ed-img sizing
    return <img className="ed-img" src={ed.img} width={size} height={size} alt="" />;
  }
  const radius = Math.round(size * 0.27);
  if (ed.tile === "terminal") {
    return (
      <span
        className="ed-tile"
        style={{ width: size, height: size, borderRadius: radius, background: "#2a2c33" }}
      >
        <span className="ed-mark mono" style={{ color: "#4ee08d", fontSize: size * 0.42 }}>
          {">_"}
        </span>
      </span>
    );
  }
  return (
    <span
      className="ed-tile"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: "linear-gradient(180deg,#36c4ff,#1e7cf0)",
      }}
    >
      <Icons.folder size={size * 0.56} style={{ color: "#fff" }} />
    </span>
  );
}

interface EditorMenuProps {
  project: string;
}

export function EditorMenu({ project }: EditorMenuProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>(readStoredId);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = findEditor(selectedId);
  /* Preference-only control until an open-in-editor BFF route exists: the copy
     must not promise an "Open …" action that never happens (uiux-fix F011 C080). */
  const triggerLabel = `Editor: ${current.name}`;
  const accessibleLabel = `Preferred editor for ${project}: ${current.name}`;

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, selectedId);
    } catch {
      /* localStorage may be unavailable */
    }
  }, [selectedId]);

  /* role=menu contract: move focus to the selected item when the menu opens (C168). */
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (menu === null) return;
    const target =
      menu.querySelector<HTMLButtonElement>('.edm-item[data-sel="true"]') ??
      menu.querySelector<HTMLButtonElement>(".edm-item");
    target?.focus();
  }, [open]);

  const closeAndRestoreFocus = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (id: string): void => {
    setSelectedId(id);
    closeAndRestoreFocus();
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const menu = menuRef.current;
    if (menu === null) return;
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>(".edm-item"));
    if (items.length === 0) return;
    event.preventDefault();
    const activeIndex = items.findIndex((item) => item === document.activeElement);
    items[nextItemIndex(event.key, activeIndex, items.length)]?.focus();
  };

  return (
    <div className="edm">
      <button
        type="button"
        ref={triggerRef}
        className="edm-trigger"
        onClick={() => setOpen((value) => !value)}
        title={accessibleLabel}
        aria-label={accessibleLabel}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <EditorTile ed={current} size={20} />
        <span className="edm-trigger-label">{triggerLabel}</span>
        <Icons.chevron size={13} style={{ color: "var(--fg-faint)" }} />
      </button>
      {open ? (
        <>
          <div
            className="edm-backdrop"
            onClick={() => setOpen(false)}
            aria-hidden="true"
            role="presentation"
          />
          <div
            className="edm-menu"
            role="menu"
            tabIndex={-1}
            ref={menuRef}
            onKeyDown={onMenuKeyDown}
          >
            <div className="edm-head mono">Preferred editor for “{project}”</div>
            {EDITORS.map((editor) => (
              <button
                key={editor.id}
                type="button"
                className="edm-item"
                data-sel={editor.id === selectedId}
                onClick={() => choose(editor.id)}
                role="menuitemradio"
                aria-checked={editor.id === selectedId}
              >
                <EditorTile ed={editor} size={24} />
                <span className="edm-name">{editor.name}</span>
                {editor.id === selectedId ? (
                  <Icons.check size={14} style={{ color: "var(--accent)" }} />
                ) : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
