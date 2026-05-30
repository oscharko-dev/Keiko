"use client";

// Stub — implementation added in M3 of issue #67.
// Exported so ToolRail can import it without a circular dependency.

import type { ReactNode } from "react";
import type { ProjectWithAvailability } from "@/lib/types";

export interface PlannedToolPanelProps {
  tool: "browser" | "review" | "terminal";
  project: ProjectWithAvailability;
  onClose: () => void;
  followUpIssueUrl: string;
}

export function PlannedToolPanel(_props: PlannedToolPanelProps): ReactNode {
  return null;
}

export default PlannedToolPanel;
