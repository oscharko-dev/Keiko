"use client";

// Later waves replace this with the real Files, Terminal, and Keiko Twin widgets.
import type { ReactNode } from "react";
import { Icons } from "../Icons";
import { WIN_TYPES, type WindowType } from "./WindowsRegistry";

interface PlaceholderBodyProps {
  readonly type: WindowType;
}

export function PlaceholderBody({ type }: PlaceholderBodyProps): ReactNode {
  const def = WIN_TYPES[type];
  const Icon = Icons[def.icon];
  return (
    <div className="too-small" style={{ minHeight: "100%" }}>
      <div className="ts-ico">
        <Icon size={28} />
      </div>
      <div className="ts-title">{def.title}</div>
      <div className="ts-sub">Real widget arrives in a later wave</div>
    </div>
  );
}
