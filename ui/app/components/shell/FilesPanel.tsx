"use client";

// Stub — implementation added in M3 of issue #67.
// Exported so ToolRail can import it without a circular dependency.

import type { ReactNode } from "react";
import type { ProjectWithAvailability } from "@/lib/types";

export interface FilesPanelProps {
  project: ProjectWithAvailability;
  onClose: () => void;
}

export function FilesPanel(_props: FilesPanelProps): ReactNode {
  return null;
}

export default FilesPanel;
