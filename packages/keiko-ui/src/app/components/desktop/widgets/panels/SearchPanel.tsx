"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { Icons } from "../../Icons";
import { PROJECT_TREE, TreeNodeComponent } from "../shared/projectTree";

export function SearchPanel(): ReactNode {
  const [active, setActive] = useState("/frontend/src/App.tsx");
  return (
    <div className="srch">
      <div className="srch-box">
        <Icons.search size={15} />
        <input placeholder="Search files & symbols…" />
        <span className="kbd">⇧⇧</span>
      </div>
      <div className="tw-label srch-label">
        example-workspace{" "}
        <span className="srch-meta mono">spring-boot · typescript</span>
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
