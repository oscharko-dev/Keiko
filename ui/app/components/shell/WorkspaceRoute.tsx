import { Suspense } from "react";
import type { ReactNode } from "react";
import { CentralArea } from "./CentralArea";
import { WorkspaceShellEntry } from "./WorkspaceShellEntry";

/**
 * Shared workspace route for both / and /launch.
 * CentralArea reads URL search params, so it must sit inside Suspense for static export.
 */
export function WorkspaceRoute(): ReactNode {
  return (
    <Suspense fallback={<WorkspaceShellEntry />}>
      <CentralArea />
    </Suspense>
  );
}

export default WorkspaceRoute;
