"use client";

import type { ReactNode } from "react";

export function ResourcesPanel(): ReactNode {
  return (
    <div className="tw-pad">
      <div className="rb-placeholder" style={{ height: 150 }}>
        <div className="ph-stripes" />
        <span className="rb-ph-label mono">resources</span>
      </div>
      <div className="rb-foot mono" style={{ marginTop: 14 }}>
        Shared assets &amp; references — coming soon.
      </div>
    </div>
  );
}
