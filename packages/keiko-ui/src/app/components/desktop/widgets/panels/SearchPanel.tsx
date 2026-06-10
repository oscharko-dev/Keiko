"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { Icons } from "../../Icons";
import { useOptionalChatSessionContext } from "../../context/ChatSessionContext";
import { PROJECT_TREE, TreeNodeComponent } from "../shared/projectTree";

export function SearchPanel(): ReactNode {
  const [active, setActive] = useState("/frontend/src/App.tsx");
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
        />
        <span className="kbd" aria-hidden="true">
          ⇧⇧
        </span>
      </div>
      <div className="tw-label srch-label">
        {projectName} <span className="srch-meta mono">workspace search</span>
      </div>
      <div className="tr">
        {PROJECT_TREE.map((node, i) => (
          <TreeNodeComponent
            key={`${node.name}-${String(i)}`}
            node={node}
            depth={0}
            path=""
            active={active}
            onPick={setActive}
          />
        ))}
      </div>
    </div>
  );
}
