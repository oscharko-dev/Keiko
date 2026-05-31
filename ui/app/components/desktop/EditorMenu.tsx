"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
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
  const current = findEditor(selectedId);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, selectedId);
    } catch {
      /* localStorage may be unavailable */
    }
  }, [selectedId]);

  const choose = (id: string): void => {
    setSelectedId(id);
    setOpen(false);
  };

  return (
    <div className="edm">
      <button
        type="button"
        className="edm-trigger"
        onClick={() => setOpen((value) => !value)}
        title={`Open ${project} in ${current.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <EditorTile ed={current} size={20} />
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
          <div className="edm-menu" role="menu">
            <div className="edm-head mono">Open “{project}” in…</div>
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
