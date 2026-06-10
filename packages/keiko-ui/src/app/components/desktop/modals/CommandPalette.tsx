"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Icons, type IconName } from "../Icons";

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly group?: string;
  readonly icon: IconName;
  // Optional keyboard chord rendered as a .kbd chip in the row (shortcut discoverability).
  readonly shortcut?: string;
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
  const dialogRef = useRef<HTMLDivElement | null>(null);

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

  // Keep the active option visible while navigating: focus stays on the input
  // (aria-activedescendant pattern), so the browser never scrolls the .cmdk-list
  // (max-height 50vh) natively — the selection would wander below the fold
  // (audit C019). Optional chaining: jsdom lacks scrollIntoView.
  useEffect(() => {
    document.getElementById(`cmdk-row-${String(sel)}`)?.scrollIntoView?.({ block: "nearest" });
  }, [sel, filtered]);

  const run = (c: Command | undefined): void => {
    if (c === undefined) return;
    c.run();
    onClose();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Tab") {
      const focusables = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex='-1'])",
        ) ?? [],
      );
      if (focusables.length > 0) {
        const first = focusables[0] as HTMLElement;
        const last = focusables[focusables.length - 1] as HTMLElement;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
          return;
        }
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
          return;
        }
      }
    }
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
        ref={dialogRef}
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cmdk-title"
        aria-describedby="cmdk-desc"
        // tabIndex -1: clicking a non-focusable area (header text, list padding)
        // keeps focus inside the dialog, so the Escape/Tab handlers on this
        // element stay reachable (audit C007).
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <h2 id="cmdk-title" className="sr-only">
          Command palette
        </h2>
        <p id="cmdk-desc" className="sr-only">
          Search commands and press Enter to run the selected action.
        </p>
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
        {/* Live filter feedback for screen readers — without it the 0-results
            state is silent (aria-activedescendant just becomes undefined) and
            Enter no-ops without explanation (audit C188). */}
        <div className="sr-only" role="status">
          {filtered.length === 0
            ? "No matching commands"
            : `${String(filtered.length)} command${filtered.length === 1 ? "" : "s"}`}
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
              {c.shortcut !== undefined && <span className="kbd">{c.shortcut}</span>}
              {c.group !== undefined && <span className="cmdk-group mono">{c.group}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
