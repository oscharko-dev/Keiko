"use client";

import type { ReactNode } from "react";
import { Icons } from "../Icons";
import { type WIN_TYPES as WinTypes, type WindowType } from "../windows/WindowsRegistry";

interface PaletteProps {
  readonly types: typeof WinTypes;
  readonly order: readonly WindowType[];
  readonly onAdd: (type: WindowType) => void;
  readonly onClose: () => void;
}

export function Palette({ types, order, onAdd, onClose }: PaletteProps): ReactNode {
  return (
    <div
      className="palette"
      role="dialog"
      aria-label="New window picker"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="palette-head">
        <span className="palette-badge"><Icons.add size={17} /></span>
        <div className="palette-htext">
          <span className="palette-title">New Window</span>
          <span className="palette-sub">Pick a card to add to your workspace</span>
        </div>
        <span className="spacer" />
        <button
          type="button"
          className="palette-x"
          onClick={onClose}
          aria-label="Close window picker"
          title="Close"
        >
          <Icons.close size={16} />
        </button>
      </div>
      <div className="palette-grid">
        {order.map((k) => {
          const t = types[k];
          const Icon = Icons[t.icon];
          return (
            <button
              type="button"
              className="pal-card pal-main"
              key={k}
              onClick={() => onAdd(k)}
            >
              <span className="pal-ico"><Icon size={18} /></span>
              <span className="pal-name">{t.title}</span>
              <span className="pal-desc">{t.desc}</span>
              <span className="pal-add"><Icons.plus size={15} /></span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
