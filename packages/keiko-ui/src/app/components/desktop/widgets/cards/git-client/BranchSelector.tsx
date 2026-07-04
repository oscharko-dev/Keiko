"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { GitBranchListEntry } from "@/lib/api";
import { Icons } from "../../../Icons";
import {
  COMPACT_BTN,
  INPUT_STYLE,
  LIST_STYLE,
  MENU_STYLE,
  REPO_OPTION_SELECTED_STYLE,
  REPO_OPTION_STYLE,
  SECONDARY_BTN,
  SUBTLE_TEXT_STYLE,
  disabledStyle,
} from "./git-client-styles";

interface BranchSelectorProps {
  readonly branches: readonly GitBranchListEntry[];
  readonly currentBranch: string;
  readonly loading: boolean;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onSwitchBranch: (branchName: string) => void;
  readonly onCreateBranch: () => void;
}

function branchMatches(branch: GitBranchListEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return branch.name.toLowerCase().includes(needle);
}

export function BranchSelector({
  branches,
  currentBranch,
  loading,
  disabled,
  busy,
  onSwitchBranch,
  onCreateBranch,
}: BranchSelectorProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listboxId = useId();
  const searchId = useId();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const filtered = useMemo(
    () => branches.filter((branch) => branchMatches(branch, query)),
    [branches, query],
  );

  const toggleOpen = (): void => {
    if (disabled || loading || branches.length === 0) return;
    setOpen((value) => !value);
  };

  const close = (restoreFocus = false): void => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  };

  const moveFocus = (index: number): void => {
    const clamped = Math.max(0, Math.min(index, filtered.length - 1));
    optionRefs.current[clamped]?.focus();
  };

  const onOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveFocus(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveFocus(filtered.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      // Tabbing out of either edge of the option list dismisses the popup (mirrors
      // KeikoSelect). Shift+Tab off the first option and Tab off the last option both
      // leave the listbox; close without stealing focus so the browser's own Tab order
      // carries focus onward to the neighbouring toolbar control.
      const first = index === 0 && event.shiftKey;
      const last = index === filtered.length - 1 && !event.shiftKey;
      if (first || last) close(false);
    }
  };

  const triggerLabel =
    currentBranch.length > 0 ? currentBranch : loading ? "Loading branches" : "No branch";

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Dismiss the popup when the user clicks outside the selector or the window loses focus
  // (mirrors KeikoSelect). These are pointer/blur paths, not keyboard, so focus is left where
  // the user put it rather than yanked back to the trigger.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (wrapRef.current !== null && target instanceof Node && wrapRef.current.contains(target)) {
        return;
      }
      close(false);
    };
    const onWindowBlur = (): void => close(false);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [open]);

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 6 }}
    >
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={`Branch: ${triggerLabel}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={disabled || loading || branches.length === 0}
        style={{ ...SECONDARY_BTN, minWidth: 168, ...disabledStyle(disabled || loading) }}
        onClick={toggleOpen}
      >
        <Icons.branch size={12} />
        <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {triggerLabel}
        </span>
      </button>
      <button
        type="button"
        aria-label="New branch"
        disabled={disabled || loading || branches.length === 0 || busy}
        style={{ ...COMPACT_BTN, ...disabledStyle(disabled || loading || busy) }}
        onClick={onCreateBranch}
      >
        <Icons.plus size={11} /> New
      </button>
      {open ? (
        <div style={MENU_STYLE}>
          <label
            htmlFor={searchId}
            style={{
              display: "block",
              marginBottom: 6,
              font: "600 11px var(--font-ui)",
              color: "var(--fg-faint)",
              textTransform: "uppercase",
            }}
          >
            Search branches
          </label>
          <input
            ref={searchRef}
            id={searchId}
            type="search"
            value={query}
            aria-label="Search branches"
            style={{ ...INPUT_STYLE, marginBottom: 10 }}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") close(true);
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveFocus(0);
              }
              // Tab out of the search field dismisses the popup and lets the browser move focus
              // to the next control in document order (pointer/keyboard-out path — no focus grab).
              if (event.key === "Tab") close(false);
            }}
          />
          <div
            id={listboxId}
            role="listbox"
            aria-label="Branches"
            style={{ ...LIST_STYLE, maxHeight: 260, padding: 0 }}
          >
            {filtered.length === 0 ? (
              <p style={{ ...SUBTLE_TEXT_STYLE, padding: 12 }}>No matching branches.</p>
            ) : (
              filtered.map((branch, index) => {
                const selected = branch.name === currentBranch || branch.current;
                return (
                  <button
                    key={branch.name}
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={busy}
                    style={{
                      ...REPO_OPTION_STYLE,
                      ...(selected ? REPO_OPTION_SELECTED_STYLE : {}),
                      ...disabledStyle(busy),
                    }}
                    onClick={() => {
                      if (!selected) onSwitchBranch(branch.name);
                      close(true);
                    }}
                    onKeyDown={(event) => onOptionKeyDown(event, index)}
                  >
                    <span className="mono">{branch.name}</span>
                    {selected ? (
                      <span style={{ float: "right", font: "400 11px var(--font-ui)" }}>
                        current
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
