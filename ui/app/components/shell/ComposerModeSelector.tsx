"use client";

import { useRef } from "react";
import type { ReactNode, KeyboardEvent } from "react";
import type { ComposerMode } from "./ChatComposer";

export interface ModeOption {
  readonly id: ComposerMode;
  readonly label: string;
}

export const MODE_OPTIONS: readonly ModeOption[] = [
  { id: "generate-tests", label: "Generate Tests" },
  { id: "investigate-bug", label: "Investigate Bug" },
  { id: "explain-plan", label: "Explain Plan" },
  { id: "verify", label: "Verify" },
];

interface ComposerModeSelectorProps {
  readonly mode: ComposerMode | null;
  readonly disabled: boolean;
  readonly onChange: (mode: ComposerMode) => void;
}

/**
 * ARIA radiogroup with roving-tabindex navigation (ARIA APG radiogroup pattern, WCAG 2.1.1).
 * Only the active pill (or the first pill when none is selected) holds tabIndex=0; all others
 * are tabIndex=-1. ArrowRight/ArrowDown advances; ArrowLeft/ArrowUp retreats, both wrapping.
 */
export function ComposerModeSelector({
  mode,
  disabled,
  onChange,
}: ComposerModeSelectorProps): ReactNode {
  // Stable ref map keyed by mode id; populated via callback refs on each button.
  const pillRefs = useRef<Map<ComposerMode, HTMLButtonElement>>(new Map());

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const isNext = e.key === "ArrowRight" || e.key === "ArrowDown";
    const isPrev = e.key === "ArrowLeft" || e.key === "ArrowUp";
    if (!isNext && !isPrev) {
      return;
    }
    e.preventDefault();
    const next = isNext
      ? (index + 1) % MODE_OPTIONS.length
      : (index - 1 + MODE_OPTIONS.length) % MODE_OPTIONS.length;
    const nextOption = MODE_OPTIONS[next];
    if (nextOption === undefined) {
      return;
    }
    onChange(nextOption.id);
    pillRefs.current.get(nextOption.id)?.focus();
  }

  return (
    <div role="radiogroup" aria-label="Workflow mode" className="mb-2 flex flex-wrap gap-2">
      {MODE_OPTIONS.map((opt, index) => {
        const active = mode === opt.id;
        // Roving tabindex: only the selected pill (or the first if none selected) is reachable
        // via Tab. All others are programmatically focusable only (arrow keys).
        const tabIndex = active || (mode === null && index === 0) ? 0 : -1;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={tabIndex}
            disabled={disabled}
            ref={(el) => {
              if (el !== null) {
                pillRefs.current.set(opt.id, el);
              } else {
                pillRefs.current.delete(opt.id);
              }
            }}
            onClick={() => onChange(opt.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={`rounded-full px-3 py-1 text-xs
              focus:outline-none focus-visible:ring-2 focus-visible:ring-focus
              disabled:opacity-50
              ${
                active
                  ? "bg-accent text-ink-inverse"
                  : "bg-elevated text-ink hover:bg-panel"
              }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
