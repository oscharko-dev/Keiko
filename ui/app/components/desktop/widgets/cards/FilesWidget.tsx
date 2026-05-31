"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { PROJECT_TREE, TreeNodeComponent } from "../shared/projectTree";
import { FilePreview } from "./FilePreview";

// `root` is accepted for spec parity with the design (and #62 cfg shape); the
// design's tree itself is hard-coded — Welle 5+ will switch to a real per-root
// listing via /api/workspace.
interface FilesWidgetProps {
  root?: string;
}

export function FilesWidget(_props: FilesWidgetProps): ReactNode {
  const [sel, setSel] = useState<string | null>(null);
  if (sel !== null) {
    return <FilePreview name={sel} onClose={() => { setSel(null); }} />;
  }
  return (
    <div className="files">
      <div className="tr">
        {PROJECT_TREE.map((node, i) => (
          <TreeNodeComponent
            key={`${node.name}-${String(i)}`}
            node={node}
            depth={0}
            path=""
            active={null}
            onPick={(p) => {
              const tail = p.split("/").pop();
              if (tail !== undefined && tail !== "") setSel(tail);
            }}
          />
        ))}
      </div>
    </div>
  );
}
