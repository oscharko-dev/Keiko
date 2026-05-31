"use client";

import type { ReactNode } from "react";
import { Icons } from "../../Icons";

interface BrowserWidgetProps {
  url?: string;
}

export function BrowserWidget({ url = "localhost:5173" }: BrowserWidgetProps): ReactNode {
  return (
    <div className="browser">
      <div className="bw-bar">
        <span className="bw-dot" style={{ background: "var(--line-strong)" }} />
        <div className="bw-url mono">
          <span className="dot" style={{ background: "var(--ok)" }} />
          {url}
        </div>
        <Icons.reset size={13} />
      </div>
      <div className="bw-view">
        <div className="ph-stripes" />
        <div className="bw-overlay mono">live preview</div>
      </div>
    </div>
  );
}
