"use client";

import type { ReactNode } from "react";

interface ToggleProps {
  on: boolean;
  onChange: (next: boolean) => void;
  label?: string;
}

export function Toggle({ on, onChange, label }: ToggleProps): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`auto-toggle${on ? " on" : ""}`}
      onClick={() => {
        onChange(!on);
      }}
    >
      <span />
    </button>
  );
}
