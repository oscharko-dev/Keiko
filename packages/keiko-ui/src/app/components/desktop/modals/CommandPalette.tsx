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
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // capture the element that opened the palette so we can return focus on close
    triggerRef.current = document.activeElement as HTMLElement | null;
    return () => {
      triggerRef.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    return commands.filter((c) => `${c.label} ${c.group ?? ""}`.toLowerCase().includes(needle));
  }, [commands, q]);

  useEffect(() => {
    setSel(0);
  }, [q]);

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
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={filtered.length > 0 ? `cmdk-row-${String(sel)}` : undefined}
            aria-label="Command query"
            placeholder="Type a command…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <span className="kbd">esc</span>
        </div>
        <div id="cmdk-list" role="listbox" className="cmdk-list">
          {filtered.length === 0 && <div className="cmdk-empty">No matching commands</div>}
          {filtered.map((c, i) => (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- keyboard navigation is handled at the combobox input level via arrow keys; options are reached via aria-activedescendant, not focus
            <div
              role="option"
              id={`cmdk-row-${String(i)}`}
              aria-selected={i === sel}
              key={c.id}
              className="cmdk-row"
              data-sel={i === sel}
              tabIndex={-1}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(c)}
            >
              <span className="cmdk-ico">{iconNode(c.icon)}</span>
              <span className="cmdk-label">{c.label}</span>
              <span className="spacer" />
              {c.group !== undefined && <span className="cmdk-group mono">{c.group}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
