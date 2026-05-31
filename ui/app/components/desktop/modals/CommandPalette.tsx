"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Icons, type IconName } from "../Icons";

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly group?: string;
  readonly icon: IconName;
  readonly run: () => void;
}

interface CommandPaletteProps {
  readonly commands: readonly Command[];
  readonly onClose: () => void;
}

function iconNode(name: IconName): ReactNode {
  const Ico = Icons[name] ?? Icons.spark;
  return <Ico size={16} />;
}

export function CommandPalette({ commands, onClose }: CommandPaletteProps): ReactNode {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    return commands.filter((c) =>
      `${c.label} ${c.group ?? ""}`.toLowerCase().includes(needle),
    );
  }, [commands, q]);

  useEffect(() => { setSel(0); }, [q]);

  const run = (c: Command | undefined): void => {
    if (c === undefined) return;
    c.run();
    onClose();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(filtered.length - 1, s + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      run(filtered[sel]);
      return;
    }
    if (e.key === "Escape") onClose();
  };

  return (
    <div className="cmdk-overlay" onPointerDown={onClose}>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- modal needs arrow/Enter/Esc key handling */}
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="cmdk-input">
          <Icons.search size={16} />
          <input
            ref={inputRef}
            placeholder="Type a command…"
            aria-label="Command query"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="cmdk-list">
          {filtered.length === 0 && <div className="cmdk-empty">No matching commands</div>}
          {filtered.map((c, i) => (
            <button
              type="button"
              key={c.id}
              className="cmdk-row"
              data-sel={i === sel}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(c)}
            >
              <span className="cmdk-ico">{iconNode(c.icon)}</span>
              <span className="cmdk-label">{c.label}</span>
              <span className="spacer" />
              {c.group !== undefined && <span className="cmdk-group mono">{c.group}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
