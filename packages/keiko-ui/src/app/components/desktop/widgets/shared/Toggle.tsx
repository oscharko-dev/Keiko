"use client";

import type { ReactNode } from "react";

interface ToggleBaseProps {
  on: boolean;
  onChange: (next: boolean) => void;
}

// GEN-UI-A11Y-020 — a role="switch" MUST have an accessible name. The props are a discriminated
// union so callers are forced to supply exactly one of `label` (aria-label text) or
// `aria-labelledby` (id of an existing visible label); a nameless switch is now a type error.
type ToggleProps =
  | (ToggleBaseProps & { label: string; "aria-labelledby"?: never })
  | (ToggleBaseProps & { "aria-labelledby": string; label?: never });

export function Toggle(props: ToggleProps): ReactNode {
  const { on, onChange } = props;
  const label = "label" in props ? props.label : undefined;
  const labelledBy = "aria-labelledby" in props ? props["aria-labelledby"] : undefined;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-labelledby={labelledBy}
      className={`auto-toggle${on ? " on" : ""}`}
      onClick={() => {
        onChange(!on);
      }}
    >
      <span />
    </button>
  );
}
