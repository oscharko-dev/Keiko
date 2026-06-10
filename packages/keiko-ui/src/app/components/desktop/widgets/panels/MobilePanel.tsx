"use client";

import type { ReactNode } from "react";
import { Icons } from "../../Icons";

export function MobilePanel(): ReactNode {
  return (
    <div className="tw-pad mob">
      <div className="mob-qr">
        <div className="ph-stripes" />
        <Icons.mobile size={28} style={{ position: "relative", color: "var(--fg-dim)" }} />
      </div>
      <div className="mob-title">Keiko Mobile</div>
      <div className="mob-sub">Scan to continue this workspace on your phone.</div>
    </div>
  );
}
