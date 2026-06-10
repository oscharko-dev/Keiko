"use client";

import type { ReactNode } from "react";
import { Icons } from "../../Icons";
import { useOptionalChatSessionContext } from "../../context/ChatSessionContext";

export function SearchPanel(): ReactNode {
  const session = useOptionalChatSessionContext();
  const projectName = session?.activeProject?.name ?? "No project selected";
  return (
    <div className="srch">
      <div className="srch-box">
        <Icons.search size={15} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search files and symbols"
          placeholder="Search files & symbols…"
          disabled
        />
      </div>
      <div className="tw-label srch-label">
        {projectName} <span className="srch-meta mono">workspace search</span>
      </div>
      {/* uiux-fix F027 C040: the previous tree was the hardcoded PROJECT_TREE demo
          rendered under the REAL project name, with a dead input and a fabricated
          ⇧⇧ shortcut chip. Until real workspace search exists, show the honest
          placeholder pattern (ResourcesPanel / Settings security tab). */}
      <div className="tw-pad">
        <div className="rb-placeholder" style={{ height: 150 }}>
          <div className="ph-stripes" />
          <span className="rb-ph-label mono">search</span>
        </div>
        <div className="rb-foot mono" style={{ marginTop: 14 }}>
          Search across workspace files &amp; symbols — coming soon.
        </div>
      </div>
    </div>
  );
}
